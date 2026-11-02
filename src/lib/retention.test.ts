import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notesAbility } from './abilities/notes'
import { setAbilitiesForTest, type Ability, type AbilityCtx } from './abilities/registry'
import { fallbackModelInfo, type ModelInfo } from './catalog'
import { estimateTokens, fingerprint, isCold, planWindow } from './context'
import { notes, YOU } from './notes/store'
import { buildOutgoing, renderRounds, sendsCall, stepCounter } from './normalise'
import type { OutMessage } from './openrouter'
import { keptWhole, pointerFor, STRIP_AFTER_TURNS, STRIP_MIN_CHARS, wholeInWindow } from './retention'
import { generate, sendUserMessage } from './send'
import { db, storage } from './storage'
import type { ContentPart, Message, Role, ToolPart, Version } from './types'

const BIG = 'r'.repeat(STRIP_MIN_CHARS + 1)
const HEADER = 'shared/lists/insects, version 7: Favourite insects'
const READ = `${HEADER}\n\n1| ${BIG}`
const POINTER = '(Read shared/lists/insects, version 7. Stripped. notes_read reopens it.)'
const PATH = 'shared/lists/insects'

const stepOf = (callId: string, result = READ, extra: Partial<ToolPart> = {}): ToolPart => ({
  type: 'tool',
  callId,
  round: 0,
  model: 'm/a',
  name: 'notes_read',
  args: { path: PATH },
  result,
  status: 'done',
  ...extra,
})

function msg(order: number, role: Role, content: string | ContentPart[], extra: Partial<Message> = {}): Message {
  return {
    id: `m${order}`,
    conversationId: 'c',
    order,
    role,
    versions: [{ id: `v${order}`, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, status: 'done', createdAt: 0 }],
    activeVersion: 0,
    pinned: false,
    createdAt: 0,
    ...extra,
  }
}

/** A question, a reply with `step`, then `later` user turns. Ends on the newest user message, as at a send. */
function chat(later: number, step: ToolPart = stepOf('c1')): Message[] {
  const out = [msg(1, 'user', 'first'), msg(2, 'assistant', [step, { type: 'text', text: 'done' }])]
  for (let i = 0; i < later; i++) {
    if (i > 0) out.push(msg(2 * i + 2, 'assistant', `reply ${i}`))
    out.push(msg(2 * i + 3, 'user', `turn ${i}`))
  }
  return out
}

const ON = { modelId: 'm/a', toolsEnabled: true, plain: false }
const opts = { ...ON, system: null, windowStartId: null, inputModalities: [], blobUrl: () => undefined }
const toolMessage = (out: OutMessage[]): OutMessage | undefined => out.find((m) => m.role === 'tool')
const callMessage = (out: OutMessage[]) => out.find((m) => m.role === 'assistant' && m.tool_calls !== undefined) as Extract<OutMessage, { role: 'assistant' }>
const lastRequest = (out: OutMessage[]) => ({ model: 'm/a', provider: null, toolsHash: null, ...fingerprint(out), at: 0 })

describe('keptWhole', () => {
  it('a big result stays whole for two user turns, then becomes a pointer', () => {
    expect(STRIP_AFTER_TURNS).toBe(2)
    for (const later of [0, 1, 2]) expect(keptWhole(chat(later)).has('c1')).toBe(true)
    expect(keptWhole(chat(3)).has('c1')).toBe(false)
    expect(toolMessage(buildOutgoing(chat(2), opts))?.content).toBe(READ)
    expect(toolMessage(buildOutgoing(chat(3), opts))?.content).toBe(POINTER)
  })

  it('a small result is never stripped', () => {
    const edge = stepOf('c1', 'x'.repeat(STRIP_MIN_CHARS))
    expect(STRIP_MIN_CHARS).toBe(1200)
    expect(keptWhole(chat(9, edge)).has('c1')).toBe(true)
    expect(keptWhole(chat(9, stepOf('c1', 'x'.repeat(STRIP_MIN_CHARS + 1)))).has('c1')).toBe(false)
  })

  it('a reply and a divider do not count as turns', () => {
    const messages = [...chat(2), msg(9, 'divider', []), msg(10, 'assistant', 'one more')]
    expect(keptWhole(messages).has('c1')).toBe(true)
  })

  it('counts active versions, and a rerolled reply counts from its message', () => {
    const old: Version = { id: 'old', content: [stepOf('gone')], status: 'done', createdAt: 0 }
    const fresh: Version = { id: 'new', content: [stepOf('c1')], status: 'done', createdAt: 99 }
    const rerolled = (later: number): Message[] => {
      const messages = chat(later)
      messages[1] = { ...messages[1], versions: [old, fresh], activeVersion: 1 }
      return messages
    }
    expect(keptWhole(rerolled(1))).toEqual(new Set(['c1']))
    // Its version is newer than every turn here, and it still counts from where it sits.
    expect(keptWhole(rerolled(3)).has('c1')).toBe(false)
  })

  it('takes messages in any order', () => {
    expect(keptWhole(chat(3).reverse()).has('c1')).toBe(false)
  })

  it('counts only what the request holds, so a reroll of an old turn sees the steps before it whole', () => {
    const messages = chat(3)
    expect(toolMessage(buildOutgoing(messages, { ...opts, upToId: 'm7' }))?.content).toBe(READ)
  })
})

