import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../lib/db'
import { BENCH_DB, clearBench, fakeText, freeSpaceText, QUERIES, reportText, runBench, stats, type BenchResult } from './run'

const names = async () => (await indexedDB.databases()).map((d) => d.name)

const RESULT: BenchResult = {
  messages: 100_000,
  chats: 100,
  longChat: 20_000,
  seedMs: 60_000,
  indexMs: 120_000,
  repairMs: 30_000,
  indexBytes: 200_000_000,
  messageBytes: 60_000_000,
  indexedRows: 100_000,
  termsPerMessage: 80,
  write: { min: 1, median: 2, p90: 3, max: 3 },
  slice: { min: 20, median: 40, p90: 60, max: 70 },
  longMessageMs: 150,
  query: { min: 10, median: 100, p90: 700, max: 700 },
  queries: [
    { query: 'the', ms: 700, hits: 25 },
    { query: 'kissa', ms: 10, hits: 25 },
  ],
  hidden: false,
  device: 'test phone',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fakeText', () => {
  it('mixes Finnish and English at about 400 characters', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => fakeText(i))
    for (const t of seeds) {
      expect(t.length).toBeGreaterThanOrEqual(400)
      expect(t.length).toBeLessThan(460)
    }
    expect(seeds.some((t) => /\b(ja|on|että)\b/.test(t))).toBe(true)
    expect(seeds.some((t) => /\b(the|and|with)\b/.test(t))).toBe(true)
  })

  it('can write longer text', () => {
    expect(fakeText(1, 1600).length).toBeGreaterThanOrEqual(1600)
    expect(fakeText(1, 1600).length).toBeLessThan(1660)
  })

  it('gives the same text for the same seed', () => {
    expect(fakeText(7)).toBe(fakeText(7))
    expect(fakeText(7)).not.toBe(fakeText(8))
  })
})

describe('stats', () => {
  it('gives min, median and max', () => {
    expect(stats([5, 1, 3])).toEqual({ min: 1, median: 3, p90: 5, max: 5 })
    expect(stats([4, 1, 2, 3])).toEqual({ min: 1, median: 3, p90: 4, max: 4 })
    expect(stats(Array.from({ length: 100 }, (_, i) => i + 1)).p90).toBe(91)
  })
})

describe('runBench', () => {
  it('has about 20 queries of all three kinds', () => {
    expect(QUERIES.length).toBeGreaterThanOrEqual(18)
    expect(QUERIES.some((q) => q.split(' ').length === 2)).toBe(true)
    expect(QUERIES).toContain('kissoille')
    expect(QUERIES.some((q) => q.split(' ').length === 8)).toBe(true)
  })

  it('indexes every message through the real code and reports each number', async () => {
    const phases = new Set<string>()
    const r = await runBench({ messages: 300, onProgress: (p) => phases.add(p.phase) })
    expect(r.messages).toBe(300)
    expect(r.indexedRows).toBe(300)
    expect(r.termsPerMessage).toBeGreaterThan(20)
    expect(r.queries).toHaveLength(QUERIES.length)
    expect(r.queries.filter((q) => q.hits > 0).length).toBeGreaterThan(QUERIES.length / 2)
    expect(r.write.max).toBeGreaterThanOrEqual(r.write.min)
    expect([...phases]).toEqual(['seed', 'index', 'measure', 'clean'])
    expect(r.slice.max).toBeGreaterThanOrEqual(r.slice.min)
    expect(r.longMessageMs).toBeGreaterThan(0)
    expect(r.hidden).toBe(false)
  })

  it('can put every message in one chat', async () => {
    const r = await runBench({ messages: 40, oneChat: true, onProgress: () => {} })
    expect(r.chats).toBe(1)
    expect(r.longChat).toBe(40)
    expect(r.queries.some((q) => q.hits > 0)).toBe(true)
  })

  it('notes that the page was hidden during a run', async () => {
    const r = await runBench({
      messages: 30,
      onProgress: (p) => {
        if (p.phase !== 'index') return
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      },
    })
    expect(r.hidden).toBe(true)
  })

  it('clears a database that a killed run left, and leaves the real one', async () => {
    const left = new Dexie(BENCH_DB)
    left.version(1).stores({ messages: 'id' })
    const real = new Dexie('orfe')
    real.version(1).stores({ messages: 'id' })
    await left.table('messages').put({ id: 'x' })
    await real.table('messages').put({ id: 'y' })
    left.close()
    real.close()
    await clearBench()
    expect(await names()).not.toContain(BENCH_DB)
    expect(await names()).toContain('orfe')
    await Dexie.delete('orfe')
  })

  it('deletes its database and never opens the real one', async () => {
    await runBench({ messages: 30, onProgress: () => {} })
    expect(await names()).not.toContain(BENCH_DB)
    expect(await names()).not.toContain('orfe')
    expect(db.isOpen()).toBe(false)
  })

  it('deletes its database when a run fails', async () => {
    await expect(runBench({ messages: 30, onProgress: () => { throw new Error('boom') } })).rejects.toThrow('boom')
    expect(await names()).not.toContain(BENCH_DB)
  })

  it('sends nothing to any host', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await runBench({ messages: 30, onProgress: () => {} })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a report says which query was slowest and how many passed 500 ms', () => {
    const line = reportText(RESULT)
    expect(line).toContain('100,000 messages in 100 chats')
    expect(line).toContain('Queries run in the longest chat: 20,000 messages')
    expect(line).toContain('Slowest: "the" 700 ms')
    expect(line).toContain('Over 500 ms: 1 of 2')
    expect(line).toContain('190.7 MB')
    expect(line).toContain('Backfill slice: min 20 ms, median 40 ms, p90 60 ms, max 70 ms')
    expect(line).toContain('One 500 KB message: 150 ms')
    expect(line).toContain('Page was hidden: no')
  })

  it('a report says so when the browser gives no size', () => {
    const line = reportText({ ...RESULT, indexBytes: null, messageBytes: null, hidden: true, queries: [{ query: 'x', ms: 1, hits: 0 }] })
    expect(line).toContain('Index size: not given by this browser')
    expect(line).toContain('Over 500 ms: 0 of 1')
    expect(line).toContain('Page was hidden: yes')
  })

  it('says how much space is free, and warns under 2 GB', () => {
    const gb = 1024 ** 3
    expect(freeSpaceText({ quota: 12 * gb, usage: 2 * gb })).toBe('Free space: 10.0 GB.')
    expect(freeSpaceText({ quota: 3 * gb, usage: 2 * gb })).toBe('Free space: 1.0 GB. Under 2 GB: the run may fail.')
    expect(freeSpaceText({})).toBe('Free space: not given by this browser.')
    expect(freeSpaceText(null)).toBe('Free space: not given by this browser.')
  })
})
