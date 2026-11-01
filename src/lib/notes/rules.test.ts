import { describe, expect, it } from 'vitest'
import type { Note } from '../types'
import { MAX_BODY, MAX_PATH, checkWrite, nearMatch, normalisePath, shelfOf } from './rules'

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'n1', shelf: 'shared', path: 'lists/insects', aliases: [], description: 'Insects I like',
    tags: [], body: 'x'.repeat(100), protected: false, bodyHash: 'h', version: 3,
    supersedes: null, updatedAt: 1, deletedAt: null, ...over,
  }
}
const ok = { body: 'x'.repeat(100), description: 'A line' }

describe('paths', () => {
  it('shared/ and chat/ map to shelves; anything else is refused', () => {
    expect(shelfOf('shared/lists/a', 'c1')).toEqual({ shelf: 'shared', path: 'lists/a' })
    expect(shelfOf('chat/todo', 'c1')).toEqual({ shelf: 'c1', path: 'todo' })
    expect(shelfOf('/Shared//lists/a/', 'c1')).toEqual({ shelf: 'shared', path: 'lists/a' })
    expect(shelfOf('lists/a', 'c1')).toBeNull()
    expect(shelfOf('shared/', 'c1')).toBeNull()
    expect(shelfOf('chat/../shared/a', 'c1')).toBeNull()
    expect(shelfOf('', 'c1')).toBeNull()
  })

  it('refuses control characters, brackets and very long paths', () => {
    expect(shelfOf('shared/a\nb', 'c1')).toBeNull()
    expect(shelfOf('shared/a\u0000b', 'c1')).toBeNull()
    expect(shelfOf('shared/a[b', 'c1')).toBeNull()
    expect(shelfOf('shared/a]b', 'c1')).toBeNull()
    expect(shelfOf(`shared/${'a'.repeat(MAX_PATH)}`, 'c1')).toBeNull()
    expect(shelfOf(`shared/${'a'.repeat(MAX_PATH - 'shared/'.length)}`, 'c1')).not.toBeNull()
  })

  it('allows Finnish characters in paths', () => {
    expect(shelfOf('shared/Ruoka/Pääsiäisleivät', 'c1')).toEqual({ shelf: 'shared', path: 'Ruoka/Pääsiäisleivät' })
    // A decomposed "a" + combining diaeresis is stored as the single character.
    expect(normalisePath('shared/mäki')).toBe('shared/mäki')
    expect(normalisePath('shared\\a\\b')).toBe('shared/a/b')
  })
})

describe('nearMatch', () => {
  const existing = ['lists/insects', 'lists/birds', 'recipes/pancakes', 'recipes/week-1', 'lists/Retkeilyvarusteet']

  it('finds case, plural and small typo differences, and not unrelated paths', () => {
    expect(nearMatch('lists/Insects', existing)).toBe('lists/insects')
    expect(nearMatch('lists/insect', existing)).toBe('lists/insects')
    expect(nearMatch('recipes/pancake', existing)).toBe('recipes/pancakes')
    expect(nearMatch('lists/retkeilyvarusteet', existing)).toBe('lists/Retkeilyvarusteet')
    expect(nearMatch('lists/Retkeilyvarusteer', existing)).toBe('lists/Retkeilyvarusteet')
    expect(nearMatch('lists/fish', existing)).toBeNull()
    expect(nearMatch('lists/bird-watching', existing)).toBeNull()
    expect(nearMatch('lists/bard', existing)).toBeNull()
    expect(nearMatch('other/insects', existing)).toBeNull()
    expect(nearMatch('recipes/week-2', existing)).toBeNull()
  })

  it('does not take different words for typos', () => {
    const pairs = [
      ['bread', 'break'],
      ['spring', 'string'],
      ['kirje', 'kirja'],
      ['news', 'new'],
      ['insights', 'insects'],
      ['kurkku', 'kurpitsa'],
      ['chapter-1', 'chapter-2'],
    ]
    for (const [a, b] of pairs) {
      expect(nearMatch(`x/${a}`, [`x/${b}`])).toBeNull()
      expect(nearMatch(`x/${b}`, [`x/${a}`])).toBeNull()
    }
  })

  it('allows one typo from 8 letters up, and never two', () => {
    expect(nearMatch('x/mushroom', ['x/mushrooo'])).toBe('x/mushrooo')
    expect(nearMatch('x/mushroom', ['x/mushraam'])).toBeNull()
    expect(nearMatch('x/pancake', ['x/pancakw'])).toBeNull()
  })
})