describe('what a stripped step sends', () => {
  it('a stripped pair keeps its call and its tool message', () => {
    const out = buildOutgoing(chat(3), opts)
    const whole = buildOutgoing(chat(2), opts)
    const call = callMessage(out)
    expect(call).toEqual(callMessage(whole))
    expect(call.tool_calls?.[0]).toMatchObject({ id: 'c1', function: { name: 'notes_read' } })
    expect(toolMessage(out)).toEqual({ role: 'tool', tool_call_id: 'c1', content: POINTER })
    // The tool message comes right after its call.
    expect(out[out.indexOf(call) + 1]).toBe(toolMessage(out))
  })

  it('the stored result never changes', () => {
    const messages = chat(3)
    buildOutgoing(messages, opts)
    stepCounter(ON, messages)
    expect((messages[1].versions[0].content[0] as ToolPart).result).toBe(READ)
  })

  it('a flat step has no result, so it stays one line', () => {
    const flat = (later: number) => buildOutgoing(chat(later), { ...opts, modelId: 'm/b' })
    expect(toolMessage(flat(3))).toBeUndefined()
    expect(flat(3)[1]).toEqual(flat(1)[1])
    expect(JSON.stringify(flat(3))).not.toContain('Stripped')
  })

  it('the turn in flight renders whole, however old its parts are', () => {
    const out = renderRounds([stepOf('c1')], { modelId: 'm/a', toolsEnabled: true })
    expect(toolMessage(out)?.content).toBe(READ)
  })

  it('stripping does not read as cold', () => {
    const before = buildOutgoing(chat(2), opts)
    const after = buildOutgoing(chat(3), opts)
    expect(toolMessage(before)?.content).not.toBe(toolMessage(after)?.content)
    const next = { model: 'm/a', provider: null, toolsHash: null, outgoing: after, now: 1, ttlMs: 1000 }
    expect(isCold(lastRequest(before), next)).toBe(false)
  })

  it('messageChars counts the pointer once stripped', () => {
    const count = (later: number) => estimateTokens(chat(later), null, 1, 0, stepCounter(ON, chat(later)))
    const text = 'first'.length + 'done'.length + 'turn 0'.length + 'reply 1'.length + 'turn 1'.length
    const call = 'notes_read'.length + JSON.stringify({ path: PATH }).length
    expect(count(2)).toBe(Math.ceil((text + call + READ.length) / 4))
    const more = 'reply 2'.length + 'turn 2'.length
    expect(count(3)).toBe(Math.ceil((text + more + call + POINTER.length) / 4))
  })

  it('counts what the request sends, step by step', () => {
    const messages = [...chat(3, stepOf('c1')), msg(20, 'assistant', [stepOf('c2')]), msg(21, 'user', 'next')]
    const sent = buildOutgoing(messages, opts)
      .filter((m) => m.role === 'tool')
      .map((m) => (m.content as string).length)
    const counter = stepCounter(ON, messages)
    const callChars = 'notes_read'.length + JSON.stringify({ path: PATH }).length
    const parts = messages.flatMap((m) => m.versions[0].content.filter((p): p is ToolPart => p.type === 'tool'))
    expect(parts.map(counter)).toEqual(sent.map((n) => n + callChars))
  })

  it('a stripped step no longer pushes the window to trim', () => {
    const later = 12
    const messages = chat(later, stepOf('c1', `${HEADER}\n\n${'r'.repeat(8000)}`))
    const setting = { mode: 'tokens' as const, limit: 1000, trimTo: 0.7 }
    const plan = {
      messages,
      windowStartId: null,
      windowStartOrder: null,
      setting,
      system: null,
      ratio: 1,
      cold: false,
      soft: 0.85,
      overheadChars: 0,
    }
    expect(planWindow({ ...plan, stepChars: stepCounter(ON, messages) }).trimmed).toBe(false)
  })
})

