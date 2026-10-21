import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('provides IndexedDB through fake-indexeddb', () => {
    expect(indexedDB).toBeDefined()
    expect(typeof indexedDB.open).toBe('function')
  })
})
