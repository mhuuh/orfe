import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, newId, storage } from '../storage'
import type { ContentPart, Message } from '../types'
import { editedVersion, withActive, withNewVersion } from '../versions'
import { createSearchIndex, searchIndex } from './termIndex'

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
  await searchIndex.index(m)
  return m
}
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
    await searchIndex.index(edited!)
    expect(await found('kissa')).toEqual([])
    expect(await found('koira')).toEqual([m.id])
  })

  it('reads the active version only', async () => {
    const m = await indexed('kissa')
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'koira')))
    const flipped = await storage.mutateMessage(m.id, (x) => withActive(x, 0))
    await searchIndex.index(flipped!)
    expect(await found('kissa')).toEqual([m.id])
    expect(await found('koira')).toEqual([])
  })

  it('a stale copy cannot put old text back', async () => {
    const m = await indexed('kissa')
    await storage.mutateMessage(m.id, (x) => withNewVersion(x, editedVersion(x.versions[0], 'koira')))
    await searchIndex.index(m)
    expect(await found('koira')).toEqual([m.id])
    expect(await found('kissa')).toEqual([])
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
    await searchIndex.index(m)
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

describe('what goes in', () => {
  it('leaves tool steps out', async () => {
    const step: ContentPart = { type: 'tool', callId: 'c', round: 0, model: 'm', name: 'read_note', args: { path: 'mira' }, result: 'mira', status: 'done' }
    const m = await storage.appendMessage(chat, 'assistant', version([step, { type: 'text', text: 'kissa' }]))
    await searchIndex.index(m)
    expect(await found('mira')).toEqual([])
    expect(await found('read_note')).toEqual([])
    expect(await found('kissa')).toEqual([m.id])
  })

  it('stores no row for a message with no text', async () => {
    const divider = await storage.appendMessage(chat, 'divider', version([]))
    await searchIndex.index(divider)
    expect(await db.searchDocs.count()).toBe(0)
  })

  it('takes the row away when the active version has no text', async () => {
    const m = await indexed('kissa')
    const empty = await storage.mutateMessage(m.id, (x) => withNewVersion(x, version([])))
    await searchIndex.index(empty!)
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
    for (const id of ['0', 'zzzz']) await db.searchDocs.put({ messageId: id, conversationId: chat, terms: ['haamu'], textHash: 'x' })
    await pass()
    expect(await found('haamu')).toEqual([])
    expect(await db.searchDocs.count()).toBe(40)
  })

  it('takes away every row when no message is left', async () => {
    await db.searchDocs.put({ messageId: 'gone', conversationId: chat, terms: ['haamu'], textHash: 'x' })
    await pass()
    expect(await db.searchDocs.count()).toBe(0)
  })

  it('does not tokenise a message that has not changed', async () => {
    await indexed('kissa')
    const put = vi.spyOn(db.table('searchDocs'), 'bulkPut')
    await pass()
    expect(put.mock.calls.flatMap(([rows]) => rows as unknown[])).toEqual([])
  })
})