describe('checkWrite', () => {
  it('refuses a model body over 8000 characters, and allows it for "you"', () => {
    const big = { ...ok, body: 'y'.repeat(MAX_BODY + 1) }
    const r = checkWrite(null, big, 'openai/gpt-5')
    expect(r).toMatch(/^Error:/)
    expect(r).toMatch(/shorten|split/i)
    expect(checkWrite(null, big, 'you')).toBeNull()
    expect(checkWrite(null, { ...ok, body: 'y'.repeat(MAX_BODY) }, 'openai/gpt-5')).toBeNull()
  })

  it('refuses a replace that removes over half, unless shrink is true', () => {
    const prev = note()
    const small = { ...ok, body: 'x'.repeat(40) }
    const r = checkWrite(prev, small, 'm')
    expect(r).toMatch(/^Error:/)
    expect(r).toMatch(/shrink/)
    expect(checkWrite(prev, { ...small, shrink: true }, 'm')).toBeNull()
    expect(checkWrite(prev, { ...ok, body: 'x'.repeat(50) }, 'm')).toBeNull()
    expect(checkWrite(null, small, 'm')).toBeNull()
  })

  it('refuses a stale expectedVersion', () => {
    const prev = note()
    const r = checkWrite(prev, { ...ok, expectedVersion: 2 }, 'm')
    expect(r).toMatch(/^Error:/)
    expect(r).toMatch(/notes_read/)
    expect(r).toMatch(/3/)
    expect(checkWrite(prev, { ...ok, expectedVersion: 3 }, 'm')).toBeNull()
  })

  it('refuses a missing description', () => {
    expect(checkWrite(null, { ...ok, description: '   ' }, 'm')).toMatch(/^Error:.*description/)
    expect(checkWrite(null, { ...ok, description: 'two\nlines' }, 'm')).toMatch(/one line/)
  })

  it('refuses a protected note, and the text names move, tag and a linking note', () => {
    const r = checkWrite(note({ protected: true }), ok, 'm')
    expect(r).toMatch(/^Error:/)
    expect(r).toMatch(/protected/)
    expect(r).toMatch(/move/i)
    expect(r).toMatch(/tag/i)
    expect(r).toMatch(/link/i)
  })

  it('lets "you" edit a protected note and shrink it, but still checks version and description', () => {
    const prev = note({ protected: true })
    expect(checkWrite(prev, { ...ok, body: 'x'.repeat(10) }, 'you')).toBeNull()
    expect(checkWrite(prev, { ...ok, expectedVersion: 1 }, 'you')).toMatch(/^Error:/)
    expect(checkWrite(prev, { ...ok, description: '' }, 'you')).toMatch(/description/)
    expect(checkWrite(prev, ok, 'tidy')).toMatch(/protected/)
  })

  it('refuses a new-note write onto an existing note', () => {
    expect(checkWrite(note(), { ...ok, isNew: true }, 'm')).toMatch(/^Error:.*already exists at shared\/lists\/insects\./)
    expect(checkWrite(note({ shelf: 'c1' }), { ...ok, isNew: true }, 'm')).toMatch(/at chat\/lists\/insects\./)
    expect(checkWrite(null, { ...ok, isNew: true }, 'm')).toBeNull()
  })

  it('passes a clean write', () => {
    expect(checkWrite(null, ok, 'm')).toBeNull()
    expect(checkWrite(note(), ok, 'm')).toBeNull()
  })
})