describe('pointerFor', () => {
  it('names the note and its version', () => {
    expect(pointerFor(stepOf('c1'))).toBe(POINTER)
  })

  it('names the page of a long note', () => {
    const part = stepOf('c1', `${HEADER}\nPage 2 of 3.\n\n9| text`, { args: { path: PATH, page: 2 } })
    expect(pointerFor(part)).toBe('(Read shared/lists/insects, version 7, page 2. Stripped. notes_read reopens it.)')
  })

  it('names where a moved note is now, not the old path it was asked by', () => {
    const part = stepOf('c1', READ, { args: { path: 'shared/old/place' } })
    expect(pointerFor(part)).toBe(POINTER)
  })

  it('a listing and a search use their own past line', () => {
    const list = stepOf('c1', `All notes:\n${BIG}`, { args: {} })
    expect(pointerFor(list)).toBe('(Listed the notes. Stripped. notes_read reopens it.)')
    const search = stepOf('c1', `Found 12 notes for "river".\n${BIG}`, { name: 'notes_search', args: { query: 'river' } })
    expect(pointerFor(search)).toBe("(Looked in notes for 'river': found 12 notes. Stripped. notes_search reopens it.)")
  })

  it('works for a tool nothing knows', () => {
    expect(pointerFor(stepOf('c1', BIG, { name: 'old_tool', args: {} }))).toBe('(Used old_tool. Stripped. old_tool reopens it.)')
  })

  it('an ability can give its own words, and a failing one falls back', () => {
    const ability = (pointer: Ability['pointer']): Ability => ({
      id: 'x',
      title: 'X',
      summary: 'x',
      tools: [{ name: 'x_get', description: 'x', parameters: {} }],
      run: async () => 'ok',
      describe: () => ({ running: 'x', done: 'x', past: '(Got x.)' }),
      pointer,
      traits: {},
    })
    const part = stepOf('c1', BIG, { name: 'x_get', args: {} })
    setAbilitiesForTest([ability(() => 'Got messages 4 to 6.')])
    expect(pointerFor(part)).toBe('(Got messages 4 to 6. Stripped. x_get reopens it.)')
    setAbilitiesForTest([
      ability(() => {
        throw new Error('boom')
      }),
    ])
    expect(pointerFor(part)).toBe('(Got x. Stripped. x_get reopens it.)')
    setAbilitiesForTest()
  })
})

