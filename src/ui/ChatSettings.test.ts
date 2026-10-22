import { describe, expect, it } from 'vitest'
import { clampLimit, contextSummary, stepTrim } from './ChatSettings'

describe('context fields', () => {
  it('clampLimit keeps tokens in 1000–2,000,000 and messages in 2–1000', () => {
    expect(clampLimit('tokens', 5, 32000)).toBe(1000)
    expect(clampLimit('tokens', 9_000_000, 32000)).toBe(2_000_000)
    expect(clampLimit('tokens', 48000, 32000)).toBe(48000)
    expect(clampLimit('messages', 1, 40)).toBe(2)
    expect(clampLimit('messages', 5000, 40)).toBe(1000)
    expect(clampLimit('messages', Number(''), 40)).toBe(2) // Number('') is 0, a number: clamps
    expect(clampLimit('messages', Number.NaN, 40)).toBe(40)
  })

  it('stepTrim moves 5 % within 50–90 and snaps odd values to the grid', () => {
    expect(stepTrim(0.7, 1)).toBe(0.75)
    expect(stepTrim(0.7, -1)).toBe(0.65)
    expect(stepTrim(0.9, 1)).toBe(0.9)
    expect(stepTrim(0.5, -1)).toBe(0.5)
    expect(stepTrim(0.72, 1)).toBe(0.75)
    expect(stepTrim(0.3, 1)).toBe(0.5)
  })

  it('contextSummary names the default', () => {
    expect(contextSummary({ mode: 'tokens', limit: 32000, trimTo: 0.7 })).toBe('32k tokens')
    expect(contextSummary({ mode: 'messages', limit: 40, trimTo: 0.7 })).toBe('40 messages')
  })
})
