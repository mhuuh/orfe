import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './__fixtures__/models.json'
import type { RawModel } from './openrouter'

vi.mock('./openrouter', () => ({ fetchModels: vi.fn() }))

import { fetchModels } from './openrouter'
import { chatModels, groupByMonth, loadCatalog, search, sortAZ, toModelInfo } from './catalog'
import { db } from './db'
import { storage } from './storage'

const raw = fixture as RawModel[]
const all = raw.map(toModelInfo)
const mockFetch = vi.mocked(fetchModels)

beforeEach(async () => {
  mockFetch.mockReset()
  await db.cache.clear()
})

describe('catalog', () => {
  it('toModelInfo converts per-token price strings to per-million numbers', () => {
    const m = toModelInfo(raw[0])
    expect(m.priceIn).toBeCloseTo(3)
    expect(m.priceOut).toBeCloseTo(15)
    expect(m.efforts).toEqual(['low', 'medium', 'high'])
    expect(m.defaultEffort).toBe('medium')
    expect(m.free).toBe(false)
    const router = toModelInfo(raw[5])
    expect(router.priceIn).toBe(0)
    expect(router.efforts).toBeNull()
    expect(toModelInfo(raw[6]).free).toBe(true)
  })

  it('does not mark routers with negative or unknown prices as free', () => {
    expect(toModelInfo(raw[5]).free).toBe(false) // openrouter/auto, price "-1"
    expect(toModelInfo({ ...raw[6], id: 'x/no-price', pricing: undefined } as unknown as RawModel).free).toBe(false)
    expect(toModelInfo({ ...raw[6], id: 'x/half', pricing: { prompt: '0', completion: 'n/a' } }).free).toBe(false)
    expect(toModelInfo({ ...raw[6], id: 'x/zero', pricing: { prompt: '0', completion: '0' } }).free).toBe(true)
  })

  it('chatModels removes embeddings, rerank and decisions models', () => {
    const ids = chatModels(all).map((m) => m.id)
    expect(ids).not.toContain('openai/text-embedding-4')
    expect(ids).not.toContain('cohere/rerank-4')
    expect(ids).not.toContain('acme/router-decisions')
    expect(ids).toContain('google/imagen-5')
    expect(ids).toHaveLength(5)
  })

  it('groupByMonth groups by created month, newest first, with "October 2026" labels', () => {
    const groups = groupByMonth(chatModels(all))
    expect(groups.map((g) => g.label)).toEqual(['October 2026', 'September 2026', 'August 2026'])
    expect(groups[0].models.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-5.5', 'openai/gpt-6'])
  })

  it('sortAZ is alphabetical by name', () => {
    const names = sortAZ(all).map((m) => m.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(names[0]).toBe('Acme: Decisions')
  })

  it('search matches all terms across id and name', () => {
    expect(search(all, 'claude sonnet').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-5.5'])
    expect(search(all, 'OPENAI gpt').map((m) => m.id)).toEqual(['openai/gpt-6'])
    expect(search(all, 'claude gpt')).toEqual([])
    expect(search(all, '  ')).toHaveLength(all.length)
  })

  it('loadCatalog uses fresh cache without fetching', async () => {
    await storage.setCache('catalog', all)
    const r = await loadCatalog()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(r.models).toHaveLength(all.length)
    expect(r.stale).toBe(false)
    expect(r.error).toBeUndefined()
  })

  it('falls back to cached catalog when fetch fails', async () => {
    await storage.setCache('catalog', all)
    mockFetch.mockRejectedValue(new Error('offline'))
    const r = await loadCatalog({ force: true })
    expect(mockFetch).toHaveBeenCalled()
    expect(r.models).toHaveLength(all.length)
    expect(r.error).toBe('offline')
  })

  it('returns empty list with error when fetch fails and no cache', async () => {
    mockFetch.mockRejectedValue(new Error('offline'))
    const r = await loadCatalog()
    expect(r.models).toEqual([])
    expect(r.error).toBe('offline')
  })
})
