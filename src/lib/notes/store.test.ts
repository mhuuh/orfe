import { beforeEach, describe, expect, it } from 'vitest'
import { deleteChat, restoreChat } from '../send'
import { db, storage } from '../storage'
import type { Note } from '../types'
import { MAX_BODY } from './rules'
import { notes, refOf, YOU, type NoteRef, type Result, type WriteInput, type Writer } from './store'

const CHAT = 'c1'
const shared = (path: string): NoteRef => ({ path: `shared/${path}`, conversationId: CHAT })
const chat = (path: string, conversationId = CHAT): NoteRef => ({ path: `chat/${path}`, conversationId })

const model = (callId: string | null = null, messageId: string | null = 'm1', writer = 'a/model'): Writer => ({ writer, messageId, callId })
const body = (text: string, more: Partial<WriteInput> = {}): WriteInput => ({ body: text, description: 'A line', ...more })

function okNote(r: Result): Note {
  if ('refused' in r) throw new Error(r.refused)
  return r.ok
}
function refusal(r: Result): string {
  if ('ok' in r) throw new Error('expected a refusal')
  return r.refused
}
const create = async (ref: NoteRef, text = 'first text', by: Writer = model()) => okNote(await notes.write(ref, body(text), by))
const last = async (noteId: string) => (await notes.revisions(noteId)).at(-1)!

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('writes and revisions', () => {
  it('every write adds a revision in the same transaction, with the writer', async () => {
    const n = await create(shared('lists/insects'), 'moth', model('c1', 'm1', 'a/model'))
    expect(n).toMatchObject({ shelf: 'shared', path: 'lists/insects', version: 1, deletedAt: null, protected: false })
    const next = okNote(await notes.write(shared('lists/insects'), body('moth, beetle', { expectedVersion: 1 }), model('c2', 'm2', 'b/model')))
    expect(next.version).toBe(2)

    const revs = await notes.revisions(n.id)
    expect(revs.map((r) => [r.version, r.writer, r.messageId, r.callId])).toEqual([
      [1, 'a/model', 'm1', 'c1'],
      [2, 'b/model', 'm2', 'c2'],
    ])
    expect(revs[0].before).toBeNull()
    expect(revs[0].after?.body).toBe('moth')
    expect(revs[1].before?.body).toBe('moth')
    expect(revs[1].after?.body).toBe('moth, beetle')

    // A failed revision rolls the note back: the two rows live or die together.
    db.noteRevisions.hook('creating', function fail() {
      db.noteRevisions.hook('creating').unsubscribe(fail)
      throw new Error('disk full')
    })
    await expect(notes.write(shared('lists/insects'), body('moth, beetle, lost', { expectedVersion: 2 }), model())).rejects.toThrow()
    expect((await notes.read(shared('lists/insects')))?.body).toBe('moth, beetle')
    expect(await notes.revisions(n.id)).toHaveLength(2)
  })

  it('a path with no shelf prefix is refused, and the refusal says what to do', async () => {
    const r = refusal(await notes.write({ path: 'lists/a', conversationId: CHAT }, body('x'), model()))
    expect(r).toMatch(/^Error:/)
    expect(r).toMatch(/shared\//)
    expect(r).toMatch(/chat\//)
  })

  it('paths ignore case on a shelf, and a new note gets the near match refusal', async () => {
    await create(shared('lists/insects'))
    expect((await notes.read(shared('LISTS/Insects')))?.path).toBe('lists/insects')

    const near = refusal(await notes.write(shared('lists/insect'), body('other'), model()))
    expect(near).toMatch(/^Error:/)
    expect(near).toMatch(/shared\/lists\/insects/)
    expect(near).toMatch(/new: true/)
    const fresh = okNote(await notes.write(shared('lists/insect'), body('other', { isNew: true }), model()))
    expect(fresh.path).toBe('lists/insect')

    // A different case of the same path is the same note, never a second one.
    const same = refusal(await notes.write(shared('Lists/Insects'), body('z', { isNew: true }), model()))
    expect(same).toMatch(/already exists/)
    expect((await notes.list('shared')).map((n) => n.path)).toEqual(['lists/insect', 'lists/insects'])
  })

  it('a model must give expectedVersion to replace a note; "you" need not', async () => {
    const n = await create(shared('a'), 'one')
    const r = refusal(await notes.write(shared('a'), body('two'), model()))
    expect(r).toMatch(/^Error:/)
    expect(r).toMatch(/notes_read/)
    expect(r).toMatch(/expected_version 1/)
    expect((await notes.read(shared('a')))?.body).toBe('one')
    expect(okNote(await notes.write(shared('a'), body('two'), YOU)).version).toBe(n.version + 1)
  })

  it('a write with expectedVersion on a note that is gone is refused, and starts no new note', async () => {
    await create(shared('a'), 'one')
    okNote(await notes.remove(shared('a'), model()))
    expect(refusal(await notes.write(shared('a'), body('two', { expectedVersion: 1 }), model()))).toMatch(/notes_search/)
    expect(await notes.read(shared('a'))).toBeUndefined()
  })

  it('a soft-deleted note does not block a new note at its path', async () => {
    const old = await create(shared('a'), 'old text')
    okNote(await notes.remove(shared('a'), model()))
    const fresh = await create(shared('a'), 'new text')
    expect(fresh.id).not.toBe(old.id)
    expect(fresh.version).toBe(3)
    expect((await notes.read(shared('a')))?.body).toBe('new text')
  })

  it('a stale expectedVersion does not pass on a new note at the same path', async () => {
    const seen = await create(shared('story'), 'old story')
    okNote(await notes.remove(shared('story'), model()))
    const made = await create(shared('story'), 'A new poem from chat B')
    expect(made.version).toBeGreaterThan(seen.version + 1)
    expect(refusal(await notes.write(shared('story'), body('stale write from chat A', { expectedVersion: seen.version }), model()))).toMatch(/notes_read/)
    expect((await notes.read(shared('story')))?.body).toBe('A new poem from chat B')
  })

  it('the same holds for a Trash note that held the path as an old path', async () => {
    const seen = await create(shared('old'), 'old story')
    okNote(await notes.move(shared('old'), 'shared/new', model()))
    okNote(await notes.remove(shared('new'), model()))
    const made = await create(shared('old'), 'fresh')
    expect(made.version).toBe(seen.version + 3)
  })

  it('a stale expectedVersion does not pass on a note that came to the path later', async () => {
    const seen = await create(shared('p1'), 'old story')
    okNote(await notes.move(shared('p1'), 'shared/m1', model()))
    okNote(await notes.remove(shared('m1'), model()))
    await create(shared('elsewhere'), 'other')
    okNote(await notes.move(shared('elsewhere'), 'shared/p1', model()))
    expect((await notes.read(shared('p1')))?.version).toBeGreaterThan(seen.version + 2)
  })

  it('the same holds for a note restored to a path that a later note held', async () => {
    const a = await create(shared('p1'), 'A')
    okNote(await notes.remove(shared('p1'), model()))
    const b = await create(shared('p1'), 'B')
    okNote(await notes.write(shared('p1'), body('B again', { expectedVersion: b.version }), model()))
    okNote(await notes.remove(shared('p1'), model()))
    expect(await notes.revert((await last(a.id)).id, YOU)).toBe('done')
    const back = (await notes.read(shared('p1')))!
    expect(back.id).toBe(a.id)
    expect(back.version).toBeGreaterThan(b.version + 2)
  })

  it('a refusal for an existing note names a path that notes_read can use', async () => {
    await create(chat('p1'))
    const r = refusal(await notes.write(chat('p1'), body('x', { isNew: true }), model()))
    expect(r).toMatch(/at chat\/p1\./)
  })

  it('keeps tags, supersedes and protected on a replace that does not name them', async () => {
    await notes.write(shared('a'), body('one', { tags: ['x'], supersedes: 'shared/old' }), model())
    const n = okNote(await notes.write(shared('a'), body('two', { expectedVersion: 1 }), model()))
    expect(n).toMatchObject({ tags: ['x'], supersedes: 'shared/old' })
    expect(n.bodyHash).not.toBe((await notes.revisions(n.id))[0].after?.bodyHash)
  })

  it('two writers on one shared note: the second is refused, and no text is lost', async () => {
    const n = await create(shared('story'), 'base')
    const a = await notes.write(shared('story'), body('base and A', { expectedVersion: 1 }), model('a', 'm1', 'a/one'))
    const b = await notes.write({ path: 'shared/story', conversationId: 'other' }, body('base and B', { expectedVersion: 1 }), model('b', 'm2', 'b/two'))
    expect(okNote(a).version).toBe(2)
    expect(refusal(b)).toMatch(/version 2/)
    expect((await notes.read(shared('story')))?.body).toBe('base and A')

    // The same race, at the same moment: the transactions run one at a time.
    const [c, d] = await Promise.all([
      notes.write(shared('story'), body('from C', { expectedVersion: 2 }), model('c')),
      notes.write(shared('story'), body('from D', { expectedVersion: 2 }), model('d')),
    ])
    expect([c, d].filter((r) => 'ok' in r)).toHaveLength(1)
    expect([c, d].filter((r) => 'refused' in r)).toHaveLength(1)

    // An edit on an old read fails the same way, and every text stays in the history.
    expect(refusal(await notes.edit(shared('story'), { oldText: 'base', newText: 'x', expectedVersion: 1 }, model()))).toMatch(/notes_read/)
    const revs = await notes.revisions(n.id)
    expect(revs.map((r) => r.after?.body).slice(0, 2)).toEqual(['base', 'base and A'])
    expect(revs).toHaveLength(3)
  })
})

describe('edit', () => {
  it('edit must match exactly once; zero or two matches refuse, and say which', async () => {
    await create(shared('a'), 'one two two three')
    const zero = refusal(await notes.edit(shared('a'), { oldText: 'four', newText: 'x', expectedVersion: 1 }, model()))
    expect(zero).toMatch(/^Error:/)
    expect(zero).toMatch(/not found/)
    const two = refusal(await notes.edit(shared('a'), { oldText: 'two', newText: 'x', expectedVersion: 1 }, model()))
    expect(two).toMatch(/^Error:/)
    expect(two).toMatch(/2 times/)
    expect((await notes.read(shared('a')))?.body).toBe('one two two three')

    const done = okNote(await notes.edit(shared('a'), { oldText: 'one', newText: 'ONE', expectedVersion: 1 }, model()))
    expect(done.body).toBe('ONE two two three')
    expect(done.version).toBe(2)
  })

  it('counts overlapping matches, and is exact about case', async () => {
    await create(shared('a'), 'aaa Bee')
    expect(refusal(await notes.edit(shared('a'), { oldText: 'aa', newText: 'x', expectedVersion: 1 }, model()))).toMatch(/2 times/)
    expect(refusal(await notes.edit(shared('a'), { oldText: 'bee', newText: 'x', expectedVersion: 1 }, model()))).toMatch(/not found/)
  })

  it('puts new text in word for word, with no $ patterns', async () => {
    await create(shared('a'), 'price: X')
    const n = okNote(await notes.edit(shared('a'), { oldText: 'X', newText: "$& $1 $' 10$", expectedVersion: 1 }, model()))
    expect(n.body).toBe("price: $& $1 $' 10$")
  })

  it('inserts at the end when there is no old text, and removes when there is no new text', async () => {
    await create(shared('a'), 'line one\nline two')
    const added = okNote(await notes.edit(shared('a'), { newText: 'line three', expectedVersion: 1 }, model()))
    expect(added.body).toBe('line one\nline two\nline three')
    const cut = okNote(await notes.edit(shared('a'), { oldText: 'line two\n', expectedVersion: 2 }, model()))
    expect(cut.body).toBe('line one\nline three')
  })

  it('a big cut by edit passes: every removed letter must be quoted', async () => {
    const text = 'keep\n' + 'x'.repeat(100)
    await create(shared('a'), text)
    const n = okNote(await notes.edit(shared('a'), { oldText: 'x'.repeat(100), newText: '', expectedVersion: 1 }, model()))
    expect(n.body).toBe('keep')
  })

  describe('old text with line numbers from notes_read', () => {
    const LIST = 'Milk\nBread\nApples'
    const edit = (oldText: string, newText: string) => notes.edit(shared('a'), { oldText, newText, expectedVersion: 1 }, model())

    it('strips the numbers and tries again', async () => {
      await create(shared('a'), LIST)
      expect(okNote(await edit('2| Bread', 'Rye')).body).toBe('Milk\nRye\nApples')
    })

    it('strips them from each line, and takes a line break with them', async () => {
      await create(shared('a'), LIST)
      expect(okNote(await edit('1| Milk\n2| Bread\n', '')).body).toBe('Apples')
    })

    it('strips them from new text too, or they would land in the note', async () => {
      await create(shared('a'), LIST)
      expect(okNote(await edit('1| Milk\n2| Bread', '1| Oat milk\n2| Rye')).body).toBe('Oat milk\nRye\nApples')
    })

    it('leaves new text alone when old text matched as it was', async () => {
      await create(shared('a'), LIST)
      expect(okNote(await edit('Bread', '2| Rye')).body).toBe('Milk\n2| Rye\nApples')
    })

    it('text that truly holds such a prefix matches first', async () => {
      await create(shared('a'), '1| one\none')
      expect(okNote(await edit('1| one', 'two')).body).toBe('two\none')
    })

    it('still matches once, exactly', async () => {
      await create(shared('a'), 'same\nsame')
      expect(refusal(await edit('1| same', 'x'))).toMatch(/2 times/)
      expect(refusal(await edit('1| Same', 'x'))).toMatch(/not found/)
    })

    it('a line number with nothing after it finds nothing', async () => {
      await create(shared('a'), LIST)
      expect(refusal(await edit('1| ', 'x'))).toMatch(/not found/)
    })
  })

  describe('new text empty and old text a whole line', () => {
    const cut = async (text: string, oldText: string) => {
      await create(shared('a'), text)
      return okNote(await notes.edit(shared('a'), { oldText, newText: '', expectedVersion: 1 }, model())).body
    }

    it.each([
      ['the first line', 'Milk\nBread\nApples', 'Milk', 'Bread\nApples'],
      ['a middle line', 'Milk\nBread\nApples', 'Bread', 'Milk\nApples'],
      ['the last line', 'Milk\nBread\nApples', 'Apples', 'Milk\nBread'],
      ['the only line', 'Milk', 'Milk', ''],
      ['two whole lines', 'Milk\nBread\nApples', 'Milk\nBread', 'Apples'],
    ])('removes %s and leaves no blank line', async (_name, text, oldText, want) => {
      expect(await cut(text, oldText)).toBe(want)
    })

    it('a part of a line stays a plain cut', async () => {
      expect(await cut('Milk two\nBread', ' two')).toBe('Milk\nBread')
    })

    it('old text with its own line break takes only that break', async () => {
      expect(await cut('Milk\n\nBread', 'Milk\n')).toBe('\nBread')
    })

    it('a replace of a whole line keeps its line break', async () => {
      await create(shared('a'), 'Milk\nBread')
      expect(okNote(await notes.edit(shared('a'), { oldText: 'Milk', newText: 'Eggs', expectedVersion: 1 }, model())).body).toBe('Eggs\nBread')
    })
  })

  describe('an append', () => {
    it.each([['\nEggs'], ['\n\nEggs'], ['\r\nEggs']])('trims the line breaks at the start of %j, as the app adds its own', async (newText) => {
      await create(shared('a'), 'Milk')
      expect(okNote(await notes.edit(shared('a'), { newText, expectedVersion: 1 }, model())).body).toBe('Milk\nEggs')
    })

    it('adds no second break to a note that ends with one', async () => {
      await create(shared('a'), 'Milk\n')
      expect(okNote(await notes.edit(shared('a'), { newText: '\nEggs', expectedVersion: 1 }, model())).body).toBe('Milk\nEggs')
    })

    it('keeps blank lines inside the new text', async () => {
      await create(shared('a'), 'Milk')
      expect(okNote(await notes.edit(shared('a'), { newText: '\nEggs\n\nTea', expectedVersion: 1 }, model())).body).toBe('Milk\nEggs\n\nTea')
    })

    it('only line breaks change nothing, so that is refused', async () => {
      await create(shared('a'), 'Milk')
      expect(refusal(await notes.edit(shared('a'), { newText: '\n\n', expectedVersion: 1 }, model()))).toMatch(/changes nothing/)
    })
  })

  it('refuses old text that equals new text, with a next step, and writes no version', async () => {
    const n = await create(shared('a'), 'Bread')
    const same = refusal(await notes.edit(shared('a'), { oldText: 'Bread', newText: 'Bread', expectedVersion: 1 }, model()))
    expect(same).toMatch(/^Error:/)
    expect(same).toContain('notes_read')
    // Line numbers do not hide it.
    expect(refusal(await notes.edit(shared('a'), { oldText: '1| Bread', newText: 'Bread', expectedVersion: 1 }, model()))).toBe(same)
    expect(await notes.revisions(n.id)).toHaveLength(1)
  })

  it('checks the size cap on an edit, but not on a change of tags', async () => {
    await notes.write(shared('big'), body(`${'y'.repeat(9000)} end`), YOU)
    expect(refusal(await notes.edit(shared('big'), { oldText: ' end', newText: ' the end', expectedVersion: 1 }, model()))).toMatch(/limit/)
    expect(refusal(await notes.edit(shared('big'), { newText: 'more', expectedVersion: 1 }, model()))).toMatch(/limit/)
    const n = okNote(await notes.edit(shared('big'), { tags: ['long'], expectedVersion: 1 }, model()))
    expect(n.tags).toEqual(['long'])
  })

  it('a fix that does not grow a long note goes through; growing past the cap does not', async () => {
    await notes.write(shared('big'), body(`${'y'.repeat(9000)} end`), YOU)
    const fixed = okNote(await notes.edit(shared('big'), { oldText: ' end', newText: ' End', expectedVersion: 1 }, model()))
    expect(fixed.body.endsWith(' End')).toBe(true)
    const cut = okNote(await notes.edit(shared('big'), { oldText: ' End', newText: '', expectedVersion: 2 }, model()))
    expect(cut.body).toHaveLength(9000)

    await create(shared('near'), 'x'.repeat(MAX_BODY))
    expect(refusal(await notes.edit(shared('near'), { newText: 'y', expectedVersion: 1 }, model()))).toMatch(/limit/)

    // A whole-note replace over the cap stays refused, even when it does not grow the note.
    expect(refusal(await notes.write(shared('big'), body('z'.repeat(8999), { expectedVersion: 3 }), model()))).toMatch(/limit/)
  })

  it('refuses an edit that changes nothing, and a bad description', async () => {
    await create(shared('a'))
    expect(refusal(await notes.edit(shared('a'), { expectedVersion: 1 }, model()))).toMatch(/^Error:/)
    expect(refusal(await notes.edit(shared('a'), { description: ' ', expectedVersion: 1 }, model()))).toMatch(/description/)
  })

  it('an edit of a missing note says to search', async () => {
    expect(refusal(await notes.edit(shared('none'), { newText: 'x', expectedVersion: 1 }, model()))).toMatch(/notes_search/)
  })
})

describe('move', () => {
  it('a moved note keeps its old path as an alias; read follows it', async () => {
    const n = await create(shared('lists/bugs'), 'moth')
    const moved = okNote(await notes.move(shared('lists/bugs'), 'shared/animals/insects', model()))
    expect(moved).toMatchObject({ id: n.id, path: 'animals/insects', version: 2 })
    expect(moved.aliases).toEqual(['shared/lists/bugs'])
    expect((await notes.read(shared('lists/bugs')))?.path).toBe('animals/insects')
    expect((await notes.read(shared('Lists/BUGS')))?.id).toBe(n.id)

    // A second move keeps both old places. Moving back drops that alias.
    const again = okNote(await notes.move(shared('animals/insects'), 'shared/fauna', model()))
    expect(again.aliases).toEqual(['shared/lists/bugs', 'shared/animals/insects'])
    const back = okNote(await notes.move(shared('lists/bugs'), 'shared/lists/bugs', model()))
    expect(back.aliases).toEqual(['shared/animals/insects', 'shared/fauna'])

    // A write to the old path updates the note. It starts no second one.
    const through = okNote(await notes.write(shared('fauna'), body('moth, wasp', { expectedVersion: back.version }), model()))
    expect(through.id).toBe(n.id)
    expect(await notes.list('shared')).toHaveLength(1)
  })

  it('refuses a path taken by another note, or by its old path, ignoring case', async () => {
    await create(shared('a'))
    await create(shared('zebra'))
    okNote(await notes.move(shared('zebra'), 'shared/horse', model()))
    expect(refusal(await notes.move(shared('a'), 'shared/HORSE', model()))).toMatch(/shared\/horse/)
    expect(refusal(await notes.move(shared('a'), 'shared/Zebra', model()))).toMatch(/shared\/horse/)
    expect(okNote(await notes.write(shared('Zebra'), body('still the horse', { expectedVersion: 2 }), model())).path).toBe('horse')
  })

  it('a change of case only is a rename, with no alias', async () => {
    await create(shared('recipes'))
    const n = okNote(await notes.move(shared('recipes'), 'shared/Recipes', model()))
    expect(n.path).toBe('Recipes')
    expect(n.aliases).toEqual([])
  })

  it('moves a chat note to the shared shelf; the old path works from that chat only', async () => {
    const n = await create(chat('todo'))
    const moved = okNote(await notes.move(chat('todo'), 'shared/todo', model()))
    expect(moved).toMatchObject({ id: n.id, shelf: 'shared', path: 'todo' })
    expect((await notes.read(chat('todo')))?.id).toBe(n.id)
    expect(await notes.list(CHAT)).toEqual([])

    // A shared note moved to a chat is that chat's: other chats do not see it.
    const down = await create(shared('secret'))
    okNote(await notes.move(shared('secret'), 'chat/secret', YOU))
    expect((await notes.read(shared('secret')))?.id).toBe(down.id)
    expect(await notes.read({ path: 'shared/secret', conversationId: 'other' })).toBeUndefined()
  })

  it('only "you" can move a shared note to a chat shelf', async () => {
    await create(shared('poem'), 'words')
    for (const by of [model(), { ...model(), writer: 'tidy' }]) {
      const r = refusal(await notes.move(shared('poem'), 'chat/poem', by))
      expect(r).toMatch(/^Error:/)
      expect(r).toMatch(/shared\//)
      expect(r).toMatch(/links to it/)
    }
    expect((await notes.read(shared('poem')))?.shelf).toBe('shared')
    expect(await notes.list(CHAT)).toEqual([])
  })

  it('refuses a bad new path', async () => {
    await create(shared('a'))
    expect(refusal(await notes.move(shared('a'), 'nowhere/a', model()))).toMatch(/shared\//)
  })
})

describe('delete', () => {
  it('delete is soft; restore brings it back', async () => {
    const n = await create(shared('a'), 'keep me')
    const gone = okNote(await notes.remove(shared('a'), model('c9')))
    expect(gone.deletedAt).not.toBeNull()
    expect(gone.body).toBe('keep me')
    expect(await notes.read(shared('a'))).toBeUndefined()
    expect(await notes.list('shared')).toEqual([])
    expect((await db.notes.get(n.id))?.body).toBe('keep me')

    const rev = await last(n.id)
    expect(rev.before?.body).toBe('keep me')
    expect(rev.after).toBeNull()

    expect(await notes.revert(rev.id, YOU)).toBe('done')
    const back = await notes.read(shared('a'))
    expect(back).toMatchObject({ id: n.id, body: 'keep me', deletedAt: null, version: 3 })
  })

  it('a removed path can be restored only while it is free', async () => {
    const old = await create(shared('a'), 'old text')
    okNote(await notes.remove(shared('a'), model()))
    await create(shared('a'), 'new text')
    expect(await notes.revert((await last(old.id)).id, YOU)).toBe('changed-later')
    // The old text stays in Trash. Both texts live.
    expect((await db.notes.get(old.id))?.body).toBe('old text')
    expect((await notes.read(shared('a')))?.body).toBe('new text')
  })

  it('a delete of a missing note says to search', async () => {
    expect(refusal(await notes.remove(shared('none'), model()))).toMatch(/notes_search/)
  })
})

describe('protection', () => {
  it('protected refuses edit, replace and delete, and allows move and tags', async () => {
    await notes.write(shared('poem'), body('Words stay', { protected: true }), model())
    const m = model()
    const edit = refusal(await notes.edit(shared('poem'), { oldText: 'Words', newText: 'Text', expectedVersion: 1 }, m))
    expect(edit).toMatch(/^Error:.*protected/)
    expect(edit).toMatch(/Move or tag/)
    expect(refusal(await notes.edit(shared('poem'), { newText: 'more', expectedVersion: 1 }, m))).toMatch(/protected/)
    expect(refusal(await notes.write(shared('poem'), body('New', { expectedVersion: 1 }), m))).toMatch(/protected/)
    expect(refusal(await notes.remove(shared('poem'), m))).toMatch(/protected/)
    expect(refusal(await notes.remove(shared('poem'), { ...m, writer: 'tidy' }))).toMatch(/protected/)
    expect((await notes.read(shared('poem')))?.body).toBe('Words stay')

    expect(refusal(await notes.edit(shared('poem'), { description: 'A poem', expectedVersion: 1 }, m))).toMatch(/protected/)
    expect(refusal(await notes.edit(shared('poem'), { description: 'A poem', tags: ['x'], expectedVersion: 1 }, { ...m, writer: 'tidy' }))).toMatch(/protected/)

    // Sending the same description again changes nothing, so it is no reason to refuse a tag.
    const tagged = okNote(await notes.edit(shared('poem'), { tags: ['verse'], description: 'A line', expectedVersion: 1 }, m))
    expect(tagged).toMatchObject({ tags: ['verse'], description: 'A line', body: 'Words stay', protected: true })
    const moved = okNote(await notes.move(shared('poem'), 'shared/poems/words', m))
    expect(moved).toMatchObject({ path: 'poems/words', body: 'Words stay', protected: true })
  })

  it('"you" can edit and delete a protected note', async () => {
    await notes.write(shared('poem'), body('Words stay', { protected: true }), model())
    expect(okNote(await notes.edit(shared('poem'), { oldText: 'stay', newText: 'stayed', description: 'A poem', expectedVersion: 1 }, YOU)).body).toBe('Words stayed')
    okNote(await notes.remove(shared('poem'), YOU))
    expect(await notes.read(shared('poem'))).toBeUndefined()
  })

  it('only "you" can clear protected', async () => {
    const n = await create(shared('poem'))
    const on = okNote(await notes.setProtected(n.id, true, model()))
    expect(on).toMatchObject({ protected: true, version: 2 })
    expect((await last(n.id)).writer).toBe('a/model')

    const r = refusal(await notes.setProtected(n.id, false, model()))
    expect(r).toMatch(/^Error:/)
    expect((await notes.read(shared('poem')))?.protected).toBe(true)
    expect((await notes.setProtected(n.id, false, { ...model(), writer: 'tidy' }))).toHaveProperty('refused')

    const off = okNote(await notes.setProtected(n.id, false, YOU))
    expect(off).toMatchObject({ protected: false, version: 3 })
    expect((await last(n.id)).writer).toBe('you')
  })

  it('a model cannot clear protected with a replace', async () => {
    await notes.write(shared('poem'), body('Words', { protected: true }), model())
    expect(refusal(await notes.write(shared('poem'), body('Words', { protected: false, expectedVersion: 1 }), model()))).toMatch(/protected/)
    expect((await notes.read(shared('poem')))?.protected).toBe(true)
  })

  it('setProtected on a note that is gone is refused, and adds no revision', async () => {
    expect(await notes.setProtected('none', true, YOU)).toHaveProperty('refused')
    const n = await create(shared('a'))
    okNote(await notes.setProtected(n.id, false, YOU))
    expect(await notes.revisions(n.id)).toHaveLength(1)
  })
})

describe('list and search', () => {
  it('list gives live notes of one shelf, by path', async () => {
    await create(shared('b'))
    await create(shared('a'))
    await create(chat('c'))
    await create(shared('gone'))
    okNote(await notes.remove(shared('gone'), model()))
    expect((await notes.list('shared')).map((n) => n.path)).toEqual(['a', 'b'])
    expect((await notes.list(CHAT)).map((n) => n.path)).toEqual(['c'])
  })

  it('search looks in path, description, tags and body, on the given shelves, and skips deleted notes', async () => {
    await notes.write(shared('stories/harbour'), body('Mira walked by the river at dawn.', { description: 'Harbour notes', tags: ['mira'] }), model())
    await notes.write(chat('todo'), body('Buy river stones'), model())
    await notes.write(chat('elsewhere', 'c2'), body('The river in another chat'), model())
    await notes.write(shared('gone'), body('river'), model())
    okNote(await notes.remove(shared('gone'), model()))

    const hits = await notes.search(['shared', CHAT], 'RIVER', 10)
    expect(hits.map((h) => h.note.path).sort()).toEqual(['stories/harbour', 'todo'])
    expect(hits.find((h) => h.note.path === 'stories/harbour')?.snippet).toContain('river')
    expect((await notes.search(['shared'], 'harbour', 10))[0].snippet).toBe('Harbour notes')
    expect((await notes.search(['shared'], 'mira dawn', 10)).map((h) => h.note.path)).toEqual(['stories/harbour'])
    expect(await notes.search(['shared'], 'mira nothing', 10)).toEqual([])
    expect(await notes.search(['shared'], '  ', 10)).toEqual([])
    expect(await notes.search(['shared', CHAT], 'river', 1)).toHaveLength(1)
  })

  it('search puts a hit in the path or description first', async () => {
    await notes.write(shared('z-body'), body('all about spring rain'), model())
    await notes.write(shared('a-other'), body('nothing', { description: 'The spring plan' }), model())
    expect((await notes.search(['shared'], 'spring', 10)).map((h) => h.note.path)).toEqual(['a-other', 'z-body'])
  })

  it('a snippet is short and on one line', async () => {
    await notes.write(shared('long'), body(`${'x '.repeat(500)}\nneedle\n${'y '.repeat(500)}`), model())
    const [hit] = await notes.search(['shared'], 'needle', 1)
    expect(hit.snippet).toContain('needle')
    expect(hit.snippet.length).toBeLessThan(200)
    expect(hit.snippet).not.toContain('\n')
  })
})

describe('byCall', () => {
  it('finds a write by call id, scoped by message, because a model can reuse call_0', async () => {
    const a = await create(shared('a'), 'one', model('call_0', 'm1'))
    const b = await create(shared('b'), 'two', model('call_0', 'm2'))
    expect((await notes.byCall('call_0', 'm1'))?.noteId).toBe(a.id)
    expect((await notes.byCall('call_0', 'm2'))?.noteId).toBe(b.id)
    expect(await notes.byCall('call_0', 'm3')).toBeUndefined()
    expect(await notes.byCall('none')).toBeUndefined()
    expect(await notes.byCall('call_0')).toBeDefined()
  })

  it('never returns an undo row', async () => {
    const n = await create(shared('a'), 'one', model('c1'))
    const rev = (await notes.byCall('c1'))!
    await notes.revert(rev.id, { ...YOU, callId: 'c1' })
    expect((await notes.byCall('c1'))?.id).toBe(rev.id)
    expect(await notes.revisions(n.id)).toHaveLength(2)
  })
})

describe('revert', () => {
  it('revert restores before; a create becomes a soft delete', async () => {
    const n = await create(shared('a'), 'one', model('c1'))
    const v2 = okNote(await notes.write(shared('a'), body('two', { expectedVersion: 1, tags: ['t'] }), model('c2')))
    expect(await notes.revert((await last(n.id)).id, YOU)).toBe('done')
    const back = await notes.read(shared('a'))
    expect(back).toMatchObject({ body: 'one', tags: [], version: v2.version + 1 })
    expect(back?.bodyHash).toBe(n.bodyHash)

    const undo = await last(n.id)
    expect(undo).toMatchObject({ writer: 'you', callId: null, version: 3 })
    expect(undo.before?.body).toBe('two')
    expect(undo.after?.body).toBe('one')

    // Create: nothing to restore, so the note goes to Trash, with its text.
    const fresh = await create(shared('b'), 'made', model('c3'))
    expect(await notes.revert((await last(fresh.id)).id, YOU)).toBe('done')
    expect(await notes.read(shared('b'))).toBeUndefined()
    expect((await db.notes.get(fresh.id))?.body).toBe('made')
    expect((await last(fresh.id)).after).toBeNull()
  })

  it('revert undoes a move, and the old path is free again', async () => {
    const n = await create(shared('a'), 'one')
    okNote(await notes.move(shared('a'), 'shared/b', model('c1')))
    expect(await notes.revert((await notes.byCall('c1'))!.id, YOU)).toBe('done')
    expect(await notes.read(shared('a'))).toMatchObject({ id: n.id, path: 'a', aliases: [] })
    expect(await notes.read(shared('b'))).toBeUndefined()
  })

  it('revert says changed-later when a newer revision exists', async () => {
    const n = await create(shared('a'), 'one', model('c1'))
    okNote(await notes.write(shared('a'), body('Mikael changed this', { expectedVersion: 1 }), YOU))
    const count = (await notes.revisions(n.id)).length
    expect(await notes.revert((await notes.byCall('c1'))!.id, YOU)).toBe('changed-later')
    expect((await notes.read(shared('a')))?.body).toBe('Mikael changed this')
    expect(await notes.revisions(n.id)).toHaveLength(count)
  })

  it('a second tap on the same revert changes nothing', async () => {
    const n = await create(shared('a'), 'one')
    okNote(await notes.write(shared('a'), body('two', { expectedVersion: 1 }), model('c2')))
    const rev = (await notes.byCall('c2'))!
    expect(await notes.revert(rev.id, YOU)).toBe('done')
    expect(await notes.revert(rev.id, YOU)).toBe('changed-later')
    expect((await notes.read(shared('a')))?.body).toBe('one')
    expect(await notes.revisions(n.id)).toHaveLength(3)
  })

  it('an unknown revision reads as changed-later', async () => {
    expect(await notes.revert('none', YOU)).toBe('changed-later')
  })

  it('a restored note gives up an old path that another note now holds', async () => {
    const a = await create(shared('old'), 'A text')
    okNote(await notes.move(shared('old'), 'shared/new', YOU))
    okNote(await notes.remove(shared('new'), YOU))
    await create(shared('old'), 'B text')
    await create(shared('other'), 'C text')
    expect(await notes.revert((await last(a.id)).id, YOU)).toBe('done')
    expect((await notes.read(shared('new')))?.aliases).toEqual([])
    expect((await notes.read(shared('old')))?.body).toBe('B text')

    // With B gone, the old path must not fall back to A.
    okNote(await notes.remove(shared('old'), YOU))
    expect(await notes.read(shared('old'))).toBeUndefined()
    expect(okNote(await notes.write(shared('old'), body('fresh', { isNew: true }), model())).path).toBe('old')
  })

  it('an old path that nobody took stays when a note is restored', async () => {
    const a = await create(shared('old'), 'A text')
    okNote(await notes.move(shared('old'), 'shared/new', YOU))
    okNote(await notes.remove(shared('new'), YOU))
    expect(await notes.revert((await last(a.id)).id, YOU)).toBe('done')
    expect((await notes.read(shared('old')))?.id).toBe(a.id)
  })

  it('an undo can itself be reverted, and the earlier write then counts as latest again', async () => {
    const n = await create(shared('a'), 'one', model('c1'))
    okNote(await notes.remove(shared('a'), YOU))
    expect(await notes.revert((await last(n.id)).id, YOU)).toBe('done')
    expect(await notes.revert((await last(n.id)).id, YOU)).toBe('done')
    expect(await notes.read(shared('a'))).toBeUndefined()
    expect(await notes.revert((await last(n.id)).id, YOU)).toBe('done')
    expect((await notes.read(shared('a')))?.body).toBe('one')
    expect(await notes.revert((await notes.byCall('c1'))!.id, YOU)).toBe('done')
    expect(await notes.read(shared('a'))).toBeUndefined()
  })
})

describe('undoCalls and redoCalls', () => {
  it('undoCalls touches chat-shelf writes only', async () => {
    const c = await create(chat('todo'), 'chat text', model('c1'))
    const s = await create(shared('list'), 'shared text', model('c2'))
    const report = await notes.undoCalls('m1', ['c1', 'c2'], 'chat')
    expect(report).toEqual({ undone: ['c1'], kept: [] })
    expect(await notes.read(chat('todo'))).toBeUndefined()
    expect((await notes.read(shared('list')))?.body).toBe('shared text')
    expect((await db.notes.get(c.id))?.deletedAt).not.toBeNull()
    expect(await notes.revisions(s.id)).toHaveLength(1)
  })

  it('a move between shelves counts as a shared write', async () => {
    await create(chat('todo'), 'x', model('c0'))
    okNote(await notes.move(chat('todo'), 'shared/todo', model('c1')))
    expect(await notes.undoCalls('m1', ['c1'], 'chat')).toEqual({ undone: [], kept: [] })
    expect((await notes.read(shared('todo')))?.body).toBe('x')
  })

  it('only touches writes of that message', async () => {
    await create(chat('a'), 'x', model('call_0', 'm1'))
    await create(chat('b'), 'y', model('call_0', 'm2'))
    expect(await notes.undoCalls('m2', ['call_0'], 'chat')).toEqual({ undone: ['call_0'], kept: [] })
    expect(await notes.read(chat('a'))).toBeDefined()
    expect(await notes.read(chat('b'))).toBeUndefined()
  })

  it('a reply that wrote one note twice undoes both, in any order given', async () => {
    await create(chat('a'), 'one', model('c1'))
    okNote(await notes.write(chat('a'), body('two', { expectedVersion: 1 }), model('c2')))
    okNote(await notes.write(chat('a'), body('three', { expectedVersion: 2 }), model('c3')))
    const report = await notes.undoCalls('m1', ['c1', 'c2', 'c3'], 'chat')
    expect(report.undone.sort()).toEqual(['c1', 'c2', 'c3'])
    expect(report.kept).toEqual([])
    expect(await notes.read(chat('a'))).toBeUndefined()
  })

  it('a note changed later stays, and the report says so', async () => {
    await create(chat('a'), 'one', model('c1'))
    okNote(await notes.write(chat('a'), body('Mikael wrote this', { expectedVersion: 1 }), YOU))
    expect(await notes.undoCalls('m1', ['c1'], 'chat')).toEqual({ undone: [], kept: ['c1'] })
    expect((await notes.read(chat('a')))?.body).toBe('Mikael wrote this')
  })

  it('a later write stops the undo at that point: nothing it built on is pulled out', async () => {
    await create(chat('a'), 'one', model('c1', 'm1'))
    okNote(await notes.write(chat('a'), body('two', { expectedVersion: 1 }), model('c2', 'm2')))
    okNote(await notes.write(chat('a'), body('three', { expectedVersion: 2 }), model('c3', 'm1')))
    const report = await notes.undoCalls('m1', ['c1', 'c3'], 'chat')
    expect(report).toEqual({ undone: ['c3'], kept: ['c1'] })
    expect((await notes.read(chat('a')))?.body).toBe('two')
  })

  it('leaves out reads and a write that is already undone, so a redo cannot bring that back', async () => {
    await create(chat('a'), 'one', model('c1'))
    await notes.revert((await notes.byCall('c1'))!.id, YOU)
    expect(await notes.undoCalls('m1', ['c1', 'a-read'], 'chat')).toEqual({ undone: [], kept: [] })
  })

  it('a write whose undo was taken back counts as live again', async () => {
    const n = await create(chat('a'), 'one', model('c1'))
    await notes.revert((await notes.byCall('c1'))!.id, YOU)
    await notes.revert((await last(n.id)).id, YOU)
    expect((await notes.read(chat('a')))?.body).toBe('one')
    expect(await notes.undoCalls('m1', ['c1'], 'chat')).toEqual({ undone: ['c1'], kept: [] })
    expect(await notes.read(chat('a'))).toBeUndefined()
  })

  it('redoCalls puts undone writes back, oldest first', async () => {
    await create(chat('a'), 'one', model('c1'))
    okNote(await notes.write(chat('a'), body('two', { expectedVersion: 1 }), model('c2')))
    await create(chat('b'), 'other', model('c3'))
    const { undone } = await notes.undoCalls('m1', ['c1', 'c2', 'c3'], 'chat')
    await notes.redoCalls(undone, 'm1')
    expect((await notes.read(chat('a')))?.body).toBe('two')
    expect((await notes.read(chat('b')))?.body).toBe('other')
  })

  it('redo acts only in reverse order of the undos, so a chain stays whole', async () => {
    await create(chat('a'), 'one', model('c1'))
    okNote(await notes.write(chat('a'), body('two', { expectedVersion: 1 }), model('c2')))
    await notes.undoCalls('m1', ['c1', 'c2'], 'chat')
    await notes.redoCalls(['c2'], 'm1')
    expect(await notes.read(chat('a'))).toBeUndefined()
    await notes.redoCalls(['c1'], 'm1')
    expect((await notes.read(chat('a')))?.body).toBe('one')
    await notes.redoCalls(['c2'], 'm1')
    expect((await notes.read(chat('a')))?.body).toBe('two')
  })

  it('redo does not bring back a note Mikael restored and then deleted', async () => {
    const n = await create(chat('a'), 'one', model('c1'))
    const { undone } = await notes.undoCalls('m1', ['c1'], 'chat')
    expect(await notes.revert((await last(n.id)).id, YOU)).toBe('done')
    okNote(await notes.remove(chat('a'), YOU))
    await notes.redoCalls(undone, 'm1')
    expect(await notes.read(chat('a'))).toBeUndefined()
  })

  it('redo does nothing to a write that was never undone, even when the text matches', async () => {
    await create(chat('a'), 'one', model('c1'))
    okNote(await notes.write(chat('a'), body('two', { expectedVersion: 1 }), model('c2')))
    okNote(await notes.write(chat('a'), body('one'), YOU))
    await notes.redoCalls(['c2'], 'm1')
    expect((await notes.read(chat('a')))?.body).toBe('one')
  })

  it('redo does nothing after a later write, even when that write was undone too', async () => {
    await create(chat('a'), 'one', model('c1'))
    okNote(await notes.write(chat('a'), body('two', { expectedVersion: 1 }), model('c2')))
    await notes.undoCalls('m1', ['c2'], 'chat')
    okNote(await notes.write(chat('a'), body('three'), YOU))
    const n = (await notes.read(chat('a')))!
    await notes.revert((await last(n.id)).id, YOU)
    await notes.redoCalls(['c2'], 'm1')
    expect((await notes.read(chat('a')))?.body).toBe('one')
  })

  it('redoCalls reports what it redid and what stayed', async () => {
    await create(chat('a'), 'one', model('c1'))
    await create(chat('b'), 'two', model('c2'))
    await notes.undoCalls('m1', ['c1', 'c2'], 'chat')
    okNote(await notes.write(chat('b'), body('Mikael wrote this'), YOU))
    expect(await notes.redoCalls(['c1', 'c2', 'nope'], 'm1')).toEqual({ redone: ['c1'], kept: ['nope', 'c2'] })
    expect(await notes.redoCalls(['c1'], 'm1')).toEqual({ redone: [], kept: ['c1'] })
  })

  it('redoCalls leaves a note that changed after the undo', async () => {
    await create(chat('a'), 'one', model('c1'))
    okNote(await notes.write(chat('a'), body('two', { expectedVersion: 1 }), model('c2')))
    await notes.undoCalls('m1', ['c2'], 'chat')
    okNote(await notes.write(chat('a'), body('Mikael wrote this', { expectedVersion: 3 }), YOU))
    const before = await notes.revisions((await notes.read(chat('a')))!.id)
    await notes.redoCalls(['c2'], 'm1')
    expect((await notes.read(chat('a')))?.body).toBe('Mikael wrote this')
    expect(await notes.revisions(before[0].noteId)).toHaveLength(before.length)
  })

  it('redo of a create does not take a path that a new note now holds', async () => {
    const old = await create(chat('a'), 'old', model('c1'))
    await notes.undoCalls('m1', ['c1'], 'chat')
    await create(chat('a'), 'new', model('c2'))
    await notes.redoCalls(['c1'], 'm1')
    expect((await notes.read(chat('a')))?.body).toBe('new')
    expect((await db.notes.get(old.id))?.body).toBe('old')
  })

  it('redo twice is safe, and a redone write can be undone again', async () => {
    await create(chat('a'), 'one', model('c1'))
    okNote(await notes.write(chat('a'), body('two', { expectedVersion: 1 }), model('c2')))
    await notes.undoCalls('m1', ['c2'], 'chat')
    await notes.redoCalls(['c2'], 'm1')
    await notes.redoCalls(['c2'], 'm1')
    const n = (await notes.read(chat('a')))!
    expect(n.body).toBe('two')
    expect(await notes.revisions(n.id)).toHaveLength(4)
    const rev = (await notes.byCall('c2'))!
    expect(await notes.revert(rev.id, YOU)).toBe('done')
    expect((await notes.read(chat('a')))?.body).toBe('one')
    await notes.redoCalls(['c2'], 'm1')
    expect((await notes.read(chat('a')))?.body).toBe('two')
  })

  it('redoCalls can be scoped by message, because a model can reuse call_0', async () => {
    await create(chat('a'), 'x', model('call_0', 'm1'))
    await create(chat('b'), 'y', model('call_0', 'm2'))
    await notes.undoCalls('m1', ['call_0'], 'chat')
    await notes.undoCalls('m2', ['call_0'], 'chat')
    await notes.redoCalls(['call_0'], 'm1')
    expect(await notes.read(chat('a'))).toBeDefined()
    expect(await notes.read(chat('b'))).toBeUndefined()
  })

  it('redo brings a deleted note back to deleted', async () => {
    await create(chat('a'), 'x')
    okNote(await notes.remove(chat('a'), model('c1')))
    await notes.undoCalls('m1', ['c1'], 'chat')
    expect(await notes.read(chat('a'))).toBeDefined()
    await notes.redoCalls(['c1'], 'm1')
    expect(await notes.read(chat('a'))).toBeUndefined()
  })
})

describe('deleteChat and restoreChat', () => {
  const setup = async () => {
    const c = await storage.createConversation()
    const trashed = await create(chat('already', c.id), 'in Trash first')
    okNote(await notes.remove(chat('already', c.id), model()))
    await new Promise((r) => setTimeout(r, 2))
    const live = await create(chat('todo', c.id), 'chat text', model('c1'))
    const kept = await create(shared('list'), 'shared text')
    return { id: c.id, trashed, live, kept }
  }

  it('deleteChat soft-deletes chat-shelf notes and restoreChat brings them back', async () => {
    const { id, trashed, live, kept } = await setup()
    const trashedAt = (await db.notes.get(trashed.id))?.deletedAt
    const undo = await deleteChat(id)

    const gone = await db.notes.get(live.id)
    expect(gone?.deletedAt).toBe(undo?.notesDeletedAt)
    expect(gone?.body).toBe('chat text')
    expect(await notes.read(chat('todo', id))).toBeUndefined()
    expect(await notes.read(shared('list'))).toBeDefined()
    expect((await last(live.id)).after).toBeNull()
    expect((await last(live.id)).writer).toBe('you')

    await restoreChat(undo!)
    expect((await notes.read(chat('todo', id)))?.body).toBe('chat text')
    expect(await storage.getConversation(id)).toBeDefined()
    // Ruling P8: a note that was in Trash before the delete stays there.
    expect((await db.notes.get(trashed.id))?.deletedAt).toBe(trashedAt)
    expect(await notes.revisions(kept.id)).toHaveLength(1)

    // The write counts as latest again, so its Undo still works.
    expect(await notes.undoCalls('m1', ['c1'], 'chat')).toEqual({ undone: ['c1'], kept: [] })
  })

  it('a note moved to the shared shelf stays when its chat goes', async () => {
    const c = await storage.createConversation()
    await create(chat('todo', c.id))
    okNote(await notes.move(chat('todo', c.id), 'shared/todo', model()))
    await deleteChat(c.id)
    expect((await notes.list('shared')).map((n) => n.path)).toEqual(['todo'])
  })
})

describe('reads and restores for the vault', () => {
  const remove = async (ref: NoteRef, by: Writer = YOU) => okNote(await notes.remove(ref, by))

  it('get finds a note by id, in Trash too', async () => {
    const n = await create(shared('a'))
    expect((await notes.get(n.id))?.path).toBe('a')
    await remove(shared('a'))
    expect((await notes.get(n.id))?.deletedAt).not.toBeNull()
    expect(await notes.get('nobody')).toBeUndefined()
  })

  it('all lists the live notes of every shelf', async () => {
    await create(shared('a'))
    await create(chat('b'))
    await create(chat('c', 'c2'))
    await create(shared('gone'))
    await remove(shared('gone'))
    expect((await notes.all()).map((n) => `${n.shelf}/${n.path}`).sort()).toEqual(['c1/b', 'c2/c', 'shared/a'])
  })

  it('trash lists the deleted notes, the newest delete first', async () => {
    await create(shared('old'))
    await create(chat('new'))
    await create(shared('live'))
    const first = await remove(shared('old'))
    const second = await remove(chat('new'))
    await db.notes.update(first.id, { deletedAt: 100 })
    await db.notes.update(second.id, { deletedAt: 200 })
    expect((await notes.trash()).map((n) => n.path)).toEqual(['new', 'old'])
  })

  it('restore brings a note back with a revision by the writer', async () => {
    const n = await create(shared('a'), 'kept words')
    await remove(shared('a'))
    const back = okNote(await notes.restore(n.id, YOU))
    expect(back).toMatchObject({ deletedAt: null, body: 'kept words', version: 3 })
    expect((await notes.read(shared('a')))?.id).toBe(n.id)
    expect((await last(n.id)).writer).toBe('you')
    expect((await last(n.id)).after?.deletedAt).toBeNull()
    expect((await last(n.id)).undoes).toBeUndefined()
  })

  it('a restore is a later write, so Undo on the delete line leaves the note alone', async () => {
    const n = await create(shared('a'))
    await notes.remove(shared('a'), model('call-del', 'm2'))
    const del = await last(n.id)
    okNote(await notes.restore(n.id, YOU))
    expect(await notes.revert(del.id, YOU)).toBe('changed-later')
    expect((await notes.read(shared('a')))?.id).toBe(n.id)
  })

  it('restore is refused while another note holds the path, and the note stays in Trash', async () => {
    const n = await create(shared('a'))
    await remove(shared('a'))
    await create(shared('a'), 'the new one')
    const r = refusal(await notes.restore(n.id, YOU))
    expect(r).toMatch(/^Error:/)
    expect(r).toMatch(/shared\/a/)
    expect((await notes.get(n.id))?.deletedAt).not.toBeNull()
    expect((await notes.read(shared('a')))?.body).toBe('the new one')
  })

  it('restore refuses a note that is not in Trash, and one that is gone', async () => {
    const n = await create(shared('a'))
    expect(refusal(await notes.restore(n.id, YOU))).toMatch(/^Error:/)
    expect(await notes.revisions(n.id)).toHaveLength(1)
    expect(refusal(await notes.restore('nobody', YOU))).toMatch(/^Error:/)
  })

  it('a restored note drops an old path that another note took while it was away', async () => {
    const n = await create(shared('old'))
    okNote(await notes.move(shared('old'), 'shared/new', model()))
    await remove(shared('new'))
    await create(shared('old'), 'someone else')
    const back = okNote(await notes.restore(n.id, YOU))
    expect(back.aliases).toEqual([])
    expect((await notes.read(shared('old')))?.body).toBe('someone else')
  })

  it('restoreRevision puts back the words, description and tags as a new write', async () => {
    const n = okNote(await notes.write(shared('a'), body('first', { tags: ['one'] }), model()))
    okNote(await notes.write(shared('a'), { body: 'second', description: 'New line', tags: ['two'], expectedVersion: 1 }, model()))
    const [v1] = await notes.revisions(n.id)
    const back = okNote(await notes.restoreRevision(v1.id, 2, YOU))
    expect(back).toMatchObject({ body: 'first', description: 'A line', tags: ['one'], version: 3 })
    expect((await last(n.id)).writer).toBe('you')
    expect((await last(n.id)).before?.body).toBe('second')
    // The stored hash follows the words.
    expect(back.bodyHash).toBe(v1.after?.bodyHash)
  })

  it('restoreRevision keeps the path and the protection of today', async () => {
    const n = await create(shared('a'), 'first')
    okNote(await notes.write(shared('a'), body('second', { expectedVersion: 1 }), model()))
    okNote(await notes.move(shared('a'), 'shared/b', model()))
    okNote(await notes.setProtected(n.id, true, YOU))
    const [v1] = await notes.revisions(n.id)
    const back = okNote(await notes.restoreRevision(v1.id, 4, YOU))
    expect(back).toMatchObject({ path: 'b', protected: true, body: 'first' })
  })

  it('restoreRevision refuses a model on a protected note', async () => {
    const n = await create(shared('a'), 'first')
    okNote(await notes.write(shared('a'), body('second', { expectedVersion: 1 }), model()))
    okNote(await notes.setProtected(n.id, true, model()))
    const [v1] = await notes.revisions(n.id)
    expect(refusal(await notes.restoreRevision(v1.id, 3, model()))).toMatch(/protected/)
  })

  it('restoreRevision of the words a note has now writes nothing', async () => {
    const n = await create(shared('a'))
    okNote(await notes.setProtected(n.id, true, YOU))
    const [v1] = await notes.revisions(n.id)
    expect(okNote(await notes.restoreRevision(v1.id, 2, YOU)).version).toBe(2)
    expect(await notes.revisions(n.id)).toHaveLength(2)
  })

  it('restoreRevision refuses a delete row, a note in Trash and an unknown id', async () => {
    const n = await create(shared('a'))
    await remove(shared('a'))
    const [v1, del] = await notes.revisions(n.id)
    expect(refusal(await notes.restoreRevision(del.id, 2, YOU))).toMatch(/^Error:/)
    expect(refusal(await notes.restoreRevision(v1.id, 2, YOU))).toMatch(/Trash/)
    expect(refusal(await notes.restoreRevision('nobody', 2, YOU))).toMatch(/^Error:/)
  })

  it('restoreRevision refuses a stale version and writes nothing', async () => {
    const n = await create(shared('a'), 'first')
    okNote(await notes.write(shared('a'), body('second', { expectedVersion: 1 }), model()))
    const [v1] = await notes.revisions(n.id)
    okNote(await notes.write(shared('a'), body('third', { expectedVersion: 2 }), model()))

    const r = refusal(await notes.restoreRevision(v1.id, 2, YOU))
    expect(r).toMatch(/^Error:/)
    expect(r).toMatch(/version 3/)
    expect((await notes.read(shared('a')))?.body).toBe('third')
    expect(await notes.revisions(n.id)).toHaveLength(3)
  })

  it('refOf finds a note on any shelf, a chat with no row included', async () => {
    const a = await create(shared('a'))
    const b = await create(chat('b', 'gone-chat'))
    expect((await notes.read(refOf(a)))?.id).toBe(a.id)
    expect((await notes.read(refOf(b)))?.id).toBe(b.id)
    // Mikael's edit on a chat that is not open works the same.
    expect(okNote(await notes.edit(refOf(b), { newText: 'more', expectedVersion: 1 }, YOU)).version).toBe(2)
  })

  it('refOf lets a shared note move to the given chat', async () => {
    const a = await create(shared('a'))
    expect(okNote(await notes.move(refOf(a, 'c2'), 'chat/a', YOU)).shelf).toBe('c2')
  })
})
