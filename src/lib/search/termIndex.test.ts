import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, newId, storage } from '../storage'
import type { ContentPart, Message } from '../types'
import { editedVersion, withActive, withNewVersion } from '../versions'
import { hashText } from '../hash'
import { createSearchIndex, MAX_QUERY_WORDS, MAX_ROWS_PER_TOKEN, MS_PER_TERM, searchIndex } from './termIndex'

let chat: string

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  chat = (await storage.createConversation()).id
})

afterEach(() => {
  vi.restoreAllMocks()
})

const version = (content: ContentPart[]) => ({ id: newId(), content, status: 'done' as const, createdAt: 1 })
const text = (t: string, conversationId = chat): Promise<Message> =>
  storage.appendMessage(conversationId, 'user', version([{ type: 'text', text: t }]))
async function indexed(t: string, conversationId = chat): Promise<Message> {
  const m = await text(t, conversationId)
  await searchIndex.index(m.id)
  return m
}
/** A message from this moment, not from now. */
const at = async (m: Message, createdAt: number): Promise<void> => void (await db.messages.update(m.id, { createdAt }))
/** A message and its row, from this moment. */
async function indexedAt(t: string, createdAt: number): Promise<Message> {
  const m = await text(t)
  await at(m, createdAt)
  await searchIndex.index(m.id)
  return m
}
/** A row by hand, with no message behind it. */
const row = (n: number, messageId: string, term: string, textHash = 'x') => ({ n, messageId, conversationId: chat, terms: [`${chat}:${term}`], textHash })
const numberOf = async (id: string): Promise<number> => (await db.searchDocs.where('messageId').equals(id).first())!.n
const found = async (query: string, conversationId = chat): Promise<string[]> =>
  (await searchIndex.search(conversationId, query, 50)).map((h) => h.messageId)
/** Runs a pass to its end. */
async function pass(): Promise<void> {
  while (!(await searchIndex.backfill(1000)));
}

