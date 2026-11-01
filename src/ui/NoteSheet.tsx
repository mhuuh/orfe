import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { renderMarkdown } from '../lib/markdown'
import { noteName, sameWords, shownPath } from '../lib/notes/rules'
import { notes, refOf, YOU } from '../lib/notes/store'
import type { Note, NoteRevision } from '../lib/types'
import { shortModel } from './Divider'
import { Sheet } from './Sheet'
import { openSheet } from './sheetHistory'
import { useToast } from './Toast'
import { AGE_UNITS, Lock, plainRefusal, shortAge } from './Vault'
import css from './NoteSheet.module.css'

interface Props {
  noteId: string | null
  open: boolean
  onClose: () => void
  /** What 'chat/' means for a shared note: in a move, and in a link. */
  conversationId?: string | null
}

type View = 'read' | 'edit' | 'history'

/** 'shared / lists'. The note's own name is the title under it. */
export const crumb = (n: Pick<Note, 'shelf' | 'path'>): string => shownPath(n).split('/').slice(0, -1).join(' / ')

export function longAge(at: number, now: number): string {
  const unit = AGE_UNITS.find(([ms]) => now - at >= ms)
  if (!unit) return 'just now'
  const n = Math.floor((now - at) / unit[0])
  return `${n} ${unit[2]}${n === 1 ? '' : 's'} ago`
}

/** What a revision did, in one or two words. */
export function revisionWord(r: NoteRevision): string {
  const { before, after } = r
  if (r.undoes !== undefined) return 'undo'
  if (!before) return 'created'
  if (!after) return 'deleted'
  if (before.deletedAt !== null) return 'restored'
  if (before.shelf !== after.shelf || before.path !== after.path) return 'moved'
  if (before.protected !== after.protected) return after.protected ? 'protected' : 'unprotected'
  return before.body === after.body ? 'details changed' : 'edited'
}

/** Whether this revision has words to put back. */
export const canRestore = (r: NoteRevision, note: Note): boolean =>
  note.deletedAt === null && r.after !== null && !sameWords(r.after, note)

const LINK = /\[\[([^[\]\n]+)\]\]/

/**
 * Turns each [[path]] in sanitised html into a button that names the note. Code keeps its text.
 * A path goes in as a text node and a dataset value, so it can't add markup.
 */
