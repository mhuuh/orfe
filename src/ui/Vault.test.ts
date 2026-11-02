import { describe, expect, it } from 'vitest'
import type { Conversation, Note } from '../lib/types'
import { MAX_ROWS, flatLines, otherShelves, plainRefusal, plainSnippet, shelfRows, shortAge } from './Vault'

const MIN = 60_000
const DAY = 24 * 60 * MIN

function note(path: string, updatedAt = 0, shelf = 'shared'): Note {
  return {
    id: `${shelf}:${path}`, shelf, path, aliases: [], description: 'x', tags: [], body: '', protected: false,
    bodyHash: 'h', version: 1, supersedes: null, updatedAt, deletedAt: null,
  }
}
const chat = (id: string, title: string) => ({ id, title }) as Conversation

describe('shortAge', () => {
  it('counts in the largest whole unit', () => {
    expect(shortAge(0, 30_000)).toBe('now')
    expect(shortAge(0, 5 * MIN)).toBe('5m')
    expect(shortAge(0, 3 * 60 * MIN)).toBe('3h')
    expect(shortAge(0, 2 * DAY)).toBe('2d')
    expect(shortAge(0, 21 * DAY)).toBe('3w')
    expect(shortAge(0, 90 * DAY)).toBe('3mo')
    expect(shortAge(0, 800 * DAY)).toBe('2y')
  })

  it('a clock that went back still reads now', () => {
    expect(shortAge(1000, 0)).toBe('now')
  })
})

describe('shelfRows', () => {
  it('puts the newest first, and a folder sits at its newest note', () => {
    const rows = shelfRows([note('old', 1), note('recipes/soup', 2), note('recipes/bread', 5), note('new', 9), note('mid', 3)])
    expect(rows.map((r) => r.name)).toEqual(['New', 'Recipes', 'Mid', 'Old'])
  })

  it('a folder holds its notes, newest first, named without the folder', () => {
    const [folder] = shelfRows([note('recipes/leek-soup', 1), note('recipes/bread', 5), note('recipes/winter/stew', 3)])
    expect(folder.kind === 'folder' && folder.rows.map((r) => r.name)).toEqual(['Bread', 'Winter, stew', 'Leek soup'])
  })

  it('a folder of one note is just that note', () => {
    expect(shelfRows([note('lists/favourite-insects'), note('mira/voice')]).map((r) => [r.kind, r.name])).toEqual([
      ['note', 'Favourite insects'],
      ['note', 'Mira, voice'],
    ])
  })
})

describe('flatLines', () => {
  const rows = shelfRows([note('a/one', 4), note('a/two', 3), note('b', 2)])

  it('lists the rows, with the notes of the open folder after it', () => {
    expect(flatLines(rows, null).map((l) => [l.row.name, l.inner])).toEqual([
      ['A', false],
      ['B', false],
    ])
    expect(flatLines(rows, 'A').map((l) => [l.row.name, l.inner])).toEqual([
      ['A', false],
      ['One', true],
      ['Two', true],
      ['B', false],
    ])
  })

  it('counts an open folder against the cap', () => {
    const big = shelfRows(Array.from({ length: MAX_ROWS + 5 }, (_, i) => note(`a/n${i}`, i)))
    expect(big).toHaveLength(1)
    expect(flatLines(big, 'A')).toHaveLength(MAX_ROWS + 6)
  })
})

describe('otherShelves', () => {
  const chats = [chat('here', 'Now'), chat('b', 'Newer'), chat('a', 'Older'), chat('empty', 'No notes')]

  it('lists the other chats with notes, in chat order', () => {
    const list = [note('x', 0, 'a'), note('y', 0, 'b'), note('z', 0, 'here'), note('s')]
    expect(otherShelves(list, chats, 'here').map((s) => [s.title, s.notes.length])).toEqual([
      ['Newer', 1],
      ['Older', 1],
    ])
  })

  it('gathers live notes whose chat is gone under one shelf at the end', () => {
    const list = [note('x', 0, 'gone-1'), note('y', 0, 'gone-2'), note('z', 0, 'a')]
    expect(otherShelves(list, chats, 'here').map((s) => [s.title, s.notes.length])).toEqual([
      ['Older', 1],
      ['No chat', 2],
    ])
  })
})

describe('plainSnippet', () => {
  it('drops the Markdown marks that stand alone, and keeps the words', () => {
    expect(plainSnippet('#### The top three - Orchid mantis > wasp * bee')).toBe('The top three Orchid mantis wasp bee')
    expect(plainSnippet('…end of a line ## Next')).toBe('…end of a line Next')
  })

  it('leaves marks inside a word', () => {
    expect(plainSnippet('well-known c# code')).toBe('well-known c# code')
  })
})

describe('plainRefusal', () => {
  it('drops the Error: a model reads', () => {
    expect(plainRefusal('Error: That path belongs to chat/a. Pick another path.')).toBe('That path belongs to chat/a. Pick another path.')
  })
})
