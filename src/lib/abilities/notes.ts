import { badPathText, echo, normalisePath, safeCut, shelfOf, shownPath } from '../notes/rules'
import { notes, type Result } from '../notes/store'
import type { Note, ToolPart } from '../types'
import { outcome } from './outcome'
import type { Ability, AbilityCtx, StepWords } from './registry'

/** Characters of note text in one notes_read page. */
const PAGE_CHARS = 8000
const SEARCH_LIMIT = 10
/** Starts the result of a read that found nothing. A miss is a normal result, not an error. */
const NO_NOTE = 'No note'
/** What a model may copy along with a path from an index line: ` — description` or ` (12 notes)`. */
const LINE_TAIL = /\s+([—–-]\s.*|\(\d+ notes?\)|\(and \d+ more[^)]*\))$/s

type Args = Record<string, unknown>

const PATH_PARAM = { type: 'string', description: 'Starts with shared/ or chat/. Like chat/mira/voice.' }
const VERSION_PARAM = { type: 'integer', description: 'The version you got from notes_read.' }

const instructions = `You keep notes that last across chats, with the notes_ tools. Mikael, the user, can read them too.
Paths start with shared/ (every chat) or chat/ (this chat only). A new note goes on chat/ unless you have a reason, or Mikael asks for shared/.
- Use notes_search before you say you don't remember something.
- Saving nothing is a normal outcome. Save only what is durable, useful, and stated or confirmed by Mikael.
- Don't save your own paraphrase of a note you just read.
- Notes say what is true now. When notes disagree, prefer the newest, and when one states a limit, follow it. When a note replaces another, set supersedes.
- Keep planned events in a "Planned" section, apart from what has happened.
- What Mikael just did outranks any note.`

/** The model sees this in every request. Keep it short, and keep counts, dates and titles out. */
const TOOLS: Ability['tools'] = [
  {
    name: 'notes_search',
    description:
      'Search your saved notes for words. Looks in paths, descriptions, tags and note text, on the shared shelf and this chat\'s shelf. Every word must match, so use few words. Returns paths, versions and snippets. This finds notes only, not chat messages.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few plain words, like: river walk' } },
      required: ['query'],
    },
  },
  {
    name: 'notes_read',
    description:
      'Read a saved note. Gives its version and its numbered lines. The numbers are not part of the text. A long note comes in pages. A folder path lists that folder. With no path, lists all notes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A note or a folder, like chat/mira/voice. Leave out to list all notes.' },
        page: { type: 'integer', description: 'Which page. Leave out for the first.' },
      },
    },
  },
  {
    name: 'notes_write',
    description:
      'Create a note, or replace a whole note. To change a part of a note, use notes_edit. To replace, read the note first and give expected_version. Link to another note with [[path]].',
    parameters: {
      type: 'object',
      properties: {
        path: { ...PATH_PARAM, description: `${PATH_PARAM.description} Use chat/ unless you have a reason.` },
        description: { type: 'string', description: 'One short line: what the note holds.' },
        body: { type: 'string', description: 'The whole note, in Markdown. Say what is true now. It is not a diary.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short labels.' },
        expected_version: { ...VERSION_PARAM, description: `Needed to replace. ${VERSION_PARAM.description}` },
        new: { type: 'boolean', description: 'True if a close path exists and this note is a different one.' },
        shrink: { type: 'boolean', description: 'True if you mean to remove over half of the note.' },
        protected: {
          type: 'boolean',
          description: 'True to lock a note that must stay word for word, like a poem, a recipe or a voice sample. Only Mikael can unlock it.',
        },
        supersedes: { type: 'string', description: 'The path of an older note that this note replaces.' },
      },
      required: ['path', 'description', 'body'],
    },
  },
  {
    name: 'notes_edit',
    description:
      'Change a part of a note. To replace text, give old_text, which must match once, exactly, and new_text. To add to the end, give new_text alone. To change only tags or the description, give only those.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH_PARAM,
        expected_version: VERSION_PARAM,
        old_text: { type: 'string', description: 'The exact text to replace, with no line numbers.' },
        new_text: { type: 'string', description: 'The text to put in. An empty string removes old_text.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'The new tags, at least one. They replace the old ones.' },
        description: { type: 'string', description: 'A new description, in one short line.' },
      },
      required: ['path', 'expected_version'],
    },
  },
  {
    name: 'notes_delete',
    description: 'Delete a note, which sends it to Trash. Or give new_path to move it. A moved note still answers at its old path.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH_PARAM,
        new_path: { type: 'string', description: 'Where to move the note. Leave out to delete it.' },
      },
      required: ['path'],
    },
  },
]

