import { useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { noteName } from '../lib/notes/rules'
import { notes, YOU } from '../lib/notes/store'
import { storage } from '../lib/storage'
import type { Conversation, Note } from '../lib/types'
import { useToast } from './Toast'
import css from './Vault.module.css'

interface Props {
  conversationId: string | null
  onOpen: (id: string) => void
}

const MAX_HITS = 50

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** Largest first. The short form is `3w`, the long form `3 weeks ago`. */
export const AGE_UNITS: [ms: number, short: string, word: string][] = [
  [365 * DAY, 'y', 'year'],
  [30 * DAY, 'mo', 'month'],
  [7 * DAY, 'w', 'week'],
  [DAY, 'd', 'day'],
  [60 * MINUTE, 'h', 'hour'],
  [MINUTE, 'm', 'minute'],
]

export function shortAge(at: number, now: number): string {
  const unit = AGE_UNITS.find(([ms]) => now - at >= ms)
  return unit ? `${Math.floor((now - at) / unit[0])}${unit[1]}` : 'now'
}

/** A refusal is written for a model. The word "Error:" means nothing to Mikael. */
export const plainRefusal = (refused: string): string => refused.replace(/^Error: /, '')

/** A search snippet is raw Markdown, for a model. Marks that stand alone are noise here. */
export const plainSnippet = (snippet: string): string => snippet.replace(/(^|\s)[#>*-]+\s+/g, '$1')

const count = (n: number): string => `${n} ${n === 1 ? 'note' : 'notes'}`

export interface NoteRow {
  kind: 'note'
  name: string
  note: Note
}
export interface FolderRow {
  kind: 'folder'
  name: string
  rows: NoteRow[]
}
export type Row = NoteRow | FolderRow

const newestOf = (r: Row): number => (r.kind === 'note' ? r.note.updatedAt : Math.max(...r.rows.map((x) => x.note.updatedAt)))

const newestFirst = <T extends Row>(rows: T[]): T[] => [...rows].sort((a, b) => newestOf(b) - newestOf(a))

/** A shelf's rows, the newest first. Notes that share a first path part fold into one row. */
export function shelfRows(list: Note[]): Row[] {
  const byFolder = new Map<string, Note[]>()
  const loose: NoteRow[] = []
  for (const note of list) {
    const cut = note.path.indexOf('/')
    if (cut === -1) loose.push({ kind: 'note', name: noteName(note.path), note })
    else byFolder.set(note.path.slice(0, cut), [...(byFolder.get(note.path.slice(0, cut)) ?? []), note])
  }
  const folded = [...byFolder].map(([folder, group]): Row => {
    if (group.length === 1) return { kind: 'note', name: noteName(group[0].path), note: group[0] }
    const rows = group.map((note): NoteRow => ({ kind: 'note', name: noteName(note.path.slice(folder.length + 1)), note }))
    return { kind: 'folder', name: noteName(folder), rows: newestFirst(rows) }
  })
  return newestFirst([...loose, ...folded])
}

export interface OtherShelf {
  id: string
  title: string
  notes: Note[]
}

/** A live note whose chat is gone can come out of Trash. Its shelf keeps it reachable here. */
const NO_CHAT = 'no-chat'

/** The other chats that hold notes, in chat order. Live notes with no chat share one shelf at the end. */
export function otherShelves(list: Note[], chats: Conversation[], current: string | null): OtherShelf[] {
  const on = (shelf: string) => list.filter((n) => n.shelf === shelf)
  const known = new Set(chats.map((c) => c.id))
  const shelves = chats.filter((c) => c.id !== current).map((c) => ({ id: c.id, title: c.title, notes: on(c.id) }))
  const orphans = list.filter((n) => n.shelf !== 'shared' && !known.has(n.shelf))
  return [...shelves, { id: NO_CHAT, title: 'No chat', notes: orphans }].filter((s) => s.notes.length > 0)
}

/** `quiet`: the words next to it already say protected. */
export function Lock({ quiet = false }: { quiet?: boolean }) {
  const name = quiet ? ({ 'aria-hidden': true } as const) : ({ role: 'img', 'aria-label': 'Protected' } as const)
  return (
    <svg className={css.lock} viewBox="0 0 12 12" {...name}>
      <path d="M3.5 5V3.6a2.5 2.5 0 0 1 5 0V5M2.5 5h7v5.5h-7z" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

interface NoteLineProps {
  name: string
  note: Note
  /** The mono text on the right. */
  right: ReactNode
  /** The line under the name. */
  detail: string
  wrap?: boolean
  onOpen: (id: string) => void
}

function NoteLine({ name, note, right, detail, wrap, onOpen }: NoteLineProps) {
  return (
    <button className={css.row} onClick={() => onOpen(note.id)}>
      <span className={css.top}>
        <span className={css.name}>{name}</span>
        {note.protected && <Lock />}
        <span className={css.right}>{right}</span>
      </span>
      <span className={`${css.detail} ${wrap ? css.wrap : ''}`}>{detail}</span>
    </button>
  )
}

interface RowsProps {
  rows: Row[]
  now: number
  onOpen: (id: string) => void
}

function Rows({ rows, now, onOpen }: RowsProps) {
  const [openFolder, setOpenFolder] = useState<string | null>(null)
  const line = (r: NoteRow, inner: boolean) => (
    <li key={r.note.id} className={`${css.item} ${inner ? css.inner : ''}`}>
      <NoteLine name={r.name} note={r.note} right={shortAge(r.note.updatedAt, now)} detail={r.note.description} onOpen={onOpen} />
    </li>
  )
  return (
    <ul className={css.rows}>
      {rows.map((r) => {
        if (r.kind === 'note') return line(r, false)
        const opened = openFolder === r.name
        return [
          <li key={`folder:${r.name}`} className={css.item}>
            <button className={css.row} aria-expanded={opened} onClick={() => setOpenFolder(opened ? null : r.name)}>
              <span className={css.top}>
                <span className={css.name}>{r.name}</span>
                <span className={css.right}>
                  {count(r.rows.length)} <span className={opened ? css.chevOpen : css.chev}>›</span>
                </span>
              </span>
              <span className={css.detail}>Folder</span>
            </button>
          </li>,
          opened && r.rows.map((x) => line(x, true)),
        ]
      })}
    </ul>
  )
}

interface ShelfProps extends Omit<RowsProps, 'rows'> {
  label: string
  list: Note[]
}

function Shelf({ label, list, now, onOpen }: ShelfProps) {
  return (
    <section className={css.shelf} aria-label={label}>
      <div className={css.head}>
        <span className={css.headText}>{label}</span>
        <span className={css.headCount}>{count(list.length)}</span>
      </div>
      <Rows rows={shelfRows(list)} now={now} onOpen={onOpen} />
    </section>
  )
}

export function Vault({ conversationId, onOpen }: Props) {
  const [query, setQuery] = useState('')
  const [pickedShelf, setPickedShelf] = useState<string | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const toast = useToast()

  const data = useLiveQuery(async () => {
    const [all, chats, trash] = await Promise.all([notes.all(), storage.listConversations(), notes.trash()])
    return { all, chats, trash }
  }, [])

  const q = query.trim()
  const hits = useLiveQuery(async () => {
    if (!q) return null
    const shelves = new Set((await notes.all()).map((n) => n.shelf))
    return notes.search([...shelves], q, MAX_HITS)
  }, [q])

  if (!data) return null
  const now = Date.now()
  const { all, chats, trash } = data
  const title = (id: string): string | undefined => chats.find((c) => c.id === id)?.title
  const here = conversationId ? title(conversationId) : undefined
  const shelfName = (shelf: string): string => (shelf === 'shared' ? 'Shared' : shelf === conversationId ? 'This chat' : (title(shelf) ?? 'No chat'))
  const others = otherShelves(all, chats, conversationId)
  const picked = others.find((s) => s.id === pickedShelf)

  const restore = (note: Note) => {
    notes
      .restore(note.id, YOU)
      .then((r) => {
        if ('refused' in r) toast.show(plainRefusal(r.refused))
      })
      .catch((e: unknown) => {
        console.error(e)
        toast.show("Couldn't restore the note.")
      })
  }

  const from = (shelf: string): string => {
    const name = shelf === 'shared' ? 'Shared' : title(shelf)
    return name ? `From ${name}` : 'From a deleted chat'
  }

  return (
    <div className={css.vault}>
      <input
        className={css.search}
        value={query}
        placeholder="Search notes"
        aria-label="Search notes"
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => setQuery(e.target.value)}
      />
      {q ? (
        <>
          {/* The last result stays up while the next one comes. An empty list says so. */}
          {hits?.length === 0 && <p className={css.none}>No notes found</p>}
          <ul className={css.rows}>
            {hits?.map(({ note, snippet }) => (
              <li key={note.id} className={css.item}>
                <NoteLine name={noteName(note.path)} note={note} right={shelfName(note.shelf)} detail={plainSnippet(snippet)} wrap onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {/* Task 22 mounts the To review row here. */}
          <Shelf label="Shared" list={all.filter((n) => n.shelf === 'shared')} now={now} onOpen={onOpen} />
          {conversationId && (
            <Shelf
              label={here ? `This chat · ${here}` : 'This chat'}
              list={all.filter((n) => n.shelf === conversationId)}
              now={now}
              onOpen={onOpen}
            />
          )}
          {others.length > 0 && (
            <section className={css.shelf} aria-label="Other chats">
              <div className={css.head}>
                <span className={css.headText}>Other chats</span>
              </div>
              <div className={css.chips}>
                {others.map((s) => (
                  <button
                    key={s.id}
                    className={`${css.chip} ${s.id === pickedShelf ? css.chipOn : ''}`}
                    aria-pressed={s.id === pickedShelf}
                    onClick={() => setPickedShelf(s.id === pickedShelf ? null : s.id)}
                  >
                    <span className={css.chipName}>{s.title}</span> · {count(s.notes.length)}
                  </button>
                ))}
              </div>
              {picked && <Rows rows={shelfRows(picked.notes)} now={now} onOpen={onOpen} />}
            </section>
          )}
          <section className={css.shelf} aria-label="Trash">
            <button
              className={css.trash}
              aria-expanded={trashOpen}
              disabled={trash.length === 0}
              onClick={() => setTrashOpen((o) => !o)}
            >
              <span className={css.name}>Trash</span>
              <span className={css.right}>
                {count(trash.length)} {trash.length > 0 && <span className={trashOpen ? css.chevOpen : css.chev}>›</span>}
              </span>
            </button>
            {trashOpen && (
              <ul className={css.rows}>
                {trash.map((note) => {
                  const name = noteName(note.path)
                  return (
                    <li key={note.id} className={css.item}>
                      <NoteLine name={name} note={note} right={null} detail={from(note.shelf)} onOpen={onOpen} />
                      <button className={css.restore} aria-label={`Restore ${name}`} onClick={() => restore(note)}>
                        Restore
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
