import { describe, expect, it } from 'vitest'
import { compact } from './ChatSettings'
import { cacheState, headerMeta } from './Header'
import type { Message } from '../lib/types'

describe('headerMeta', () => {
  it('tokens mode: turns, estimated size over the limit, warm cache', () => {
    expect(headerMeta({ turns: 5, size: 12100, limit: 32000, mode: 'tokens', cache: 'warm' })).toBe(
      '5 turns · 12.1k / 32k ctx · warm cache',
    )
  })

  it('messages mode: message count over the limit, cold', () => {
    expect(headerMeta({ turns: 5, size: 14, limit: 40, mode: 'messages', cache: 'cold' })).toBe(
      '5 turns · 14 / 40 msgs · cold',
    )
  })

  it('no reply yet: the cache part is a dash', () => {
    expect(headerMeta({ turns: 1, size: 40, limit: 32000, mode: 'tokens', cache: 'none' })).toBe(
      '1 turn · 40 / 32k ctx · –',
    )
    expect(headerMeta({ turns: 0, size: 0, limit: 40, mode: 'messages', cache: 'none' })).toBe('0 turns · 0 / 40 msgs · –')
  })
})

describe('compact', () => {
  it('plain under 1000, k with one decimal (no trailing .0) under a million, then m', () => {
    expect(compact(999)).toBe('999')
    expect(compact(1000)).toBe('1k')
    expect(compact(12_149)).toBe('12.1k')
    expect(compact(32_000)).toBe('32k')
    expect(compact(128_000)).toBe('128k')
    expect(compact(999_960)).toBe('1m')
    expect(compact(2_000_000)).toBe('2m')
    expect(compact(1_250_000)).toBe('1.3m')
  })
})

describe('cacheState', () => {
  const reply = (cachedTokens: number | null): Message => ({
    id: crypto.randomUUID(),
    conversationId: 'c',
    order: 0,
    role: 'assistant',
    activeVersion: 0,
    pinned: false,
    createdAt: 0,
    versions: [
      {
        id: 'v',
        content: [],
        status: cachedTokens === null ? 'error' : 'done',
        createdAt: 0,
        ...(cachedTokens === null
          ? {}
          : { usage: { promptTokens: 10, completionTokens: 1, cachedTokens, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0 } }),
      },
    ],
  })

  it('warm when the newest reply with usage read from the cache, cold when not, none before any', () => {
    expect(cacheState([])).toBe('none')
    expect(cacheState([reply(null)])).toBe('none')
    expect(cacheState([reply(0)])).toBe('cold')
    expect(cacheState([reply(0), reply(800)])).toBe('warm')
    expect(cacheState([reply(800), reply(0), reply(null)])).toBe('cold')
  })
})