/**
 * There, but not text. Such a field must not pass as left out: that can pick another action.
 * Null does count as left out: strict-mode models fill every optional field with it.
 */
const notText = (v: unknown): boolean => v !== undefined && v !== null && typeof v !== 'string'
const asArgs = (a: unknown): Args => (typeof a === 'object' && a !== null && !Array.isArray(a) ? (a as Args) : {})

/** A non-blank string. Text that may be empty, like a body, is read with `raw`. */
const word = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const raw = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// Weak models send "3" for 3, "true" for true, and "a, b" for a list.
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v
  return typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : undefined
}
const flag = (v: unknown): true | undefined => (v === true || v === 'true' ? true : undefined)
/** Nothing usable counts as left out, so a model can't wipe a note's tags. Clearing them is Mikael's. */
const list = (v: unknown): string[] | undefined => {
  const items: unknown[] = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : []
  const tags = items.flatMap((t) => (typeof t === 'string' && t.trim() !== '' ? [t.trim()] : []))
  return tags.length > 0 ? tags : undefined
}

const report = (r: Result, ok: (n: Note) => string): string => ('ok' in r ? ok(r.ok) : r.refused)

const atVersion = (n: Note): string => `It is at version ${n.version}.`

/** Splits at line ends. A line longer than a page is cut, so every page fits and each is reachable. */
function paginate(lines: string[]): string[] {
  const pages: string[] = []
  let page = ''
  for (const line of lines) {
    let rest = line
    do {
      const piece = safeCut(rest, PAGE_CHARS)
      rest = rest.slice(piece.length)
      if (page !== '' && page.length + 1 + piece.length > PAGE_CHARS) {
        pages.push(page)
        page = ''
      }
      page = page === '' ? piece : `${page}\n${piece}`
    } while (rest !== '')
  }
  return [...pages, page]
}

/** One page with the header lines above it, or a refusal for a page past the end. `path`: what was read. */
function paged(header: string[], lines: string[], page: number, path: string): string {
  const pages = paginate(lines)
  const call = (n: number): string => `call notes_read with ${path === '' ? '' : `path ${path} and `}page ${n}`
  if (page > pages.length) {
    const count = pages.length === 1 ? 'is 1 page' : `are ${pages.length} pages`
    return `Error: There ${count}. For the last page, ${call(pages.length)}.`
  }
  const more = page < pages.length ? ` For more, ${call(page + 1)}.` : ''
  const line = pages.length > 1 ? [`Page ${page} of ${pages.length}.${more}`] : []
  return [...header, ...line, '', pages[page - 1]].join('\n')
}

function readNote(n: Note, asked: string, page: number): string {
  const moved = asked.toLowerCase() !== shownPath(n).toLowerCase()
  const header = [
    `${shownPath(n)}, version ${n.version}: ${n.description}`,
    ...(moved ? [`This note moved. Its path is now ${shownPath(n)}.`] : []),
    ...(n.tags.length > 0 ? [`Tags: ${n.tags.join(', ')}.`] : []),
    ...(n.protected ? ['Protected: its text is locked. You can move it or change its tags.'] : []),
    ...(n.supersedes ? [`Replaces ${n.supersedes}.`] : []),
  ]
  return paged(header, n.body.split('\n').map((line, i) => `${i + 1}| ${line}`), page, shownPath(n))
}

/** The live notes this chat can see, under a folder if one is given. Null when there are none. */
async function listing(ctx: AbilityCtx, folder: string, page: number): Promise<string | null> {
  const all = [...(await notes.list('shared')), ...(await notes.list(ctx.conversationId))]
  const under = folder === '' ? '' : `${folder.toLowerCase()}/`
  const lines = all.filter((n) => shownPath(n).toLowerCase().startsWith(under)).map((n) => `${shownPath(n)} — ${n.description}`)
  if (lines.length === 0) return null
  return folder === '' ? paged(['All notes:'], lines, page, '') : paged([`Notes in ${folder}/:`], lines, page, `${folder}/`)
}

/** A note or a folder at this path. A slash at the end asks for the folder first. */
async function lookup(given: string, page: number, ctx: AbilityCtx): Promise<string | null> {
  const path = normalisePath(given)
  const asFolder = (): Promise<string | null> => listing(ctx, path, page)
  const asNote = async (): Promise<string | null> => {
    const note = await notes.read({ path, conversationId: ctx.conversationId })
    return note ? readNote(note, path, page) : null
  }
  return given.endsWith('/') ? ((await asFolder()) ?? (await asNote())) : ((await asNote()) ?? (await asFolder()))
}

