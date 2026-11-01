import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fallbackModelInfo, type ModelInfo } from './catalog'
import { db, newId, storage } from './storage'
import { setAbilitiesForTest, toolsFor, type Ability } from './abilities/registry'
import { setModelRulesForTest } from './modelRules'
import { computeCold, deleteChat, deleteMessage, deleteVersion, errorText, generate, MAX_ROUNDS, okStep, patchVersion, isGenerating, recoverInterrupted, replacePromptRef, restoreChat, restoreMessage, restoreVersion, sendUserMessage, setAbility, setAlreadyDoneForTest, setPlain, setPrompt, setToolUndone, stop, undoReplyWrites } from './send'
import { notes, YOU } from './notes/store'
import { CAPABILITY_NOTE, systemFor } from './system'
import { fingerprint } from './context'
import type { ToolPart, Version } from './types'
import { editedVersion, withActive, withNewVersion } from './versions'

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
    tools: false,
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
    messages: Array<{
      role: string
      content: unknown
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
      tool_call_id?: string
      reasoning_details?: unknown[]
    }>
    reasoning?: { effort: string }
    session_id: string
    stream: boolean
    tools?: unknown[]
    tool_choice?: string
  }

let convId: string
async function setup() {
  await storage.setSettings({ key: 'sk-test' })
  const c = await storage.createConversation({ nextModel: A.id })
  convId = c.id
}
const lastMsg = async () => (await storage.listMessages(convId)).at(-1)!

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  await setup()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setAbilitiesForTest()
  setAlreadyDoneForTest()
  setModelRulesForTest()
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
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
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
    expect(body.messages).toEqual([
      { role: 'system', content: CAPABILITY_NOTE },
      { role: 'user', content: 'q1' },
    ])
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

  it('joins streamed reasoning details by index, so a signature stays whole', async () => {
    stubFetch(() =>
      sse([
        ev({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'ab' }] } }] }),
        ev({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'cd', signature: 'sig' }] } }] }),
        ev({ choices: [{ delta: { content: 'answer' } }] }),
        ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    )
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    const r = (await lastMsg()).versions[0].reasoning!
    expect(r.details).toEqual([{ type: 'reasoning.text', index: 0, text: 'abcd', signature: 'sig' }])
    expect(r.text).toBe('abcd')
  })

  it('marks a stream that ends without finish as interrupted, keeping partial text', async () => {
    stubFetch(() => sse([ev({ choices: [{ delta: { content: 'cut of' } }] })]))
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    const v = (await lastMsg()).versions[0]
    expect(v.status).toBe('interrupted')
    expect(v.content).toEqual([{ type: 'text', text: 'cut of' }])
  })

  it('a connection drop after some text ends interrupted (Continue), keeping the text', async () => {
    let pulls = 0
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (pulls++ === 0) c.enqueue(enc.encode(ev({ choices: [{ delta: { content: 'half a rep' } }] })))
              else c.error(new TypeError('network error'))
            },
          }),
          { status: 200 },
        ),
    )
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    const v = (await lastMsg()).versions[0]
    expect(v.status).toBe('interrupted')
    expect(v.error).toBeUndefined()
    expect(v.content).toEqual([{ type: 'text', text: 'half a rep' }])
  })

  it('a connection failure before any text is an error with a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    const v = (await lastMsg()).versions[0]
    expect(v.status).toBe('error')
    expect(v.error).toBe("Couldn't reach OpenRouter.")
    expect(errorText(undefined, 'network error')).toBe("Couldn't reach OpenRouter.")
    expect(errorText(undefined, 'Load failed')).toBe("Couldn't reach OpenRouter.")
    expect(errorText(undefined, 'NetworkError when attempting to fetch resource.')).toBe("Couldn't reach OpenRouter.")
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

  it('still sends the chosen effort when the model is an unlisted stand-in (catalog not loaded)', async () => {
    const f = stubFetch(() => sse(reply('x')))
    await storage.updateConversation(convId, { nextEffort: 'low' })
    await sendUserMessage(convId, 'hi', { reply: true, model: fallbackModelInfo('c/reasoner') })
    expect(bodyOf(f, 0).reasoning).toEqual({ effort: 'low' })
    expect((await lastMsg()).versions[0].reasoningEffort).toBe('low')
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

  it('deleting a chat stops its stream; undo brings it back settled, not streaming', async () => {
    // A stream that hangs after one chunk until aborted.
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      let sent = false
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (!sent) {
              sent = true
              c.enqueue(enc.encode(ev({ choices: [{ delta: { content: 'part' } }] })))
              return
            }
            return new Promise<void>((_, rej) =>
              init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
            )
          },
        }),
        { status: 200 },
      )
    })
    await sendUserMessage(convId, 'hi', { reply: false })
    const p = generate(convId, { kind: 'new' }, A)
    await vi.waitFor(async () => expect((await lastMsg()).role).toBe('assistant'))
    const undo = await deleteChat(convId)
    await p
    expect(isGenerating(convId)).toBe(false)
    expect(await storage.getConversation(convId)).toBeUndefined()
    expect(await storage.listMessages(convId)).toEqual([])
    expect(undo).not.toBeNull()
    expect(undo!.messages.flatMap((m) => m.versions).some((v) => v.status === 'streaming')).toBe(false)
    await restoreChat(undo!)
    const back = await storage.listMessages(convId)
    expect(back.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(back[1].versions[0].status).toBe('stopped')
    expect(await deleteChat('missing')).toBeNull()
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

/** What generateInner computes as `cold` for the next request, from the stored state. */
async function coldNow(m: ModelInfo = A): Promise<boolean> {
  const c = (await storage.getConversation(convId))!
  const s = await storage.getSettings()
  const { system, prompt } = await systemFor(c, m)
  return computeCold({
    lastRequest: c.lastRequest,
    messages: await storage.listMessages(convId),
    system,
    windowStartId: c.windowStartMessageId,
    model: m,
    toolsHash: toolsFor(c, prompt, m)?.hash ?? null,
    anthropicCacheHour: s.anthropicCacheHour,
    now: Date.now(),
  })
}

/** The non-system message contents of request `i`. */
const texts = (f: ReturnType<typeof stubFetch>, i: number) =>
  bodyOf(f, i).messages.filter((m) => m.role !== 'system').map((m) => m.content)

const doneVersion = (text: string): Version => ({ id: newId(), content: [{ type: 'text', text }], status: 'done', createdAt: 1 })

describe('generate: prompts, window and cache', () => {
  it('sends the active prompt plus capability note as the system message', async () => {
    const f = stubFetch(() => sse(reply('ok')))
    const p = await storage.savePrompt({ name: 'Chef', parentId: null, text: 'You are a chef.' })
    await storage.updateConversation(convId, { systemPromptRef: p.id })
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    expect(bodyOf(f, 0).messages[0]).toEqual({ role: 'system', content: `You are a chef.\n\n${CAPABILITY_NOTE}` })
    const v = (await lastMsg()).versions[0]
    expect(v.promptRef).toBe(p.id)
    expect(v.promptVersionHash).toBe(p.versionHash)

    // No prompt and no capability note: no system message, promptRef null.
    await storage.updateConversation(convId, { systemPromptRef: null, capabilityNote: false })
    await sendUserMessage(convId, 'again', { reply: true, model: A })
    expect(bodyOf(f, 1).messages.some((m) => m.role === 'system')).toBe(false)
    const v2 = (await lastMsg()).versions[0]
    expect(v2.promptRef).toBeNull()
    expect(v2.promptVersionHash).toBeUndefined()
  })

  it('consecutive normal turns are warm', async () => {
    stubFetch(() => sse(reply('a')))
    expect(await coldNow()).toBe(true) // no last request yet
    await sendUserMessage(convId, 'one', { reply: true, model: A })
    await sendUserMessage(convId, 'two', { reply: false })
    expect(await coldNow()).toBe(false)
    expect(await coldNow(B)).toBe(true) // another model
  })

  it('editing the active prompt makes the next request cold', async () => {
    // messages mode, limit 5: 5 messages is not over the limit (no hard trim) but is over
    // the soft threshold (0.85 × 5), so only a cold request trims.
    const f = stubFetch(() => sse(reply('r')))
    const p = await storage.savePrompt({ name: 'Chef', parentId: null, text: 'Old text.' })
    await storage.updateConversation(convId, {
      systemPromptRef: p.id,
      context: { mode: 'messages', limit: 5, trimTo: 0.7 },
    })
    await sendUserMessage(convId, 'u1', { reply: true, model: A })
    await sendUserMessage(convId, 'u2', { reply: true, model: A })
    await storage.savePrompt({ id: p.id, name: 'Chef', parentId: null, text: 'New text.' })
    await sendUserMessage(convId, 'u3', { reply: false })
    expect(await coldNow()).toBe(true)
    await generate(convId, { kind: 'new' }, A)
    expect(bodyOf(f, 2).messages[0].content).toBe(`New text.\n\n${CAPABILITY_NOTE}`)
    expect(texts(f, 2)).toEqual(['u2', 'r', 'u3']) // cold trim to ≤ 0.7 × 5
    const u2 = (await storage.listMessages(convId))[2]
    const c = (await storage.getConversation(convId))!
    expect(c.windowStartMessageId).toBe(u2.id)
    expect(c.windowStartOrder).toBe(u2.order)
  })

  it('the same chat without the edit stays warm and does not trim', async () => {
    const f = stubFetch(() => sse(reply('r')))
    const p = await storage.savePrompt({ name: 'Chef', parentId: null, text: 'Old text.' })
    await storage.updateConversation(convId, {
      systemPromptRef: p.id,
      context: { mode: 'messages', limit: 5, trimTo: 0.7 },
    })
    await sendUserMessage(convId, 'u1', { reply: true, model: A })
    await sendUserMessage(convId, 'u2', { reply: true, model: A })
    await sendUserMessage(convId, 'u3', { reply: true, model: A })
    expect(texts(f, 2)).toEqual(['u1', 'r', 'u2', 'r', 'u3'])
    expect((await storage.getConversation(convId))!.windowStartMessageId).toBeNull()
  })

  it('trims and stores the new window start when over the limit', async () => {
    const f = stubFetch(() => sse(reply('r')))
    await storage.updateConversation(convId, { context: { mode: 'messages', limit: 4, trimTo: 0.7 } })
    await sendUserMessage(convId, 'u1', { reply: true, model: A })
    await sendUserMessage(convId, 'u2', { reply: true, model: A })
    await sendUserMessage(convId, 'u3', { reply: true, model: A })
    // 5 messages > 4 → trim to ≤ 2.8: the window starts at the second reply.
    expect(texts(f, 2)).toEqual(['…', 'r', 'u3'])
    const msgs = await storage.listMessages(convId)
    const c = (await storage.getConversation(convId))!
    expect(c.windowStartMessageId).toBe(msgs[3].id)
    expect(c.windowStartOrder).toBe(msgs[3].order)
    // The global setting applies when the chat has none.
    await storage.updateConversation(convId, { context: null })
    await storage.setSettings({ context: { mode: 'messages', limit: 2, trimTo: 0.5 } })
    await sendUserMessage(convId, 'u4', { reply: true, model: A })
    expect(texts(f, 3)).toEqual(['u4'])
  })

  it('reroll of a non-last reply in an over-limit chat stays inside the window', async () => {
    const f = stubFetch(() => sse(reply('new')))
    await storage.updateConversation(convId, { context: { mode: 'messages', limit: 4, trimTo: 0.7 } })
    const replies: string[] = []
    for (let i = 1; i <= 5; i++) {
      await storage.appendMessage(convId, 'user', doneVersion(`u${i}`))
      replies.push((await storage.appendMessage(convId, 'assistant', doneVersion(`a${i}`))).id)
    }
    await generate(convId, { kind: 'reroll', messageId: replies[3] }, A) // a4
    // Cut before a4: u1 a1 u2 a2 u3 a3 u4 = 7 > 4 → trim to ≤ 2.8 inside the cut.
    expect(texts(f, 0)).toEqual(['…', 'a3', 'u4'])
    // A reroll's window is a local view: the chat's stored start does not move.
    expect((await storage.getConversation(convId))!.windowStartMessageId).toBeNull()
  })

  it('reroll before the stored window start plans from the beginning of the cut', async () => {
    const f = stubFetch(() => sse(reply('new')))
    await storage.updateConversation(convId, { context: { mode: 'messages', limit: 10, trimTo: 0.7 } })
    const all = []
    for (let i = 1; i <= 4; i++) {
      all.push(await storage.appendMessage(convId, 'user', doneVersion(`u${i}`)))
      all.push(await storage.appendMessage(convId, 'assistant', doneVersion(`a${i}`)))
    }
    await storage.updateConversation(convId, { windowStartMessageId: all[6].id, windowStartOrder: all[6].order }) // u4
    await generate(convId, { kind: 'reroll', messageId: all[3].id }, A) // a2
    expect(texts(f, 0)).toEqual(['u1', 'a1', 'u2'])
    const c = (await storage.getConversation(convId))!
    expect(c.windowStartMessageId).toBe(all[6].id)
    expect(c.windowStartOrder).toBe(all[6].order)
  })

  it('adds cache_control for anthropic models and ttl 1h when the setting is on', async () => {
    const f = stubFetch(() => sse(reply('x')))
    const C = model('anthropic/claude-x')
    await sendUserMessage(convId, 'one', { reply: true, model: C })
    expect((bodyOf(f, 0) as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' })
    await storage.setSettings({ anthropicCacheHour: true })
    await sendUserMessage(convId, 'two', { reply: true, model: C })
    expect((bodyOf(f, 1) as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    await sendUserMessage(convId, 'three', { reply: true, model: A })
    expect('cache_control' in bodyOf(f, 2)).toBe(false)
  })

  it('stores lastRequest fingerprint and updates tokenRatio from usage', async () => {
    await storage.updateConversation(convId, { capabilityNote: false })
    const withProvider = (prompt: number) => () => {
      const r = sse([
        ev({ choices: [{ delta: { content: 'ok' } }] }),
        ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        usageChunk(prompt),
      ])
      return new Response(r.body, { status: 200, headers: { 'X-Provider-Name': 'Anthropic' } })
    }
    const f = stubFetch(withProvider(150), withProvider(0), withProvider(100000))
    const before = Date.now()
    await sendUserMessage(convId, 'x'.repeat(400), { reply: true, model: A }) // estimate 100 tokens
    let c = (await storage.getConversation(convId))!
    expect(c.lastRequest).not.toBeNull()
    expect(c.lastRequest!.model).toBe(A.id)
    expect(c.lastRequest!.provider).toBeNull() // the preference (none yet), not the served provider
    expect(c.lastRequest!.at).toBeGreaterThanOrEqual(before)
    const fp = fingerprint(bodyOf(f, 0).messages as never)
    expect(c.lastRequest!.prefixHash).toBe(fp.prefixHash)
    expect(c.lastRequest!.prefixCount).toBe(fp.prefixCount)
    expect(c.tokenRatio).toBeCloseTo(1.5)
    expect((await lastMsg()).versions[0].provider).toBe('Anthropic')

    await sendUserMessage(convId, 'y', { reply: true, model: A }) // promptTokens 0: ignored
    c = (await storage.getConversation(convId))!
    expect(c.tokenRatio).toBeCloseTo(1.5)
    expect(c.lastRequest!.prefixCount).toBe(3)

    await sendUserMessage(convId, 'z', { reply: true, model: A }) // absurd count: clamped to 2
    expect((await storage.getConversation(convId))!.tokenRatio).toBe(2)
  })

  it('a failed request does not store lastRequest', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'raw' } }), { status: 500 }))
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    expect((await storage.getConversation(convId))!.lastRequest).toBeNull()
  })

  it('a 200 whose stream errors before any token does not store lastRequest', async () => {
    // The provider header makes the stream yield a meta event first (HTTP 200), then the error chunk.
    stubFetch(() => {
      const r = sse([ev({ error: { message: 'Provider overloaded', code: 502 } })])
      return new Response(r.body, { status: 200, headers: { 'X-Provider-Name': 'Anthropic' } })
    })
    await sendUserMessage(convId, 'hi', { reply: true, model: A })
    expect((await lastMsg()).versions[0].status).toBe('error')
    expect((await storage.getConversation(convId))!.lastRequest).toBeNull()
  })
})