export function linkNotes(html: string, className: string): string {
  if (!LINK.test(html)) return html
  const box = document.createElement('template')
  box.innerHTML = html
  const walker = document.createTreeWalker(box.content, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const text of texts) {
    if (!LINK.test(text.data) || text.parentElement?.closest('code, pre, a')) continue
    const parts = text.data.split(LINK).map((part, i) => {
      if (i % 2 === 0) return part
      const link = document.createElement('button')
      link.className = className
      link.dataset.noteLink = part
      link.textContent = noteName(part.replace(/^(shared|chat)\//i, ''))
      return link
    })
    text.replaceWith(...parts)
  }
  return box.innerHTML
}

export function NoteSheet({ noteId, open, onClose, conversationId = null }: Props) {
  /** A tap on a link shows that note in this same sheet. */
  const [linked, setLinked] = useState<string | null>(null)
  const [view, setViewState] = useState<View>('read')
  /** The editor holds edits that are not saved. */
  const dirty = useRef(false)
  /** The inline "Unsaved changes · Discard · Keep editing" row is showing. */
  const [asking, setAsking] = useState(false)
  /** Bumped to register the view's Back step again after a refused Back. */
  const [backGen, setBackGen] = useState(0)
  const inView = view !== 'read'

  const setView = (v: View) => {
    dirty.current = false
    setAsking(false)
    setViewState(v)
  }

  // Each open starts on the note.
  useEffect(() => {
    if (open) {
      dirty.current = false
      setAsking(false)
      setViewState('read')
      setLinked(null)
    }
  }, [open])

  /** Back to the note, unless that would drop edits: then ask first. */
  const leave = useRef(() => {})
  leave.current = () => {
    if (dirty.current) setAsking(true)
    else setView('read')
  }

  // The editor and History get their own Back step: Back (and Escape) return to the note, not to the vault.
  useEffect(() => {
    if (!open || !inView) return
    const me = openSheet(() => {
      // Back has already popped this step. If we refuse, put it back, so the next Back asks again.
      if (dirty.current) {
        setAsking(true)
        setBackGen((g) => g + 1)
      } else leave.current()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && me.isTop()) leave.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      me.release()
    }
  }, [open, inView, backGen])

  const id = linked ?? noteId
  const onBack = inView ? () => leave.current() : onClose
  return (
    <Sheet open={open} onClose={onBack} title="Note" side="full" tone="bg">
      {id && (
        <NoteBody
          // A note shown through a link starts clean: no panel from the note before it.
          key={id}
          id={id}
          view={view}
          setView={setView}
          onBack={onBack}
          onClose={onClose}
          onLink={setLinked}
          conversationId={conversationId}
          guard={{
            asking,
            onDirty: (d) => {
              dirty.current = d
            },
            discard: () => setView('read'),
            keep: () => setAsking(false),
          }}
        />
      )}
    </Sheet>
  )
}

/** What the editor needs for the unsaved-changes guard. */
interface Guard {
  asking: boolean
  onDirty: (dirty: boolean) => void
  discard: () => void
  keep: () => void
}

interface BodyProps {
  id: string
  view: View
  setView: (v: View) => void
  onBack: () => void
  onClose: () => void
  onLink: (id: string) => void
  conversationId: string | null
  guard: Guard
}

function NoteBody({ id, view, setView, onBack, onClose, onLink, conversationId, guard }: BodyProps) {
  const [more, setMore] = useState(false)
  const data = useLiveQuery(async () => {
    const [note, revs] = await Promise.all([notes.get(id), notes.revisions(id)])
    return note && { note, revs }
  }, [id])
  if (!data) return null
  const { note, revs } = data
  return (
    <div className={css.page}>
      <header className={css.head}>
        <button className={css.back} onClick={onBack} aria-label="Back">
          <span aria-hidden="true">‹</span>
        </button>
        <span className={css.crumb}>{crumb(note)}</span>
        {view === 'read' && note.deletedAt === null && (
          <button className={css.more} onClick={() => setMore((m) => !m)} aria-label="More" aria-expanded={more}>
            <span aria-hidden="true">⋯</span>
          </button>
        )}
      </header>
      {view === 'read' && (
        <ReadView
          note={note}
          writer={revs.at(-1)?.writer}
          more={more}
          conversationId={conversationId}
          setView={setView}
          onClose={onClose}
          onLink={onLink}
        />
      )}
      {view === 'edit' && <Editor note={note} onDone={() => setView('read')} guard={guard} />}
      {view === 'history' && <History note={note} revs={revs} onDone={() => setView('read')} />}
    </div>
  )
}

/** Runs a store call. A failure says so in a toast. */
function useRun() {
  const toast = useToast()
  return (work: () => Promise<void>, fail: string) => {
    work().catch((e: unknown) => {
      console.error(e)
      toast.show(fail)
    })
  }
}

interface ReadProps {
  note: Note
  writer: string | undefined
  more: boolean
  conversationId: string | null
  setView: (v: View) => void
  onClose: () => void
  onLink: (id: string) => void
}

function ReadView({ note, writer, more, conversationId, setView, onClose, onLink }: ReadProps) {
  const [panel, setPanel] = useState<'move' | 'clear' | null>(null)
  const toast = useToast()
  const run = useRun()
  const html = useMemo(() => linkNotes(renderMarkdown(note.body), css.link), [note.body])
  const inTrash = note.deletedAt !== null

  const restore = async () => {
    const r = await notes.restore(note.id, YOU)
    if ('refused' in r) toast.show(plainRefusal(r.refused))
  }

  const remove = () =>
    run(async () => {
      const r = await notes.remove(refOf(note), YOU)
      if ('refused' in r) {
        toast.show(plainRefusal(r.refused))
        return
      }
      onClose()
      toast.show('Note deleted', { label: 'Undo', run: () => run(restore, "Couldn't restore the note.") })
    }, "Couldn't delete the note.")

  const setProtected = (on: boolean) =>
    run(async () => {
      await notes.setProtected(note.id, on, YOU)
      setPanel(null)
    }, "Couldn't change the protection.")

  const openLink = (e: MouseEvent<HTMLDivElement>) => {
    const path = (e.target as HTMLElement).closest<HTMLElement>('[data-note-link]')?.dataset.noteLink
    if (!path) return
    run(async () => {
      const found = await notes.read({ path, conversationId: refOf(note, conversationId ?? undefined).conversationId })
      if (found) onLink(found.id)
      else toast.show('There is no note at that path.')
    }, "Couldn't open the link.")
  }

  return (
    <div className={css.content}>
      <h2 className={css.title}>{noteName(note.path)}</h2>
      <div className={css.meta}>
        Updated {longAge(note.updatedAt, Date.now())}
        {writer && ` · ${shortModel(writer)}`} · version {note.version}
      </div>
      <div className={css.actions}>
        {inTrash ? (
          <button className={css.chip} onClick={() => run(restore, "Couldn't restore the note.")}>
            Restore
          </button>
        ) : (
          <button className={css.chip} onClick={() => setView('edit')}>
            Edit
          </button>
        )}
        <button className={css.chip} onClick={() => setView('history')}>
          History
        </button>
        {!inTrash && (
          <>
            <button className={css.chip} aria-expanded={panel === 'move'} onClick={() => setPanel(panel === 'move' ? null : 'move')}>
              Move
            </button>
            <button
              className={`${css.chip} ${note.protected ? css.chipOn : ''}`}
              aria-pressed={note.protected}
              onClick={() => (note.protected ? setPanel('clear') : setProtected(true))}
            >
              {note.protected && <Lock quiet />}
              {note.protected ? 'Protected' : 'Protect'}
            </button>
            {more && (
              <button className={css.chip} onClick={remove}>
                Delete
              </button>
            )}
          </>
        )}
      </div>
      {inTrash && <p className={css.notice}>This note is in Trash.</p>}
      {note.protected && !inTrash && panel !== 'clear' && (
        <p className={css.notice}>Models can read, move and tag this note. Only you can change the words.</p>
      )}
      {panel === 'clear' && (
        <div className={css.notice}>
          <p className={css.ask}>Clear protection? Models can then change the words.</p>
          <div className={css.buttons}>
            <button className={css.go} onClick={() => setProtected(false)}>
              Clear
            </button>
            <button className={css.btn} onClick={() => setPanel(null)}>
              Keep
            </button>
          </div>
        </div>
      )}
      {panel === 'move' && <MovePanel note={note} conversationId={conversationId} onDone={() => setPanel(null)} />}
      <div className={css.body} onClick={openLink} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

interface MoveProps {
  note: Note
  conversationId: string | null
  onDone: () => void
}

function MovePanel({ note, conversationId, onDone }: MoveProps) {
  const [path, setPath] = useState(shownPath(note))
  const [problem, setProblem] = useState<string | null>(null)
  const run = useRun()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const to = path.trim()
    if (note.shelf === 'shared' && !conversationId && /^chat\//i.test(to)) {
      setProblem('Open a chat first.')
      return
    }
    run(async () => {
      const r = await notes.move(refOf(note, conversationId ?? undefined), to, YOU)
      if ('ok' in r) onDone()
      else setProblem(plainRefusal(r.refused))
    }, "Couldn't move the note.")
  }

  return (
    <form className={css.notice} onSubmit={submit}>
      <input
        className={css.field}
        value={path}
        aria-label="New path"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        onChange={(e) => setPath(e.target.value)}
      />
      {problem ? (
        <p className={css.problem} role="alert">
          {problem}
        </p>
      ) : (
        <p className={css.ask}>Start with shared/ or chat/.</p>
      )}
      <div className={css.buttons}>
        <button className={css.go} type="submit" aria-label="Move note" disabled={path.trim() === ''}>
          Move
        </button>
        <button className={css.btn} type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

interface EditorProps {
  note: Note
  onDone: () => void
  guard: Guard
}

function Editor({ note, onDone, guard }: EditorProps) {
  // The note as the edit began. The live copy can change under it: that is the stale case.
  const [base] = useState(note)
  const [text, setText] = useState(note.body)
  const [line, setLine] = useState(note.description)
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** A later write got there first. Mikael picks, and his text stays here until he does. */
  const [conflict, setConflict] = useState<Note | null>(null)
  const textField = useRef<HTMLTextAreaElement>(null)
  const toast = useToast()

  const dirty = text !== base.body || line !== base.description
  const { onDirty } = guard
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
  const canSave = line.trim() !== '' && !working

  const act = async (work: () => Promise<void>) => {
    setWorking(true)
    setProblem(null)
    try {
      await work()
    } catch (e) {
      console.error(e)
      toast.show("Couldn't save the note.")
    } finally {
      setWorking(false)
    }
  }

  const write = async (at: Note) => {
    const r = await notes.write(refOf(at), { body: text, description: line, expectedVersion: at.version }, YOU)
    if ('ok' in r) {
      onDone()
      return
    }
    const now = await notes.get(at.id)
    if (now && (now.deletedAt !== null || now.version !== at.version)) setConflict(now)
    else setProblem(plainRefusal(r.refused))
  }

  const save = () => act(() => (dirty ? write(base) : Promise.resolve(onDone())))

  // Mine goes on top. The other version stays in History.
  const saveMine = () =>
    act(async () => {
      setConflict(null)
      const now = await notes.get(base.id)
      if (!now) return
      if (now.deletedAt === null) {
        await write(now)
        return
      }
      const r = await notes.restore(now.id, YOU)
      if ('ok' in r) await write(r.ok)
      else setProblem(plainRefusal(r.refused))
    })

  const said = conflict
    ? `${conflict.deletedAt === null ? 'This note changed while you edited.' : 'This note went to Trash while you edited.'} Your text is still here. Save mine keeps the other version in History.`
    : problem

  return (
    <div className={css.editor}>
      <input
        className={css.lineField}
        value={line}
        placeholder="One line: what the note holds"
        aria-label="Note description"
        autoComplete="off"
        enterKeyHint="next"
        onChange={(e) => setLine(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            textField.current?.focus()
          }
        }}
      />
      <textarea
        ref={textField}
        className={css.textField}
        value={text}
        rows={8}
        aria-label="Note text"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSave) void (conflict ? saveMine() : save())
        }}
      />
      {said && (
        <p className={css.warn} role="alert">
          {said}
        </p>
      )}
      {/* Sticky, so Save stays in reach when the keyboard shrinks the sheet. */}
      <div className={css.bar}>
        {guard.asking ? (
          <>
            <span className={css.barAsk}>Unsaved changes</span>
            <button className={css.quiet} onClick={guard.discard}>
              Discard
            </button>
            <button
              className={css.save}
              onClick={() => {
                guard.keep()
                // Back to the text, so the Android keyboard comes back up.
                textField.current?.focus({ preventScroll: true })
              }}
            >
              Keep editing
            </button>
          </>
        ) : conflict ? (
          <>
            <button className={css.quiet} onClick={guard.discard}>
              Discard
            </button>
            <button className={css.save} onClick={() => void saveMine()} disabled={!canSave}>
              Save mine
            </button>
          </>
        ) : (
          <button className={css.save} onClick={() => void save()} disabled={!canSave}>
            Save
          </button>
        )}
      </div>
    </div>
  )
}

interface HistoryProps {
  note: Note
  revs: NoteRevision[]
  onDone: () => void
}

function History({ note, revs, onDone }: HistoryProps) {
  const toast = useToast()
  const run = useRun()
  const now = Date.now()
  const newestFirst = [...revs].reverse()

  const restore = (r: NoteRevision) =>
    run(async () => {
      const done = await notes.restoreRevision(r.id, YOU)
      if ('refused' in done) {
        toast.show(plainRefusal(done.refused))
        return
      }
      onDone()
      toast.show(`Back to the words of version ${r.version}`)
    }, "Couldn't restore that version.")

  return (
    <div className={css.content}>
      <h2 className={css.title}>History</h2>
      <ul className={css.history}>
        {newestFirst.map((r, i) => (
          <li key={r.id} className={css.rev}>
            <div className={css.revText}>
              <div>Version {r.version}</div>
              <div className={css.revMeta}>
                {shortModel(r.writer)} · {revisionWord(r)} · {shortAge(r.at, now)}
              </div>
            </div>
            {i === 0 ? (
              <span className={css.current}>Current</span>
            ) : (
              canRestore(r, note) && (
                <button className={css.chip} aria-label={`Restore version ${r.version}`} onClick={() => restore(r)}>
                  Restore
                </button>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
