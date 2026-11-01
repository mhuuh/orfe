import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fallbackModelInfo, type ModelInfo } from '../catalog'
import { buildIndex, INDEX_MAX_CHARS } from '../notes/index'
import { notes, YOU } from '../notes/store'
import { buildOutgoing } from '../normalise'
import { sendUserMessage } from '../send'
import { db, storage } from '../storage'
import { CAPABILITY_NOTE, systemFor } from '../system'
import type { Note, ToolPart } from '../types'
import { notesAbility } from './notes'
import { UNCHECKED } from './outcome'
import { describeStep, setAbilitiesForTest, toolsFor, type AbilityCtx } from './registry'

const T: ModelInfo = { ...fallbackModelInfo('t/tools'), tools: true }
const PLAIN_MODEL: ModelInfo = { ...fallbackModelInfo('p/plain'), tools: false }

let convId: string
const ctx = (callId = 'c1', model = T.id): AbilityCtx => ({
  conversationId: convId,
  messageId: 'm1',
  callId,
  model,
  key: 'k',
  signal: new AbortController().signal,
})
const call = (name: string, args: unknown, callId?: string): Promise<string> => notesAbility.run(name, args, ctx(callId))
const put = (path: string, description = `About ${path}`, body = 'Body text.') =>
  call('notes_write', { path, description, body })
const ref = (path: string) => ({ path, conversationId: convId })

const enc = new TextEncoder()
function sse(lines: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(lines.join('')))
        c.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const reply = (text: string) => [
  ev({ choices: [{ delta: { content: text } }] }),
  ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ev({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 5, cost: 0 } }),
  'data: [DONE]\n\n',
]
function stubFetch() {
  const f = vi.fn(async () => sse(reply('ok')))
  vi.stubGlobal('fetch', f)
  return f
}
const systemOf = (f: ReturnType<typeof stubFetch>, i: number): string | undefined => {
  const body = JSON.parse((f.mock.calls[i] as unknown as [string, RequestInit])[1].body as string) as {
    messages: { role: string; content: string }[]
  }
  return body.messages.find((m) => m.role === 'system')?.content
}
const bodyOf = (f: ReturnType<typeof stubFetch>, i: number) =>
  JSON.parse((f.mock.calls[i] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  await storage.setSettings({ key: 'sk-test' })
  convId = (await storage.createConversation({ nextModel: T.id })).id
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setAbilitiesForTest()
})

