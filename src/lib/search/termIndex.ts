import type Dexie from 'dexie'
import { db, type KvRow } from '../db'
import { hashText } from '../hash'
import type { Message, SearchDoc } from '../types'
import { wordsOf, wordTokens, tokens } from './tokens'

/** History search talks to this and nothing else, so FTS5 can replace the term index behind it. */
export interface SearchIndex {
  /** Makes the message's row match what is stored: a new row, an update, or no row if the message or its text is gone. */
  index(messageId: string): Promise<void>
  remove(messageId: string): Promise<void>
  /** One delete for a whole chat. A long chat must not cost one transaction per message. */
  removeChat(conversationId: string): Promise<void>
  /**
   * Best hits first, in one chat, ties newest first. Each query word adds at most 1 to the score,
   * and less the more rows hold it, so a name beats the plain words around it.
   */
  search(conversationId: string, query: string, limit: number): Promise<{ messageId: string; score: number }[]>
  /** One slice of a pass over all messages. True when the pass is done. The next call then starts a new pass. */
  backfill(budgetMs: number): Promise<boolean>
  /** True if no pass has finished, one stopped half way, the last is over a week old, or it was of an older format. */
  passDue(): Promise<boolean>
}

/** Bump this on any change to `filed` or `tokens`. A pass then rebuilds every row. */
const FORMAT = 1
/**
 * `db.cache` key: the last message id the pass walked, and the format of that pass. A killed run
 * resumes from it. A place of another format is ignored: rows below it would stay old.
 */
const PLACE = 'search-backfill'
/** `db.cache` key: `at` is when the last pass finished, and `value` its format. */
const FINISHED = 'search-backfill-finished'
const WEEK_MS = 7 * 86_400_000
/** Messages read in one transaction. */
const BATCH = 25
/**
 * The time one backfill slice gets for its rows, in ms. The batch read comes on top: a slow read
 * must not leave a slice one message. A slice holds `messages`, so a send can wait that long.
 * Measured at 100k messages under a 6x throttle. Writing: median 31 ms, p90 37 ms, max 118 ms. A
 * clean pass: median 40 ms, max 49 ms, 70 messages a slice.
 */
export const SLICE_BUDGET_MS = 30
/**
 * What one term costs to write, in ms, under a 6x throttle. The deadline is checked while
 * tokenising, which is cheap. The write comes after, so a slice charges it up front.
 */
export const MS_PER_TERM = 0.1
/** Row numbers per millisecond. 1.8e12 ms times this stays a safe integer. */
const SAME_MS = 1024
/**
 * Under this length a token matches whole. A prefix of two letters reads half the index. So `yö`
 * does not find `yön`: the stemmer leaves these short words as they are, and only the tool text can help.
 */
const MIN_PREFIX = 3
/**
 * The most rows one token reads, so that no word can make a search slow. Rows of one term come
 * newest first, so the cap keeps the newest rows of a word. A prefix spans several terms and they
 * come in term order, so the exact word comes before longer words. The cost: past the cap, a very
 * common word reaches only the newest 4,000 rows that hold it. A rare word never reaches the cap.
 */
export const MAX_ROWS_PER_TOKEN = 4000
/**
 * The most keys one search reads. The time of a search is almost all key reads, at about 16
 * microseconds per key under a 6x throttle, so this holds a search near 400 ms. Each token gets its
 * share, up to `MAX_ROWS_PER_TOKEN`. The cost: in a query with many tokens, a capped word reaches
 * only its newest 2,000 to 3,000 rows. Queries of one or two words never reach this limit.
 */
export const MAX_KEYS_PER_SEARCH = 24000
/** Query words read. Past this the rest are dropped. A form of a word counts as a word. */
export const MAX_QUERY_WORDS = 8

/**
 * The text of the active version, as stored. Strip and plain change what goes out, not what is
 * stored, so they have no effect here. Tool steps stay out: history search covers messages, and
 * notes have their own search.
 */