/** The model that can use tools. */
const T = model('a/tools', { tools: true })

const ability = (
  run: Ability['run'] = async (_n, args) => `ran ${JSON.stringify(args)}`,
  name = 'echo',
): Ability => ({
  id: name,
  title: name,
  summary: '',
  tools: [{ name, description: 'Say it back.', parameters: { type: 'object', properties: {} } }],
  run,
  describe: () => ({ running: 'running', done: 'done', past: `(Used ${name}.)` }),
  traits: {},
})

const callPiece = (id: string, name: string, args: string, index = 0) =>
  ev({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] })
const finish = (reason: string) => ev({ choices: [{ delta: {}, finish_reason: reason }] })
const DONE = 'data: [DONE]\n\n'
/** One model reply that asks for these calls. */
const asks = (...calls: [id: string, name: string, args: string][]) => [
  ...calls.map(([id, name, args], i) => callPiece(id, name, args, i)),
  finish('tool_calls'),
  usageChunk(),
  DONE,
]
const activeVersion = async () => {
  const m = await lastMsg()
  return m.versions[m.activeVersion]
}
const steps = async (): Promise<ToolPart[]> => (await activeVersion()).content.filter((p): p is ToolPart => p.type === 'tool')
const step = (callId: string, round: number, extra: Partial<ToolPart> = {}): ToolPart => ({
  type: 'tool',
  callId,
  round,
  model: T.id,
  name: 'echo',
  args: {},
  result: 'old result',
  status: 'done',
  ...extra,
})
const open = (callId: string, round: number) => step(callId, round, { status: 'running', result: '' })
/** Every id in `tool_calls` has one `tool` message, right after it, and no id comes twice. */
function expectValid(messages: ReturnType<typeof bodyOf>['messages']) {
  const seen = new Set<string>()
  messages.forEach((m, i) => {
    m.tool_calls?.forEach((c, n) => {
      expect(seen.has(c.id)).toBe(false)
      seen.add(c.id)
      expect(messages[i + 1 + n]).toMatchObject({ role: 'tool', tool_call_id: c.id })
    })
  })
}
/** The fetch itself fails, as when the connection is gone. */
const dropped = (): Response => {
  throw new TypeError('Failed to fetch')
}
/** A tool that waits until Stop, then rejects as a fetch would. */
const hangs = (onStart: () => void): Ability['run'] => async (_n, _a, ctx) => {
  onStart()
  await new Promise<void>((_, rej) => ctx.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
  return 'never'
}

describe('tool loop', () => {
  beforeEach(() => setAbilitiesForTest([ability()]))

  it('runs a tool and sends the result in the next round', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{"a":1}'])), () => sse(reply('Done')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(f).toHaveBeenCalledTimes(2)
    const first = bodyOf(f, 0)
    expect(first.tools).toEqual([{ type: 'function', function: ability().tools[0] }])
    expect(first.tool_choice).toBe('auto')
    const second = bodyOf(f, 1)
    expect(second.tools).toEqual(first.tools)
    expect(second.tool_choice).toBe('auto')
    expect(second.messages.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ran {"a":1}' },
    ])
    const v = await activeVersion()
    expect(v.status).toBe('done')
    expect(v.content).toEqual([
      { type: 'tool', callId: 'c1', round: 0, model: T.id, name: 'echo', args: { a: 1 }, result: 'ran {"a":1}', status: 'done' },
      { type: 'text', text: 'Done' },
    ])
  })

  it('a reply with only tool steps ends done', async () => {
    const f = stubFetch(
      () => sse(asks(['c1', 'echo', '{}'])),
      () => sse([finish('stop'), usageChunk(), DONE]),
      () => sse(reply('next')),
    )
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const v = await activeVersion()
    expect(v.status).toBe('done')
    expect(v.error).toBeUndefined()
    expect(v.content.map((p) => p.type)).toEqual(['tool'])
    // The next turn is a valid request.
    await sendUserMessage(convId, 'and now', { reply: true, model: T })
    const next = bodyOf(f, 2).messages
    expect(next.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expectValid(next)
  })

  it('saves running then done on the ToolPart', async () => {
    const seen: string[][] = []
    setAbilitiesForTest([
      ability(async () => {
        seen.push((await steps()).map((p) => p.status))
        return 'result'
      }),
    ])
    stubFetch(() => sse(asks(['c1', 'echo', '{}'], ['c2', 'echo', '{}'])), () => sse(reply('ok')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    // All calls of a round are saved before the first one runs. They run in order, one at a time.
    expect(seen).toEqual([
      ['running', 'running'],
      ['done', 'running'],
    ])
    expect((await steps()).map((p) => p.status)).toEqual(['done', 'done'])
  })

  it('base outgoing is byte-identical across rounds', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{}'])), () => sse(asks(['c2', 'echo', '{}'])), () => sse(reply('ok')))
    await sendUserMessage(convId, 'one', { reply: true, model: T })
    const raw = (i: number) => JSON.parse((f.mock.calls[i] as unknown as [string, RequestInit])[1].body as string) as { messages: unknown[]; tools: unknown }
    const head = (i: number) => JSON.stringify(raw(i).messages).slice(0, -1)
    expect(raw(0).messages).toHaveLength(2)
    expect(head(1).startsWith(head(0))).toBe(true)
    expect(head(2).startsWith(head(1))).toBe(true)
    expect(JSON.stringify(raw(2).tools)).toBe(JSON.stringify(raw(0).tools))
  })

  it('stops at 8 rounds and lets the model answer', async () => {
    let ran = 0
    setAbilitiesForTest([
      ability(async () => {
        ran++
        return 'x'
      }),
    ])
    let n = 0
    const f = vi.fn(async () => (++n <= MAX_ROUNDS ? sse(asks([`c${n}`, 'echo', '{}'])) : sse(reply('Answer'))))
    vi.stubGlobal('fetch', f)
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(MAX_ROUNDS).toBe(8)
    expect(f).toHaveBeenCalledTimes(9)
    expect(ran).toBe(7)
    const all = await steps()
    expect(all.map((p) => p.round)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(all[7].result).toBe('Round limit reached. Answer now.')
    expect(bodyOf(f as never, 8).messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c8', content: 'Round limit reached. Answer now.' })
    const v = await activeVersion()
    expect(v.status).toBe('done')
    expect(v.content.at(-1)).toEqual({ type: 'text', text: 'Answer' })
  })

  it('calls after the limit are stored as errors and the reply ends done', async () => {
    let n = 0
    const f = vi.fn(async () => sse(asks([`c${++n}`, 'echo', '{}'])))
    vi.stubGlobal('fetch', f)
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(f).toHaveBeenCalledTimes(9)
    expect((await steps()).at(-1)).toMatchObject({ callId: 'c9', round: 8, status: 'error', result: 'Round limit reached. Answer now.' })
    expect((await activeVersion()).status).toBe('done')
  })

  it('sends reasoning_details inside the loop', async () => {
    const think = (text: string) => ev({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text, signature: text }] } }] })
    const f = stubFetch(
      () => sse([think('one'), ...asks(['c1', 'echo', '{}'])]),
      () => sse([think('two'), ...asks(['c2', 'echo', '{}'])]),
      () => sse(reply('ok')),
      () => sse(reply('later')),
    )
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const first = { type: 'reasoning.text', index: 0, text: 'one', signature: 'one' }
    const second = { type: 'reasoning.text', index: 0, text: 'two', signature: 'two' }
    // The same index in two rounds never joins, or a signature breaks.
    expect(bodyOf(f, 2).messages.filter((m) => m.tool_calls).map((m) => m.reasoning_details)).toEqual([[first], [second]])
    const v = await activeVersion()
    expect(v.roundReasoning).toEqual([[first], [second]])
    expect(v.reasoning?.details).toEqual([first, second])
    expect(v.reasoning?.text).toBe('onetwo')
    // Once the reply is finished, it goes out with none.
    await sendUserMessage(convId, 'more', { reply: true, model: T })
    expect(bodyOf(f, 3).messages.some((m) => m.reasoning_details)).toBe(false)
  })

  it('Stop writes a stopped result for every open call, and the next request is valid', async () => {
    let ran = 0
    setAbilitiesForTest([ability(hangs(() => ran++))])
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{}'], ['c2', 'echo', '{}'])), () => sse(reply('next')))
    await sendUserMessage(convId, 'go', { reply: false })
    const p = generate(convId, { kind: 'new' }, T)
    await vi.waitFor(() => expect(ran).toBe(1))
    stop(convId)
    await p
    expect(ran).toBe(1)
    expect(f).toHaveBeenCalledTimes(1)
    expect(await steps()).toMatchObject([
      { callId: 'c1', status: 'stopped', result: 'Stopped by the user.' },
      { callId: 'c2', status: 'stopped', result: 'Stopped by the user.' },
    ])
    expect((await activeVersion()).status).toBe('stopped')
    await sendUserMessage(convId, 'never mind', { reply: true, model: T })
    const next = bodyOf(f, 1).messages
    expectValid(next)
    expect(next.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['Stopped by the user.', 'Stopped by the user.'])
  })

  it('adds usage across rounds without double counting', async () => {
    stubFetch(
      () =>
        sse([
          callPiece('c1', 'echo', '{}'),
          finish('tool_calls'),
          usageChunk(10, 5, 0.01),
          usageChunk(10, 5, 0.01), // a repeat replaces the one before it
          DONE,
        ]),
      () => sse([ev({ choices: [{ delta: { content: 'ok' } }] }), finish('stop'), usageChunk(20, 7, 0.02), DONE]),
    )
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const u = (await activeVersion()).usage!
    expect(u.promptTokens).toBe(30)
    expect(u.completionTokens).toBe(12)
    expect(u.cost).toBeCloseTo(0.03)
    const c = (await storage.getConversation(convId))!
    expect(c.totals.promptTokens).toBe(30)
    expect(c.totals.completionTokens).toBe(12)
    expect(c.totals.cost).toBeCloseTo(0.03)
  })

  it('only the first request of a run sets tokenRatio', async () => {
    await storage.updateConversation(convId, { capabilityNote: false })
    // A later round holds tool text that the estimate leaves out, so it would read as a high ratio.
    stubFetch(() => sse([callPiece('c1', 'echo', '{}'), finish('tool_calls'), usageChunk(150), DONE]), () => sse([finish('stop'), usageChunk(100000), DONE]))
    await sendUserMessage(convId, 'x'.repeat(400 - JSON.stringify(ability().tools).length), { reply: true, model: T }) // estimate 100 tokens
    expect((await storage.getConversation(convId))!.tokenRatio).toBeCloseTo(1.5)
  })

  it('updates lastRequest each round, with the tools hash', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{}'])), () => sse(reply('ok')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const c = (await storage.getConversation(convId))!
    const { prompt } = await systemFor(c, T)
    expect(c.lastRequest!.toolsHash).toBe(toolsFor(c, prompt, T)!.hash)
    const fp = fingerprint(bodyOf(f, 1).messages as never)
    expect(c.lastRequest!.prefixCount).toBe(fp.prefixCount)
    expect(c.lastRequest!.prefixHash).toBe(fp.prefixHash)
  })

  it('malformed arguments give the model an error result and the loop goes on', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{"x"'])), () => sse(reply('Sorry')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const [part] = await steps()
    expect(part.status).toBe('error')
    expect(part.args).toBe('{"x"')
    expect(part.result).toMatch(/^Error: the arguments for "echo" are not valid JSON/)
    const sent = bodyOf(f, 1).messages
    expect(sent.at(-2)!.tool_calls![0].function.arguments).toBe('{}')
    expect(sent.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: part.result })
    expect((await activeVersion()).status).toBe('done')
  })

  it('an unknown tool gives the model an error result and the loop goes on', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'nope', '{}'])), () => sse(reply('Sorry')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const [part] = await steps()
    expect(part.status).toBe('error')
    expect(part.result).toBe('Error: there is no tool called "nope". The tools you have are: echo.')
    expect(bodyOf(f, 1).messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: part.result })
    expect((await activeVersion()).status).toBe('done')
  })

  it('a tool that throws is a result too', async () => {
    setAbilitiesForTest([
      ability(async () => {
        throw new Error('boom')
      }),
    ])
    stubFetch(() => sse(asks(['c1', 'echo', '{}'])), () => sse(reply('Sorry')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect((await steps())[0]).toMatchObject({ status: 'error', result: 'Error: "echo" failed. boom' })
  })

  it('a call with no id, or an id used before, gets a new one', async () => {
    const f = stubFetch(() => sse(asks(['', 'echo', '{}'], ['same', 'echo', '{}'])), () => sse(asks(['same', 'echo', '{}'])), () => sse(reply('ok')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const ids = (await steps()).map((p) => p.callId)
    expect(ids.every((id) => id !== '')).toBe(true)
    expect(new Set(ids).size).toBe(3)
    expectValid(bodyOf(f, 2).messages)
  })

  it('an id used in an earlier reply gets a new one, so no request holds it twice', async () => {
    const f = stubFetch(
      () => sse(asks(['call_0', 'echo', '{}'])),
      () => sse(reply('one')),
      () => sse(asks(['call_0', 'echo', '{}'])),
      () => sse(reply('two')),
    )
    await sendUserMessage(convId, 'first', { reply: true, model: T })
    await sendUserMessage(convId, 'second', { reply: true, model: T })
    expect((await steps())[0].callId).not.toBe('call_0')
    expectValid(bodyOf(f, 3).messages)
    expect(bodyOf(f, 3).messages.filter((m) => m.tool_calls)).toHaveLength(2)
  })

  it('a fresh call with a reused id runs, and no lookup can skip it', async () => {
    let ran = 0
    const lookups: string[] = []
    setAbilitiesForTest([
      ability(async () => {
        ran++
        return 'ran now'
      }),
    ])
    setAlreadyDoneForTest(async (id) => {
      lookups.push(id)
      return 'old result'
    })
    stubFetch(
      () => sse(asks(['call_0', 'echo', '{}'])),
      () => sse(reply('one')),
      () => sse(asks(['call_0', 'echo', '{}'])),
      () => sse(reply('two')),
    )
    await sendUserMessage(convId, 'first', { reply: true, model: T })
    await sendUserMessage(convId, 'second', { reply: true, model: T })
    expect(ran).toBe(2)
    expect(lookups).toEqual([])
    expect((await steps())[0]).toMatchObject({ status: 'done', result: 'ran now' })
  })

  it('a finish of stop with calls still runs them', async () => {
    const f = stubFetch(() => sse([callPiece('c1', 'echo', '{}'), finish('stop')]), () => sse(reply('ok')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(f).toHaveBeenCalledTimes(2)
    expect((await steps())[0].status).toBe('done')
  })

  it('calls cut off by the length limit do not run', async () => {
    const f = stubFetch(() => sse([ev({ choices: [{ delta: { content: 'so far' } }] }), callPiece('c1', 'echo', '{"x'), finish('length')]))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(f).toHaveBeenCalledTimes(1)
    expect(await steps()).toEqual([])
    expect(await activeVersion()).toMatchObject({ status: 'done', finishReason: 'length' })
  })

  it('calls from a stream with no finish do not run, and the reply ends interrupted', async () => {
    let ran = 0
    setAbilitiesForTest([
      ability(async () => {
        ran++
        return 'x'
      }),
    ])
    stubFetch(() => sse([callPiece('c1', 'echo', '{"x"')]))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(ran).toBe(0)
    expect(await steps()).toEqual([])
    expect((await activeVersion()).status).toBe('interrupted')
  })

  it('a refusal with an empty reply is an error and stores no lastRequest', async () => {
    stubFetch(() => sse([finish('content_filter'), usageChunk(0, 0, 0), DONE]))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const v = await activeVersion()
    expect(v.status).toBe('error')
    expect(v.error).toBeTruthy()
    expect((await storage.getConversation(convId))!.lastRequest).toBeNull()
  })

  it('a filter finish after real text stays a finished reply', async () => {
    stubFetch(() => sse([ev({ choices: [{ delta: { content: 'part' } }] }), finish('content_filter')]))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(await activeVersion()).toMatchObject({ status: 'done', finishReason: 'content_filter' })
  })

  it('a network drop mid-loop ends interrupted, with Continue', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{}'])), dropped, () => sse(reply('Back')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const v = await activeVersion()
    expect(v.status).toBe('interrupted')
    expect(v.error).toBeUndefined()

    await generate(convId, { kind: 'continue', messageId: (await lastMsg()).id }, T)
    expect(f).toHaveBeenCalledTimes(3)
    expectValid(bodyOf(f, 2).messages)
    expect(bodyOf(f, 2).messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    const after = await activeVersion()
    expect(after.status).toBe('done')
    expect(after.content.map((p) => p.type)).toEqual(['tool', 'text'])
  })

  it('a model without tools sends no tools field', async () => {
    const f = stubFetch(() => sse(reply('ok')))
    await sendUserMessage(convId, 'go', { reply: true, model: A })
    expect(bodyOf(f, 0)).not.toHaveProperty('tools')
    expect(bodyOf(f, 0)).not.toHaveProperty('tool_choice')

    // A rule can take tools from a model that lists them.
    setModelRulesForTest([{ pattern: /^a\/tools/, rule: { noTools: true } }])
    await sendUserMessage(convId, 'again', { reply: true, model: T })
    expect(bodyOf(f, 1)).not.toHaveProperty('tools')
    setModelRulesForTest()

    // So does a plain chat.
    await storage.updateConversation(convId, { plain: true })
    await sendUserMessage(convId, 'plain', { reply: true, model: T })
    expect(bodyOf(f, 2)).not.toHaveProperty('tools')
  })

  it('with no abilities, a request is what it was before tools', async () => {
    setAbilitiesForTest([])
    const f = stubFetch(() => sse(reply('ok')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(Object.keys(bodyOf(f, 0)).sort()).toEqual(['messages', 'model', 'session_id', 'stream'])
    expect((await storage.getConversation(convId))!.lastRequest!.toolsHash).toBeNull()
  })

  it('old steps flatten for a model without tools', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{}'])), () => sse(reply('one')), () => sse(reply('two')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    await sendUserMessage(convId, 'next', { reply: true, model: A })
    const sent = bodyOf(f, 2)
    expect(sent).not.toHaveProperty('tools')
    expect(sent.messages.some((m) => m.role === 'tool' || m.tool_calls)).toBe(false)
    expect(JSON.stringify(sent.messages)).toContain('(Used echo.)')
  })

  it('counts the tools JSON toward the window', async () => {
    const huge = ability()
    huge.tools = [{ ...huge.tools[0], description: 'x'.repeat(4000) }]
    setAbilitiesForTest([huge])
    await storage.updateConversation(convId, { context: { mode: 'tokens', limit: 1000, trimTo: 0.5 } })
    const f = stubFetch(() => sse(reply('ok')))
    await storage.appendMessage(convId, 'user', doneVersion('old'))
    await storage.appendMessage(convId, 'assistant', doneVersion('old reply'))
    await sendUserMessage(convId, 'new', { reply: true, model: T })
    expect(texts(f, 0)).toEqual(['new'])
  })

  it('an in-flight request with reasoning, then the stored next turn, reads warm', async () => {
    const think = ev({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'hm' }] } }] })
    stubFetch(() => sse([think, ...asks(['c1', 'echo', '{"a":1}'])]), () => sse(reply('ok')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    await sendUserMessage(convId, 'next', { reply: false })
    expect(await coldNow(T)).toBe(false)
  })

  it('a change of tools reads cold', async () => {
    stubFetch(() => sse(reply('ok')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    await sendUserMessage(convId, 'next', { reply: false })
    expect(await coldNow(T)).toBe(false)
    setAbilitiesForTest([ability(undefined, 'other')])
    expect(await coldNow(T)).toBe(true)
  })
})

describe('tool loop: Continue', () => {
  beforeEach(() => setAbilitiesForTest([ability()]))

  /** A user turn and a reply cut off in this state. */
  async function cutOff(content: Version['content'], extra: Partial<Version> = {}) {
    await storage.appendMessage(convId, 'user', doneVersion('go'))
    return storage.appendMessage(convId, 'assistant', { id: newId(), content, status: 'interrupted', model: T.id, createdAt: 1, ...extra })
  }

  it('Continue after a lock does not run a finished write twice', async () => {
    const ran: string[] = []
    setAbilitiesForTest([
      ability(async (_n, _a, ctx) => {
        ran.push(ctx.callId)
        return 'ran now'
      }),
    ])
    const lookups: [string, string][] = []
    setAlreadyDoneForTest(async (id, messageId) => {
      lookups.push([id, messageId])
      return id === 'written' ? 'stored result' : null
    })
    const f = stubFetch(() => sse(reply('Finished')))
    const m = await cutOff([open('written', 0), open('lost', 0), step('closed', 0)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(ran).toEqual(['lost'])
    // Only open parts are looked up, each with its message.
    expect(lookups).toEqual([
      ['written', m.id],
      ['lost', m.id],
    ])
    expect(await steps()).toMatchObject([
      { callId: 'written', status: 'done', result: 'stored result' },
      { callId: 'lost', status: 'done', result: 'ran now' },
      { callId: 'closed', status: 'done', result: 'old result' },
    ])
    expect(bodyOf(f, 0).messages.filter((x) => x.role === 'tool').map((x) => x.content)).toEqual(['stored result', 'ran now', 'old result'])
    const v = await activeVersion()
    expect(v.status).toBe('done')
    expect(v.content.at(-1)).toEqual({ type: 'text', text: 'Finished' })
    // The old version stays as it was.
    const after = await lastMsg()
    expect(after.versions).toHaveLength(2)
    expect(after.versions[0].status).toBe('interrupted')
  })

  it('a failed lookup is a readable result, the call does not run, and the loop goes on', async () => {
    const ran: string[] = []
    setAbilitiesForTest([
      ability(async (_n, _a, ctx) => {
        ran.push(ctx.callId)
        return 'ran now'
      }),
    ])
    setAlreadyDoneForTest(async (id) => {
      if (id === 'c1') throw new Error('database gone')
      return null
    })
    const f = stubFetch(() => sse(reply('Finished')))
    const m = await cutOff([open('c1', 0), open('c2', 0)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    // A write could run twice, so the call that could not be checked stays unrun.
    expect(ran).toEqual(['c2'])
    const [failed, next] = await steps()
    expect(failed.status).toBe('error')
    expect(failed.result).toMatch(/^Error: /)
    expect(next).toMatchObject({ status: 'done', result: 'ran now' })
    expect(bodyOf(f, 0).messages.find((x) => x.tool_call_id === 'c1')?.content).toBe(failed.result)
    expect((await activeVersion()).status).toBe('done')
  })

  it('Stop during the lookup does not start the tool', async () => {
    let ran = 0
    setAbilitiesForTest([
      ability(async () => {
        ran++
        return 'ran now'
      }),
    ])
    setAlreadyDoneForTest(async () => {
      stop(convId)
      return null
    })
    const f = stubFetch(() => sse(reply('no')))
    const m = await cutOff([open('c1', 0)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(ran).toBe(0)
    expect(f).not.toHaveBeenCalled()
    expect((await steps())[0]).toMatchObject({ status: 'stopped', result: 'Stopped by the user.' })
    expect((await activeVersion()).status).toBe('stopped')
  })

  it('Stop during the lookup keeps a result that was found', async () => {
    setAlreadyDoneForTest(async () => {
      stop(convId)
      return 'stored result'
    })
    stubFetch(() => sse(reply('no')))
    const m = await cutOff([open('c1', 0)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect((await steps())[0]).toMatchObject({ status: 'done', result: 'stored result' })
    expect((await activeVersion()).status).toBe('stopped')
  })

  /** A tool that writes one chat-shelf note, like `notes_write`. */
  const writes = (onWrite?: () => void) =>
    ability(async (_n, _a, ctx) => {
      await notes.write(
        { path: 'chat/todo', conversationId: ctx.conversationId },
        { body: `from ${ctx.callId}`, description: 'A line', isNew: true },
        { writer: ctx.model, messageId: ctx.messageId, callId: ctx.callId },
      )
      onWrite?.()
      return 'written now'
    })
  const todo = () => ({ path: 'chat/todo', conversationId: convId })

  it('the real lookup finds a write from its revision, with path and version', async () => {
    setAbilitiesForTest([writes()])
    const m = await cutOff([open('c1', 0)])
    await notes.write(
      { path: 'shared/lists/insects', conversationId: convId },
      { body: 'moth', description: 'A line' },
      { writer: T.id, messageId: m.id, callId: 'c1' },
    )
    const f = stubFetch(() => sse(reply('Finished')))
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    const [part] = await steps()
    expect(part.status).toBe('done')
    expect(part.result).toContain('shared/lists/insects')
    expect(part.result).toContain('version 1')
    expect(bodyOf(f, 0).messages.find((x) => x.tool_call_id === 'c1')?.content).toBe(part.result)
    expect(await notes.read(todo())).toBeUndefined()
  })

  it('the real lookup ignores the same id on another message', async () => {
    setAbilitiesForTest([writes()])
    await notes.write(
      { path: 'shared/old', conversationId: convId },
      { body: 'x', description: 'A line' },
      { writer: T.id, messageId: 'other', callId: 'c1' },
    )
    stubFetch(() => sse(reply('Finished')))
    const m = await cutOff([open('c1', 0)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect((await steps())[0]).toMatchObject({ status: 'done', result: 'written now' })
    expect(await notes.byCall('c1', m.id)).toBeDefined()
  })

  it('an open part on a reroll is not taken for a write of an older version', async () => {
    setAbilitiesForTest([writes()])
    stubFetch(
      () => sse(asks(['call_0', 'echo', '{}'])),
      () => sse(reply('one')),
      () => sse(asks(['call_0', 'echo', '{}'])),
      () => sse(reply('two')),
    )
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const m = await lastMsg()
    expect(await notes.byCall('call_0', m.id)).toBeDefined()
    await notes.remove(todo(), YOU)

    // The model reuses the id on the reroll. The new part must not share it.
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    const [part] = await steps()
    expect(part.callId).not.toBe('call_0')
    expect(await notes.read(todo())).toBeDefined()

    // Now say the phone locked before that write landed: Continue must run it.
    const row = await notes.byCall(part.callId, m.id)
    await db.noteRevisions.delete(row!.id)
    await notes.remove(todo(), YOU)
    await storage.mutateMessage(m.id, (x) => ({
      ...x,
      versions: x.versions.map((v, i) =>
        i === x.activeVersion ? { ...v, status: 'interrupted' as const, content: [{ ...part, status: 'running' as const, result: '' }] } : v,
      ),
    }))
    stubFetch(() => sse(reply('Finished')))
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect((await steps())[0]).toMatchObject({ callId: part.callId, status: 'done', result: 'written now' })
    expect(await notes.byCall(part.callId, m.id)).toBeDefined()
  })

  it('a reroll does not take the id of an open part on an older version', async () => {
    const ran: string[] = []
    setAbilitiesForTest([
      ability(async (_n, _a, ctx) => {
        ran.push(ctx.callId)
        await notes.write(
          { path: `chat/run-${ran.length}`, conversationId: ctx.conversationId },
          { body: 'text', description: 'A line' },
          { writer: ctx.model, messageId: ctx.messageId, callId: ctx.callId },
        )
        return 'written now'
      }),
    ])
    const m = await cutOff([open('call_0', 0)])
    stubFetch(() => sse(asks(['call_0', 'echo', '{}'])), () => sse(reply('two')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect((await steps())[0].callId).not.toBe('call_0')

    // Flip back to the first version and Continue: its open call still has to run.
    await storage.mutateMessage(m.id, (x) => ({ ...x, activeVersion: 0 }))
    stubFetch(() => sse(reply('Finished')))
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(ran).toHaveLength(2)
    expect(ran[1]).toBe('call_0')
    expect((await steps())[0]).toMatchObject({ callId: 'call_0', status: 'done', result: 'written now' })
  })

  it('a reroll does not take the id of a write from a deleted version', async () => {
    setAbilitiesForTest([writes()])
    stubFetch(() => sse(asks(['call_0', 'echo', '{}'])), () => sse(reply('one')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    const m = await lastMsg()
    await storage.mutateMessage(m.id, (x) => ({ ...x, versions: x.versions.map((v) => ({ ...v, content: [] })) }))
    await notes.remove(todo(), YOU)
    stubFetch(() => sse(asks(['call_0', 'echo', '{}'])), () => sse(reply('two')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect((await steps())[0].callId).not.toBe('call_0')
  })

  it('a write that lands just before Stop does not read as stopped', async () => {
    setAbilitiesForTest([writes(() => stop(convId))])
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{}'])), () => sse(reply('no')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect(f).toHaveBeenCalledTimes(1)
    const [part] = await steps()
    expect(part.status).toBe('done')
    expect(part.result).toContain('chat/todo')
    expect((await activeVersion()).status).toBe('stopped')
  })

  /** An old version with an open call whose write landed, and a reroll that undid that write. */
  async function undoneOpenCall() {
    const m = await cutOff([open('c1', 0)])
    await notes.write(todo(), { body: 'first', description: 'A line' }, { writer: T.id, messageId: m.id, callId: 'c1' })
    stubFetch(() => sse(reply('New')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect(await notes.read(todo())).toBeUndefined()
    await storage.mutateMessage(m.id, (x) => ({ ...x, activeVersion: 0 }))
    return m
  }

  it('an undone write counts as not done, so the call runs again on Continue', async () => {
    setAbilitiesForTest([writes()])
    const m = await undoneOpenCall()
    stubFetch(() => sse(reply('Finished')))
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    const [part] = await steps()
    expect(part).toMatchObject({ callId: 'c1', status: 'done', result: 'written now', undone: false })
    expect((await notes.read(todo()))?.body).toBe('from c1')
    // The older copy of the step must not say undone about a write that now stands.
    const [first] = (await lastMsg()).versions
    expect(first.content[0]).toMatchObject({ callId: 'c1', undone: false })
  })

  it('Stop does not call an undone write done', async () => {
    setAbilitiesForTest([writes()])
    const m = await undoneOpenCall()
    vi.stubGlobal('fetch', () => {
      throw new Error('no request')
    })
    const p = generate(convId, { kind: 'continue', messageId: m.id }, T)
    stop(convId)
    await p
    expect((await steps())[0]).toMatchObject({ status: 'stopped', result: 'Stopped by the user.' })
  })

  it('a call that Stop cut before its write stays stopped', async () => {
    setAbilitiesForTest([
      ability(async () => {
        stop(convId)
        return 'no write'
      }),
    ])
    stubFetch(() => sse(asks(['c1', 'echo', '{}'])))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    expect((await steps())[0]).toMatchObject({ status: 'stopped', result: 'Stopped by the user.' })
  })

  it('Stop before a Continue starts keeps a write that had landed', async () => {
    setAbilitiesForTest([writes()])
    const m = await cutOff([open('c1', 0), open('c2', 0)])
    await notes.write(
      { path: 'shared/a', conversationId: convId },
      { body: 'x', description: 'A line' },
      { writer: T.id, messageId: m.id, callId: 'c1' },
    )
    const f = stubFetch(() => sse(reply('no')))
    const p = generate(convId, { kind: 'continue', messageId: m.id }, T)
    stop(convId)
    await p
    expect(f).not.toHaveBeenCalled()
    expect(await steps()).toMatchObject([
      { callId: 'c1', status: 'done' },
      { callId: 'c2', status: 'stopped', result: 'Stopped by the user.' },
    ])
  })

  it('a failed lookup at Stop is a readable result, not a stopped one', async () => {
    setAlreadyDoneForTest(async () => {
      stop(convId)
      throw new Error('database gone')
    })
    stubFetch(() => sse(reply('no')))
    const m = await cutOff([open('c1', 0)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    const [part] = await steps()
    expect(part.status).toBe('error')
    expect(part.result).toMatch(/^Error: /)
  })

  it('a new call cannot take an id from the reply it continues', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{}'])), () => sse(reply('ok')))
    const m = await cutOff([step('c1', 0)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect((await steps()).map((p) => p.callId)[1]).not.toBe('c1')
    expectValid(bodyOf(f, 1).messages)
  })

  it('sends each call once', async () => {
    const f = stubFetch(() => sse(reply('Back')))
    const m = await cutOff([step('c1', 0), step('c2', 1)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    const sent = bodyOf(f, 0).messages
    expectValid(sent)
    expect(sent.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool'])
  })

  it('resumes at the round after the last one, so two rounds never fold into one message', async () => {
    const f = stubFetch(() => sse(asks(['c3', 'echo', '{}'])), () => sse(reply('ok')))
    const m = await cutOff([step('c1', 0), step('c2', 1)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect((await steps()).map((p) => p.round)).toEqual([0, 1, 2])
    expect(bodyOf(f, 1).messages.filter((x) => x.tool_calls).map((x) => x.tool_calls!.map((c) => c.id))).toEqual([['c1'], ['c2'], ['c3']])
  })

  it('counts the rounds of the old version toward the limit', async () => {
    const f = stubFetch(() => sse(asks(['late', 'echo', '{}'])))
    const m = await cutOff([step('c1', MAX_ROUNDS - 1)])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(f).toHaveBeenCalledTimes(1)
    expect((await steps()).at(-1)).toMatchObject({ callId: 'late', status: 'error' })
    expect((await activeVersion()).status).toBe('done')
  })

  it('keeps the reasoning of old rounds, in the request and on the new version', async () => {
    const details = [{ type: 'reasoning.text', index: 0, text: 'hm', signature: 's' }]
    const f = stubFetch(() => sse(reply('Back')))
    const m = await cutOff([step('c1', 0)], { roundReasoning: [details] })
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(bodyOf(f, 0).messages.find((x) => x.tool_calls)!.reasoning_details).toEqual(details)
    expect((await activeVersion()).roundReasoning).toEqual([details])
  })

  it('after an edit the reasoning of old rounds is gone, and the request stays valid', async () => {
    const f = stubFetch(() => sse(reply('Back')))
    const m = await cutOff([step('c1', 0), { type: 'text', text: 'edited' }])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    const sent = bodyOf(f, 0).messages
    expectValid(sent)
    expect(sent.some((x) => x.reasoning_details)).toBe(false)
  })

  it('a partial text after the steps goes out as a prefill, and the new text joins it', async () => {
    const f = stubFetch(() => sse(reply(' more')))
    const m = await cutOff([step('c1', 0), { type: 'text', text: 'partial' }])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(bodyOf(f, 0).messages.at(-1)).toEqual({ role: 'assistant', content: 'partial' })
    expect((await activeVersion()).content.at(-1)).toEqual({ type: 'text', text: 'partial more' })
  })

  it('Stop while finishing open calls closes them', async () => {
    let ran = 0
    setAbilitiesForTest([ability(hangs(() => ran++))])
    const f = stubFetch(() => sse(reply('no')))
    const m = await cutOff([open('c1', 0), open('c2', 0)])
    const p = generate(convId, { kind: 'continue', messageId: m.id }, T)
    await vi.waitFor(() => expect(ran).toBe(1))
    stop(convId)
    await p
    expect(f).not.toHaveBeenCalled()
    expect((await steps()).map((s) => s.status)).toEqual(['stopped', 'stopped'])
    expect((await activeVersion()).status).toBe('stopped')
  })

  it('another model sees the old steps as text, and they keep their model', async () => {
    const f = stubFetch(() => sse(reply('Back')))
    const m = await cutOff([step('c1', 0)])
    await generate(convId, { kind: 'continue', messageId: m.id }, model('o/other', { tools: true }))
    const sent = bodyOf(f, 0)
    expect(sent.messages.some((x) => x.role === 'tool')).toBe(false)
    expect(sent.messages.at(-1)).toEqual({ role: 'assistant', content: '(Used echo.)' })
    expect((await steps())[0].model).toBe(T.id)
  })

  it('a text reply continues as it did, merged into the reply before it', async () => {
    const f = stubFetch(() => sse(reply(' more')))
    await storage.appendMessage(convId, 'user', doneVersion('go'))
    await storage.appendMessage(convId, 'assistant', doneVersion('first'))
    const m = await storage.appendMessage(convId, 'assistant', doneVersion('second'))
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(bodyOf(f, 0).messages.at(-1)).toEqual({ role: 'assistant', content: 'first\n\nsecond' })
    expect((await activeVersion()).content).toEqual([{ type: 'text', text: 'second more' }])
  })

  it('a text reply that continues into a tool call sends the reply once', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'echo', '{}'])), () => sse(reply('ok')))
    await storage.appendMessage(convId, 'user', doneVersion('go'))
    const m = await storage.appendMessage(convId, 'assistant', doneVersion('Once'))
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    const sent = bodyOf(f, 1).messages
    expect(sent.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(sent[2].content).toBe('Once')
  })

  it('a reply with nothing before it still follows a user turn', async () => {
    const f = stubFetch(() => sse(reply('Back')))
    const m = await storage.appendMessage(convId, 'assistant', { id: newId(), content: [step('c1', 0)], status: 'interrupted', model: T.id, createdAt: 1 })
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(bodyOf(f, 0).messages.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool'])
  })
})

describe('rerolls, deletes and edits', () => {
  const ref = (path: string) => ({ path, conversationId: convId })
  const noteArgs = (path: string) => JSON.stringify({ path, description: 'The harbour', body: 'Boats' })
  const answer = (id: string, ...paths: string[]) => asks(...paths.map((p, i): [string, string, string] => [`${id}${i}`, 'notes_write', noteArgs(p)]))
  const rejected = () => new Response('{"error":{"message":"busy"}}', { status: 429 })
  const stepsOf = (v: Version) => v.content.filter((p): p is ToolPart => p.type === 'tool')
  /** The steps of the first version of the last message. */
  const firstSteps = async () => stepsOf((await lastMsg()).versions[0])

  /** A finished reply that wrote these paths, with call ids w0, w1… */
  async function written(...paths: string[]) {
    stubFetch(() => sse(answer('w', ...paths)), () => sse(reply('Done')))
    await sendUserMessage(convId, 'go', { reply: true, model: T })
    return lastMsg()
  }

  /** Requests hang until Stop. */
  function hangingFetch() {
    vi.stubGlobal(
      'fetch',
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
    )
  }

  it('a reroll undoes chat-shelf writes before the request goes out', async () => {
    const m = await written('chat/harbour')
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
    let atRequest: unknown = 'not asked'
    const f = vi.fn(async () => {
      atRequest = await notes.read(ref('chat/harbour'))
      return sse(reply('New'))
    })
    vi.stubGlobal('fetch', f)
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect(atRequest).toBeUndefined()
    // The index in the system text was rebuilt after the undo.
    expect(JSON.stringify(bodyOf(f as never, 0).messages)).not.toContain('harbour')
    expect(await firstSteps()).toMatchObject([{ callId: 'w0', undone: true }])
    expect((await activeVersion()).content).toEqual([{ type: 'text', text: 'New' }])
  })

  it('a reroll keeps shared-shelf writes', async () => {
    const m = await written('shared/harbour', 'chat/tide')
    stubFetch(() => sse(reply('New')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect(await notes.read(ref('shared/harbour'))).toBeDefined()
    expect(await notes.read(ref('chat/tide'))).toBeUndefined()
    const [shared, chat] = await firstSteps()
    expect(shared.undone).toBeUndefined()
    expect(chat.undone).toBe(true)
  })

  it('a failed reroll puts the writes back', async () => {
    const m = await written('chat/harbour')
    stubFetch(rejected)
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect((await activeVersion()).status).toBe('error')
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
    expect((await firstSteps())[0].undone).toBe(false)
  })

  it('a reroll stopped with no output puts the writes back', async () => {
    const m = await written('chat/harbour')
    hangingFetch()
    const p = generate(convId, { kind: 'reroll', messageId: m.id }, T)
    await vi.waitFor(async () => expect((await lastMsg()).versions).toHaveLength(2))
    stop(convId)
    await p
    expect((await activeVersion()).status).toBe('stopped')
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
  })

  it('a reroll stopped with output keeps the undo', async () => {
    const m = await written('chat/harbour')
    vi.stubGlobal('fetch', async () => {
      let sent = false
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (!sent) {
              sent = true
              c.enqueue(enc.encode(ev({ choices: [{ delta: { content: 'part' } }] })))
              return
            }
            stop(convId)
            throw new DOMException('aborted', 'AbortError')
          },
        }),
        { status: 200 },
      )
    })
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect((await activeVersion()).status).toBe('stopped')
    expect(await notes.read(ref('chat/harbour'))).toBeUndefined()
  })

  it('Retry after a failed reroll undoes the writes that came back', async () => {
    const m = await written('chat/harbour')
    stubFetch(rejected)
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    stubFetch(() => sse(reply('New')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect(await notes.read(ref('chat/harbour'))).toBeUndefined()
    expect((await firstSteps())[0].undone).toBe(true)
  })

  it('a failed reroll puts back only what it undid', async () => {
    const m = await written('chat/harbour')
    const rev = await notes.byCall('w0', m.id)
    await notes.revert(rev!.id, YOU)
    await setToolUndone(m.id, 'w0', true)
    stubFetch(rejected)
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect(await notes.read(ref('chat/harbour'))).toBeUndefined()
    expect((await firstSteps())[0].undone).toBe(true)
  })

  it('a failed reroll does not bring back a version deleted meanwhile', async () => {
    const m = await written('chat/harbour')
    hangingFetch()
    const p = generate(convId, { kind: 'reroll', messageId: m.id }, T)
    await vi.waitFor(async () => expect((await lastMsg()).versions).toHaveLength(2))
    await storage.mutateMessage(m.id, (x) => withActive(x, 0))
    await deleteVersion(m.id)
    stop(convId)
    await p
    expect(await notes.read(ref('chat/harbour'))).toBeUndefined()
  })

  it('a note changed later stays, and the part says so', async () => {
    const m = await written('chat/harbour')
    await notes.write(ref('chat/harbour'), { body: 'Mine now', description: 'The harbour', expectedVersion: 1 }, YOU)
    stubFetch(() => sse(reply('New')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect((await notes.read(ref('chat/harbour')))?.body).toBe('Mine now')
    expect(await firstSteps()).toMatchObject([{ callId: 'w0', kept: true }])
    expect((await firstSteps())[0].undone).toBeUndefined()
  })

  it('a failed reroll takes the kept mark away again', async () => {
    const m = await written('chat/harbour')
    await notes.write(ref('chat/harbour'), { body: 'Mine now', description: 'The harbour', expectedVersion: 1 }, YOU)
    stubFetch(rejected)
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect((await firstSteps())[0].kept).toBe(false)
  })

  it('undoReplyWrites reports the calls and marks each version that holds them', async () => {
    const m = await written('chat/harbour', 'shared/tide')
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'Edited')))
    expect(await undoReplyWrites(m.id, [m.versions[0]])).toEqual({ undone: ['w0'], kept: [] })
    const after = await lastMsg()
    expect(after.versions.map((v) => stepsOf(v)[0].undone)).toEqual([true, true])
  })

  it('deleting a message undoes its writes; toast Undo restores them', async () => {
    const m = await written('chat/harbour', 'shared/tide')
    const snapshot = await deleteMessage(m.id)
    expect((await storage.listMessages(convId)).some((x) => x.id === m.id)).toBe(false)
    expect(await notes.read(ref('chat/harbour'))).toBeUndefined()
    expect(await notes.read(ref('shared/tide'))).toBeDefined()

    await restoreMessage(snapshot!)
    expect((await lastMsg()).id).toBe(m.id)
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
    expect((await firstSteps())[0].undone).toBe(false)
  })

  it('a delete of a message that is gone does nothing', async () => {
    expect(await deleteMessage('nope')).toBeNull()
  })

  it('Undo leaves a write undone when the note changed in between', async () => {
    const m = await written('chat/harbour')
    const snapshot = await deleteMessage(m.id)
    await notes.write(ref('chat/harbour'), { body: 'A new one', description: 'The harbour', isNew: true }, YOU)
    await restoreMessage(snapshot!)
    expect((await firstSteps())[0].undone).toBe(true)
    expect((await notes.read(ref('chat/harbour')))?.body).toBe('A new one')
  })

  it('deleting a message mid-stream waits, so a late write does not stay', async () => {
    let started = false
    setAbilitiesForTest([
      ability(async (_n, _a, ctx) => {
        started = true
        await new Promise((res) => ctx.signal.addEventListener('abort', res))
        await notes.write(ref('chat/late'), { body: 'x', description: 'A line' }, { writer: ctx.model, messageId: ctx.messageId, callId: ctx.callId })
        return 'written now'
      }),
    ])
    stubFetch(() => sse(asks(['c1', 'echo', '{}'])))
    await sendUserMessage(convId, 'go', { reply: false })
    const p = generate(convId, { kind: 'new' }, T)
    await vi.waitFor(() => expect(started).toBe(true))
    const m = await lastMsg()
    await deleteMessage(m.id)
    await p
    expect(isGenerating(convId)).toBe(false)
    expect(await notes.read(ref('chat/late'))).toBeUndefined()
  })

  it('a chat brought back after a delete does not run a stopped call on Continue', async () => {
    const ran: string[] = []
    let started = false
    setAbilitiesForTest([
      ability(async (...args) => {
        ran.push(args[2].callId)
        return hangs(() => (started = true))(...args)
      }),
    ])
    stubFetch(() => sse(asks(['c1', 'echo', '{}'])), () => sse(reply('Finished')))
    await sendUserMessage(convId, 'go', { reply: false })
    const p = generate(convId, { kind: 'new' }, T)
    await vi.waitFor(() => expect(started).toBe(true))
    const snapshot = await deleteChat(convId)
    await p
    await restoreChat(snapshot!)
    expect(await steps()).toMatchObject([{ callId: 'c1', status: 'stopped', result: 'Stopped by the user.' }])
    await generate(convId, { kind: 'continue', messageId: (await lastMsg()).id }, T)
    expect(ran).toEqual(['c1'])
  })

  it('deleting one version undoes only that version', async () => {
    const m = await written('chat/one')
    stubFetch(() => sse(answer('x', 'chat/two')), () => sse(reply('New')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    await notes.redoCalls(['w0'], m.id)
    await setToolUndone(m.id, 'w0', false)
    expect(await notes.read(ref('chat/one'))).toBeDefined()

    const snapshot = await deleteVersion(m.id)
    expect((await lastMsg()).versions).toHaveLength(1)
    expect(await notes.read(ref('chat/two'))).toBeUndefined()
    expect(await notes.read(ref('chat/one'))).toBeDefined()

    await restoreVersion(snapshot!)
    const after = await lastMsg()
    expect(after.versions).toHaveLength(2)
    expect(after.activeVersion).toBe(1)
    expect(await notes.read(ref('chat/two'))).toBeDefined()
    expect((await steps())[0].undone).toBe(false)
  })

  it('deleting a version keeps a write that another version holds', async () => {
    const m = await written('chat/harbour')
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'Edited')))
    await deleteVersion(m.id)
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
    expect((await firstSteps())[0].undone).toBeUndefined()
  })

  it('deleting the only version does nothing', async () => {
    const m = await written('chat/harbour')
    expect(await deleteVersion(m.id)).toBeNull()
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
  })

  it('Edit leaves ToolParts and revisions alone', async () => {
    const m = await written('chat/harbour')
    const note = await notes.read(ref('chat/harbour'))
    const before = await notes.revisions(note!.id)
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'Edited')))
    const after = await lastMsg()
    expect(stepsOf(after.versions[1])).toEqual(stepsOf(after.versions[0]))
    expect(await notes.revisions(note!.id)).toEqual(before)
    expect(await notes.read(ref('chat/harbour'))).toEqual(note)
  })

  it('a reroll of an edited reply undoes the writes it kept', async () => {
    const m = await written('chat/harbour')
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'Edited')))
    stubFetch(() => sse(reply('New')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect(await notes.read(ref('chat/harbour'))).toBeUndefined()
    expect((await firstSteps())[0].undone).toBe(true)
  })

  it('flipping to an old version shows its writes as undone', async () => {
    const m = await written('chat/harbour')
    stubFetch(() => sse(reply('New')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    await storage.mutateMessage(m.id, (x) => withActive(x, 0))
    expect(await steps()).toMatchObject([{ callId: 'w0', undone: true }])
    // A flip alone redoes nothing. A tap on the line does.
    expect(await notes.read(ref('chat/harbour'))).toBeUndefined()
    expect(await notes.redoCalls(['w0'], m.id)).toEqual({ redone: ['w0'], kept: [] })
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
  })

  it('a tap marks each version that holds the call, on a Continue copy too', async () => {
    const m = await written('chat/harbour')
    stubFetch(() => sse(reply('More')))
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    await setToolUndone(m.id, 'w0', true)
    const after = await lastMsg()
    expect(after.versions).toHaveLength(2)
    expect(after.versions.map((v) => stepsOf(v)[0].undone)).toEqual([true, true])
    await setToolUndone(m.id, 'w0', false)
    expect((await lastMsg()).versions.map((v) => stepsOf(v)[0].undone)).toEqual([false, false])
  })

  it('a Continue from an empty try undoes the writes, as a reroll does', async () => {
    const m = await written('chat/harbour')
    stubFetch(rejected)
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()

    let atRequest: unknown = 'not asked'
    vi.stubGlobal('fetch', async () => {
      atRequest = await notes.read(ref('chat/harbour'))
      return sse(reply('New'))
    })
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(atRequest).toBeUndefined()
    expect(await notes.read(ref('chat/harbour'))).toBeUndefined()
    expect((await firstSteps())[0].undone).toBe(true)
  })

  it('a Continue from an empty try that gives no output puts the writes back', async () => {
    const m = await written('chat/harbour')
    stubFetch(rejected)
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
    expect((await firstSteps())[0].undone).toBe(false)
  })

  it('a Continue from a version with output keeps its writes', async () => {
    const m = await written('chat/harbour')
    stubFetch(() => sse(reply('More')))
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
    expect((await firstSteps())[0].undone).toBeUndefined()
  })

  it('an Edit that fills an empty try leaves the writes alone', async () => {
    const m = await written('chat/harbour')
    stubFetch(rejected)
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[x.activeVersion], 'Typed')))
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
    expect((await firstSteps())[0].undone).toBe(false)
  })

  it('a version toast Undo takes the flags of a held call from its sibling', async () => {
    const m = await written('chat/harbour')
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'Edited')))
    const snapshot = await deleteVersion(m.id)
    const rev = await notes.byCall('w0', m.id)
    await notes.revert(rev!.id, YOU)
    await setToolUndone(m.id, 'w0', true)

    await restoreVersion(snapshot!)
    const after = await lastMsg()
    expect(after.versions.map((v) => stepsOf(v)[0].undone)).toEqual([true, true])
  })

  it('a throw after the undo puts the writes back', async () => {
    const m = await written('chat/harbour')
    const list = vi.spyOn(notes, 'list').mockRejectedValueOnce(new Error('database gone'))
    await expect(generate(convId, { kind: 'reroll', messageId: m.id }, T)).rejects.toThrow('database gone')
    list.mockRestore()
    expect(await notes.read(ref('chat/harbour'))).toBeDefined()
    expect((await firstSteps())[0].undone).toBe(false)
    expect(isGenerating(convId)).toBe(false)
  })

  it('a warm reroll rebuilds the index, so it lists no note it undid', async () => {
    const m = await written('chat/harbour')
    await storage.updateConversation(convId, { notesIndex: 'Notes: chat/harbour' })
    const c = (await storage.getConversation(convId))!
    const { system, prompt } = await systemFor(c, T)
    const toolsHash = toolsFor(c, prompt, T)?.hash ?? null
    const sent = [{ role: 'system' as const, content: system! }, { role: 'user' as const, content: 'go' }]
    const lastRequest = { model: T.id, provider: null, toolsHash, ...fingerprint(sent), at: Date.now() }
    await storage.updateConversation(convId, { lastRequest })
    const cut = (await storage.listMessages(convId)).filter((x) => x.order < m.order)
    expect(computeCold({ lastRequest, messages: cut, system, windowStartId: null, model: T, toolsHash, anthropicCacheHour: false, now: Date.now() })).toBe(false)

    const f = stubFetch(() => sse(reply('New')))
    await generate(convId, { kind: 'reroll', messageId: m.id }, T)
    expect(JSON.stringify(bodyOf(f, 0).messages)).not.toContain('chat/harbour')
  })

  it("a Continue that changes model keeps each part's own model", async () => {
    const m = await written('chat/harbour')
    const U = model('u/tools', { tools: true })
    stubFetch(() => sse(answer('y', 'chat/tide')), () => sse(reply('More')))
    await generate(convId, { kind: 'continue', messageId: m.id }, U)
    const after = await lastMsg()
    expect(after.versions[after.activeVersion].model).toBe(U.id)
    expect(await steps()).toMatchObject([
      { callId: 'w0', model: T.id },
      { callId: 'y0', model: U.id },
    ])
  })
})

describe('setPrompt', () => {
  it('setPrompt appends a divider only when the chat has messages and the ref changed', async () => {
    const p = await storage.savePrompt({ name: 'Chef', parentId: null, text: 'Cook.' })
    await setPrompt(convId, p.id)
    expect((await storage.getConversation(convId))!.systemPromptRef).toBe(p.id)
    expect(await storage.listMessages(convId)).toHaveLength(0) // empty chat: no divider

    await sendUserMessage(convId, 'hi', { reply: false })
    await setPrompt(convId, p.id) // same ref: no divider
    expect(await storage.listMessages(convId)).toHaveLength(1)

    await setPrompt(convId, null)
    const msgs = await storage.listMessages(convId)
    expect(msgs).toHaveLength(2)
    const d = msgs[1]
    expect(d.role).toBe('divider')
    expect(d.dividerLabel).toBe('→ No prompt')
    expect(d.versions).toHaveLength(1)
    expect(d.versions[0].content).toEqual([])
    expect(d.versions[0].status).toBe('done')
    expect((await storage.getConversation(convId))!.systemPromptRef).toBeNull()

    await setPrompt(convId, p.id)
    expect((await storage.listMessages(convId)).at(-1)!.dividerLabel).toBe('→ Chef')

    // A ref to a deleted prompt reads as "No prompt".
    await setPrompt(convId, 'gone')
    expect((await storage.listMessages(convId)).at(-1)!.dividerLabel).toBe('→ No prompt')
  })
})

describe('replacePromptRef', () => {
  it('swaps the ref only while it still holds the expected value, without a divider', async () => {
    await sendUserMessage(convId, 'hi', { reply: false })
    await storage.updateConversation(convId, { systemPromptRef: 'p1' })

    expect(await replacePromptRef(convId, 'p1', null)).toBe(true)
    expect((await storage.getConversation(convId))!.systemPromptRef).toBeNull()
    expect(await storage.listMessages(convId)).toHaveLength(1) // no divider

    // The chat moved on to another prompt meanwhile: an undo must not pull it back.
    await storage.updateConversation(convId, { systemPromptRef: 'p2' })
    expect(await replacePromptRef(convId, null, 'p1')).toBe(false)
    expect((await storage.getConversation(convId))!.systemPromptRef).toBe('p2')
  })
})

/** The tool names in request `i`. */
const toolNames = (f: ReturnType<typeof stubFetch>, i: number) =>
  ((bodyOf(f, i).tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name)

describe('abilities in settings', () => {
  const go = (text: string) => sendUserMessage(convId, text, { reply: true, model: T })

  beforeEach(() => setAbilitiesForTest([ability(undefined, 'one'), ability(undefined, 'two')]))

  it('a switch changes the tool list and the next request reads cold', async () => {
    const f = stubFetch(() => sse(reply('ok')))
    await go('first')
    expect(toolNames(f, 0)).toEqual(['one', 'two'])
    expect(await coldNow(T)).toBe(false)

    await setAbility(convId, 'one', false)
    expect((await storage.getConversation(convId))!.abilities).toEqual({ one: false })
    expect(await coldNow(T)).toBe(true)

    await go('second')
    expect(toolNames(f, 1)).toEqual(['two'])
    expect(await coldNow(T)).toBe(false)
  })

  it('a chat with a prompt default follows it until the chat sets its own', async () => {
    const f = stubFetch(() => sse(reply('ok')))
    const saved = { name: 'Chef', parentId: null, text: 'You are a chef.' }
    const p = await storage.savePrompt({ ...saved, abilities: { one: false } })
    await setPrompt(convId, p.id)
    await go('first')
    expect(toolNames(f, 0)).toEqual(['two'])

    // A chat with no set of its own follows the prompt.
    await storage.savePrompt({ ...saved, id: p.id, abilities: { two: false } })
    await go('second')
    expect(toolNames(f, 1)).toEqual(['one'])

    // The first switch keeps what the chat followed, so the other switch reads the same.
    await setAbility(convId, 'one', true)
    expect((await storage.getConversation(convId))!.abilities).toEqual({ one: true, two: false })
    await storage.savePrompt({ ...saved, id: p.id, abilities: { one: false } })
    await go('third')
    expect(toolNames(f, 2)).toEqual(['one'])
  })

  it('a plain chat sends no tools, no index, no instructions, no summary block and no capability note', async () => {
    setAbilitiesForTest()
    const f = stubFetch(() => sse(reply('ok')))
    await notes.write(
      { path: 'shared/harbour', conversationId: convId },
      { body: 'Boats.', description: 'The harbour', isNew: true },
      YOU,
    )
    await storage.updateConversation(convId, { capabilityNote: true, summaryBlock: 'The story so far.' })
    await go('first')
    expect(bodyOf(f, 0).tools).toBeDefined()
    expect(JSON.stringify(bodyOf(f, 0).messages[0])).toContain('harbour')

    const p = await storage.savePrompt({ name: 'Chef', parentId: null, text: 'You are a chef.' })
    await setPrompt(convId, p.id)
    await setPlain(convId, true)
    await go('second')
    const sent = bodyOf(f, 1)
    expect(Object.keys(sent).sort()).toEqual(['messages', 'model', 'session_id', 'stream'])
    expect(sent.messages).toEqual([
      { role: 'system', content: 'You are a chef.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ])

    // With no prompt there is no system message at all.
    await setPrompt(convId, null)
    await go('third')
    expect(bodyOf(f, 2).messages[0]).toEqual({ role: 'user', content: 'first' })
  })

  it('a call that a plain chat gets anyway finds no tool', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'one', '{}'])), () => sse(reply('Fine')))
    await setPlain(convId, true)
    await go('first')
    expect(bodyOf(f, 0)).not.toHaveProperty('tools')
    expect((await steps())[0].status).toBe('error')
    expect((await steps())[0].result).toContain('You have no tools in this chat.')
  })

  it('old steps go out as plain text in a plain chat, so no tool message is left without its tools', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'one', '{}'])), () => sse(reply('Done')), () => sse(reply('Fine')))
    await go('first')
    await setPlain(convId, true)
    await go('second')
    const { messages } = bodyOf(f, 2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1].content).toContain('(Used one.)')
    expect(messages[1].tool_calls).toBeUndefined()
  })

  it('turning plain off brings back the switches as they were, and the next request reads cold', async () => {
    const f = stubFetch(() => sse(reply('ok')))
    await setAbility(convId, 'one', false)
    await go('first')
    expect(toolNames(f, 0)).toEqual(['two'])

    await setPlain(convId, true)
    expect(await coldNow(T)).toBe(true)
    await go('second')
    expect(bodyOf(f, 1)).not.toHaveProperty('tools')
    expect(bodyOf(f, 1).messages[0].role).toBe('user')
    expect((await storage.getConversation(convId))!.abilities).toEqual({ one: false })

    await setPlain(convId, false)
    expect(await coldNow(T)).toBe(true)
    await go('third')
    expect(toolNames(f, 2)).toEqual(['two'])
    expect(bodyOf(f, 2).messages[0]).toEqual({ role: 'system', content: CAPABILITY_NOTE })
  })
})

describe('trust gate', () => {
  /** The tools that really ran, in order. */
  let ran: string[]
  const tool = (name: string, extra: Partial<Ability>): Ability => ({
    ...ability(async () => {
      ran.push(name)
      return `${name} ran`
    }, name),
    ...extra,
  })
  const go = () => sendUserMessage(convId, 'go', { reply: true, model: T })
  const waitsFor = (callId: string) => vi.waitFor(async () => expect((await activeVersion()).waitingFor).toBe(callId))
  /** A reply that a run left behind, with `content` as its steps. */
  async function leftBehind(content: Version['content'], extra: Partial<Version> = {}) {
    await storage.appendMessage(convId, 'user', doneVersion('go'))
    return storage.appendMessage(convId, 'assistant', { id: newId(), content, status: 'interrupted', model: T.id, createdAt: 1, ...extra })
  }
  const webThenOpenSave = () => [step('c1', 0, { name: 'web' }), step('c2', 0, { name: 'save', status: 'running', result: '' })]

  beforeEach(() => {
    ran = []
    setAbilitiesForTest([
      tool('web', { traits: { untrusted: true } }),
      tool('save', { writes: ['save'] }),
      tool('post', { traits: { outward: true } }),
      tool('look', {}),
    ])
  })

  it('after untrusted content a note write waits for OK', async () => {
    const f = stubFetch(() => sse(asks(['c1', 'web', '{}'], ['c2', 'save', '{}'])), () => sse(reply('Done')))
    const running = go()
    await waitsFor('c2')
    expect(ran).toEqual(['web'])
    expect((await steps())[1].status).toBe('running')
    expect((await activeVersion()).status).toBe('streaming')
    expect(f).toHaveBeenCalledTimes(1)

    okStep(convId, 'c2')
    await running
    expect(ran).toEqual(['web', 'save'])
    const v = await activeVersion()
    expect(v.waitingFor).toBeUndefined()
    expect(v.status).toBe('done')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('an outward tool waits too, a later round counts, and a plain read does not wait', async () => {
    stubFetch(
      () => sse(asks(['c1', 'web', '{}'])),
      () => sse(asks(['c2', 'look', '{}'], ['c3', 'post', '{}'])),
      () => sse(reply('Done')),
    )
    const running = go()
    await waitsFor('c3')
    expect(ran).toEqual(['web', 'look'])
    okStep(convId, 'c3')
    await running
    expect(ran).toEqual(['web', 'look', 'post'])
  })

  it('a write before the untrusted content does not wait, and a new reply starts clean', async () => {
    stubFetch(
      () => sse(asks(['c1', 'save', '{}'], ['c2', 'web', '{}'])),
      () => sse(reply('Done')),
      () => sse(asks(['c3', 'save', '{}'])),
      () => sse(reply('Done')),
    )
    await go()
    expect(ran).toEqual(['save', 'web'])
    await go()
    expect(ran).toEqual(['save', 'web', 'save'])
  })

  it('an untrusted call that was stopped gave nothing to read, so nothing waits', async () => {
    stubFetch(() => sse(reply('Done')))
    const m = await leftBehind([
      step('c1', 0, { name: 'web', status: 'stopped', result: 'Stopped by the user.' }),
      step('c2', 0, { name: 'save', status: 'running', result: '' }),
    ])
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(ran).toEqual(['save'])
  })

  it('an OK for another step does nothing', async () => {
    stubFetch(() => sse(asks(['c1', 'web', '{}'], ['c2', 'save', '{}'])), () => sse(reply('Done')))
    const running = go()
    await waitsFor('c2')
    okStep(convId, 'other')
    okStep('other chat', 'c2')
    await new Promise((r) => setTimeout(r, 20))
    expect(ran).toEqual(['web'])
    okStep(convId, 'c2')
    await running
  })

  it('Stop ends the wait: the step never runs and the next request is valid', async () => {
    const f = stubFetch(
      () => sse(asks(['c1', 'web', '{}'], ['c2', 'save', '{}'], ['c3', 'save', '{}'])),
      () => sse(reply('Fine')),
    )
    const running = go()
    await waitsFor('c2')
    stop(convId)
    await running
    expect(ran).toEqual(['web'])
    expect(isGenerating(convId)).toBe(false)
    const v = await activeVersion()
    expect(v.status).toBe('stopped')
    expect(v.waitingFor).toBeUndefined()
    expect((await steps()).map((p) => p.status)).toEqual(['done', 'stopped', 'stopped'])

    await sendUserMessage(convId, 'next', { reply: true, model: T })
    expectValid(bodyOf(f, 1).messages)
  })

  it('deleting the chat during the wait ends the reply', async () => {
    stubFetch(() => sse(asks(['c1', 'web', '{}'], ['c2', 'save', '{}'])))
    const running = go()
    await waitsFor('c2')
    await deleteChat(convId)
    await running
    expect(ran).toEqual(['web'])
    expect(isGenerating(convId)).toBe(false)
  })

  it('a lock during the wait is not a dead end: Continue asks again', async () => {
    const f = stubFetch(() => sse(reply('Done')))
    // What a lost run leaves. Startup then marks it interrupted.
    const m = await leftBehind(webThenOpenSave(), { status: 'streaming', waitingFor: 'c2' })
    await recoverInterrupted()
    expect((await activeVersion()).status).toBe('interrupted')

    const again = generate(convId, { kind: 'continue', messageId: m.id }, T)
    await vi.waitFor(async () => {
      const v = await activeVersion()
      expect(v.status).toBe('streaming')
      expect(v.waitingFor).toBe('c2')
    })
    expect(ran).toEqual([])
    expect(f).not.toHaveBeenCalled()
    okStep(convId, 'c2')
    await again
    expect(ran).toEqual(['save'])
    expect((await activeVersion()).status).toBe('done')
  })

  it('Continue does not ask again for a write that landed before the lock', async () => {
    setAlreadyDoneForTest(async () => 'stored result')
    stubFetch(() => sse(reply('Done')))
    const m = await leftBehind(webThenOpenSave())
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    expect(ran).toEqual([])
    expect((await steps())[1]).toMatchObject({ status: 'done', result: 'stored result' })
  })
})
