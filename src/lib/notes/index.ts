import type { Note } from '../types'
import { safeCut, shownPath } from './rules'

/** About 2,000 tokens (spec §8). */
export const INDEX_MAX_CHARS = 8000
/** One note must not eat the map. Mikael's own descriptions have no cap. */
const SHOWN_DESCRIPTION = 160
const HEADER = 'Notes index. It can miss the newest notes, so use notes_search too. A line with a count is a folder: give it to notes_read to list it.'

interface Entry {
  line: string
  at: number
  shown: boolean
}

/** A folder: the notes under one first path part. `loose`: the shelf's notes in no folder. */
interface Group {
  folder: string
  loose: boolean
  entries: Entry[]
}

interface Shelf {
  name: string
  groups: Group[]
  closed: boolean
}

const notesWord = (n: number): string => `${n} ${n === 1 ? 'note' : 'notes'}`

const newestFirst = (entries: Entry[]): Entry[] => [...entries].sort((a, b) => b.at - a.at)

const charsOf = (g: Group): number => g.entries.reduce((sum, e) => sum + e.line.length + 1, 0)

function lineFor(n: Note): string {
  const d = n.description
  return `${shownPath(n)} — ${d.length > SHOWN_DESCRIPTION ? `${safeCut(d, SHOWN_DESCRIPTION)}…` : d}`
}

function toShelf(name: string, notes: Note[]): Shelf {
  const groups = new Map<string, Group>()
  for (const n of notes) {
    const cut = n.path.indexOf('/')
    const folder = `${name}/${n.path.slice(0, cut + 1)}`
    const group = groups.get(folder) ?? { folder, loose: cut === -1, entries: [] }
    groups.set(folder, group)
    group.entries.push({ line: lineFor(n), at: n.updatedAt, shown: true })
  }
  return { name, groups: [...groups.values()], closed: false }
}

function groupLines(g: Group): string[] {
  const shown = g.entries.filter((e) => e.shown)
  const hidden = g.entries.length - shown.length
  if (hidden === 0) return shown.map((e) => e.line)
  const tail = shown.length === 0 && !g.loose ? `${g.folder} (${notesWord(hidden)})` : `${g.folder} (and ${hidden} more: use notes_search)`
  return [...newestFirst(shown).map((e) => e.line), tail]
}

function render(shelves: Shelf[]): string {
  const lines = shelves.flatMap((s) => {
    if (!s.closed) return s.groups.flatMap(groupLines)
    return [`${s.name}/ (${notesWord(s.groups.reduce((sum, g) => sum + g.entries.length, 0))})`]
  })
  return [HEADER, ...lines].join('\n')
}

/**
 * The map of the notes: one `path — description` line each, grouped by folder, with full paths so
 * a model can copy one straight into notes_read. Takes the order of `notes.list`.
 * Over the cap, the folders holding the most text close first, each to a name and a count. Notes
 * in no folder come next, then, if the count lines alone are too long, whole shelves. Room left
 * after that goes to the newest notes of the last folder closed and of the notes in no folder,
 * so a flat shelf or one huge folder keeps part of its map. Empty when there are no notes.
 */
export function buildIndex(shared: Note[], chat: Note[]): string {
  const shelves = [toShelf('shared', shared), toShelf('chat', chat)].filter((s) => s.groups.length > 0)
  if (shelves.length === 0) return ''

  const over = (): boolean => render(shelves).length > INDEX_MAX_CHARS
  const groups = shelves.flatMap((s) => s.groups)
  const largestFirst = (list: Group[]): Group[] => [...list].sort((a, b) => charsOf(b) - charsOf(a))
  const closing = [...largestFirst(groups.filter((g) => !g.loose)), ...largestFirst(groups.filter((g) => g.loose))]

  let last: Group | null = null
  for (const g of closing) {
    if (!over()) break
    for (const e of g.entries) e.shown = false
    last = g
  }
  for (const s of shelves) {
    if (over()) s.closed = true
  }

  const hidden = (g: Group): boolean => g.entries.every((e) => !e.shown)
  const open = shelves.filter((s) => !s.closed).flatMap((s) => s.groups)
  const room = open.filter((g) => hidden(g) && (g.loose || g === last)).flatMap((g) => g.entries)
  for (const e of newestFirst(room)) {
    e.shown = true
    if (over()) {
      e.shown = false
      break
    }
  }
  return render(shelves)
}
