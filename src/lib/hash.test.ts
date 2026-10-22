import { describe, expect, it } from 'vitest'
import { hashText } from './hash'

describe('hashText', () => {
  it('is stable and 8 hex chars', () => {
    expect(hashText('hello')).toBe(hashText('hello'))
    expect(hashText('hello')).toMatch(/^[0-9a-f]{8}$/)
    expect(hashText('')).toBe('811c9dc5')
  })
  it('different texts give different hashes', () => {
    expect(hashText('a')).not.toBe(hashText('b'))
  })
})
