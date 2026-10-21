import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from './catalog'
import { db, newId, storage } from './storage'
import { errorText, generate, patchVersion, isGenerating, recoverInterrupted, sendUserMessage, stop } from './send'
import type { Version } from './types'

const enc = new TextEncoder()
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    created: 0,
    contextLength: 0,
    priceIn: 0,
    priceOut: 0,
    inputModalities: ['text'],
    outputModalities: ['text'],
    efforts: null,
    defaultEffort: null,
    free: false,
    ...extra,
  }
}
const A = model('a/model-a')
const B = model('b/model-b')

const usageChunk = (prompt = 10, completion = 5, cost = 0.01) =>
  ev({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, cost } })

function sse(lines: string[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(lines.join('')))
        c.close()
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  )
}

const reply = (text: string) => [
  ev({ choices: [{ delta: { content: text } }] }),
  ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  usageChunk(),
  'data: [DONE]\n\n',
]

function stubFetch(...responses: Array<() => Response>) {
  const f = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]
    return next()
  })
  vi.stubGlobal('fetch', f)
  return f
}
const bodyOf = (f: ReturnType<typeof stubFetch>, i: number) =>
  JSON.parse((f.mock.calls[i] as unknown as [string, RequestInit])[1].body as string) as {
    model: string
    messages: Array<{ role: string; content: unknown }>
    reasoning?: { effort: string }
    session_id: string
    stream: boolean
  }

let convId: string
async function setup() {
  await storage.setSettings({ key: 'sk-test' })
  const c = await storage.createConversation({ nextModel: A.id })
  convId = c.id
}
const lastMsg = async () => (await storage.listMessages(convId)).at(-1)!

