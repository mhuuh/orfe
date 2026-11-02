import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../lib/db'
import { tokens } from '../lib/search/tokens'
import { BENCH_DB, fakeText, QUERIES, reportText, runBench, stats } from './run'

const names = async () => (await indexedDB.databases()).map((d) => d.name)

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

  it('gives the same text for the same seed', () => {
    expect(fakeText(7)).toBe(fakeText(7))
    expect(fakeText(7)).not.toBe(fakeText(8))
  })
})

describe('stats', () => {
  it('gives min, median and max', () => {
    expect(stats([5, 1, 3])).toEqual({ min: 1, median: 3, max: 5 })
    expect(stats([4, 1, 2, 3])).toEqual({ min: 1, median: 3, max: 4 })
  })
})

describe('runBench', () => {
  it('has about 20 queries of all three kinds', () => {
    expect(QUERIES.length).toBeGreaterThanOrEqual(18)
    expect(QUERIES.some((q) => q.split(' ').length === 2)).toBe(true)
    expect(QUERIES).toContain('kissoille')
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
    const line = reportText({
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
      write: { min: 1, median: 2, max: 3 },
      query: { min: 10, median: 100, max: 700 },
      queries: [
        { query: 'the', ms: 700, hits: 25 },
        { query: 'kissa', ms: 10, hits: 25 },
      ],
      device: 'test phone',
    })
    expect(line).toContain('100,000 messages in 100 chats')
    expect(line).toContain('Queries run in the longest chat: 20,000 messages')
    expect(line).toContain('Slowest: "the" 700 ms')
    expect(line).toContain('Over 500 ms: 1 of 2')
    expect(line).toContain('190.7 MB')
    expect(tokens(line).length).toBeGreaterThan(0)
  })

  it('a report says so when the browser gives no size', () => {
    const line = reportText({
      messages: 1,
      chats: 1,
      longChat: 1,
      seedMs: 1,
      indexMs: 1,
      repairMs: 1,
      indexBytes: null,
      messageBytes: null,
      indexedRows: 1,
      termsPerMessage: 1,
      write: { min: 1, median: 1, max: 1 },
      query: { min: 1, median: 1, max: 1 },
      queries: [{ query: 'x', ms: 1, hits: 0 }],
      device: 'test',
    })
    expect(line).toContain('Index size: not given by this browser')
    expect(line).toContain('Over 500 ms: 0 of 1')
  })
})