describe('search', () => {
  it('finds a word with ä and ö, and not its folded spelling', async () => {
    const m = await indexed('Hyvää yötä')
    expect(await found('yötä')).toEqual([m.id])
    expect(await found('yota')).toEqual([])
  })

  it('finds a Finnish inflection through the stem', async () => {
    const singular = await indexed('Näin kissan pihalla')
    const plural = await indexed('Annoin ruokaa kissoille')
    expect((await found('kissa')).sort()).toEqual([singular.id, plural.id].sort())
    expect((await found('kissan')).sort()).toEqual([singular.id, plural.id].sort())
  })

  it('prefix search finds a compound start', async () => {
    const m = await indexed('Kävin eilen kirjastossa')
    expect(await found('kirja')).toEqual([m.id])
  })

  it('a word under three letters matches whole, not as a prefix', async () => {
    const m = await indexed('ja sitten jalka')
    await indexed('jalka vain')
    expect(await found('ja')).toEqual([m.id])
  })

  it('an edit replaces the old terms', async () => {
    const m = await indexed('kissa')
    const edited = await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'koira')))
    await searchIndex.index(edited!.id)
    expect(await found('kissa')).toEqual([])
    expect(await found('koira')).toEqual([m.id])
  })

  it('reads the active version only', async () => {
    const m = await indexed('kissa')
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'koira')))
    const flipped = await storage.mutateMessage(m.id, (x) => withActive(x, 0))
    await searchIndex.index(flipped!.id)
    expect(await found('kissa')).toEqual([m.id])
    expect(await found('koira')).toEqual([])
  })

  it('a deleted message leaves the index', async () => {
    const m = await indexed('kissa')
    await storage.deleteMessage(m.id)
    await searchIndex.remove(m.id)
    expect(await found('kissa')).toEqual([])
    expect(await db.searchDocs.count()).toBe(0)
  })

  it('a message deleted before its index call leaves no row', async () => {
    const m = await text('kissa')
    await storage.deleteMessage(m.id)
    await searchIndex.index(m.id)
    expect(await db.searchDocs.count()).toBe(0)
  })

  it('search scores more matching terms higher', async () => {
    const one = await indexed('kissa nukkuu')
    const both = await indexed('kissa ja koira')
    const hits = await searchIndex.search(chat, 'kissa koira', 10)
    expect(hits.map((h) => h.messageId)).toEqual([both.id, one.id])
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it('a whole word scores above a stem that only starts the same', async () => {
    const near = await indexed('kisko')
    const whole = await indexed('kissa')
    expect((await searchIndex.search(chat, 'kissa', 10)).map((h) => h.messageId)).toEqual([whole.id, near.id])
  })

  it('stays inside the chat', async () => {
    const other = (await storage.createConversation()).id
    await indexed('kissa', other)
    expect(await found('kissa')).toEqual([])
  })

  it('files each term under its chat, so a search reads no row of another chat', async () => {
    await indexed('kissa')
    const [row] = await db.searchDocs.toArray()
    expect(row.terms.length).toBeGreaterThan(0)
    for (const term of row.terms) expect(term.startsWith(`${chat}:`)).toBe(true)
    const everyRow = vi.spyOn(db.table('searchDocs'), 'where')
    await searchIndex.search(chat, 'kissa', 5)
    expect(everyRow.mock.calls.map(([index]) => index)).not.toContain('conversationId')
  })

  it('reads a bounded number of rows for a common word, the exact word first', async () => {
    const common = Array.from({ length: MAX_ROWS_PER_TOKEN + 50 }, (_, i) => row(i, `a${i}`, 'kissalla'))
    await db.searchDocs.bulkPut([...common, row(1_000_000, 'z-rare', 'kissa')])
    const hits = await searchIndex.search(chat, 'kissa', MAX_ROWS_PER_TOKEN * 2)
    expect(hits).toHaveLength(MAX_ROWS_PER_TOKEN)
    expect(hits.map((h) => h.messageId)).toContain('z-rare')
  })

  it('past the cap, the newest rows of a word stay', async () => {
    await db.searchDocs.bulkPut(Array.from({ length: MAX_ROWS_PER_TOKEN + 50 }, (_, i) => row(i, `m${i}`, 'kissa')))
    const ids = (await searchIndex.search(chat, 'kissa', MAX_ROWS_PER_TOKEN * 2)).map((h) => h.messageId)
    expect(ids).toContain('m0')
    expect(ids).toContain(`m${MAX_ROWS_PER_TOKEN - 1}`)
    expect(ids).not.toContain(`m${MAX_ROWS_PER_TOKEN}`)
  })

  it('reads each distinct token once', async () => {
    await indexed('kissa')
    const where = vi.spyOn(db.table('searchDocs'), 'where')
    await searchIndex.search(chat, 'kissa kissan kissat kissa', 5) // kis is a stem of all three
    const reads = where.mock.calls.filter(([index]) => (index as unknown) === 'terms')
    expect(reads).toHaveLength(new Set(['kissa', 'kissan', 'kissat', 'kis']).size)
  })

  it('reads the query up to its word limit and drops the rest', async () => {
    const m = await indexed('kaukainen')
    const fill = Array.from({ length: MAX_QUERY_WORDS }, (_, i) => `sana${i}`).join(' ')
    expect(await found(`${fill} kaukainen`)).toEqual([])
    expect(await found(`kaukainen ${fill}`)).toEqual([m.id])
  })

  it('a form of a word and the word itself each use up a word of the limit', async () => {
    const m = await indexed('kaukainen')
    const forms = Array.from({ length: MAX_QUERY_WORDS }, (_, i) => `talo${'a'.repeat(i + 1)}`).join(' ')
    expect(await found(`${forms} kaukainen`)).toEqual([])
    expect(await found('kaukainen kaukaisen')).toEqual([m.id])
  })

  it('finds ids only for the rows it returns', async () => {
    for (let i = 0; i < 12; i++) await indexed(`kissa ${i}`)
    const bulkGet = vi.spyOn(db.table('searchDocs'), 'bulkGet')
    expect(await searchIndex.search(chat, 'kissa', 3)).toHaveLength(3)
    expect(bulkGet.mock.calls.flatMap(([keys]) => keys as unknown[])).toHaveLength(3)
  })

  it('a rare word beats a common word', async () => {
    for (let i = 0; i < 30; i++) await indexed(`ja ${i}`)
    const rare = await indexed('mira')
    const hits = await searchIndex.search(chat, 'mira ja', 5)
    expect(hits[0].messageId).toBe(rare.id)
  })

  it('a word at the cap weighs the least', async () => {
    const common = Array.from({ length: MAX_ROWS_PER_TOKEN + 1 }, (_, i) => row(i, `m${i}`, 'ja'))
    const nearly = Array.from({ length: MAX_ROWS_PER_TOKEN - 1 }, (_, i) => row(100_000 + i, `n${i}`, 'on'))
    await db.searchDocs.bulkPut([...common, ...nearly])
    const hits = await searchIndex.search(chat, 'ja on', MAX_ROWS_PER_TOKEN * 2)
    const score = (id: string) => hits.find((h) => h.messageId === id)!.score
    expect(score('m0')).toBeLessThan(score('n0'))
  })

  it('ties go to the newest message', async () => {
    const old = await indexedAt('kissa', 1000)
    const newest = await indexedAt('kissa', 3000)
    const mid = await indexedAt('kissa', 2000)
    expect(await found('kissa')).toEqual([newest.id, mid.id, old.id])
  })

  it('stops at the limit', async () => {
    await indexed('kissa yksi')
    await indexed('kissa kaksi')
    expect(await searchIndex.search(chat, 'kissa', 1)).toHaveLength(1)
  })

  it('finds nothing for a query with no words', async () => {
    await indexed('kissa')
    expect(await searchIndex.search(chat, ' … ', 10)).toEqual([])
  })
})