async function read(a: Args, ctx: AbilityCtx): Promise<string> {
  // A [[link]] from a note body works as a path.
  const given = (word(a.path) ?? '').trim().replace(/^\[\[(.*)\]\]$/s, '$1')
  const page = Math.max(1, Math.floor(num(a.page) ?? 1))
  if (normalisePath(given) === '') return (await listing(ctx, '', page)) ?? 'There are no notes yet. Use notes_write to save one.'
  // The whole text first: a path may hold what looks like a tail.
  const bare = given.replace(LINE_TAIL, '')
  const found = (await lookup(given, page, ctx)) ?? (bare === given ? null : await lookup(bare, page, ctx))
  if (found !== null) return found
  const path = normalisePath(bare)
  if (/^(shared|chat)$/i.test(path)) return `${NO_NOTE}s on this shelf yet.`
  if (!shelfOf(path, ctx.conversationId)) return badPathText(path)
  return `${NO_NOTE} at ${echo(path)}. It is gone, or it was never there. Use notes_search to look for it.`
}

async function search(a: Args, ctx: AbilityCtx): Promise<string> {
  const query = word(a.query)
  if (!query) return 'Error: notes_search needs a query. Send the call again with a few words to look for.'
  const hits = await notes.search(['shared', ctx.conversationId], query, SEARCH_LIMIT + 1)
  const shown = hits.slice(0, SEARCH_LIMIT)
  if (shown.length === 0) {
    return `Found 0 notes for "${echo(query)}". Try fewer or other words, or use notes_read with no path to list all notes.`
  }
  const head = `Found ${shown.length} ${shown.length === 1 ? 'note' : 'notes'} for "${echo(query)}".`
  const more = hits.length > SEARCH_LIMIT ? ' There are more: add more words to narrow it.' : ''
  const lines = shown.flatMap(({ note, snippet }) => [
    `${shownPath(note)} (version ${note.version}) — ${note.description}`,
    ...(snippet !== note.description ? [`  ${snippet}`] : []),
  ])
  return [`${head}${more}`, ...lines].join('\n')
}

function run(name: string, a: Args, ctx: AbilityCtx): Promise<string> | string {
  const by = { writer: ctx.model, messageId: ctx.messageId, callId: ctx.callId }
  const path = word(a.path)
  const ref = { path: path ?? '', conversationId: ctx.conversationId }

  switch (name) {
    case 'notes_search':
      return search(a, ctx)
    case 'notes_read':
      return read(a, ctx)
  }
  if (!path) return `Error: ${name} needs a path. Send the call again with a path that starts with shared/ or chat/.`

  switch (name) {
    case 'notes_write': {
      const description = raw(a.description)
      const body = raw(a.body)
      if (description === undefined || body === undefined) {
        return 'Error: notes_write needs path, description and body. Send the call again with all three.'
      }
      const input = {
        body,
        description,
        tags: list(a.tags),
        expectedVersion: num(a.expected_version) || undefined,
        isNew: flag(a.new),
        shrink: flag(a.shrink),
        protected: flag(a.protected),
        supersedes: word(a.supersedes),
      }
      return notes.write(ref, input, by).then((r) => report(r, (n) => `Wrote ${shownPath(n)}. ${atVersion(n)}`))
    }
    case 'notes_edit': {
      const expectedVersion = num(a.expected_version) || undefined
      if (expectedVersion === undefined) return 'Error: notes_edit needs expected_version. Use notes_read to get it, then edit again.'
      if (notText(a.old_text)) return 'Error: old_text must be text. Send the exact text to replace, or leave old_text out.'
      // A weak model fills every field, so a blank field means left out. Only a replace can put in nothing.
      const oldText = raw(a.old_text) || undefined
      // Null is no exception here, so it can never delete text.
      if (notText(a.new_text) || (oldText && typeof a.new_text !== 'string')) {
        return 'Error: new_text must be text. To replace old_text, send the new words. To remove it, send new_text as an empty string.'
      }
      const newText = oldText ? raw(a.new_text) : raw(a.new_text) || undefined
      const change = { oldText, newText, tags: list(a.tags), description: word(a.description), expectedVersion }
      return notes.edit(ref, change, by).then((r) => report(r, (n) => `Edited ${shownPath(n)}. ${atVersion(n)}`))
    }
    case 'notes_delete': {
      if (notText(a.new_path)) return 'Error: new_path must be text that starts with shared/ or chat/. Send it again, or leave it out to delete the note.'
      const to = word(a.new_path)
      if (to) return notes.move(ref, to, by).then((r) => report(r, (n) => `Moved ${normalisePath(path)} to ${shownPath(n)}. ${atVersion(n)}`))
      return notes.remove(ref, by).then((r) => report(r, (n) => `Deleted ${shownPath(n)}. It is in Trash, and Mikael can bring it back.`))
    }
    default:
      return `Error: there is no notes tool called "${name}".`
  }
}

