import Dexie from 'dexie'
import { CACHE_SCHEMA, MESSAGES_SCHEMA, SEARCH_DOCS_SCHEMA } from '../lib/db'
import { createSearchIndex } from '../lib/search/termIndex'
import type { Message, SearchDoc } from '../lib/types'

/**
 * Measures the term index on the phone. Spec §10 keeps FTS5 as the way out if a search takes over
 * 500 ms. Everything here runs on a database of its own, deleted at the end. It never opens the
 * real database, never reads the key, and sends nothing to any host.
 */
export const BENCH_DB = 'orfe-bench'

/** One chat in five messages is the long one, and queries run there. The rest spread over this many chats. */
const OTHER_CHATS = 99
const SEED_BATCH = 1000
const TARGET_CHARS = 400
const SLICE_MS = 100
const WRITE_SAMPLES = 50
const SEARCH_LIMIT = 25
const SLOW_MS = 500

/** Single words, inflected Finnish and two-word queries. Common words are in on purpose: they cost the most. */
export const QUERIES = [
  'the',
  'and',
  'ja',
  'memory',
  'project',
  'window',
  'kissa',
  'koira',
  'zebra',
  'kissoille',
  'talossa',
  'kirjastossa',
  'järvellä',
  'ystävälle',
  'metsästä',
  'kirja',
  'kissa koira',
  'memory project',
  'talo järvi',
  'kirja window',
]

const FINNISH_COMMON = 'ja on ei se että mutta kun niin myös vain sitten nyt jos tai minä sinä hän me te he olen olet oli ovat kuin mitä tämä tuo siellä täällä'.split(' ')
const FINNISH_NOUNS = `kissa koira talo kirja kala lintu puu kukka järvi metsä kivi kuva tuoli pöytä ikkuna ovi lattia seinä katto
  auto juna bussi laiva tie silta kaupunki kylä maa meri ranta saari vuori joki taivas pilvi sade lumi tuuli aurinko kuu tähti
  ystävä lapsi äiti isä sisko veli opettaja lääkäri muusikko kirjailija kokki taiteilija ihminen nainen mies poika tyttö
  kirje lehti sana lause tarina runo laulu elokuva peli ohjelma kone puhelin näyttö muisti tiedosto kansio viesti kysymys vastaus
  aamu ilta yö päivä viikko kuukausi vuosi hetki kesä talvi syksy kevät ruoka leipä maito kahvi tee keitto omena peruna
  työ koulu koti huone keittiö sauna piha puisto kauppa kirjasto museo teatteri sairaala asema tori pelto niitty suo
  ajatus idea suunnitelma ongelma ratkaisu muutos virhe tulos syy tapa asia paikka aika raha hinta väri ääni valo varjo`.split(/\s+/)
const ENGLISH_COMMON = 'the and of to in a is that it for on with as was at be this have from or by not but what all were when we there can an your which their if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know'.split(' ')
const ENGLISH_WORDS = `memory project window cache token model stream message search index version branch commit server client browser phone screen
  button sheet drawer composer system prompt context budget summary note shelf vault tool result error status request response
  key value table column schema query filter sort limit batch record update delete restore backup theme colour font layout grid
  zebra garden river forest mountain village harbour island bridge market kitchen library museum theatre hospital station
  morning evening winter summer autumn spring weather thunder rainbow shadow silver golden purple orange yellow
  writer reader teacher doctor singer painter driver farmer walker runner dreamer builder keeper hunter player
  happy quiet gentle bright strange simple careful curious honest patient clever brave tired hungry
  think wonder remember forget believe imagine explain describe discover consider decide change follow travel`.split(/\s+/)
const ENGLISH_ENDINGS = ['', '', 's', 'ing', 'ed', 'ly']
const SYLLABLES = 'ka ke ki ko ku la le li lo lu ma me mi mo mu na ne ni no nu pa pe pi po pu ra re ri ro ru sa se si so su ta te ti to tu va ve vi vo ha he hi ho ju jo ää öy yl än'.split(' ')

