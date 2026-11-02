import { describe, expect, it } from 'vitest'
import { tokens, wordsOf } from './tokens'

describe('tokens', () => {
  it('keeps ä and ö', () => {
    const t = tokens('Hyvää yötä')
    expect(t).toContain('hyvää')
    expect(t).toContain('yötä')
    expect(t).not.toContain('hyvaa')
    expect(t).not.toContain('yota')
  })

  it('reads ä the same when it comes as two code points', () => {
    expect(tokens('hän')).toEqual(tokens('hän'))
  })

  it('holds the raw word, the Finnish stem and the English stem, lower-cased', () => {
    expect(tokens('Talossa')).toEqual(expect.arrayContaining(['talossa', 'talo']))
    expect(tokens('Running')).toEqual(expect.arrayContaining(['running', 'run']))
  })

  it('uses Snowball English, not the older Porter stemmer', () => {
    expect(tokens('skies')).toContain('sky')
    expect(tokens('dying')).toContain('die')
  })

  it('holds each token once', () => {
    const t = tokens('talo talo Talo talossa')
    expect(new Set(t).size).toBe(t.length)
  })

  it('splits on punctuation and hyphens, and keeps numbers', () => {
    expect(wordsOf('kirja-arvostelu, 2026!')).toEqual(['kirja', 'arvostelu', '2026'])
  })

  it('skips a word too long to be a word', () => {
    expect(tokens(`${'x'.repeat(65)} talo`)).not.toContain('x'.repeat(65))
    expect(tokens(`${'x'.repeat(65)} talo`)).toContain('talo')
  })

  it('gives nothing for text with no words', () => {
    expect(tokens('')).toEqual([])
    expect(tokens(' … 🙂 ')).toEqual([])
  })
})
