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

/** No lone half of an emoji. */
const whole = (s: string): boolean => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)

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
      'Edited chat/harbour. It is at version 2.\n\n1| Boats at dusk.',
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

  describe('a field of the wrong type never picks another action', () => {
    const BODY = 'Age: 30. Town: Oulu.'
    const edit = (args: object) => call('notes_edit', { path: 'chat/a', expected_version: 1, ...args })
    const body = async () => (await notes.read(ref('chat/a')))?.body
    beforeEach(() => put('chat/a', 'd', BODY))

    it.each([[31], [null], [{ text: 'x' }], [undefined]])('old_text with new_text %j is refused, and the text stays', async (new_text) => {
      const out = await edit({ old_text: 'Age: 30', new_text })
      expect(out).toMatch(/^Error: new_text must be text/)
      expect(out).toContain('empty string')
      expect(await body()).toBe(BODY)
    })

    it.each([[30], [{ text: 'Age' }], [['Age']]])('old_text %j is refused, and nothing is added', async (old_text) => {
      expect(await edit({ old_text, new_text: '31' })).toMatch(/^Error: old_text must be text/)
      expect(await body()).toBe(BODY)
    })

    it('null counts as left out on every optional field, as a strict-mode model sends it', async () => {
      const nulls = { old_text: null, new_text: null, description: null, tags: null }
      expect(await edit(nulls)).toMatch(/^Error: This edit changes nothing/)
      expect(await edit({ ...nulls, new_text: ' More.' })).toBe(`Edited chat/a. It is at version 2.\n\n1| ${BODY}\n2|  More.`)
      expect(await body()).toBe(`${BODY}\n More.`)
      expect((await call('notes_read', { path: 'chat/a', page: null })).length).toBeGreaterThan(0)
      expect(await call('notes_read', { path: null })).toContain('chat/a — d')

      const write = { tags: null, expected_version: null, new: null, shrink: null, protected: null, supersedes: null }
      expect(await call('notes_write', { path: 'chat/b', description: 'd', body: 'b', ...write })).toBe('Wrote chat/b. It is at version 1.')
      expect((await notes.read(ref('chat/b')))?.protected).toBe(false)

      expect(await call('notes_delete', { path: 'chat/b', new_path: null })).toContain('Deleted chat/b.')
    })

    it('null can never delete text', async () => {
      expect(await edit({ old_text: 'Age: 30', new_text: null })).toMatch(/^Error: new_text must be text/)
      expect(await body()).toBe(BODY)
    })

    it('new_text as an empty string still removes text', async () => {
      expect(await edit({ old_text: ' Town: Oulu.', new_text: '' })).toBe('Edited chat/a. It is at version 2.\n\n1| Age: 30.')
      expect(await body()).toBe('Age: 30.')
    })

    it('new_text of the wrong type alone is refused', async () => {
      expect(await edit({ new_text: 31, tags: ['a'] })).toMatch(/^Error: new_text must be text/)
    })

    it.each([[{ path: 'chat/b' }], [7], [['chat/b']]])('new_path %j is refused, and the note stays', async (new_path) => {
      const out = await call('notes_delete', { path: 'chat/a', new_path })
      expect(out).toMatch(/^Error: new_path must be text/)
      expect(await body()).toBe(BODY)
    })
  })

  it('a create that carries expected_version gets a way out', async () => {
    const out = await call('notes_write', { path: 'chat/new', description: 'd', body: 'b', expected_version: 1 })
    expect(out).toContain('There is no note at chat/new.')
    expect(out).toContain('To create it, write again with no expected_version.')
    expect(await call('notes_write', { path: 'chat/new', description: 'd', body: 'b', expected_version: 0 })).toBe('Wrote chat/new. It is at version 1.')
  })

  it('expected_version 0 counts as left out on an edit', async () => {
    await put('chat/a')
    expect(await call('notes_edit', { path: 'chat/a', expected_version: 0, tags: ['a'] })).toMatch(/^Error: notes_edit needs expected_version/)
  })

  it.each([[[]], [[1, 2]], [','], ['  '], [null], [{}]])('tags %j count as left out, so they wipe nothing', async (tags) => {
    await call('notes_write', { path: 'chat/a', description: 'd', body: 'b', tags: ['keep'] })
    await call('notes_edit', { path: 'chat/a', expected_version: 1, tags, description: 'New' })
    await call('notes_write', { path: 'chat/a', description: 'New', body: 'b', expected_version: 2, tags })
    expect((await notes.read(ref('chat/a')))?.tags).toEqual(['keep'])
  })

  it('non-strings in a tag list are dropped', async () => {
    await call('notes_write', { path: 'chat/a', description: 'd', body: 'b', tags: [1, 'real', null, ' '] })
    expect((await notes.read(ref('chat/a')))?.tags).toEqual(['real'])
  })

  it('a long description is refused for a model, by write and by edit', async () => {
    const long = 'x'.repeat(201)
    const out = await put('chat/a', long)
    expect(out).toMatch(/^Error: The description is 201 characters\. The limit is 200\. Shorten it/)
    expect(await put('chat/a', 'x'.repeat(200))).toBe('Wrote chat/a. It is at version 1.')
    expect(await call('notes_edit', { path: 'chat/a', expected_version: 1, description: long })).toMatch(/^Error: The description is 201/)

    // Mikael has no cap, and an edit that leaves his long line alone still goes through.
    await notes.write(ref('chat/his'), { body: 'b', description: long, isNew: true }, YOU)
    expect(await call('notes_edit', { path: 'chat/his', expected_version: 1, new_text: 'more' })).toBe('Edited chat/his. It is at version 2.\n\n1| b\n2| more')
  })

  it('a huge path or query does not come back whole', async () => {
    const huge = 'x'.repeat(100000)
    const results = [
      await call('notes_read', { path: huge }),
      await call('notes_read', { path: `chat/${huge}` }),
      await call('notes_write', { path: huge, description: 'd', body: 'b' }),
      await call('notes_write', { path: `chat/${huge}`, description: 'd', body: 'b' }),
      await call('notes_edit', { path: huge, expected_version: 1, tags: ['a'] }),
      await call('notes_delete', { path: `chat/${huge}` }),
      await call('notes_search', { query: huge }),
    ]
    for (const out of results) expect(out.length).toBeLessThan(400)
    const part: ToolPart = { type: 'tool', callId: 'c', round: 0, model: 'm', name: 'notes_read', args: { path: `chat/${huge}` }, result: '', status: 'done' }
    expect(describeStep(part).past.length).toBeLessThan(200)
    expect(describeStep({ ...part, name: 'notes_search', args: { query: huge } }).past.length).toBeLessThan(200)
  })

  it('a search snippet never ends on half an emoji', async () => {
    await notes.write(ref('shared/e'), { body: `river${'😀'.repeat(60)}`, description: 'd', isNew: true }, YOU)
    await notes.write(ref('shared/f'), { body: `${'😀'.repeat(60)}x river`, description: 'd', isNew: true }, YOU)
    expect(whole(await call('notes_search', { query: 'river' }))).toBe(true)
  })

  describe('notes_edit shows what it did', () => {
    const LIST = 'One\nTwo\nThree\nFour\nFive'
    const head = 'Edited chat/a. It is at version 2.'
    const edit = (args: object) => call('notes_edit', { path: 'chat/a', expected_version: 1, ...args })
    const view = (out: string) => out.split('\n\n').slice(1).join('\n\n')

    it('gives the changed line and one line each side, numbered as notes_read numbers them', async () => {
      await put('chat/a', 'd', LIST)
      expect(await edit({ old_text: 'Three', new_text: 'THREE' })).toBe(`${head}\n\n2| Two\n3| THREE\n4| Four`)
      expect(await call('notes_read', { path: 'chat/a' })).toContain('2| Two\n3| THREE\n4| Four')
    })

    it('at the top and the bottom there is only one side', async () => {
      await put('chat/a', 'd', LIST)
      expect(await edit({ old_text: 'One', new_text: '1' })).toBe(`${head}\n\n1| 1\n2| Two`)
      await put('chat/b', 'd', LIST)
      expect(await call('notes_edit', { path: 'chat/b', expected_version: 1, old_text: 'Five', new_text: '5' })).toContain('4| Four\n5| 5')
    })

    it('a new text of several lines shows them all', async () => {
      await put('chat/a', 'd', LIST)
      expect(await edit({ old_text: 'Two', new_text: 'A\nB\nC' })).toBe(`${head}\n\n1| One\n2| A\n3| B\n4| C\n5| Three`)
    })

    it('a removed line shows where it was', async () => {
      await put('chat/a', 'd', LIST)
      expect(await edit({ old_text: 'Three', new_text: '' })).toBe(`${head}\n\n2| Two\n3| Four\n4| Five`)
    })

    it('a removed last line shows the new end', async () => {
      await put('chat/a', 'd', LIST)
      expect(await edit({ old_text: 'Five', new_text: '' })).toBe(`${head}\n\n3| Three\n4| Four`)
    })

    it('a cut inside a line shows the line as it is now', async () => {
      await put('chat/a', 'd', 'One\nTwo two\nThree')
      expect(await edit({ old_text: 'Two ', new_text: '' })).toBe(`${head}\n\n1| One\n2| two\n3| Three`)
    })

    it('an append shows the end of the note', async () => {
      await put('chat/a', 'd', LIST)
      expect(await edit({ new_text: 'Six' })).toBe(`${head}\n\n5| Five\n6| Six`)
    })

    it('stays near 300 characters, and keeps the change in view', async () => {
      await put('chat/a', 'd', `${'x'.repeat(2000)} old ${'y'.repeat(2000)}`)
      const shown = view(await edit({ old_text: 'old', new_text: 'NEW' }))
      expect(shown.length).toBeLessThanOrEqual(310)
      expect(shown).toContain('NEW')
      expect(shown.startsWith('…')).toBe(true)
      expect(shown.endsWith('…')).toBe(true)
    })

    it('a long append keeps its end', async () => {
      await put('chat/a', 'd', 'Start')
      const shown = view(await edit({ new_text: `${'x'.repeat(1000)} last words` }))
      expect(shown.length).toBeLessThanOrEqual(310)
      expect(shown.endsWith('last words')).toBe(true)
    })

    it('never cuts an emoji in two', async () => {
      await notes.write(ref('chat/a'), { body: `${'😀'.repeat(400)} old ${'😀'.repeat(400)}`, description: 'd', isNew: true }, YOU)
      expect(whole(await edit({ old_text: 'old', new_text: 'new' }))).toBe(true)
      await notes.write(ref('chat/b'), { body: 'x', description: 'd', isNew: true }, YOU)
      expect(whole(await call('notes_edit', { path: 'chat/b', expected_version: 1, new_text: 'x'.repeat(5) + '😀'.repeat(400) }))).toBe(true)
    })

    it('a change to tags or the description stays as it was', async () => {
      await put('chat/a', 'd', LIST)
      expect(await edit({ tags: ['x'] })).toBe(head)
      expect(await call('notes_edit', { path: 'chat/a', expected_version: 2, description: 'New' })).toBe('Edited chat/a. It is at version 3.')
    })

    it('refuses a no-op edit with a next step', async () => {
      await put('chat/a', 'd', LIST)
      const out = await edit({ old_text: 'Two', new_text: 'Two' })
      expect(out).toMatch(/^Error:/)
      expect(out).toContain('notes_read')
      expect((await notes.read(ref('chat/a')))?.version).toBe(1)
    })
  })

  it('notes_edit takes what models really send', async () => {
    const list = 'Milk\nBread\nApples\nCoffee'
    await put('chat/a', 'd', list)
    expect(await call('notes_edit', { path: 'chat/a', expected_version: 1, old_text: '1| Milk\n', new_text: '' })).toContain('It is at version 2.')
    expect(await call('notes_edit', { path: 'chat/a', expected_version: 2, old_text: 'Apples', new_text: '' })).toContain('It is at version 3.')
    expect(await call('notes_edit', { path: 'chat/a', expected_version: 3, new_text: '\nEggs' })).toContain('It is at version 4.')
    expect((await notes.read(ref('chat/a')))?.body).toBe('Bread\nCoffee\nEggs')
  })

  it('the notes_edit description says that line numbers are not part of the text', () => {
    expect(notesAbility.tools.find((t) => t.name === 'notes_edit')?.description).toContain('Line numbers are not part of the text.')
  })

  it('the instructions say to act on a refusal without asking first', () => {
    expect(notesAbility.instructions).toContain("After a refusal, do the next step it names yourself. Don't ask Mikael first.")
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
    expect(one).toContain('For more, call notes_read with path shared/long and page 2.')
    expect(one).toContain('1| Line 1 of')
    expect(one.length).toBeLessThan(8300)

    const two = await call('notes_read', { path: 'shared/long', page: 2 })
    expect(two).toContain('Page 2 of 2')
    expect(two).toContain('200| Line 200 of')
    expect(two).not.toContain('\n1| Line 1 of')

    const past = await call('notes_read', { path: 'shared/long', page: 9 })
    expect(past).toMatch(/^Error: There are 2 pages/)
    expect(past).toContain('path shared/long and page 2')

    await put('shared/short')
    expect(await call('notes_read', { path: 'shared/short', page: 2 })).toMatch(/^Error: There is 1 page\./)
  })

  it('a page cut never splits an emoji', async () => {
    await notes.write(ref('shared/e'), { body: `${'a'.repeat(7996)}${'😀'.repeat(10)}`, description: 'd', isNew: true }, YOU)
    const one = await call('notes_read', { path: 'shared/e' })
    const two = await call('notes_read', { path: 'shared/e', page: 2 })
    for (const page of [one, two]) expect(whole(page)).toBe(true)
    expect((one + two).match(/😀/g)).toHaveLength(10)
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

  it('a slash at the end lists the folder, even with a note of that name', async () => {
    await put('shared/recipes', 'The hub', 'Hub text.')
    await put('shared/recipes/soup')
    expect(await call('notes_read', { path: 'shared/recipes' })).toContain('1| Hub text.')
    const folder = await call('notes_read', { path: 'shared/recipes/' })
    expect(folder).toContain('shared/recipes/soup — ')
    expect(folder).not.toContain('Hub text.')
  })

  it('a whole index line works as a path', async () => {
    await put('shared/recipes/soup', 'Soup')
    await put('shared/recipes/bread', 'Bread')
    const note = '1| Body text.'
    expect(await call('notes_read', { path: 'shared/recipes/soup — Soup' })).toContain(note)
    expect(await call('notes_read', { path: 'shared/recipes/soup - Soup' })).toContain(note)
    for (const line of ['shared/recipes/ (2 notes)', 'shared/recipes/ (and 1 more: use notes_search)', 'shared/ (and 2 more: use notes_search)']) {
      expect(await call('notes_read', { path: line })).toContain('shared/recipes/bread — Bread')
    }
    await put('chat/odd — name', 'Odd', 'Real path.')
    expect(await call('notes_read', { path: 'chat/odd — name' })).toContain('1| Real path.')
  })

  it('a [[link]] works as a path', async () => {
    await put('shared/harbour')
    expect(await call('notes_read', { path: '[[shared/harbour]]' })).toContain('1| Body text.')
  })

  it('an empty shelf is a normal result, and a bad read path keeps every hint', async () => {
    for (const path of ['chat/', 'chat', 'shared', 'SHARED/']) expect(await call('notes_read', { path })).toBe('No notes on this shelf yet.')
    const bad = await call('notes_read', { path: 'harbour' })
    expect(bad).toContain('square brackets')
    expect(bad).toContain('under 200 characters')
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

  it('a cut description never splits an emoji', () => {
    const out = buildIndex([note('shared', 'a', `${'x'.repeat(159)}😀😀`)], [])
    expect(whole(out)).toBe(true)
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
    expect(out).toMatch(/shared\/big\/ \(and \d+ more: use notes_search\)/)
    // The cap is met, so the smaller folders stay open.
    expect(out).toContain('shared/mid/note-1 — ')
    expect(out).toContain('shared/loose — A note in no folder')
    expect(out).toContain('chat/small/one — One note')
  })

  it('collapses the next folder only when it must', () => {
    const fill = (folder: string, n: number) => Array.from({ length: n }, (_, i) => note('shared', `${folder}/note-${i}`, 'x'.repeat(100)))
    const out = buildIndex([...fill('a', 60), ...fill('b', 50), ...fill('c', 20)], [])
    expect(out).toContain('shared/a/ (60 notes)')
    expect(out).not.toContain('shared/a/note-1 ')
    expect(out).toMatch(/shared\/b\/ \(and \d+ more: use notes_search\)/)
    expect(out).toContain('shared/c/note-1 — ')
  })

  it('a flat shelf keeps its newest notes, and says how many it left out', () => {
    const shared = Array.from({ length: 200 }, (_, i) => ({ ...note('shared', `loose-${i}`, 'x'.repeat(60)), updatedAt: i }))
    const out = buildIndex(shared, [note('c', 'kept', 'One')])
    expect(out.length).toBeLessThanOrEqual(INDEX_MAX_CHARS)
    expect(out.split('\n')[1]).toContain('shared/loose-199 — ')
    expect(out).not.toContain('shared/loose-0 ')
    const left = Number(/shared\/ \(and (\d+) more: use notes_search\)/.exec(out)?.[1])
    expect(out.match(/^shared\/loose-/gm)).toHaveLength(200 - left)
    expect(out).toContain('chat/kept — One')
  })

  it('one huge folder keeps its newest notes too', () => {
    const shared = Array.from({ length: 300 }, (_, i) => ({ ...note('shared', `story/n-${i}`, 'x'.repeat(60)), updatedAt: i }))
    const out = buildIndex(shared, [])
    expect(out).toContain('shared/story/n-299 — ')
    expect(out).toMatch(/shared\/story\/ \(and \d+ more: use notes_search\)/)
    expect(out.length).toBeGreaterThan(INDEX_MAX_CHARS * 0.9)
    expect(out.length).toBeLessThanOrEqual(INDEX_MAX_CHARS)
  })

  it('both flat shelves share the room, newest first', () => {
    const flat = (shelf: string, from: number) => Array.from({ length: 150 }, (_, i) => ({ ...note(shelf, `n-${i}`, 'x'.repeat(60)), updatedAt: from + i }))
    const out = buildIndex(flat('shared', 1000), flat('c', 1000))
    expect(out.length).toBeLessThanOrEqual(INDEX_MAX_CHARS)
    expect(out).toContain('shared/n-149 — ')
    expect(out).toContain('chat/n-149 — ')
  })

  it('holds the cap when the count lines alone are too long', () => {
    const shared = Array.from({ length: 1000 }, (_, i) => note('shared', `folder-${i}/n`, 'd'))
    const out = buildIndex(shared, [])
    expect(out.length).toBeLessThanOrEqual(INDEX_MAX_CHARS)
    expect(out).toContain('shared/ (1000 notes)')
  })

  it('cuts a very long description, and says one note, not one notes', () => {
    const out = buildIndex([note('shared', 'a/b', 'x'.repeat(5000)), ...Array.from({ length: 400 }, (_, i) => note('shared', `c/n-${i}`, 'y'.repeat(60)))], [])
    expect(out).not.toContain('x'.repeat(200))
    expect(out).toMatch(/shared\/c\/ \(and \d+ more/)
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
      past: '(Read the note shared/harbour.)',
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
      past: '(Wrote the note chat/harbour.)',
    })
    expect(describeStep(step('notes_delete', { path: 'chat/x', new_path: 'shared/y' })).past).toBe('(Moved the note chat/x to shared/y.)')
  })

  it('a note that was not there does not read as recalled', async () => {
    const result = await call('notes_read', { path: 'chat/lost' })
    const words = describeStep(step('notes_read', { path: 'chat/lost' }, { result }))
    expect(words.done).toBe('no note Lost')
    expect(words.past).toBe('(Looked for the note chat/lost. It was not there.)')
  })

  it('an error, a stop or an open call does not read as finished', () => {
    const args = { path: 'chat/harbour' }
    const refused = describeStep(step('notes_write', args, { status: 'error', result: 'Error: no.' }))
    expect(refused.done).toBe("couldn't write Harbour")
    expect(refused.past).toBe('(Tried to write the note chat/harbour. It did not work.)')

    expect(describeStep(step('notes_write', args, { status: 'stopped' })).past).toBe('(Stopped before writing the note chat/harbour.)')

    const doubt = '(Started to write the note chat/harbour. It may or may not have happened.)'
    expect(describeStep(step('notes_write', args, { status: 'running', result: '' })).past).toBe(doubt)
    expect(describeStep(step('notes_write', args, { status: 'error', result: UNCHECKED })).past).toBe(doubt)

    expect(describeStep(step('notes_read', args, { status: 'running', result: '' })).past).toBe(
      '(Started to read the note chat/harbour. It did not finish.)',
    )
  })

  it('the past line uses the path as it was given, tidy, and the screen keeps the friendly name', () => {
    const words = describeStep(step('notes_write', { path: 'chat//mikael/favourite-insect/' }))
    expect(words.past).toBe('(Wrote the note chat/mikael/favourite-insect.)')
    expect(words.done).toBe('wrote Mikael, favourite insect')
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
      { system: null, windowStartId: null, inputModalities: [], blobUrl: () => undefined, modelId: 'm', toolsEnabled: true, plain: false },
    )
    expect(JSON.stringify(out)).toContain('Tried to write the note chat/harbour')
  })
})
