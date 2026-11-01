import { hashText } from '../hash'
import { db, newId } from '../storage'
import type { Note, NoteRevision } from '../types'
import { PROTECTED, badPathText, checkDescription, checkWrite, echo, nearMatch, sameWords, shelfOf, shownPath } from './rules'

/** The note store. With `storage.ts`, this file is the Dexie seam for notes (Ruling P3). */

export interface NoteRef {
  /** Starts with 'shared/' or 'chat/'. */
  path: string
  conversationId: string
}

export interface WriteInput {
  body: string
  description: string
  tags?: string[]
  expectedVersion?: number
  isNew?: boolean
  shrink?: boolean
  protected?: boolean
  supersedes?: string
}

export interface EditChange {
  /** Must match once, exactly. Left out or empty with `newText`: insert `newText` at the end. */
  oldText?: string
  newText?: string
  tags?: string[]
  description?: string
  expectedVersion: number
}

export interface Writer {
  writer: string
  messageId: string | null
  callId: string | null
  runId?: string
}

export type Result = { ok: Note } | { refused: string }

/** Call ids. `kept` means changed later, so the write stays. A shared-shelf write is in neither list. */
export interface UndoReport {
  undone: string[]
  kept: string[]
}

/** Call ids. `kept` means the redo did not apply: the note changed later, or it was not undone. */
export interface RedoReport {
  redone: string[]
  kept: string[]
}

export interface NoteStore {
  /** Follows aliases, skips deleted. */
  read(ref: NoteRef): Promise<Note | undefined>
  /** Any note by id, in Trash too. */
  get(id: string): Promise<Note | undefined>
  list(shelf: string): Promise<Note[]>
  /** The live notes of every shelf, in no set order. */
  all(): Promise<Note[]>
  /** Notes in Trash, the newest delete first. */
  trash(): Promise<Note[]>
  search(shelves: string[], q: string, limit: number): Promise<{ note: Note; snippet: string }[]>
  write(ref: NoteRef, input: WriteInput, by: Writer): Promise<Result>
  edit(ref: NoteRef, change: EditChange, by: Writer): Promise<Result>
  remove(ref: NoteRef, by: Writer): Promise<Result>
  move(ref: NoteRef, newPath: string, by: Writer): Promise<Result>
  /** Off is refused unless `by.writer` is 'you'. */
  setProtected(id: string, on: boolean, by: Writer): Promise<Result>
  /** Oldest first. */
  revisions(noteId: string): Promise<NoteRevision[]>
  revert(revisionId: string, by: Writer): Promise<'done' | 'changed-later'>
  /** Brings a note out of Trash to its own place, as a later write. Refused while another note holds that place. */
  restore(id: string, by: Writer): Promise<Result>
  /** Puts back the words of an old revision as a new write. The path and the protection stay as they are. */
  restoreRevision(revisionId: string, by: Writer): Promise<Result>
  undoCalls(messageId: string, callIds: string[], shelves: 'chat'): Promise<UndoReport>
  /** Takes the message too, because a model can reuse an id across replies. */
  redoCalls(callIds: string[], messageId: string): Promise<RedoReport>
  /** The write a call made, never an undo or a redo of it. */
  byCall(callId: string, messageId?: string): Promise<NoteRevision | undefined>
  /** Whether a write still counts: no undo has taken it back. */
  stands(rev: NoteRevision): Promise<boolean>
  /** Sends a chat's live notes to Trash, all stamped `deletedAt`. */
  trashShelf(shelf: string, deletedAt: number): Promise<void>
  /** Brings back only the notes with that stamp. Notes already in Trash stay there (Ruling P8). */
  restoreShelf(shelf: string, deletedAt: number): Promise<void>
}

/** Mikael, acting in the app. */
export const YOU: Writer = { writer: 'you', messageId: null, callId: null }

/** The ref that finds a note you hold, on any shelf. `chat`: what 'chat/' means in a move of a shared note. */
export const refOf = (n: Note, chat?: string): NoteRef => ({
  path: shownPath(n),
  conversationId: n.shelf === 'shared' ? (chat ?? n.shelf) : n.shelf,
})

const SNIPPET_SIDE = 60

const lower = (s: string): string => s.toLowerCase()

const rw = <T>(fn: () => Promise<T>): Promise<T> => db.transaction('rw', db.notes, db.noteRevisions, fn)

const refuse = (refused: string): Result => ({ refused })

const badPath = (path: string): Result => refuse(badPathText(path))