describe('row numbers', () => {
  it('sorts by message time, newest lowest', async () => {
    const old = await indexedAt('kissa', 1000)
    const newest = await indexedAt('koira', 2000)
    expect(await numberOf(newest.id)).toBeLessThan(await numberOf(old.id))
  })

  it('gives two messages of one millisecond their own rows', async () => {
    const a = await indexedAt('kissa', 1000)
    const b = await indexedAt('koira', 1000)
    expect(await db.searchDocs.count()).toBe(2)
    expect(await numberOf(a.id)).not.toBe(await numberOf(b.id))
  })

  it('a clash stays inside its millisecond', async () => {
    const before = await indexedAt('kissa', 1001)
    const a = await indexedAt('kissa', 1000)
    const b = await indexedAt('kissa', 1000)
    const after = await indexedAt('kissa', 999)
    const order = await Promise.all([before, a, b, after].map((m) => numberOf(m.id)))
    expect(order[0]).toBeLessThan(Math.min(order[1], order[2]))
    expect(Math.max(order[1], order[2])).toBeLessThan(order[3])
  })

  it('holds under index calls at the same moment', async () => {
    const ms = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const m = await text(`kissa ${i}`)
      await at(m, 1000)
      return m
    }))
    await Promise.all(ms.map((m) => searchIndex.index(m.id)))
    expect(await db.searchDocs.count()).toBe(8)
    expect(new Set(await db.searchDocs.toCollection().primaryKeys()).size).toBe(8)
  })

  it('holds in a pass, and beside rows already there', async () => {
    const first = await indexedAt('kissa', 1000)
    for (let i = 0; i < 40; i++) await at(await text(`koira ${i}`), 1000)
    await pass()
    expect(await db.searchDocs.count()).toBe(41)
    expect(await numberOf(first.id)).toBe(-1000 * 1024)
  })

  it('re-indexing keeps the row and its number', async () => {
    const m = await indexedAt('kissa', 1000)
    await indexedAt('koira', 1000)
    const n = await numberOf(m.id)
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'lintu')))
    await searchIndex.index(m.id)
    await searchIndex.index(m.id)
    expect(await db.searchDocs.count()).toBe(2)
    expect(await numberOf(m.id)).toBe(n)
    expect(await found('lintu')).toEqual([m.id])
  })

  it('a pass repair keeps the number too', async () => {
    const m = await indexedAt('kissa', 1000)
    const n = await numberOf(m.id)
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'lintu')))
    await pass()
    expect(await db.searchDocs.count()).toBe(1)
    expect(await numberOf(m.id)).toBe(n)
  })
})