describe('wholeInWindow', () => {
  const sent = sendsCall(ON)
  const whole = (messages: Message[], startId: string | null = null, version = 7, page = 1): boolean =>
    wholeInWindow(messages, startId, PATH, version, page, sent)

  it('is true while the copy is whole, and false once it is a pointer', () => {
    expect(whole(chat(2))).toBe(true)
    expect(whole(chat(3))).toBe(false)
  })

  it('a small copy stays whole for as long as it is in the window', () => {
    expect(whole(chat(9, stepOf('c1', `${HEADER}\n\n1| short`)))).toBe(true)
  })

  it('wants the same version', () => {
    expect(whole(chat(1), null, 8)).toBe(false)
  })

  it('wants the same page', () => {
    expect(whole(chat(1), null, 7, 2)).toBe(false)
    const paged = stepOf('c1', READ, { args: { path: PATH, page: 2 } })
    expect(whole(chat(1, paged), null, 7, 2)).toBe(true)
    expect(whole(chat(1, paged), null, 7, 1)).toBe(false)
  })

  it('a copy before the window start is not sent', () => {
    expect(whole(chat(2), 'm3')).toBe(false)
    expect(whole(chat(2), 'm2')).toBe(true)
  })

  it('a pinned copy before the start is sent', () => {
    const messages = chat(2)
    messages[1] = { ...messages[1], pinned: true }
    expect(whole(messages, 'm3')).toBe(true)
  })

  it('a flat copy carries no text, so it does not count', () => {
    expect(wholeInWindow(chat(1), null, PATH, 7, 1, sendsCall({ ...ON, modelId: 'm/b' }))).toBe(false)
    expect(wholeInWindow(chat(1), null, PATH, 7, 1, sendsCall({ ...ON, plain: true }))).toBe(false)
  })

  it('a failed read, a search and an "unchanged" line are not copies', () => {
    const version7 = `${PATH}, version 7`
    const cases = [
      stepOf('c1', 'Error: no.', { status: 'error' }),
      stepOf('c1', `${version7}: x`, { status: 'stopped' }),
      stepOf('c1', `${version7}: x`, { name: 'notes_search' }),
      stepOf('c1', `${PATH} is unchanged since your last read, see above. It is at version 7.`),
    ]
    for (const c of cases) expect(whole(chat(1, c))).toBe(false)
  })

  it('reads the active version only', () => {
    const messages = chat(1)
    const other: Version = { id: 'other', content: [{ type: 'text', text: 'new try' }], status: 'done', createdAt: 0 }
    messages[1] = { ...messages[1], versions: [...messages[1].versions, other], activeVersion: 1 }
    expect(whole(messages)).toBe(false)
  })
})

