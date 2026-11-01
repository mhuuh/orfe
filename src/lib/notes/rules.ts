import type { Note } from '../types'

/** Longest body a model may write. Mikael's own edits have no cap. */
export const MAX_BODY = 8000
/** A replace may remove at most this share of the old body. */
export const SHRINK_LIMIT = 0.5

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
 * Returns null for any other prefix, an empty rest, or a '..' part.
 */
export function shelfOf(path: string, conversationId: string): { shelf: string; path: string } | null {
  const parts = normalisePath(path).split('/')
  const head = parts[0]?.toLowerCase()
  const rest = parts.slice(1)
  if (rest.length === 0 || rest.includes('..')) return null
  if (head === 'shared') return { shelf: 'shared', path: rest.join('/') }
  if (head === 'chat') return { shelf: conversationId, path: rest.join('/') }
  return null
}

function stem(s: string): string {
  const k = s.toLowerCase()
  return k.length > 3 && k.endsWith('s') && !k.endsWith('ss') ? k.slice(0, -1) : k
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

/**
 * Find an existing path that is probably the same note: same folder, and a last part that
 * differs only by case, a final plural 's', or a small typo (none under 5 letters, one under 9,
 * else two). Paths that differ in their numbers ('week-1', 'week-2') never match.
 * A false hit costs the model a retry. A miss costs a duplicate note. So we lean strict.
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
    const n = Math.max(haveStem.length, wantStem.length)
    const limit = n < 5 ? 0 : n < 9 ? 1 : 2
    if (limit > 0 && distance(haveStem, wantStem) <= limit) return e
  }
  return null
}

/**
 * Check a whole-note write or an edit against the rules at the door.
 * `prev` is the live note at that path, or null for a create.
 * Returns the refusal text, or null when the write may go ahead.
 * Refusals start with "Error:" so the tool loop shows them as errors.
 *
 * Every check but the size cap applies to every writer, 'you' too: the UI clears
 * `protected` before an edit, and it sends a version and a description with each save.
 */
export function checkWrite(
  prev: Note | null,
  next: { body: string; description: string; expectedVersion?: number; isNew?: boolean; shrink?: boolean },
  writer: string,
): string | null {
  if (prev?.protected) {
    return 'Error: This note is protected. Move or tag it, or write a new note that links to it.'
  }
  if (prev && next.isNew) {
    return `Error: A note already exists at ${prev.path}. Use notes_read to see it, then update it or pick another path.`
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
  if (prev && !next.shrink && next.body.length < prev.body.length * (1 - SHRINK_LIMIT)) {
    return `Error: This write removes more than half of the note (${prev.body.length} to ${next.body.length} characters). If you mean it, write again with shrink: true. If not, use notes_read and keep the parts that are still true.`
  }
  return null
}