describe('notes tools', () => {
  it('each tool returns text, and a refusal reads as a next step', async () => {
    expect(await put('chat/harbour', 'The harbour', 'Boats at dawn.')).toBe('Wrote chat/harbour. It is at version 1.')

    expect(await call('notes_search', { query: 'dawn' })).toContain('chat/harbour')
    expect(await call('notes_read', { path: 'chat/harbour' })).toContain('1| Boats at dawn.')
    expect(await call('notes_read', {})).toContain('chat/harbour — The harbour')

    expect(await call('notes_edit', { path: 'chat/harbour', expected_version: 1, old_text: 'dawn', new_text: 'dusk' })).toBe(
      'Edited chat/harbour. It is at version 2.',
    )
    expect(await call('notes_delete', { path: 'chat/harbour', new_path: 'shared/harbour' })).toBe(
      'Moved chat/harbour to shared/harbour. It is at version 3.',
    )
    expect(await call('notes_delete', { path: 'shared/harbour' })).toContain('Deleted shared/harbour.')

    // A stale version names the fix, and every refusal carries the "Error:" mark.
    await put('chat/quay')
    const stale = await call('notes_edit', { path: 'chat/quay', expected_version: 9, old_text: 'Body', new_text: 'Text' })
    expect(stale).toMatch(/^Error:/)
    expect(stale).toContain('notes_read')
    expect(stale).toContain('expected_version 1')

    const near = await call('notes_write', { path: 'chat/quays', description: 'd', body: 'b' })
    expect(near).toMatch(/^Error:/)
    expect(near).toContain('chat/quay')
    expect(near).toContain('new: true')

    // Missing arguments and junk arguments never throw, and name what to send.
    expect(await call('notes_write', { path: 'chat/x' })).toMatch(/^Error: notes_write needs .*body.*Send the call again/)
    expect(await call('notes_edit', { path: 'chat/quay', tags: ['a'] })).toMatch(/^Error: .*expected_version.*notes_read/)
    expect(await call('notes_search', {})).toMatch(/^Error: notes_search needs a query/)
    expect(await call('notes_delete', ['nope'])).toMatch(/^Error: notes_delete needs a path/)
  })

  it('takes loosely typed arguments from a weak model', async () => {
    await put('chat/quay')
    const out = await call('notes_edit', { path: 'chat/quay', expected_version: '1', tags: 'dock, boats' })
    expect(out).toBe('Edited chat/quay. It is at version 2.')
    expect((await notes.read(ref('chat/quay')))?.tags).toEqual(['dock', 'boats'])
    const shrunk = await call('notes_write', { path: 'chat/quay', description: 'Short', body: 'x', expected_version: 2, shrink: 'true' })
    expect(shrunk).toBe('Wrote chat/quay. It is at version 3.')
  })

  it('a blank field counts as left out, so it cannot wipe tags or trip protection', async () => {
    await call('notes_write', { path: 'chat/poem', description: 'A poem', body: 'Keep me.', tags: ['verse'], protected: true })
    const blanks = { old_text: '', new_text: '', description: '', tags: '' }
    expect(await call('notes_edit', { path: 'chat/poem', expected_version: 1, ...blanks })).toMatch(/^Error: This edit changes nothing/)
    expect(await call('notes_edit', { path: 'chat/poem', expected_version: 1, ...blanks, tags: ['poem'] })).toBe(
      'Edited chat/poem. It is at version 2.',
    )
    expect((await notes.read(ref('chat/poem')))?.tags).toEqual(['poem'])
  })

  it('records the model, message and call on the revision', async () => {
    await call('notes_write', { path: 'chat/a', description: 'd', body: 'b' }, 'call-7')
    const n = (await notes.read(ref('chat/a')))!
    const [rev] = await notes.revisions(n.id)
    expect(rev).toMatchObject({ writer: T.id, messageId: 'm1', callId: 'call-7' })
  })

  it('notes_read pages long notes and numbers lines', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of a long note that goes on a while.`).join('\n')
    await notes.write(ref('shared/long'), { body, description: 'Long', isNew: true }, YOU)

    const one = await call('notes_read', { path: 'shared/long' })
    expect(one).toContain('Page 1 of 2')
    expect(one).toContain('notes_read')
    expect(one).toContain('page 2')
    expect(one).toContain('1| Line 1 of')
    expect(one.length).toBeLessThan(8300)

    const two = await call('notes_read', { path: 'shared/long', page: 2 })
    expect(two).toContain('Page 2 of 2')
    expect(two).toContain('200| Line 200 of')
    expect(two).not.toContain('\n1| Line 1 of')

    const past = await call('notes_read', { path: 'shared/long', page: 9 })
    expect(past).toMatch(/^Error: .*2 pages/)
  })

  it('notes_read always gets through one line longer than a page', async () => {
    await notes.write(ref('shared/wall'), { body: 'x'.repeat(20000), description: 'Wall', isNew: true }, YOU)
    const three = await call('notes_read', { path: 'shared/wall', page: 3 })
    expect(three).toContain('Page 3 of 3')
    expect(three).toContain('xxx')
    expect(three.length).toBeLessThan(8300)
  })

  it('notes_read lists a folder from a collapsed index line, and pages the whole tree', async () => {
    await put('shared/recipes/soup')
    await put('shared/recipes/bread')
    await put('chat/mira')
    const folder = await call('notes_read', { path: 'shared/recipes/' })
    expect(folder).toContain('shared/recipes/soup — About shared/recipes/soup')
    expect(folder).toContain('shared/recipes/bread')
    expect(folder).not.toContain('chat/mira')
    expect(await call('notes_read', { path: 'shared' })).toContain('shared/recipes/soup')

    await db.notes.bulkPut(Array.from({ length: 300 }, (_, i) => note('shared', `many/note-${i}`, 'x'.repeat(40))))
    const tree = await call('notes_read', {})
    expect(tree).toContain('Page 1 of ')
  })

  it('notes_search says what to try when nothing matches, and that is not an error', async () => {
    const out = await call('notes_search', { query: 'nothing here' })
    expect(out).not.toMatch(/^Error:/)
    expect(out).toContain('Found 0 notes')
    expect(out).toContain('notes_read')
  })

  it('notes_search caps its results and says so', async () => {
    for (let i = 0; i < 12; i++) await put(`chat/n${i}-${'q'.repeat(i)}`, 'Same words')
    const out = await call('notes_search', { query: 'same' })
    expect(out.match(/\(version 1\)/g)).toHaveLength(10)
    expect(out).toContain('more words')
  })

  it("notes_search reads the shared shelf and this chat's shelf, never another chat's", async () => {
    await put('shared/river', 'River in common')
    await put('chat/river', 'River here')
    const other = convId
    convId = (await storage.createConversation({ nextModel: T.id })).id
    await put('chat/river-other', 'River elsewhere')
    convId = other
    const out = await call('notes_search', { query: 'river' })
    expect(out).toContain('Found 2 notes')
    expect(out).not.toContain('elsewhere')
  })

  it('a new note starts where its path says; a bare path is refused', async () => {
    await put('chat/one')
    await put('shared/two')
    expect((await notes.list(convId)).map((n) => n.path)).toEqual(['one'])
    expect((await notes.list('shared')).map((n) => n.path)).toEqual(['two'])

    for (const out of [await put('three'), await call('notes_read', { path: 'three' })]) {
      expect(out).toMatch(/^Error:/)
      expect(out).toContain('shared/')
      expect(out).toContain('chat/')
    }
    expect((await notes.list(convId)).map((n) => n.path)).toEqual(['one'])
  })

  it('a read of a deleted note says it is gone and suggests notes_search', async () => {
    await put('chat/old')
    await call('notes_delete', { path: 'chat/old' })
    const out = await call('notes_read', { path: 'chat/old' })
    expect(out).not.toMatch(/^Error:/)
    expect(out).toContain('gone')
    expect(out).toContain('notes_search')
  })

  it('a read through a moved path returns the note and names the new path', async () => {
    await put('chat/old', 'Old place', 'Still here.')
    await call('notes_delete', { path: 'chat/old', new_path: 'shared/new' })
    const out = await call('notes_read', { path: 'chat/old' })
    expect(out).toContain('1| Still here.')
    expect(out).toContain('moved')
    expect(out).toContain('shared/new')
    expect(await call('notes_read', { path: 'shared/new' })).not.toContain('moved')
  })

  it('a model can set protected, and notes_edit can still tag that note', async () => {
    await call('notes_write', { path: 'chat/poem', description: 'A poem', body: 'Keep me.', protected: true })
    const n = (await notes.read(ref('chat/poem')))!
    expect(n.protected).toBe(true)

    expect(await call('notes_read', { path: 'chat/poem' })).toContain('Protected')
    expect(await call('notes_edit', { path: 'chat/poem', expected_version: 1, tags: ['verse'] })).toBe(
      'Edited chat/poem. It is at version 2.',
    )
    expect((await notes.read(ref('chat/poem')))?.tags).toEqual(['verse'])

    for (const refused of [
      await call('notes_edit', { path: 'chat/poem', expected_version: 2, old_text: 'Keep', new_text: 'Lose' }),
      await call('notes_write', { path: 'chat/poem', description: 'A poem', body: 'Gone.', expected_version: 2 }),
      await call('notes_delete', { path: 'chat/poem' }),
    ]) {
      expect(refused).toMatch(/^Error: This note is protected/)
      expect(refused).toContain('Move or tag')
    }
    expect((await notes.read(ref('chat/poem')))?.body).toBe('Keep me.')
  })

  it('notes_write keeps supersedes, and a read shows it', async () => {
    await put('chat/plan')
    await call('notes_write', { path: 'chat/plan-b', description: 'New plan', body: 'b', supersedes: 'chat/plan', new: true })
    expect((await notes.read(ref('chat/plan-b')))?.supersedes).toBe('chat/plan')
    expect(await call('notes_read', { path: 'chat/plan-b' })).toContain('Replaces chat/plan')
  })

  it('the tool JSON has no counts, dates or titles', async () => {
    const c = (await storage.getConversation(convId))!
    const before = toolsFor(c, null, T)!
    expect(before.tools.map((t) => t.name)).toEqual(['notes_search', 'notes_read', 'notes_write', 'notes_edit', 'notes_delete'])
    await put('chat/harbour', 'Harbour')
    expect(toolsFor(c, null, T)!.json).toBe(before.json)
    expect(before.json).not.toMatch(/\d/)
    expect(before.json).not.toContain('Harbour')
  })

  it('instructions carry all six points and no counts or dates', () => {
    const text = notesAbility.instructions!
    expect(text).toMatch(/notes_search before you say you don't remember/)
    expect(text).toMatch(/Saving nothing is a normal outcome/)
    expect(text).toMatch(/durable, useful, and stated or confirmed by/)
    expect(text).toMatch(/paraphrase of a note you just read/)
    expect(text).toMatch(/prefer the newest/)
    expect(text).toMatch(/states a limit, follow it/)
    expect(text).toMatch(/supersedes/)
    expect(text).toMatch(/"Planned" section/)
    expect(text).toMatch(/just did outranks any note/)
    expect(text).not.toMatch(/\d/)
  })
})

const note = (shelf: string, path: string, description = `About ${path}`): Note => ({
  id: path,
  shelf,
  path,
  aliases: [],
  description,
  tags: [],
  body: '',
  protected: false,
  bodyHash: '',
  version: 1,
  supersedes: null,
  updatedAt: 0,
  deletedAt: null,
})

describe('buildIndex', () => {
  it('lists full paths and descriptions, shared shelf first', () => {
    const out = buildIndex([note('shared', 'lists/insects', 'Favourite insects')], [note('c', 'mira/voice', 'Her voice')])
    const lines = out.split('\n')
    expect(lines.slice(1)).toEqual(['shared/lists/insects — Favourite insects', 'chat/mira/voice — Her voice'])
    expect(lines[0]).toContain('notes_search')
  })

  it('an empty vault gives no text', () => {
    expect(buildIndex([], [])).toBe('')
  })

  it('buildIndex stays under the cap and collapses the largest folder first', () => {
    const shared = [
      ...Array.from({ length: 200 }, (_, i) => note('shared', `big/note-${i}`, 'x'.repeat(40))),
      ...Array.from({ length: 40 }, (_, i) => note('shared', `mid/note-${i}`, 'y'.repeat(40))),
      note('shared', 'loose', 'A note in no folder'),
    ]
    const out = buildIndex(shared, [note('c', 'small/one', 'One note')])
    expect(out.length).toBeLessThanOrEqual(INDEX_MAX_CHARS)
    expect(out).toContain('shared/big/ (200 notes)')
    expect(out).not.toContain('shared/big/note-1 ')
    // The cap is met, so the smaller folders stay open.
    expect(out).toContain('shared/mid/note-1 — ')
    expect(out).toContain('shared/loose — A note in no folder')
    expect(out).toContain('chat/small/one — One note')
  })

  it('collapses the next folder only when it must', () => {
    const fill = (folder: string, n: number) => Array.from({ length: n }, (_, i) => note('shared', `${folder}/note-${i}`, 'x'.repeat(100)))
    const out = buildIndex([...fill('a', 60), ...fill('b', 50), ...fill('c', 20)], [])
    expect(out).toContain('shared/a/ (60 notes)')
    expect(out).toContain('shared/b/ (50 notes)')
    expect(out).toContain('shared/c/note-1 — ')
  })

  it('holds the cap with notes in no folder at all', () => {
    const shared = Array.from({ length: 400 }, (_, i) => note('shared', `loose-${i}`, 'x'.repeat(60)))
    const out = buildIndex(shared, [note('c', 'kept', 'One')])
    expect(out.length).toBeLessThanOrEqual(INDEX_MAX_CHARS)
    expect(out).toContain('shared/ (400 notes)')
    expect(out).toContain('chat/kept — One')
  })

  it('cuts a very long description, and says one note, not one notes', () => {
    const out = buildIndex([note('shared', 'a/b', 'x'.repeat(5000)), ...Array.from({ length: 400 }, (_, i) => note('shared', `c/n-${i}`, 'y'.repeat(60)))], [])
    expect(out).not.toContain('x'.repeat(200))
    expect(out).toContain('shared/c/ (400 notes)')
    expect(buildIndex(Array.from({ length: 60 }, (_, i) => note('shared', `f${i}/n`, 'x'.repeat(160))), [])).toMatch(/\(1 note\)/)
  })
})

describe('the index in a send', () => {
  const send = (text: string) => sendUserMessage(convId, text, { reply: true, model: T })

  it('the system message runs prompt, capability note, instructions, index', async () => {
    const f = stubFetch()
    const p = await storage.savePrompt({ name: 'Chef', parentId: null, text: 'You are a chef.' })
    await storage.updateConversation(convId, { systemPromptRef: p.id })
    await put('shared/soup', 'Soup')
    await send('hi')
    const index = buildIndex(await notes.list('shared'), [])
    expect(systemOf(f, 0)).toBe(`You are a chef.\n\n${CAPABILITY_NOTE}\n\n${notesAbility.instructions}\n\n${index}`)
    expect(bodyOf(f, 0).tools).toHaveLength(5)
  })

  it('the index is unchanged while warm and refreshed when cold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000_000)
    const f = stubFetch()
    await put('shared/first', 'First note')
    await send('one')
    const frozen = (await storage.getConversation(convId))!.notesIndex
    expect(frozen).toContain('shared/first')

    // A warm send keeps the old text, so the prefix does not move.
    await put('shared/second', 'Second note')
    await send('two')
    expect(systemOf(f, 1)).toBe(systemOf(f, 0))
    expect((await storage.getConversation(convId))!.notesIndex).toBe(frozen)

    // The cache ran out, so the new note may come in.
    vi.setSystemTime(1_000_000_000 + 10 * 60_000)
    await send('three')
    expect(systemOf(f, 2)).toContain('shared/second')
    expect((await storage.getConversation(convId))!.notesIndex).toContain('shared/second')
  })

  it('a null index is built even when the cache reads warm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000_000)
    const f = stubFetch()
    await send('one')
    expect((await storage.getConversation(convId))!.notesIndex).toBe('')
    await put('shared/first', 'First note')
    await storage.updateConversation(convId, { notesIndex: null })
    await send('two')
    expect(systemOf(f, 1)).toContain('shared/first')
  })

  it('a warm send that trims refreshes the index too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000_000)
    const f = stubFetch()
    await storage.updateConversation(convId, { context: { mode: 'tokens', limit: 2000, trimTo: 0.5 } })
    await put('shared/first', 'First note')
    await send('one')
    await put('shared/second', 'Second note')
    // Warm, but this message goes over the hard limit.
    await send('x'.repeat(8000))
    expect((await storage.getConversation(convId))!.windowStartMessageId).not.toBeNull()
    expect(systemOf(f, 1)).toContain('shared/second')
    expect((await storage.getConversation(convId))!.notesIndex).toContain('shared/second')
  })

  it('the index and instructions count in the window', async () => {
    const f = stubFetch()
    const c = (await storage.getConversation(convId))!
    const big = Array.from({ length: 20 }, (_, i) => `shared/n${i}`)
    for (const p of big) await put(p, 'x'.repeat(120))
    const index = buildIndex(await notes.list('shared'), [])
    const tools = toolsFor(c, null, T)!.json.length
    const fixed = tools + notesAbility.instructions!.length + CAPABILITY_NOTE.length
    // Room for all of this without the index, but not with it.
    const limit = Math.ceil((fixed + 200 + index.length / 2) / 4)
    await storage.updateConversation(convId, { context: { mode: 'tokens', limit, trimTo: 0.5 } })
    await storage.appendMessage(convId, 'user', { id: 'u0', content: [{ type: 'text', text: 'ancient' }], status: 'done', createdAt: 1 })
    await storage.appendMessage(convId, 'assistant', { id: 'a0', content: [{ type: 'text', text: 'ancient reply' }], status: 'done', createdAt: 1 })
    await send('new')
    const sent = (JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { messages: { content: string }[] }).messages
    expect(JSON.stringify(sent)).not.toContain('ancient')
  })

  it('a chat with tools off gets no index and no instructions', async () => {
    const f = stubFetch()
    await put('shared/first', 'First note')

    await sendUserMessage(convId, 'no tools here', { reply: true, model: PLAIN_MODEL })
    expect(systemOf(f, 0)).toBe(CAPABILITY_NOTE)
    expect(bodyOf(f, 0)).not.toHaveProperty('tools')

    await storage.updateConversation(convId, { abilities: { notes: false } })
    await send('notes switched off')
    expect(systemOf(f, 1)).toBe(CAPABILITY_NOTE)
    expect(bodyOf(f, 1)).not.toHaveProperty('tools')

    await storage.updateConversation(convId, { abilities: null, plain: true })
    await send('plain')
    expect(systemOf(f, 2) ?? '').not.toContain('notes_search')
    expect(bodyOf(f, 2)).not.toHaveProperty('tools')
    expect((await storage.getConversation(convId))!.notesIndex).toBeNull()
  })

  it('systemFor gives the same text a send uses, so the header counts it', async () => {
    const f = stubFetch()
    await put('shared/first', 'First note')
    await send('hi')
    const c = (await storage.getConversation(convId))!
    expect((await systemFor(c, T)).system).toBe(systemOf(f, 0))
    expect((await systemFor(c, PLAIN_MODEL)).system).toBe(CAPABILITY_NOTE)
  })
})

describe('step words', () => {
  const step = (name: string, args: unknown, extra: Partial<ToolPart> = {}): ToolPart => ({
    type: 'tool',
    callId: 'c',
    round: 0,
    model: 'm',
    name,
    args,
    result: 'ok',
    status: 'done',
    ...extra,
  })

  it('reads, searches and writes use the mockup words', () => {
    expect(describeStep(step('notes_read', { path: 'shared/harbour' }))).toEqual({
      running: 'recalling Harbour…',
      done: 'recalled Harbour',
      past: '(Read the note Harbour.)',
    })
    expect(describeStep(step('notes_read', { path: 'chat/mira/voice' })).done).toBe('recalled Mira, voice')
    expect(describeStep(step('notes_read', {})).done).toBe('listed notes')
    expect(describeStep(step('notes_search', { query: 'river' }, { result: 'Found 2 notes for "river".' }))).toEqual({
      running: 'searching notes…',
      done: 'found 2 notes',
      past: "(Looked in notes for 'river': found 2 notes.)",
    })
    expect(describeStep(step('notes_search', { query: 'river' }, { result: 'Found 1 note for "river".' })).done).toBe('found 1 note')
    expect(describeStep(step('notes_search', { query: 'river' }, { result: 'Found 0 notes for "river".' })).done).toBe('found no notes')
    expect(describeStep(step('notes_write', { path: 'chat/harbour' }))).toEqual({
      running: 'writing note…',
      done: 'wrote Harbour',
      past: '(Wrote the note Harbour.)',
    })
    expect(describeStep(step('notes_delete', { path: 'chat/x', new_path: 'shared/y' })).past).toBe('(Moved the note X to shared/y.)')
  })

  it('a note that was not there does not read as recalled', async () => {
    const result = await call('notes_read', { path: 'chat/lost' })
    const words = describeStep(step('notes_read', { path: 'chat/lost' }, { result }))
    expect(words.done).toBe('no note Lost')
    expect(words.past).toBe('(Looked for the note Lost. It was not there.)')
  })

  it('an error, a stop or an open call does not read as finished', () => {
    const args = { path: 'chat/harbour' }
    const refused = describeStep(step('notes_write', args, { status: 'error', result: 'Error: no.' }))
    expect(refused.done).toBe("couldn't write Harbour")
    expect(refused.past).toBe('(Tried to write the note Harbour. It did not work.)')

    expect(describeStep(step('notes_write', args, { status: 'stopped' })).past).toBe('(Stopped before writing the note Harbour.)')

    const doubt = '(Started to write the note Harbour. It may or may not have happened.)'
    expect(describeStep(step('notes_write', args, { status: 'running', result: '' })).past).toBe(doubt)
    expect(describeStep(step('notes_write', args, { status: 'error', result: UNCHECKED })).past).toBe(doubt)

    expect(describeStep(step('notes_read', args, { status: 'running', result: '' })).past).toBe(
      '(Started to read the note Harbour. It did not finish.)',
    )
  })

  it('bad arguments still give words', () => {
    expect(describeStep(step('notes_edit', 'not json')).past).toBe('(Edited a note.)')
    expect(describeStep(step('notes_write', null)).done).toBe('wrote note')
  })

  it('a flattened failed step reaches the next model as a failure', () => {
    const out = buildOutgoing(
      [
        {
          id: 'a',
          conversationId: 'c',
          order: 1,
          role: 'assistant',
          activeVersion: 0,
          pinned: false,
          createdAt: 1,
          versions: [
            {
              id: 'v',
              content: [step('notes_write', { path: 'chat/harbour' }, { status: 'error', result: 'Error: no.', model: 'other' })],
              status: 'done',
              createdAt: 1,
            },
          ],
        },
      ],
      { system: null, windowStartId: null, inputModalities: [], blobUrl: () => undefined, modelId: 'm', toolsEnabled: true },
    )
    expect(JSON.stringify(out)).toContain('Tried to write the note Harbour')
  })
})