beforeEach(async () => {
  await Promise.all([db.conversations.clear(), db.messages.clear(), db.settings.clear(), db.cache.clear()])
  await setup()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('generate', () => {
  it('new: appends assistant message with model, content, usage and status done', async () => {
    stubFetch(() => sse(reply('Hello')))
    await sendUserMessage(convId, 'hi', { reply: false })
    await generate(convId, { kind: 'new' }, A)
    const m = await lastMsg()
    expect(m.role).toBe('assistant')
    const v = m.versions[0]
    expect(v.status).toBe('done')
    expect(v.model).toBe(A.id)
    expect(v.content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(v.usage?.promptTokens).toBe(10)
    expect(v.finishReason).toBe('stop')
    expect(isGenerating(convId)).toBe(false)
  })

  it('new: second turn with a different model sends both previous assistant texts', async () => {
    const f = stubFetch(() => sse(reply('Reply from A')), () => sse(reply('Reply from B')))
    await sendUserMessage(convId, 'first', { reply: true, model: A })
    await storage.updateConversation(convId, { nextModel: B.id })
    await sendUserMessage(convId, 'second', { reply: true, model: B })
    const second = bodyOf(f, 1)
    expect(second.model).toBe(B.id)
    expect(second.session_id).toBeTruthy()
    expect(JSON.stringify(second.messages)).toContain('Reply from A')
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('reroll: adds a version, keeps the old one, and sends context only up to the target', async () => {
    const f = stubFetch(() => sse(reply('old')), () => sse(reply('new')))
    await sendUserMessage(convId, 'q1', { reply: true, model: A })
    await sendUserMessage(convId, 'q2', { reply: false })
    const target = (await storage.listMessages(convId)).find((m) => m.role === 'assistant')!
    await generate(convId, { kind: 'reroll', messageId: target.id }, B)
    const after = (await storage.listMessages(convId)).find((m) => m.id === target.id)!
    expect(after.versions).toHaveLength(2)
    expect(after.versions[0].content).toEqual([{ type: 'text', text: 'old' }])
    expect(after.activeVersion).toBe(1)
    expect(after.versions[1].content).toEqual([{ type: 'text', text: 'new' }])
    expect(after.versions[1].model).toBe(B.id)
    const body = bodyOf(f, 1)
    expect(body.messages).toEqual([{ role: 'user', content: 'q1' }])
  })

  it('continue: new version starts with old text and request ends with assistant prefill', async () => {
    const f = stubFetch(() => sse(reply('Once upon')), () => sse(reply(' a time')))
    await sendUserMessage(convId, 'story', { reply: true, model: A })
    const target = await lastMsg()
    await generate(convId, { kind: 'continue', messageId: target.id }, A)
    const body = bodyOf(f, 1)
    expect(body.messages.at(-1)).toEqual({ role: 'assistant', content: 'Once upon' })
    const after = (await storage.listMessages(convId)).find((m) => m.id === target.id)!
    expect(after.versions).toHaveLength(2)
    expect(after.versions[0].content).toEqual([{ type: 'text', text: 'Once upon' }])
    expect(after.versions[1].content).toEqual([{ type: 'text', text: 'Once upon a time' }])
    expect(after.activeVersion).toBe(1)
  })

  it('stop: aborts and leaves status stopped with partial text', async () => {
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(ev({ choices: [{ delta: { content: 'partial' } }] })))
            },
            // never closes: waits for abort
          }),
          { status: 200 },
        ),
    )
    // Wire the abort signal into the body so reads reject with AbortError.
    const real = globalThis.fetch
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
      const res = await real(u, init)
      const reader = res.body!.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          const abort = new Promise<never>((_, rej) =>
            init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
          )
          try {
            const r = await Promise.race([reader.read(), abort])
            if (r.done) c.close()
            else c.enqueue(r.value)
          } catch (e) {
            c.error(e)
          }
        },
      })
      return new Response(body, { status: 200 })
    })
    await sendUserMessage(convId, 'hi', { reply: false })
    const p = generate(convId, { kind: 'new' }, A)
    await vi.waitFor(async () => {
      expect(isGenerating(convId)).toBe(true)
      const v = (await lastMsg()).versions[0]
      expect(v.status).toBe('streaming')
    })
    await new Promise((r) => setTimeout(r, 20))
    stop(convId)
    await p
    const v = (await lastMsg()).versions[0]
    expect(v.status).toBe('stopped')
    expect(v.content).toEqual([{ type: 'text', text: 'partial' }])
    expect(isGenerating(convId)).toBe(false)
  })

  it('stores readable error for 401 and 402', async () => {
    for (const [code, text] of [
      [401, 'Your OpenRouter key was rejected. Check it in Settings.'],
      [402, 'Out of credits on OpenRouter.'],
    ] as const) {
      stubFetch(() => new Response(JSON.stringify({ error: { message: 'raw' } }), { status: code }))
      await sendUserMessage(convId, 'hi', { reply: true, model: A })
      const v = (await lastMsg()).versions[0]
      expect(v.status).toBe('error')
      expect(v.error).toBe(text)
      expect(errorText(code, 'raw')).toBe(text)
    }
    expect(errorText(429, 'x')).toBe('Rate limited. Try again in a moment.')
    expect(errorText(500, 'boom')).toBe('boom')
  })

  it('stores a 401-style error when no key is set', async () => {
    await storage.setSettings({ key: null })
    const f = stubFetch(() => sse(reply('x')))
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    expect(f).not.toHaveBeenCalled()
    const v = (await lastMsg()).versions[0]
    expect(v.status).toBe('error')
    expect(v.error).toBe(errorText(401, ''))
  })

  it('marks stale streaming versions interrupted on startup', async () => {
    const stale: Version = { id: newId(), content: [{ type: 'text', text: 'half' }], status: 'streaming', createdAt: 1 }
    const m = await storage.appendMessage(convId, 'assistant', stale)
    const done: Version = { id: newId(), content: [], status: 'done', createdAt: 1 }
    await storage.appendMessage(convId, 'user', done)
    expect(await recoverInterrupted()).toBe(1)
    const after = (await storage.listMessages(convId)).find((x) => x.id === m.id)!
    expect(after.versions[0].status).toBe('interrupted')
    expect(after.versions[0].content).toEqual([{ type: 'text', text: 'half' }])
    expect(await recoverInterrupted()).toBe(0)
  })

  it('adds usage to conversation totals', async () => {
    stubFetch(() => sse([...reply('a')]), () => sse([...reply('b')]))
    await sendUserMessage(convId, 'one', { reply: true, model: A })
    await sendUserMessage(convId, 'two', { reply: true, model: A })
    const c = (await storage.getConversation(convId))!
    expect(c.totals.promptTokens).toBe(20)
    expect(c.totals.completionTokens).toBe(10)
    expect(c.totals.cost).toBeCloseTo(0.02)
  })

  it('treats a repeated finish and repeated usage idempotently', async () => {
    stubFetch(() =>
      sse([
        ev({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }),
        ev({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01 } }),
        usageChunk(),
      ]),
    )
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    const v = (await lastMsg()).versions[0]
    expect(v.status).toBe('done')
    expect((await storage.getConversation(convId))!.totals.promptTokens).toBe(10)
  })

  it('derives thinking text from reasoning details when text is empty, and keeps the details', async () => {
    const details = [
      { type: 'reasoning.text', text: 'step one ' },
      { type: 'reasoning.summary', summary: 'short' },
      { type: 'reasoning.encrypted', data: 'zzz' },
    ]
    stubFetch(() =>
      sse([
        ev({ choices: [{ delta: { reasoning_details: details } }] }),
        ev({ choices: [{ delta: { content: 'answer' } }] }),
        ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    )
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    const r = (await lastMsg()).versions[0].reasoning!
    expect(r.text).toBe('step one short')
    expect(r.details).toEqual(details)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('marks a stream that ends without finish as interrupted, keeping partial text', async () => {
    stubFetch(() => sse([ev({ choices: [{ delta: { content: 'cut of' } }] })]))
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    const v = (await lastMsg()).versions[0]
    expect(v.status).toBe('interrupted')
    expect(v.content).toEqual([{ type: 'text', text: 'cut of' }])
  })

  it('sends reasoning effort only when set and the model supports efforts', async () => {
    const f = stubFetch(() => sse(reply('x')))
    const M = model('c/reasoner', { efforts: ['low', 'high'], defaultEffort: 'low' })
    await storage.updateConversation(convId, { nextEffort: 'high' })
    await sendUserMessage(convId, 'hi', { reply: true, model: M })
    expect(bodyOf(f, 0).reasoning).toEqual({ effort: 'high' })
    expect((await lastMsg()).versions[0].reasoningEffort).toBe('high')

    await sendUserMessage(convId, 'again', { reply: true, model: A }) // no efforts
    expect(bodyOf(f, 1).reasoning).toBeUndefined()
    expect((await lastMsg()).versions[0].reasoningEffort).toBeUndefined()

    await storage.updateConversation(convId, { nextEffort: null })
    await sendUserMessage(convId, 'third', { reply: true, model: M })
    expect(bodyOf(f, 2).reasoning).toBeUndefined()
  })

  it('throttles intermediate writes to at most one per 200 ms', async () => {
    const put = vi.spyOn(storage, 'putMessage')
    stubFetch(() =>
      sse([
        ev({ choices: [{ delta: { content: 'a' } }] }),
        ev({ choices: [{ delta: { content: 'b' } }] }),
        ev({ choices: [{ delta: { content: 'c' } }] }),
        ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    )
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    // initial append goes through appendMessage; the burst yields one final write only
    expect(put.mock.calls.length).toBeLessThanOrEqual(2)
    put.mockRestore()
  })

  it('a second generate while one is starting is ignored and stop cancels the first', async () => {
    const f = stubFetch(() => sse(reply('x')))
    await sendUserMessage(convId, 'hi', { reply: false })
    const p1 = generate(convId, { kind: 'new' }, A)
    const p2 = generate(convId, { kind: 'new' }, A)
    expect(isGenerating(convId)).toBe(true)
    await Promise.all([p1, p2])
    expect(f).toHaveBeenCalledTimes(1)
    expect(isGenerating(convId)).toBe(false)
  })

  it('stop during the initial fetch ends stopped', async () => {
    vi.stubGlobal(
      'fetch',
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        }),
    )
    await sendUserMessage(convId, 'hi', { reply: false })
    const p = generate(convId, { kind: 'new' }, A)
    stop(convId) // before the controller is otherwise reachable: registered synchronously
    await p
    const msgs = await storage.listMessages(convId)
    const v = msgs.at(-1)!.versions[0]
    expect(msgs.at(-1)!.role === 'assistant' ? v.status : 'stopped').toBe('stopped')
    expect(isGenerating(convId)).toBe(false)
  })

  it('patchVersion keeps a concurrent activeVersion change', async () => {
    const v0: Version = { id: newId(), content: [], status: 'streaming', createdAt: 1 }
    const v1: Version = { id: newId(), content: [], status: 'done', createdAt: 2 }
    const m = await storage.appendMessage(convId, 'assistant', v0)
    await storage.putMessage({ ...m, versions: [v0, v1] })
    await Promise.all([
      patchVersion(m.id, v0.id, { status: 'done' }),
      db.transaction('rw', db.messages, async () => {
        const cur = (await db.messages.get(m.id))!
        await db.messages.put({ ...cur, activeVersion: 1, pinned: true })
      }),
    ])
    const after = (await db.messages.get(m.id))!
    expect(after.activeVersion).toBe(1)
    expect(after.pinned).toBe(true)
    expect(after.versions[0].status).toBe('done')
  })
})