/** A small seeded random source, so that two runs get the same text. */
function randomFrom(seed: number): () => number {
  let s = (seed * 2654435761 + 1) >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Picks early items much more often than late ones, as with real words. */
const skewed = <T,>(list: readonly T[], r: () => number): T => list[Math.floor(list.length ** r()) - 1]

function finnishForm(noun: string, r: () => number): string {
  const back = /[aou]/.test(noun)
  const a = back ? 'a' : 'ä'
  const endings = ['', '', 'n', 't', `ss${a}`, `st${a}`, `ll${a}`, `lt${a}`, 'lle', `n${a}`, 'ksi']
  const ending = endings[Math.floor(r() * endings.length)]
  // Plural stem of nouns such as kissa: kissoille, kissoissa.
  if (noun.endsWith('a') && r() < 0.25) return `${noun.slice(0, -1)}oi${ending === '' || ending === 'n' || ending === 't' ? 'lle' : ending}`
  return noun + ending
}

/** A word no list has. Real chats keep bringing new names and terms, and each one is a new key in the index. */
function rareWord(r: () => number): string {
  let word = ''
  for (let i = 0, n = 2 + Math.floor(r() * 3); i < n; i++) word += SYLLABLES[Math.floor(r() * SYLLABLES.length)]
  return word
}

function fakeWord(finnish: boolean, r: () => number): string {
  const roll = r()
  if (roll < 0.08) return rareWord(r)
  if (finnish) return roll < 0.45 ? skewed(FINNISH_COMMON, r) : finnishForm(skewed(FINNISH_NOUNS, r), r)
  if (roll < 0.55) return skewed(ENGLISH_COMMON, r)
  return skewed(ENGLISH_WORDS, r) + ENGLISH_ENDINGS[Math.floor(r() * ENGLISH_ENDINGS.length)]
}

/** About 400 characters. Most messages keep to one language, and some switch halfway, as Mikael does. */
export function fakeText(seed: number): string {
  const r = randomFrom(seed)
  let finnish = r() < 0.5
  const switches = r() < 0.2
  let text = ''
  while (text.length < TARGET_CHARS) {
    if (switches && text.length > TARGET_CHARS / 2) finnish = !finnish
    const word = fakeWord(finnish, r)
    text += text === '' ? word : `${r() < 0.1 ? '. ' : ' '}${word}`
  }
  return text
}

const chatsFor = (): string[] => Array.from({ length: OTHER_CHATS + 1 }, () => crypto.randomUUID())
const chatOf = (order: number, chats: string[]): string => (order % 5 === 0 ? chats[0] : chats[1 + (order % OTHER_CHATS)])

function fakeMessage(order: number, chats: string[]): Message {
  const createdAt = order
  return {
    id: crypto.randomUUID(),
    conversationId: chatOf(order, chats),
    order,
    role: order % 2 === 0 ? 'user' : 'assistant',
    versions: [{ id: crypto.randomUUID(), content: [{ type: 'text', text: fakeText(order) }], status: 'done', createdAt }],
    activeVersion: 0,
    pinned: false,
    createdAt,
  }
}

export interface Stats {
  min: number
  median: number
  max: number
}

export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] }
}

export interface BenchProgress {
  phase: 'seed' | 'index' | 'measure' | 'clean'
  done: number
  total: number
}

export interface BenchResult {
  messages: number
  chats: number
  /** Messages in the chat the queries run in. */
  longChat: number
  seedMs: number
  indexMs: number
  /** A second pass that finds nothing to do: what each app start costs. */
  repairMs: number
  /** Null when the browser gives no storage estimate. */
  indexBytes: number | null
  messageBytes: number | null
  indexedRows: number
  termsPerMessage: number
  write: Stats
  query: Stats
  queries: { query: string; ms: number; hits: number }[]
  device: string
}