const missingText = (path: string): string => `Error: There is no note at ${echo(path)}. Use notes_search to find it.`

const missing = (path: string): Result => refuse(missingText(path))

const GONE = 'Error: This note is gone. Use notes_search to find it.'

/** Where a note is, in the form `aliases` keeps. */
const place = (n: Pick<Note, 'shelf' | 'path'>): string => `${n.shelf}/${n.path}`

/** The next state of a note. A write always raises the version, an undo too. */
function bump(prev: Note, patch: Partial<Note>): Note {
  const next = { ...prev, ...patch, version: prev.version + 1, updatedAt: Date.now() }
  return { ...next, bodyHash: hashText(next.body) }
}

/** Stores a note and its revision. Call inside `rw`. */
async function commit(before: Note | null, next: Note, by: Writer, undoes?: string): Promise<Note> {
  await db.notes.put(next)
  await db.noteRevisions.add({
    id: newId(),
    noteId: next.id,
    version: next.version,
    before,
    after: next.deletedAt === null ? next : null,
    writer: by.writer,
    messageId: by.messageId,
    callId: by.callId,
    runId: by.runId ?? null,
    at: next.updatedAt,
    ...(undoes ? { undoes } : {}),
  })
  return next
}

const live = (shelf: string): Promise<Note[]> =>
  db.notes
    .where('shelf')
    .equals(shelf)
    .filter((n) => n.deletedAt === null)
    .toArray()

/**
 * The live note at this place, by path or by an old path, ignoring case. An old path can lead to
 * another shelf, but never into the shelf of another chat.
 */
async function locate(shelf: string, path: string, conversationId: string): Promise<Note | undefined> {
  const wanted = lower(path)
  const here = (await live(shelf)).find((n) => lower(n.path) === wanted)
  if (here) return here
  const old = lower(`${shelf}/${path}`)
  return db.notes
    .filter((n) => n.deletedAt === null && (n.shelf === 'shared' || n.shelf === conversationId) && n.aliases.some((a) => lower(a) === old))
    .first()
}

async function find(ref: NoteRef): Promise<Note | undefined> {
  const at = shelfOf(ref.path, ref.conversationId)
  return at ? locate(at.shelf, at.path, ref.conversationId) : undefined
}

/** Whether another live note holds this place, as its path or an old path. */
async function taken(id: string, shelf: string, path: string, conversationId: string): Promise<boolean> {
  const holder = await locate(shelf, path, conversationId)
  return holder !== undefined && holder.id !== id
}

/**
 * The version a new note starts from. It goes above each Trash note that held this place, so a
 * version read from one of those can't pass as a read of the new note.
 */
async function firstVersion(shelf: string, path: string): Promise<number> {
  const wanted = lower(path)
  const old = lower(`${shelf}/${path}`)
  const trash = await db.notes
    .filter((n) => n.deletedAt !== null && ((n.shelf === shelf && lower(n.path) === wanted) || n.aliases.some((a) => lower(a) === old)))
    .toArray()
  return Math.max(0, ...trash.map((n) => n.version)) + 1
}

/** A note that comes to a place by a move or a restore follows the same rule. */
const atPlace = async (n: Note): Promise<Note> => ({ ...n, version: Math.max(n.version, await firstVersion(n.shelf, n.path)) })

const history = (noteId: string): Promise<NoteRevision[]> =>
  db.noteRevisions.where('[noteId+version]').between([noteId, -Infinity], [noteId, Infinity]).toArray()

/** The writes that still count, newest first. An undo and the revision it took back cancel out. */
function standing(revs: NoteRevision[]): NoteRevision[] {
  const cancelled = new Set<string>()
  const writes: NoteRevision[] = []
  for (const r of [...revs].reverse()) {
    if (cancelled.has(r.id)) continue
    if (r.undoes === undefined) writes.push(r)
    else cancelled.add(r.undoes)
  }
  return writes
}

/** The undo rule: only a note's latest change can be undone. The last row may itself be an undo. */
const isLatest = (revs: NoteRevision[], rev: NoteRevision): boolean => revs.at(-1)?.id === rev.id || standing(revs)[0]?.id === rev.id

/**
 * The last change still in force: a write, or an undo of a write. A redo takes back an undo, so
 * the two leave no trace. Undone writes come back in reverse order through this.
 */
function lastChange(revs: NoteRevision[]): NoteRevision | undefined {
  const byId = new Map(revs.map((r) => [r.id, r]))
  const cancelled = new Set<string>()
  for (const r of [...revs].reverse()) {
    if (cancelled.has(r.id)) continue
    if (r.undoes === undefined || byId.get(r.undoes)?.undoes === undefined) return r
    cancelled.add(r.undoes)
  }
  return undefined
}

