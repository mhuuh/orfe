import type Dexie from 'dexie'
import { db, type KvRow } from '../db'
import { hashText } from '../hash'
import type { Message, SearchDoc } from '../types'
import { versionText } from '../versions'
import { wordsOf, wordTokens, tokens } from './tokens'

/** History search talks to this and nothing else, so FTS5 can replace the term index behind it. */
export interface SearchIndex {
  /** Makes the row match the stored message. The stored one counts, not `m`: a caller's copy can be stale. */
  index(m: Message): Promise<void>
  remove(messageId: string): Promise<void>
  /** Best hits first, in one chat. Each query word adds up to 1 to the score. */
  search(conversationId: string, query: string, limit: number): Promise<{ messageId: string; score: number }[]>
  /** One slice of a pass over all messages. True when the pass is done. The next call then starts a new pass. */
  backfill(budgetMs: number): Promise<boolean>
}

/** `db.cache` key: the last message id the pass walked. A killed run resumes from it. */
const PLACE = 'search-backfill'
/** Messages read in one transaction. */
const BATCH = 25
/** Under this length a token matches whole. A prefix of two letters reads half the index. */
const MIN_PREFIX = 3

/**
 * The text of the active version, as stored. Strip and plain change what goes out, not what is
 * stored, so they have no effect here. Tool steps stay out: history search covers messages, and
 * notes have their own search.
 */
const textOf = (m: Message): string => versionText(m.versions[m.activeVersion])

function docFor(m: Message, text: string): SearchDoc | null {
  const terms = tokens(text)
  return terms.length === 0 ? null : { messageId: m.id, conversationId: m.conversationId, terms, textHash: hashText(text) }
}

/** The database is a parameter so that the bench can run this same code on its own database. */
export function createSearchIndex(store: Dexie): SearchIndex {
  const messages = store.table<Message, string>('messages')
  const docs = store.table<SearchDoc, string>('searchDocs')
  const cache = store.table<KvRow, string>('cache')

  /** Walks one batch from the stored place. Stops early at the deadline, but always walks one message. True at the end. */
  const walk = (deadline: number): Promise<boolean> =>
    // One transaction, with the messages in it, so an edit can't slip in between the read and the write.
    store.transaction('rw', messages, docs, cache, async () => {
      const place = ((await cache.get(PLACE))?.value as string | undefined) ?? ''
      const batch = await messages.where(':id').above(place).limit(BATCH).toArray()
      const held = await docs.bulkGet(batch.map((m) => m.id))
      const puts: SearchDoc[] = []
      const drops: string[] = []
      const walked = new Set<string>()
      for (const [i, m] of batch.entries()) {
        if (i > 0 && performance.now() >= deadline) break
        walked.add(m.id)
        const text = textOf(m)
        if (held[i]?.textHash === hashText(text)) continue
        const doc = docFor(m, text)
        if (doc) puts.push(doc)
        else if (held[i]) drops.push(m.id)
      }
      const last = [...walked].at(-1)
      const end = walked.size === batch.length && batch.length < BATCH
      // Both tables sort by id, so a row in this stretch with no message here has lost its message.
      const stretch = end || last === undefined ? docs.where(':id').above(place) : docs.where(':id').between(place, last, false, true)
      const orphans = (await stretch.primaryKeys()).filter((id) => !walked.has(id))
      if (puts.length > 0) await docs.bulkPut(puts)
      if (drops.length + orphans.length > 0) await docs.bulkDelete([...drops, ...orphans])
      if (end) await cache.delete(PLACE)
      else if (last !== undefined) await cache.put({ k: PLACE, value: last, at: Date.now() })
      return end
    })

  /** The ids of rows that hold this token. Keys only: much cheaper than reading the rows. */
  const holders = (token: string): Promise<string[]> => {
    const terms = docs.where('terms')
    return (token.length < MIN_PREFIX ? terms.equals(token) : terms.startsWith(token)).primaryKeys()
  }

  return {
    async index(m) {
      await store.transaction('rw', messages, docs, async () => {
        const stored = await messages.get(m.id)
        const doc = stored ? docFor(stored, textOf(stored)) : null
        await (doc ? docs.put(doc) : docs.delete(m.id))
      })
    },
    remove: (messageId) => docs.delete(messageId),
    async search(conversationId, query, limit) {
      const asked = [...new Set(wordsOf(query))].map(wordTokens)
      if (asked.length === 0) return []
      const inChat = new Set(await docs.where('conversationId').equals(conversationId).primaryKeys())
      const scores = new Map<string, number>()
      for (const word of asked) {
        // A word's tokens share its point, so a whole word beats a stem that only starts the same.
        const share = 1 / word.length
        for (const token of word) {
          for (const id of new Set(await holders(token))) {
            if (inChat.has(id)) scores.set(id, (scores.get(id) ?? 0) + share)
          }
        }
      }
      return [...scores]
        .map(([messageId, score]) => ({ messageId, score }))
        .sort((a, b) => b.score - a.score || (a.messageId < b.messageId ? -1 : 1))
        .slice(0, limit)
    },
    async backfill(budgetMs) {
      const deadline = performance.now() + budgetMs
      for (;;) {
        if (await walk(deadline)) return true
        if (performance.now() >= deadline) return false
      }
    },
  }
}

export const searchIndex = createSearchIndex(db)
