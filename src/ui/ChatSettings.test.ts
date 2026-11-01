import { afterEach, describe, expect, it } from 'vitest'
import { setAbilitiesForTest, type Ability } from '../lib/abilities/registry'
import type { Conversation, Prompt } from '../lib/types'
import { abilityRows, clampLimit, contextSummary, stepTrim } from './ChatSettings'

describe('ability rows', () => {
  const fake = (id: string): Ability =>
    ({ id, title: id.toUpperCase(), summary: `About ${id}`, tools: [], traits: {} }) as unknown as Ability
  const conv = (over: Partial<Conversation> = {}) => ({ abilities: null, plain: false, ...over }) as Conversation
  const on = (rows: ReturnType<typeof abilityRows>) => rows.map((r) => r.on)

  afterEach(() => setAbilitiesForTest())

  it('has one row per ability, in registry order, all on by default', () => {
    setAbilitiesForTest([fake('a'), fake('b')])
    expect(abilityRows(conv(), null)).toEqual([
      { id: 'a', title: 'A', summary: 'About a', on: true },
      { id: 'b', title: 'B', summary: 'About b', on: true },
    ])
  })

  it('shows the prompt default until the chat sets its own', () => {
    setAbilitiesForTest([fake('a'), fake('b')])
    const prompt = { abilities: { a: false } } as unknown as Prompt
    expect(on(abilityRows(conv(), prompt))).toEqual([false, true])
    expect(on(abilityRows(conv({ abilities: { a: true, b: false } }), prompt))).toEqual([true, false])
  })

  it('keeps the values while the chat is plain', () => {
    setAbilitiesForTest([fake('a'), fake('b')])
    expect(on(abilityRows(conv({ abilities: { a: false }, plain: true }), null))).toEqual([false, true])
  })
})

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