describe('whole chats', () => {
  it('removeChat takes the chat out in one call, and leaves other chats', async () => {
    const other = (await storage.createConversation()).id
    await indexed('kissa')
    await indexed('koira')
    const kept = await indexed('kissa', other)
    await searchIndex.removeChat(chat)
    expect(await found('kissa')).toEqual([])
    expect(await found('kissa', other)).toEqual([kept.id])
    expect(await db.searchDocs.count()).toBe(1)
  })
})

describe('what goes in', () => {
  it('leaves tool steps out', async () => {
    const step: ContentPart = { type: 'tool', callId: 'c', round: 0, model: 'm', name: 'read_note', args: { path: 'mira' }, result: 'mira', status: 'done' }
    const m = await storage.appendMessage(chat, 'assistant', version([step, { type: 'text', text: 'kissa' }]))
    await searchIndex.index(m.id)
    expect(await found('mira')).toEqual([])
    expect(await found('read_note')).toEqual([])
    expect(await found('kissa')).toEqual([m.id])
  })

  it('stores no row for a message with no text', async () => {
    const divider = await storage.appendMessage(chat, 'divider', version([]))
    await searchIndex.index(divider.id)
    expect(await db.searchDocs.count()).toBe(0)
  })

  it('keeps words apart across a tool step', async () => {
    const step: ContentPart = { type: 'tool', callId: 'c', round: 0, model: 'm', name: 'read_note', args: {}, result: '', status: 'done' }
    const m = await storage.appendMessage(chat, 'assistant', version([{ type: 'text', text: 'Katson muistiinpanoa' }, step, { type: 'text', text: 'Mira asuu Oulussa' }]))
    await searchIndex.index(m.id)
    expect(await found('mira')).toEqual([m.id])
    expect(await found('muistiinpanoamira')).toEqual([])
  })

  it('takes the row away when the active version has no text', async () => {
    const m = await indexed('kissa')
    const empty = await storage.mutateMessage(m.id, (x) => withNewVersion(x, version([])))
    await searchIndex.index(empty!.id)
    expect(await db.searchDocs.count()).toBe(0)
  })
})