/** Old paths that this note can keep. One that another note took while this one was away goes. */
async function freeAliases(n: Note): Promise<string[]> {
  const kept: string[] = []
  for (const a of n.aliases) {
    const cut = a.indexOf('/')
    if (!(await taken(n.id, a.slice(0, cut), a.slice(cut + 1), n.shelf))) kept.push(a)
  }
  return kept
}

/** Puts a note back as it was before `rev`. False if its path is now taken. Call inside `rw`. */
async function undo(rev: NoteRevision, by: Writer): Promise<boolean> {
  const cur = await db.notes.get(rev.noteId)
  if (!cur) return false
  const next = bump(cur, rev.before ?? { deletedAt: Date.now() })
  if (next.deletedAt !== null) {
    await commit(cur, next, by, rev.id)
    return true
  }
  if (await taken(next.id, next.shelf, next.path, next.shelf)) return false
  await commit(cur, await atPlace({ ...next, aliases: await freeAliases(next) }), by, rev.id)
  return true
}

/**
 * Applies `rev` again by taking back its undo. That runs only when the undo is the note's last
 * change. So a write that was never undone stays out, and nothing later can be overwritten.
 */
async function redo(rev: NoteRevision): Promise<boolean> {
  const last = lastChange(await history(rev.noteId))
  return last?.undoes === rev.id && (await undo(last, { ...YOU, messageId: rev.messageId, callId: rev.callId }))
}

/** A write that goes near the shared shelf stays when a reply is rerolled. */
const chatOnly = (rev: NoteRevision): boolean => [rev.before, rev.after].every((n) => n?.shelf !== 'shared')

function count(body: string, text: string): number {
  let n = 0
  for (let i = body.indexOf(text); i !== -1; i = body.indexOf(text, i + 1)) n++
  return n
}

