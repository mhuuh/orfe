import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../lib/markdown'
import type { Note, NoteRevision } from '../lib/types'
import { canRestore, crumb, linkNotes, longAge, revisionWord } from './NoteSheet'

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'n', shelf: 'shared', path: 'a', aliases: [], description: 'Line', tags: [], body: 'Words', protected: false,
    bodyHash: 'h', version: 1, supersedes: null, updatedAt: 0, deletedAt: null, ...over,
  }
}

function rev(before: Note | null, after: Note | null, over: Partial<NoteRevision> = {}): NoteRevision {
  return { id: 'r', noteId: 'n', version: 2, before, after, writer: 'you', messageId: null, callId: null, runId: null, at: 0, ...over }
}

const dom = (html: string): HTMLElement => {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

describe('crumb', () => {
  it('shows the shelf and folders, not the note itself', () => {
    expect(crumb(note({ path: 'lists/insects' }))).toBe('shared / lists')
    expect(crumb(note({ shelf: 'c1', path: 'a/b/c' }))).toBe('chat / a / b')
    expect(crumb(note())).toBe('shared')
  })
})

describe('longAge', () => {
  it('reads as words', () => {
    expect(longAge(0, 1000)).toBe('just now')
    expect(longAge(0, 60_000)).toBe('1 minute ago')
    expect(longAge(0, 2 * 86_400_000)).toBe('2 days ago')
  })
})

describe('revisionWord', () => {
  const a = note()
  it('names what the revision did', () => {
    expect(revisionWord(rev(null, a))).toBe('created')
    expect(revisionWord(rev(a, null))).toBe('deleted')
    expect(revisionWord(rev(note({ deletedAt: 5 }), a))).toBe('restored')
    expect(revisionWord(rev(a, note({ body: 'new' })))).toBe('edited')
    expect(revisionWord(rev(a, note({ path: 'b' })))).toBe('moved')
    expect(revisionWord(rev(a, note({ shelf: 'c' })))).toBe('moved')
    expect(revisionWord(rev(a, note({ protected: true })))).toBe('protected')
    expect(revisionWord(rev(note({ protected: true }), a))).toBe('unprotected')
    expect(revisionWord(rev(a, note({ tags: ['t'] })))).toBe('details changed')
  })

  it('an undo says so, whatever it changed', () => {
    expect(revisionWord(rev(a, note({ body: 'old' }), { undoes: 'x' }))).toBe('undo')
  })
})

describe('canRestore', () => {
  const now = note({ body: 'now' })
  it('offers words that differ from the note, on a live note', () => {
    expect(canRestore(rev(null, note({ body: 'old' })), now)).toBe(true)
    expect(canRestore(rev(null, note({ body: 'now' })), now)).toBe(false)
    expect(canRestore(rev(now, null), now)).toBe(false)
    expect(canRestore(rev(null, note({ body: 'old' })), { ...now, deletedAt: 5 })).toBe(false)
  })
})

describe('linkNotes', () => {
  const links = (src: string) => dom(linkNotes(renderMarkdown(src), 'lnk')).querySelectorAll('button.lnk')

  it('turns [[path]] into a button with the note name', () => {
    const [a, b] = links('See [[chat/mira/voice]], and [[shared/plot-threads]].')
    expect(a.textContent).toBe('Mira, voice')
    expect((a as HTMLElement).dataset.noteLink).toBe('chat/mira/voice')
    expect(b.textContent).toBe('Plot threads')
  })

  it('keeps the text around a link', () => {
    expect(dom(linkNotes(renderMarkdown('a [[chat/b]] c'), 'lnk')).textContent).toBe('a B c\n')
  })

  it('leaves code alone', () => {
    expect(links('`[[chat/a]]`\n\n```\n[[chat/b]]\n```')).toHaveLength(0)
  })

  it('a path can carry no markup into the page', () => {
    const [a] = links('[[chat/<b>x</b>]]')
    if (a) expect(a.querySelector('b')).toBeNull()
    const [c] = links('[[chat/x" onclick="y]]')
    expect(c.getAttribute('onclick')).toBeNull()
  })

  it('leaves html with no link as it is', () => {
    const html = renderMarkdown('plain **text**')
    expect(linkNotes(html, 'lnk')).toBe(html)
  })
})