/** Lets the page paint and take taps. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve))

async function usedBytes(): Promise<number | null> {
  try {
    return (await navigator.storage?.estimate?.())?.usage ?? null
  } catch {
    return null
  }
}

const timed = async (fn: () => Promise<void>): Promise<number> => {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

const spread = (before: number | null, after: number | null): number | null => (before === null || after === null ? null : Math.max(0, after - before))

function deviceLine(): string {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return `${nav.userAgent} | cores ${nav.hardwareConcurrency ?? '?'} | memory ${nav.deviceMemory ?? '?'} GB`
}

export async function runBench(opts: { messages: number; onProgress(p: BenchProgress): void }): Promise<BenchResult> {
  const { messages: total, onProgress } = opts
  // A killed run leaves its database behind.
  await Dexie.delete(BENCH_DB)
  const bench = new Dexie(BENCH_DB)
  bench.version(1).stores({ messages: MESSAGES_SCHEMA, cache: CACHE_SCHEMA, searchDocs: SEARCH_DOCS_SCHEMA })
  try {
    const rows = bench.table<Message, string>('messages')
    const docs = bench.table<SearchDoc, string>('searchDocs')
    const index = createSearchIndex(bench)
    const chats = chatsFor()

    await rows.count()
    const start = await usedBytes()
    const seedMs = await timed(async () => {
      for (let done = 0; done < total; ) {
        const batch = Array.from({ length: Math.min(SEED_BATCH, total - done) }, (_, i) => fakeMessage(done + i + 1, chats))
        await rows.bulkAdd(batch)
        done += batch.length
        onProgress({ phase: 'seed', done, total })
        await breathe()
      }
    })
    const seeded = await usedBytes()

    const indexMs = await timed(async () => {
      let slices = 0
      while (!(await index.backfill(SLICE_MS))) {
        if (++slices % 20 === 0) onProgress({ phase: 'index', done: await docs.count(), total })
        await breathe()
      }
    })
    onProgress({ phase: 'index', done: total, total })
    const indexed = await usedBytes()

    const steps = WRITE_SAMPLES + QUERIES.length + 1
    let step = 0
    const sample = await rows.limit(WRITE_SAMPLES).toArray()
    const writes: number[] = []
    for (const m of sample) {
      writes.push(await timed(() => index.index(m)))
      onProgress({ phase: 'measure', done: ++step, total: steps })
    }

    const queries: BenchResult['queries'] = []
    for (const query of QUERIES) {
      let hits = 0
      const ms = await timed(async () => {
        hits = (await index.search(chats[0], query, SEARCH_LIMIT)).length
      })
      queries.push({ query, ms, hits })
      onProgress({ phase: 'measure', done: ++step, total: steps })
      await breathe()
    }

    const repairMs = await timed(async () => {
      while (!(await index.backfill(SLICE_MS))) await breathe()
    })
    onProgress({ phase: 'measure', done: ++step, total: steps })

    const held = await docs.limit(1000).toArray()
    const result: BenchResult = {
      messages: total,
      chats: chats.length,
      longChat: Math.floor(total / 5),
      seedMs,
      indexMs,
      repairMs,
      indexBytes: spread(seeded, indexed),
      messageBytes: spread(start, seeded),
      indexedRows: await docs.count(),
      termsPerMessage: held.reduce((n, d) => n + d.terms.length, 0) / Math.max(1, held.length),
      write: stats(writes),
      query: stats(queries.map((q) => q.ms)),
      queries,
      device: deviceLine(),
    }
    onProgress({ phase: 'clean', done: 1, total: 1 })
    return result
  } finally {
    bench.close()
    await Dexie.delete(BENCH_DB)
  }
}

const ms = (n: number): string => `${Math.round(n)} ms`
const mb = (n: number): string => `${(n / 1_048_576).toFixed(1)} MB`
const statLine = (s: Stats): string => `min ${ms(s.min)}, median ${ms(s.median)}, max ${ms(s.max)}`
const seconds = (n: number): string => `${(n / 1000).toFixed(1)} s`

export function reportText(r: BenchResult): string {
  const slowest = r.queries.reduce((a, b) => (b.ms > a.ms ? b : a))
  const over = r.queries.filter((q) => q.ms > SLOW_MS).length
  return [
    `ORFE term index bench: ${r.messages.toLocaleString('en-US')} messages in ${r.chats} chats`,
    `Queries run in the longest chat: ${r.longChat.toLocaleString('en-US')} messages`,
    `Seed: ${seconds(r.seedMs)}`,
    `Index: ${seconds(r.indexMs)}`,
    `Repair pass with nothing to do: ${seconds(r.repairMs)}`,
    r.indexBytes === null ? 'Index size: not given by this browser' : `Index size: ${mb(r.indexBytes)}`,
    r.messageBytes === null ? 'Message size: not given by this browser' : `Message size: ${mb(r.messageBytes)}`,
    `Index rows: ${r.indexedRows.toLocaleString('en-US')}, about ${Math.round(r.termsPerMessage)} terms each`,
    `One index write: ${statLine(r.write)}`,
    `Queries (${r.queries.length}): ${statLine(r.query)}`,
    `Slowest: "${slowest.query}" ${ms(slowest.ms)}`,
    `Over 500 ms: ${over} of ${r.queries.length}`,
    '',
    ...r.queries.map((q) => `${ms(q.ms).padStart(8)}  ${q.query} (${q.hits} hits)`),
    '',
    r.device,
  ].join('\n')
}
