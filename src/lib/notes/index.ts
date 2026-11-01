import type { Note } from '../types'
import { shownPath } from './rules'

/** About 2,000 tokens (spec §8). */
export const INDEX_MAX_CHARS = 8000
/** One note must not eat the map. Descriptions have no length rule of their own. */
const MAX_DESCRIPTION = 160
const HEADER = 'Notes index. It can miss the newest notes, so use notes_search too. A line with a count is a folder: give it to notes_read to list it.'

/** A folder: the notes under one first path part. A note in no folder is a group with `folder` null. */
interface Group {
  folder: string | null
  lines: string[]
  closed: boolean
}

interface Shelf {
  name: string
  groups: Group[]
  closed: boolean
}

const notesWord = (n: number): string => `${n} ${n === 1 ? 'note' : 'notes'}`

const charsOf = (lines: string[]): number => lines.reduce((sum, l) => sum + l.length + 1, 0)

const closedLine = (folder: string, count: number): string => `${folder} (${notesWord(count)})`

function lineFor(n: Note): string {
  const d = n.description
  return `${shownPath(n)} — ${d.length > MAX_DESCRIPTION ? `${d.slice(0, MAX_DESCRIPTION)}…` : d}`
}

function toShelf(name: string, notes: Note[]): Shelf {
  const groups: Group[] = []
  const folders = new Map<string, Group>()
  for (const n of notes) {
    const cut = n.path.indexOf('/')
    if (cut === -1) {
      groups.push({ folder: null, lines: [lineFor(n)], closed: false })
      continue
    }
    const folder = `${name}/${n.path.slice(0, cut + 1)}`
    let group = folders.get(folder)
    if (!group) {
      group = { folder, lines: [], closed: false }
      folders.set(folder, group)
      groups.push(group)
    }
    group.lines.push(lineFor(n))
  }
  return { name, groups, closed: false }
}

const linesOf = (s: Shelf): string[] => s.groups.flatMap((g) => g.lines)

function render(shelves: Shelf[]): string {
  const lines = shelves.flatMap((s) => {
    if (s.closed) return [closedLine(`${s.name}/`, linesOf(s).length)]
    return s.groups.flatMap((g) => (g.closed && g.folder !== null ? [closedLine(g.folder, g.lines.length)] : g.lines))
  })
  return [HEADER, ...lines].join('\n')
}

/**
 * The map of the notes: one `path — description` line each, grouped by folder, with full paths so
 * a model can copy one straight into notes_read. Takes the order of `notes.list`.
 * Over the cap, the folders holding the most text close first, and each closes to a name and a
 * count. Notes in no folder go last, when a whole shelf closes. Empty when there are no notes.
 */
export function buildIndex(shared: Note[], chat: Note[]): string {
  const shelves = [toShelf('shared', shared), toShelf('chat', chat)].filter((s) => s.groups.length > 0)
  if (shelves.length === 0) return ''

  const folders = shelves.flatMap((s) => s.groups).filter((g) => g.folder !== null)
  const byText = (a: { chars: number }, b: { chars: number }): number => b.chars - a.chars
  const steps = [
    ...folders.map((item) => ({ item, chars: charsOf(item.lines) })).sort(byText),
    ...shelves.map((item) => ({ item, chars: charsOf(linesOf(item)) })).sort(byText),
  ]
  for (const { item } of steps) {
    if (render(shelves).length <= INDEX_MAX_CHARS) break
    item.closed = true
  }
  return render(shelves)
}