/** 'chat/mira/voice' reads 'Mira, voice'. */
function title(path: string): string {
  const name = normalisePath(path).replace(/^(shared|chat)\//i, '').split('/').join(', ').replace(/[-_]/g, ' ')
  return echo(name.charAt(0).toUpperCase() + name.slice(1))
}

const FORMS = {
  notes_read: { ing: 'recalling', did: 'recalled', past: 'Read', verb: 'read', writes: false },
  notes_write: { ing: 'writing', did: 'wrote', past: 'Wrote', verb: 'write', writes: true },
  notes_edit: { ing: 'editing', did: 'edited', past: 'Edited', verb: 'edit', writes: true },
  notes_delete: { ing: 'deleting', did: 'deleted', past: 'Deleted', verb: 'delete', writes: true },
  moving: { ing: 'moving', did: 'moved', past: 'Moved', verb: 'move', writes: true },
}

function searchWords(part: ToolPart, a: Args): StepWords {
  const running = 'searching notes…'
  const query = echo(word(a.query) ?? '')
  switch (outcome(part)) {
    case 'done': {
      const count = Number(/^Found (\d+)/.exec(part.result)?.[1] ?? 0)
      const found = count === 0 ? 'found no notes' : `found ${count} ${count === 1 ? 'note' : 'notes'}`
      return { running, done: found, past: `(Looked in notes for '${query}': ${found}.)` }
    }
    case 'stopped':
      return { running, done: 'search stopped', past: '(Stopped a search of the notes before it finished.)' }
    case 'failed':
      return { running, done: "couldn't search notes", past: '(Tried to search the notes. It did not work.)' }
    case 'unknown':
      return { running, done: 'search not finished', past: '(Started to search the notes. It did not finish.)' }
  }
}

function describe(part: ToolPart): StepWords {
  const a = asArgs(part.args)
  if (part.name === 'notes_search') return searchWords(part, a)

  const path = word(a.path)
  if (part.name === 'notes_read' && !path) {
    const running = 'listing notes…'
    if (outcome(part) === 'done') return { running, done: 'listed notes', past: '(Listed the notes.)' }
    return { running, done: "couldn't list notes", past: '(Tried to list the notes. It did not finish.)' }
  }

  const name = path ? title(path) : 'note'
  const noun = path ? `the note ${name}` : 'a note'
  const moved = part.name === 'notes_delete' ? word(a.new_path) : undefined
  const f = moved ? FORMS.moving : (FORMS[part.name as keyof typeof FORMS] ?? FORMS.notes_write)
  const running = part.name === 'notes_write' ? 'writing note…' : `${f.ing} ${name}…`

  switch (outcome(part)) {
    case 'done':
      if (part.result.startsWith(NO_NOTE)) return { running, done: `no note ${name}`, past: `(Looked for ${noun}. It was not there.)` }
      return { running, done: `${f.did} ${name}`, past: `(${f.past} ${noun}${moved ? ` to ${echo(normalisePath(moved))}` : ''}.)` }
    case 'stopped':
      return { running, done: `stopped ${f.ing} ${name}`, past: `(Stopped before ${f.ing} ${noun}.)` }
    case 'failed':
      return { running, done: `couldn't ${f.verb} ${name}`, past: `(Tried to ${f.verb} ${noun}. It did not work.)` }
    case 'unknown':
      return {
        running,
        done: `${f.ing} ${name} not finished`,
        past: `(Started to ${f.verb} ${noun}. ${f.writes ? 'It may or may not have happened.' : 'It did not finish.'})`,
      }
  }
}

export const notesAbility: Ability = {
  id: 'notes',
  title: 'Notes',
  summary: 'The model keeps notes that last across turns and chats.',
  tools: TOOLS,
  instructions,
  run: async (name, args, ctx) => run(name, asArgs(args), ctx),
  describe,
  traits: { private: true },
}