function snippet(note: Note, terms: string[]): string {
  const body = lower(note.body)
  const at = terms.map((t) => body.indexOf(t)).find((i) => i !== -1)
  if (at === undefined) return note.description
  const from = Math.max(0, at - SNIPPET_SIDE)
  // A cut can land inside an emoji, so a lone half at either end goes.
  const part = note.body.slice(from, at + SNIPPET_SIDE).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, '').replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${part}${at + SNIPPET_SIDE < note.body.length ? '…' : ''}`
}

/** The tool result for a write that already ran. It comes from the revision (Ruling P5). */
export function writeResult(rev: NoteRevision): string {
  const n = rev.after ?? rev.before
  const path = n ? shownPath(n) : 'The note'
  return rev.after ? `Already done: ${path} is at version ${rev.version}.` : `Already done: ${path} is deleted.`
}

export const notes: NoteStore = {
  read: find,

  get: (id) => db.notes.get(id),

  async list(shelf) {
    return (await live(shelf)).sort((a, b) => a.path.localeCompare(b.path))
  },

  all: () => db.notes.filter((n) => n.deletedAt === null).toArray(),

  async trash() {
    const rows = await db.notes.filter((n) => n.deletedAt !== null).toArray()
    return rows.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
  },

  async search(shelves, q, limit) {
    const terms = lower(q).split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    const rows = await db.notes
      .where('shelf')
      .anyOf(shelves)
      .filter((n) => n.deletedAt === null)
      .toArray()
    const hits = rows.flatMap((note) => {
      const label = lower([note.path, note.description, ...note.tags].join(' '))
      const body = lower(note.body)
      if (!terms.every((t) => label.includes(t) || body.includes(t))) return []
      return [{ note, score: terms.filter((t) => label.includes(t)).length }]
    })
    hits.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
    return hits.slice(0, limit).map(({ note }) => ({ note, snippet: snippet(note, terms) }))
  },

  async write(ref, input, by) {
    const at = shelfOf(ref.path, ref.conversationId)
    if (!at) return badPath(ref.path)
    return rw(async () => {
      const prev = (await locate(at.shelf, at.path, ref.conversationId)) ?? null
      if (!prev && input.expectedVersion !== undefined) return refuse(`${missingText(ref.path)} To create it, write again with no expected_version.`)
      if (!prev && !input.isNew) {
        const prefix = `${at.shelf}/`
        const old = (await live(at.shelf)).flatMap((n) => [
          n.path,
          ...n.aliases.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length)),
        ])
        const near = nearMatch(at.path, old)
        if (near !== null) {
          const name = shownPath({ shelf: at.shelf, path: near })
          return refuse(`Error: A note with a close path exists: ${name}. Update that note, or write again with new: true if this one is different.`)
        }
      }
      const refusal = checkWrite(prev, input, by.writer) ?? checkDescription(input.description, by.writer)
      if (refusal) return refuse(refusal)
      if (prev && by.writer !== 'you' && input.expectedVersion === undefined) {
        return refuse(`Error: ${shownPath(prev)} already exists, at version ${prev.version}. Use notes_read to see it, then write again with expected_version ${prev.version}.`)
      }
      const description = input.description.trim()
      const next: Note = prev
        ? bump(prev, {
            body: input.body,
            description,
            tags: input.tags ?? prev.tags,
            protected: input.protected ?? prev.protected,
            supersedes: input.supersedes ?? prev.supersedes,
          })
        : {
            id: newId(),
            shelf: at.shelf,
            path: at.path,
            aliases: [],
            description,
            tags: input.tags ?? [],
            body: input.body,
            protected: input.protected ?? false,
            bodyHash: hashText(input.body),
            version: await firstVersion(at.shelf, at.path),
            supersedes: input.supersedes ?? null,
            updatedAt: Date.now(),
            deletedAt: null,
          }
      return { ok: await commit(prev, next, by) }
    })
  },

  async edit(ref, change, by) {
    return rw(async () => {
      const prev = await find(ref)
      if (!prev) return missing(ref.path)
      const { oldText = '', newText, expectedVersion } = change
      const changesText = oldText !== '' || newText !== undefined
      if (!changesText && change.tags === undefined && change.description === undefined) {
        return refuse('Error: This edit changes nothing. Give old_text and new_text, or tags, or a description.')
      }
      const description = change.description ?? prev.description
      // On a protected note a model or tidy can change the tags and the path, and nothing else.
      if (prev.protected && by.writer !== 'you' && (changesText || description.trim() !== prev.description)) return refuse(PROTECTED)
      // The writer 'you' has only the version and description checks: those two apply to every edit.
      const first = checkWrite(prev, { body: prev.body, description, expectedVersion }, 'you') ?? checkDescription(change.description ?? '', by.writer)
      if (first) return refuse(first)

      let body = prev.body
      if (oldText !== '') {
        const n = count(body, oldText)
        if (n === 0) return refuse('Error: The old text was not found. Use notes_read to get the exact text, then edit again.')
        if (n > 1) return refuse(`Error: The old text appears ${n} times. Add more of the text around it, so that it matches once.`)
        const i = body.indexOf(oldText)
        body = body.slice(0, i) + (newText ?? '') + body.slice(i + oldText.length)
      } else if (newText !== undefined) {
        body = body === '' || body.endsWith('\n') ? body + newText : `${body}\n${newText}`
      }
      // The size cap stops growth only, so a small fix on a long note goes through. There is no
      // shrink guard: it catches a whole-note replace built from a part of a note. An edit must
      // quote each letter that it removes, so a big cut can't be an accident.
      if (body.length > prev.body.length) {
        const size = checkWrite(prev, { body, description }, by.writer)
        if (size) return refuse(size)
      }
      return { ok: await commit(prev, bump(prev, { body, description: description.trim(), tags: change.tags ?? prev.tags }), by) }
    })
  },

  async remove(ref, by) {
    return rw(async () => {
      const prev = await find(ref)
      if (!prev) return missing(ref.path)
      if (prev.protected && by.writer !== 'you') return refuse(PROTECTED)
      return { ok: await commit(prev, bump(prev, { deletedAt: Date.now() }), by) }
    })
  },

  async move(ref, newPath, by) {
    const to = shelfOf(newPath, ref.conversationId)
    if (!to) return badPath(newPath)
    return rw(async () => {
      const prev = await find(ref)
      if (!prev) return missing(ref.path)
      const holder = await locate(to.shelf, to.path, ref.conversationId)
      if (holder && holder.id !== prev.id) return refuse(`Error: That path belongs to ${shownPath(holder)}. Pick another path.`)
      if (prev.shelf === 'shared' && to.shelf !== 'shared' && by.writer !== 'you') {
        return refuse('Error: Only Mikael can move a note from the shared shelf to a chat. Pick a path under shared/, or write a new chat note that links to it.')
      }
      if (prev.shelf === to.shelf && prev.path === to.path) return { ok: prev }
      const here = lower(place(to))
      const aliases = [...prev.aliases, place(prev)].filter((a) => lower(a) !== here)
      return { ok: await commit(prev, await atPlace(bump(prev, { ...to, aliases })), by) }
    })
  },

  async setProtected(id, on, by) {
    return rw(async () => {
      const prev = await db.notes.get(id)
      if (!prev || prev.deletedAt !== null) return refuse(GONE)
      if (!on && by.writer !== 'you') return refuse('Error: Only Mikael can clear protection. Move or tag this note, or write a new note that links to it.')
      if (prev.protected === on) return { ok: prev }
      return { ok: await commit(prev, bump(prev, { protected: on }), by) }
    })
  },

  revisions: history,

  async revert(revisionId, by) {
    return rw(async () => {
      const rev = await db.noteRevisions.get(revisionId)
      if (!rev || !isLatest(await history(rev.noteId), rev)) return 'changed-later'
      return (await undo(rev, by)) ? 'done' : 'changed-later'
    })
  },

  async restore(id, by) {
    return rw(async () => {
      const n = await db.notes.get(id)
      if (!n) return refuse(GONE)
      if (n.deletedAt === null) return refuse('Error: This note is not in Trash.')
      const holder = await locate(n.shelf, n.path, n.shelf)
      if (holder) return refuse(`Error: ${shownPath(holder)} holds this path now. Move that note, then restore this one.`)
      const next = bump(n, { deletedAt: null })
      return { ok: await commit(n, await atPlace({ ...next, aliases: await freeAliases(next) }), by) }
    })
  },

  async restoreRevision(revisionId, by) {
    return rw(async () => {
      const rev = await db.noteRevisions.get(revisionId)
      const cur = rev && (await db.notes.get(rev.noteId))
      if (!rev?.after || !cur) return refuse('Error: That version holds no text to restore.')
      if (cur.deletedAt !== null) return refuse('Error: This note is in Trash. Restore it first.')
      if (cur.protected && by.writer !== 'you') return refuse(PROTECTED)
      if (sameWords(cur, rev.after)) return { ok: cur }
      const { body, description, tags } = rev.after
      return { ok: await commit(cur, bump(cur, { body, description, tags }), by) }
    })
  },

  async undoCalls(messageId, callIds) {
    return rw(async () => {
      const report: UndoReport = { undone: [], kept: [] }
      const found: NoteRevision[] = []
      for (const id of new Set(callIds)) {
        const rev = await notes.byCall(id, messageId)
        if (rev && chatOnly(rev)) found.push(rev)
      }
      // Newest first: a reply that wrote one note twice undoes back through both.
      found.sort((a, b) => b.at - a.at || b.version - a.version)
      for (const rev of found) {
        const revs = await history(rev.noteId)
        // Already undone: say nothing, or a redo would bring back what Mikael took out.
        if (!standing(revs).some((r) => r.id === rev.id)) continue
        const done = isLatest(revs, rev) && (await undo(rev, YOU))
        ;(done ? report.undone : report.kept).push(rev.callId as string)
      }
      return report
    })
  },

  async redoCalls(callIds, messageId) {
    return rw(async () => {
      const report: RedoReport = { redone: [], kept: [] }
      const found: NoteRevision[] = []
      for (const id of new Set(callIds)) {
        const rev = await notes.byCall(id, messageId)
        if (rev) found.push(rev)
        else report.kept.push(id)
      }
      found.sort((a, b) => a.at - b.at || a.version - b.version)
      for (const rev of found) (await redo(rev) ? report.redone : report.kept).push(rev.callId as string)
      return report
    })
  },

  async byCall(callId, messageId) {
    const rows = await db.noteRevisions.where('callId').equals(callId).toArray()
    return rows
      .filter((r) => r.undoes === undefined && (messageId === undefined || r.messageId === messageId))
      .sort((a, b) => a.at - b.at || a.version - b.version)
      .at(-1)
  },

  async stands(rev) {
    return standing(await history(rev.noteId)).some((r) => r.id === rev.id)
  },

  async trashShelf(shelf, deletedAt) {
    await rw(async () => {
      for (const n of await live(shelf)) await commit(n, bump(n, { deletedAt }), YOU)
    })
  },

  async restoreShelf(shelf, deletedAt) {
    await rw(async () => {
      const rows = await db.notes
        .where('shelf')
        .equals(shelf)
        .filter((n) => n.deletedAt === deletedAt)
        .toArray()
      for (const n of rows) {
        const last = (await history(n.id)).at(-1)
        if (last?.after === null) await undo(last, YOU)
      }
    })
  },
}