describe('repeat reads in a real reply', () => {
  const T: ModelInfo = { ...fallbackModelInfo('t/tools'), tools: true }
  const B: ModelInfo = { ...fallbackModelInfo('b/tools'), tools: true }
  const LONG = `${'word '.repeat(600)}end`
  const UNCHANGED = 'unchanged since your last read, see above'
  const P = 'chat/big'

  let convId: string
  const enc = new TextEncoder()
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
  const sse = (lines: string[]): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(lines.join('')))
          c.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  const asks = (...args: unknown[]) => [
    ...args.map((a, index) =>
      ev({ choices: [{ delta: { tool_calls: [{ index, id: `call${Math.random()}`, function: { name: 'notes_read', arguments: JSON.stringify(a) } }] } }] }),
    ),
    ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]
  const answers = [ev({ choices: [{ delta: { content: 'ok' } }] }), ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']

  /** Each `generate` makes one read round and then answers. */
  function stub() {
    let i = 0
    const f = vi.fn(async () => sse(i++ % 2 === 0 ? asks({ path: P }) : answers))
    vi.stubGlobal('fetch', f)
    return f
  }
  const bodyOf = (f: ReturnType<typeof stub>, i: number) =>
    JSON.parse((f.mock.calls[i] as unknown as [string, RequestInit])[1].body as string) as { messages: OutMessage[] }
  const stepsNow = async (): Promise<ToolPart[]> =>
    (await storage.listMessages(convId)).flatMap((m) => m.versions[m.activeVersion].content.filter((p): p is ToolPart => p.type === 'tool'))
  const lastStep = async (): Promise<ToolPart> => (await stepsNow()).at(-1) as ToolPart
  const say = (text: string, model = T) => sendUserMessage(convId, text, { reply: true, model })
  const ctx: AbilityCtx = {
    conversationId: '',
    messageId: 'm',
    callId: 'w',
    model: T.id,
    key: 'k',
    signal: new AbortController().signal,
    wholeCopy: () => false,
  }
  const write = (body: string) =>
    notes.write({ path: P, conversationId: convId }, { body, description: 'Big' }, YOU)

  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()))
    setAbilitiesForTest([notesAbility])
    await storage.setSettings({ key: 'sk-test' })
    convId = (await storage.createConversation({ nextModel: T.id })).id
    ctx.conversationId = convId
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setAbilitiesForTest()
  })

  it('a repeat read says unchanged while the copy is whole, and returns the note after', async () => {
    await write(LONG)
    const f = stub()
    await say('one')
    expect((await lastStep()).result).toContain('end')
    await say('two')
    expect((await lastStep()).result).toContain(UNCHANGED)
    await say('three')
    expect((await lastStep()).result).toContain(UNCHANGED)
    // The first copy is a pointer in this request, so the note comes back.
    await say('four')
    const fresh = await lastStep()
    expect(fresh.result).toContain('end')
    expect(fresh.result).not.toContain(UNCHANGED)
    const sent = bodyOf(f, 6).messages.filter((m) => m.role === 'tool')
    expect(sent[0].content).toBe(`(Read ${P}, version 1. Stripped. notes_read reopens it.)`)
    expect(sent[1].content).toContain(UNCHANGED)
    // The stored step and its line in the UI keep the whole text.
    expect((await stepsNow())[0].result).toContain('end')
    // The new copy is whole again, so the next repeat reads as unchanged.
    await say('five')
    expect((await lastStep()).result).toContain(UNCHANGED)
  })

  it('a changed note returns in full', async () => {
    await write(LONG)
    stub()
    await say('one')
    await notes.edit({ path: P, conversationId: convId }, { newText: ' more', expectedVersion: 1 }, YOU)
    await say('two')
    const again = await lastStep()
    expect(again.result).toContain('version 2')
    expect(again.result).toContain('end')
    expect(again.result).not.toContain(UNCHANGED)
  })

  it('a note read twice in one round says unchanged the second time', async () => {
    await write(LONG)
    let i = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse(i++ === 0 ? asks({ path: P }, { path: P }) : answers)),
    )
    await say('one')
    const [first, second] = await stepsNow()
    expect(first.result).toContain('end')
    expect(second.result).toContain(UNCHANGED)
  })

  it('a copy made by another model is a flat line, so it returns in full', async () => {
    await write(LONG)
    stub()
    await say('one')
    await say('two', B)
    expect((await lastStep()).result).toContain('end')
    expect((await lastStep()).result).not.toContain(UNCHANGED)
  })

  it('a copy outside the window returns in full', async () => {
    await write(LONG)
    stub()
    await say('one')
    await say('two')
    expect((await lastStep()).result).toContain(UNCHANGED)
    const second = (await storage.listMessages(convId)).filter((m) => m.role === 'user')[1]
    await storage.updateConversation(convId, { windowStartMessageId: second.id, windowStartOrder: second.order })
    // The only line left in the window says "unchanged", and that is no copy.
    await say('three')
    expect((await lastStep()).result).toContain('end')
    expect((await lastStep()).result).not.toContain(UNCHANGED)
  })

  it('another page of a long note returns, since no copy of it is above', async () => {
    await write(`${'line of text\n'.repeat(1000)}end`)
    let i = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse(i++ === 0 ? asks({ path: P }, { path: P, page: 2 }, { path: P, page: 1 }) : answers)),
    )
    await say('one')
    const [first, second, third] = await stepsNow()
    expect(first.result).toContain('Page 1 of 3')
    expect(second.result).toContain('Page 2 of 3')
    expect(third.result).toContain(UNCHANGED)
  })

  it('a repeat read by an old path names where the note is now', async () => {
    await write(LONG)
    await notes.move({ path: P, conversationId: convId }, 'chat/new', YOU)
    const wholeCopy = vi.fn(() => true)
    const result = await notesAbility.run('notes_read', { path: P }, { ...ctx, wholeCopy })
    expect(wholeCopy).toHaveBeenCalledWith('chat/new', 2, 1)
    expect(result).toBe('chat/new is unchanged since your last read, see above. It is at version 2.')
  })

  it('a Continue sends the steps of its reply whole', async () => {
    await write(LONG)
    stub()
    await say('one')
    const m = (await storage.listMessages(convId)).at(-1) as Message
    await db.messages.update(m.id, {
      versions: m.versions.map((v) => ({ ...v, status: 'interrupted' as const })),
    })
    const f = vi.fn(async () => sse(answers))
    vi.stubGlobal('fetch', f)
    await generate(convId, { kind: 'continue', messageId: m.id }, T)
    const sent = (JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { messages: OutMessage[] }).messages
    expect(sent.filter((x) => x.role === 'tool')[0].content).toContain('end')
  })
})