const textOf = (m: Message): string =>
  (m.versions[m.activeVersion]?.content ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')

/**
 * A term as the index holds it, filed under its chat. A search then reads only its own chat's rows.
 * Without this it read the rows of every chat. See docs/research/live-checks-2026-11.md.
 */
const filed = (conversationId: string, term: string): string => `${conversationId}:${term}`

const hashOf = (text: string): string => hashText(`${FORMAT}:${text}`)

const termsOf = (m: Message, text: string): string[] => tokens(text).map((t) => filed(m.conversationId, t))

/** More rows, less weight: 1 for a word in one row, about 0.08 for a word at the cap. */
const rarity = (rows: number): number => 1 / (1 + Math.log2(Math.max(1, rows)))

/** The stored place of a pass. Exported for the bench, which times a pass over part of its messages. */
export const placeRow = (id: string): KvRow => ({ k: PLACE, value: { id, format: FORMAT }, at: Date.now() })

/** Where the stored place says to go on from. Empty: the start. */
function placeOf(row: KvRow | undefined): string {
  const place = row?.value as { id: string; format: number } | undefined
  return place?.format === FORMAT ? place.id : ''
}

/** The message's time, or 0 if a hand-edited backup left none: `n` must be a safe integer. */
const timeOf = (m: Message): number => (Number.isSafeInteger(m.createdAt * SAME_MS) ? m.createdAt : 0)

/** The database is a parameter so that the bench can run this same code on its own database. */
export function createSearchIndex(store: Dexie): SearchIndex {
  const messages = store.table<Message, string>('messages')
  const docs = store.table<SearchDoc, number>('searchDocs')
  const cache = store.table<KvRow, string>('cache')

  /**
   * The first free row number at the message's time. Only call this inside a rw transaction on
   * `docs`: such transactions run one at a time, so two writers can't pick the same number.
   * `taken` holds numbers picked in this transaction and not written yet.
   */
  const freeNumber = async (m: Message, taken: Set<number>): Promise<number> => {
    let n = -timeOf(m) * SAME_MS
    while (taken.has(n) || (await docs.get(n))) n++
    taken.add(n)
    return n
  }

  /**
   * Walks one batch from the stored place. `paid` is what the slice has used of `budgetMs` so far:
   * time on rows, and writes charged. Stops when that reaches the budget, but always walks one
   * message. Returns the new `paid`, and true at the end.
   */
  const walk = (budgetMs: number, paid: number): Promise<{ end: boolean; paid: number }> =>
    // One transaction, with the messages in it, so an edit can't slip in between the read and the write.
    store.transaction('rw', messages, docs, cache, async () => {
      const place = placeOf(await cache.get(PLACE))
      const batch = await messages.where(':id').above(place).limit(BATCH).toArray()
      const lastRead = batch.at(-1)?.id
      const tail = batch.length < BATCH || lastRead === undefined
      const ids = docs.where('messageId')
      // Both sort by message id, so this stretch of rows holds any row of these messages.
      const stretch = await (tail ? ids.above(place) : ids.between(place, lastRead, false, true)).toArray()
      const held = new Map(stretch.map((d) => [d.messageId, d]))
      // The clock starts here. A read that is already paid for must not use up the row budget.
      const begun = performance.now()
      const used = (): number => paid + performance.now() - begun
      const puts: SearchDoc[] = []
      const drops: number[] = []
      const taken = new Set<number>()
      const walked = new Set<string>()
      for (const m of batch) {
        if (walked.size > 0 && used() >= budgetMs) break
        walked.add(m.id)
        const text = textOf(m)
        const row = held.get(m.id)
        const textHash = hashOf(text)
        if (row?.textHash === textHash) continue
        const terms = termsOf(m, text)
        paid += terms.length * MS_PER_TERM
        if (terms.length > 0) {
          const n = row?.n ?? (await freeNumber(m, taken))
          puts.push({ n, messageId: m.id, conversationId: m.conversationId, terms, textHash })
        } else if (row) drops.push(row.n)
      }
      const spent = used()
      const last = [...walked].at(-1)
      const end = tail && walked.size === batch.length
      // A row in the walked stretch with no message has lost its message.
      for (const d of stretch) {
        if (!walked.has(d.messageId) && (end || (last !== undefined && d.messageId < last))) drops.push(d.n)
      }
      if (puts.length > 0) await docs.bulkPut(puts)
      if (drops.length > 0) await docs.bulkDelete(drops)
      if (end) {
        await cache.delete(PLACE)
        await cache.put({ k: FINISHED, value: FORMAT, at: Date.now() })
      } else if (last !== undefined) await cache.put(placeRow(last))
      return { end, paid: spent }
    })

  /** The numbers of rows that hold this token, newest first. Keys only: much cheaper than reading the rows. */
  const holders = (conversationId: string, token: string, limit: number): Promise<number[]> => {
    const terms = docs.where('terms')
    const term = filed(conversationId, token)
    return (token.length < MIN_PREFIX ? terms.equals(term) : terms.startsWith(term)).limit(limit).primaryKeys()
  }

  return {
    async index(messageId) {
      await store.transaction('rw', messages, docs, async () => {
        const m = await messages.get(messageId)
        const [held] = await docs.where('messageId').equals(messageId).primaryKeys()
        const text = m ? textOf(m) : ''
        const terms = m ? termsOf(m, text) : []
        if (m && terms.length > 0) {
          const n = held ?? (await freeNumber(m, new Set()))
          await docs.put({ n, messageId, conversationId: m.conversationId, terms, textHash: hashOf(text) })
        } else if (held !== undefined) await docs.delete(held)
      })
    },
    async remove(messageId) {
      await docs.where('messageId').equals(messageId).delete()
    },
    async removeChat(conversationId) {
      await docs.where('conversationId').equals(conversationId).delete()
    },
    async search(conversationId, query, limit) {
      const asked = [...new Set(wordsOf(query))].slice(0, MAX_QUERY_WORDS).map(wordTokens)
      // Forms of a word share stems, so each token is read once.
      const distinct = [...new Set(asked.flat())]
      const perToken = Math.min(MAX_ROWS_PER_TOKEN, Math.floor(MAX_KEYS_PER_SEARCH / Math.max(1, distinct.length)))
      const reads = await Promise.all(distinct.map((t) => holders(conversationId, t, perToken)))
      const found = new Map(
        distinct.map((token, i) => {
          const rows = new Set(reads[i])
          return [token, { rows, weight: rarity(reads[i].length >= perToken ? MAX_ROWS_PER_TOKEN : rows.size) }]
        }),
      )
      const scores = new Map<number, number>()
      for (const word of asked) {
        // A word's tokens share its point, so a whole word beats a stem that only starts the same.
        for (const token of word) {
          const { rows, weight } = found.get(token)!
          const share = weight / word.length
          for (const n of rows) scores.set(n, (scores.get(n) ?? 0) + share)
        }
      }
      // Lowest number first in a tie: that is the newest message.
      const top = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit)
      const held = await docs.bulkGet(top.map(([n]) => n))
      return top.flatMap(([, score], i) => {
        const row = held[i]
        return row ? [{ messageId: row.messageId, score }] : []
      })
    },
    async backfill(budgetMs) {
      const start = performance.now()
      let paid = 0
      for (;;) {
        const step = await walk(budgetMs, paid)
        if (step.end) return true
        paid = step.paid
        // The second check counts reads too, so a clean pass can't read batch after batch.
        if (paid >= budgetMs || performance.now() - start >= budgetMs) return false
      }
    },
    async passDue() {
      if (await cache.get(PLACE)) return true
      const last = await cache.get(FINISHED)
      return last?.value !== FORMAT || Date.now() - last.at > WEEK_MS
    },
  }
}

export const searchIndex = createSearchIndex(db)