describe('backfill', () => {
  it('indexes messages that have no row and says when it is done', async () => {
    const a = await text('kissa')
    const b = await text('koira')
    expect(await searchIndex.backfill(1000)).toBe(true)
    expect(await found('kissa')).toEqual([a.id])
    expect(await found('koira')).toEqual([b.id])
  })

  it('backfill resumes where it stopped', async () => {
    for (let i = 0; i < 5; i++) await text(`kissa ${i}`)
    expect(await searchIndex.backfill(0)).toBe(false)
    expect(await searchIndex.backfill(0)).toBe(false)
    expect(await db.searchDocs.count()).toBe(2)

    // A killed run: a new index on the same database knows only what is stored.
    const put = vi.spyOn(db.table('searchDocs'), 'bulkPut')
    const again = createSearchIndex(db)
    while (!(await again.backfill(0)));
    expect(await db.searchDocs.count()).toBe(5)
    expect(put.mock.calls.flatMap(([rows]) => rows as unknown[])).toHaveLength(3)
  })

  it('backfill yields within its budget', async () => {
    for (let i = 0; i < 60; i++) await text(`kissa ${i}`)
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 1))
    expect(await searchIndex.backfill(10)).toBe(false)
    const done = await db.searchDocs.count()
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThanOrEqual(10)
  })

  // The clock is real here, and the count holds on any machine, because a slice charges its writes
  // up front. This proves the count only. How long a slice really takes on IndexedDB is a bench number.
  it('a slice pays for its writes, so it writes no more rows than its budget buys', async () => {
    const words = Array.from({ length: 40 }, (_, i) => `sana${i}`).join(' ')
    for (let i = 0; i < 60; i++) await text(words)
    const terms = (await indexed(words)).id
    const perRow = (await db.searchDocs.where('messageId').equals(terms).first())!.terms.length
    await db.searchDocs.clear()

    const budget = 30
    await searchIndex.backfill(budget)
    expect(await db.searchDocs.count()).toBeLessThanOrEqual(Math.ceil(budget / (perRow * MS_PER_TERM)) + 1)
  })

  it('a slice always moves on, however large the first message', async () => {
    const words = Array.from({ length: 500 }, (_, i) => `sana${i}`).join(' ')
    await text(words)
    await text(words)
    expect(await searchIndex.backfill(1)).toBe(false)
    expect(await db.searchDocs.count()).toBe(1)
  })

  describe('passDue', () => {
    const WEEK = 7 * 86_400_000
    it('is true until a pass has finished', async () => {
      expect(await searchIndex.passDue()).toBe(true)
      await pass()
      expect(await searchIndex.passDue()).toBe(false)
    })

    it('is true when a pass stopped half way', async () => {
      await pass()
      for (let i = 0; i < 3; i++) await text(`kissa ${i}`)
      await searchIndex.backfill(0)
      expect(await searchIndex.passDue()).toBe(true)
    })

    it('is true when the last pass is over a week old', async () => {
      await pass()
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now + WEEK - 60_000)
      expect(await searchIndex.passDue()).toBe(false)
      vi.spyOn(Date, 'now').mockReturnValue(now + WEEK + 60_000)
      expect(await searchIndex.passDue()).toBe(true)
    })

    it('is true when the last pass was of an older format', async () => {
      await pass()
      const [row] = await db.cache.where('k').startsWith('search-backfill').toArray()
      await db.cache.put({ ...row, value: 0 })
      expect(await searchIndex.passDue()).toBe(true)
    })
  })

  it('a finished pass leaves no place behind, so the next one starts over', async () => {
    await text('kissa')
    await pass()
    await db.searchDocs.clear()
    await pass()
    expect(await db.searchDocs.count()).toBe(1)
  })

  it('repairs a row that missed the last edit', async () => {
    const m = await indexed('kissa')
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'koira')))
    await pass()
    expect(await found('kissa')).toEqual([])
    expect(await found('koira')).toEqual([m.id])
  })

  it('takes away rows whose message is gone, at any place in the walk', async () => {
    for (let i = 0; i < 40; i++) await indexed(`kissa ${i}`)
    await db.searchDocs.bulkPut([row(1, '0', 'haamu'), row(2, 'zzzz', 'haamu')])
    await pass()
    expect(await found('haamu')).toEqual([])
    expect(await db.searchDocs.count()).toBe(40)
  })

  it('takes away every row when no message is left', async () => {
    await db.searchDocs.put(row(1, 'gone', 'haamu'))
    await pass()
    expect(await db.searchDocs.count()).toBe(0)
  })

  it('rebuilds a row of an older format, though its text is the same', async () => {
    const m = await indexed('kissa')
    await db.searchDocs.where('messageId').equals(m.id).modify({ textHash: hashText('0:kissa'), terms: ['vanha muoto'] })
    await pass()
    expect(await found('kissa')).toEqual([m.id])
    expect((await db.searchDocs.toArray())[0].terms).not.toContain('vanha muoto')
  })

  it('does not tokenise a message that has not changed', async () => {
    await indexed('kissa')
    const put = vi.spyOn(db.table('searchDocs'), 'bulkPut')
    await pass()
    expect(put.mock.calls.flatMap(([rows]) => rows as unknown[])).toEqual([])
  })
})
