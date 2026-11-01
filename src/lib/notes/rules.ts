import type { Note } from '../types'

/** Longest body a model may write. Mikael's own edits have no cap. */
export const MAX_BODY = 8000
/** A replace may remove at most this share of the old body. */
export const SHRINK_LIMIT = 0.5
/** Longest path, with its shelf prefix. */
export const MAX_PATH = 200
/** Longest description a model may write. Mikael's own edits have no cap. */
export const MAX_DESCRIPTION = 200
/** Most of a model's own text that a tool result repeats back. */
const MAX_ECHO = 100
/** Refusal for a text change to a protected note. */
export const PROTECTED = 'Error: This note is protected. Move or tag it, or write a new note that links to it.'

/** How a model writes a note's path. A refusal must name this form, or notes_read can't use it. */
export const shownPath = (n: Pick<Note, 'shelf' | 'path'>): string => `${n.shelf === 'shared' ? 'shared' : 'chat'}/${n.path}`

/** The start of `s`, up to `n` units, or one fewer if `n` would cut an emoji in two. */
export function safeCut(s: string, n: number): string {
  const code = s.charCodeAt(n - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n)
}

/** A model's own text, cut for repeating in a result, which goes into storage and the next request. */
export const echo = (s: string): string => (s.length > MAX_ECHO ? `${safeCut(s, MAX_ECHO)}…` : s)

export const badPathText = (path: string): string =>
  `Error: "${echo(path)}" is not a usable path. Start it with shared/ or chat/. Leave out square brackets, and keep it under ${MAX_PATH} characters.`

/**
 * Tidy a path: one slash between parts, none at the ends, NFC form.
 * NFC makes a typed "ä" and a pasted "a" + accent the same path. Case stays as written.
 */
export function normalisePath(p: string): string {
  return p
    .normalize('NFC')
    .replace(/[\\]/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.')
    .join('/')
}

/**
 * Map 'shared/x' or 'chat/x' to a shelf and the path without its prefix.
 * Returns null for any other prefix, an empty rest, a '..' part, a control character, a square
 * bracket (it would break a [[link]]), or a path over MAX_PATH.
 */
export function shelfOf(path: string, conversationId: string): { shelf: string; path: string } | null {
  const whole = normalisePath(path)
  if (whole.length > MAX_PATH || /[\p{Cc}[\]]/u.test(whole)) return null
  const parts = whole.split('/')
  const head = parts[0]?.toLowerCase()
  const rest = parts.slice(1)
  if (rest.length === 0 || rest.includes('..')) return null
  if (head === 'shared') return { shelf: 'shared', path: rest.join('/') }
  if (head === 'chat') return { shelf: conversationId, path: rest.join('/') }
  return null
}

/** Drops a plural 's'. Short words keep it: 'news' is not 'new'. */
function stem(s: string): string {
  const k = s.toLowerCase()
  return k.length > 4 && k.endsWith('s') && !k.endsWith('ss') ? k.slice(0, -1) : k
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

const digits = (s: string) => s.replace(/\D+/g, ' ').trim()

const MIN_TYPO_LETTERS = 8

/**
 * Find an existing path that is probably the same note: same folder, and a last part that
 * differs only by case, a final plural 's', or one typo (from MIN_TYPO_LETTERS up: shorter words
 * one letter apart are usually different words, like 'bread' and 'break').
 * Paths that differ in their numbers ('week-1', 'week-2') never match.
 * A false hit costs the model a retry. A miss costs a duplicate note. Tidying can merge a
 * duplicate later, so we lean towards a miss.
 */
export function nearMatch(path: string, existing: string[]): string | null {
  const split = (p: string) => {
    const parts = normalisePath(p).toLowerCase().split('/')
    const last = parts.pop() ?? ''
    return { dir: parts.join('/'), last }
  }
  const want = split(path)
  const wantStem = stem(want.last)
  for (const e of existing) {
    const have = split(e)
    if (have.dir !== want.dir) continue
    if (have.last === want.last) return e
    const haveStem = stem(have.last)
    if (haveStem === wantStem) return e
    if (digits(haveStem) !== digits(wantStem)) continue
    if (Math.max(haveStem.length, wantStem.length) >= MIN_TYPO_LETTERS && distance(haveStem, wantStem) <= 1) return e
  }
  return null
}

/** The size rule for a description. A separate check: an edit that leaves one alone must pass. */
export function checkDescription(description: string, writer: string): string | null {
  const length = description.trim().length
  if (writer === 'you' || length <= MAX_DESCRIPTION) return null
  return `Error: The description is ${length} characters. The limit is ${MAX_DESCRIPTION}. Shorten it to one short line, then write again.`
}

/**
 * Check a whole-note write or an edit against the rules at the door.
 * `prev` is the live note at that path, or null for a create.
 * Returns the refusal text, or null when the write may go ahead.
 * Refusals start with "Error:" so the tool loop shows them as errors.
 *
 * Mikael ('you') skips the size cap, the shrink guard and protection: he may edit his own
 * protected notes. Models and tidy get every check. The version and description checks
 * apply to all writers.
 */
export function checkWrite(
  prev: Note | null,
  next: { body: string; description: string; expectedVersion?: number; isNew?: boolean; shrink?: boolean },
  writer: string,
): string | null {
  if (prev?.protected && writer !== 'you') {
    return PROTECTED
  }
  if (prev && next.isNew) {
    return `Error: A note already exists at ${shownPath(prev)}. Use notes_read to see it, then update it or pick another path.`
  }
  const desc = next.description.trim()
  if (!desc) {
    return 'Error: A note needs a description. Add one line that says what the note holds, then write again.'
  }
  if (desc.includes('\n')) {
    return 'Error: The description must be one line. Cut it to a single short line, then write again.'
  }
  if (writer !== 'you' && next.body.length > MAX_BODY) {
    return `Error: The body is ${next.body.length} characters. The limit is ${MAX_BODY}. Shorten it, or split it into two notes that link to each other.`
  }
  if (prev && next.expectedVersion !== undefined && next.expectedVersion !== prev.version) {
    return `Error: The note is now at version ${prev.version}, not ${next.expectedVersion}. Use notes_read to get the current text, then write again with expected_version ${prev.version}.`
  }
  if (writer !== 'you' && prev && !next.shrink && next.body.length < prev.body.length * (1 - SHRINK_LIMIT)) {
    return `Error: This write removes more than half of the note (${prev.body.length} to ${next.body.length} characters). If you mean it, write again with shrink: true. If not, use notes_read and keep the parts that are still true.`
  }
  return null
}
