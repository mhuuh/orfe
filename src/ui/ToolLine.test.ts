import { beforeEach, describe, expect, it } from 'vitest'
import { renderMarkdown } from '../lib/markdown'
import { notes, YOU } from '../lib/notes/store'
import { db, storage } from '../lib/storage'
import type { ContentPart, ToolPart, Version } from '../lib/types'
import { editedVersion, segments, withNewVersion } from '../lib/versions'
import { lineView, redoStep, undoStep } from './ToolLine'

const tool = (over: Partial<ToolPart> = {}): ToolPart => ({
  type: 'tool',
  callId: 'c1',
  round: 0,
  model: 'a/m',
  name: 'notes_write',
  args: { path: 'chat/harbour', description: 'The harbour', body: 'x' },
  result: 'Wrote chat/harbour. It is at version 1.',
  status: 'done',
  ...over,
})

describe('segments', () => {
  it('keeps text and tools in order', () => {
    const a = tool({ callId: 'a' })
    const b = tool({ callId: 'b' })
    const content: ContentPart[] = [{ type: 'text', text: 'one' }, a, { type: 'text', text: 'two' }, b]
    expect(segments(content)).toEqual([
      { kind: 'text', text: 'one' },
      { kind: 'tool', part: a },
      { kind: 'text', text: 'two' },
      { kind: 'tool', part: b },
    ])
  })

  it('adjacent text parts merge into one segment', () => {
    const content: ContentPart[] = [
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
      tool(),
    ]
    expect(segments(content)).toEqual([
      { kind: 'text', text: 'one two' },
      { kind: 'tool', part: content[2] },
    ])
  })

  it('drops empty text', () => {
    expect(segments([{ type: 'text', text: '' }, tool()])).toHaveLength(1)
  })
})

describe('segments with markdown', () => {
  it('text, a tool, then text with a code fence render as both segments', () => {
    const segs = segments([
      { type: 'text', text: 'Before.' },
      tool(),
      { type: 'text', text: 'After:\n\n```\nlet a = 1\n```\n' },
    ])
    const html = segs.map((x) => (x.kind === 'text' ? renderMarkdown(x.text) : 'TOOL'))
    expect(html[0]).toContain('<p>Before.</p>')
    expect(html[1]).toBe('TOOL')
    expect(html[2]).toContain('After:')
    expect(html[2]).toContain('<pre')
    expect(html[2]).toContain('let a = 1')
  })
})

describe('lineView', () => {
  it('Undo and Redo are off while the reply streams', () => {
    expect(lineView(tool(), true).canUndo).toBe(false)
    expect(lineView(tool({ undone: true }), true).canRedo).toBe(false)
    expect(lineView(tool(), false).canUndo).toBe(true)
  })

  it('a running part shows the running words', () => {
    const v = lineView(tool({ status: 'running', result: '' }))
    expect(v.live).toBe(true)
    expect(v.text).toBe('writing note…')
    expect(v.canUndo).toBe(false)
  })

  it('a write shows Undo; a read does not', () => {
    expect(lineView(tool()).canUndo).toBe(true)
    expect(lineView(tool()).text).toBe('wrote Harbour')
    const read = lineView(tool({ name: 'notes_read', args: { path: 'chat/harbour' }, result: '1| Boats' }))
    expect(read.canUndo).toBe(false)
    expect(read.canRedo).toBe(false)
  })

  it('a failed write shows no Undo', () => {
    expect(lineView(tool({ status: 'error', result: 'Error: no.' })).canUndo).toBe(false)
  })

  it('an undone write shows Redo', () => {
    const v = lineView(tool({ undone: true }))
    expect(v.canRedo).toBe(true)
    expect(v.canUndo).toBe(false)
    expect(v.text).toBe('wrote Harbour')
    expect(v.undone).toBe(true)
  })

  it('a write that an undo left in place says so', () => {
    expect(lineView(tool({ kept: true })).kept).toBe(true)
    expect(lineView(tool()).kept).toBe(false)
  })

  it('the detail is the first lines of the result', () => {
    const v = lineView(tool({ result: 'a\nb\nc\nd\ne' }))
    expect(v.detail).toEqual(['a', 'b', 'c'])
    expect(v.more).toBe(true)
  })
})

describe('undoStep and redoStep', () => {
  const body = (text: string) => ({ body: text, description: 'A line' })
  let part: ToolPart
  let messageId: string

  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()))
    const conv = await storage.createConversation()
    part = tool({ callId: 'c1', args: { path: 'shared/harbour' } })
    const first: Version = { id: 'v1', content: [part], status: 'done', model: 'a/m', createdAt: 0 }
    messageId = (await storage.appendMessage(conv.id, 'assistant', first)).id
    const by = { writer: 'a/m', messageId, callId: 'c1' }
    const r = await notes.write({ path: 'shared/harbour', conversationId: conv.id }, body('Boats'), by)
    expect('ok' in r).toBe(true)
  })

  const flag = async () => {
    const m = (await storage.listMessages((await db.conversations.toArray())[0].id)).find((x) => x.id === messageId)
    return (m?.versions[0].content[0] as ToolPart).undone
  }

  it('undo takes the note back and sets the flag', async () => {
    expect(await undoStep(part, messageId)).toBeNull()
    expect(await flag()).toBe(true)
    expect(await notes.read({ path: 'shared/harbour', conversationId: 'x' })).toBeUndefined()
  })

  it('undo says so when the note changed, and leaves the flag', async () => {
    const conv = (await db.conversations.toArray())[0]
    await notes.write({ path: 'shared/harbour', conversationId: conv.id }, { ...body('Mikael'), expectedVersion: 1 }, YOU)
    expect(await undoStep(part, messageId)).toBe('The note changed since. This write stays.')
    expect(await flag()).toBeUndefined()
  })

  it('a tap that undoes a kept line takes the mark away', async () => {
    await storage.mutateMessage(messageId, (m) => ({
      ...m,
      versions: m.versions.map((v) => ({ ...v, content: v.content.map((p) => ({ ...p, kept: true })) })),
    }))
    expect(await undoStep(part, messageId)).toBeNull()
    expect((await db.messages.get(messageId))?.versions[0].content[0]).toMatchObject({ undone: true, kept: false })
  })

  it('a tap on an Edit copy marks the source too, so neither line lies', async () => {
    await storage.mutateMessage(messageId, (m) => withNewVersion(m, editedVersion(m.versions[0], 'Edited')))
    const flags = async () =>
      (await db.messages.get(messageId))?.versions.map((v) => (v.content.find((p) => p.type === 'tool') as ToolPart).undone)
    expect(await undoStep(part, messageId)).toBeNull()
    expect(await flags()).toEqual([true, true])
    expect(await redoStep({ ...part, undone: true }, messageId)).toBeNull()
    expect(await flags()).toEqual([false, false])
  })

  it('redo that did not apply leaves the flag set', async () => {
    const conv = (await db.conversations.toArray())[0]
    await undoStep(part, messageId)
    await notes.write({ path: 'shared/harbour', conversationId: conv.id }, body('Mikael wrote this'), YOU)
    expect(await redoStep({ ...part, undone: true }, messageId)).toBe('The note changed since. It stays undone.')
    expect(await flag()).toBe(true)
  })

  it('redo that applied clears the flag', async () => {
    await undoStep(part, messageId)
    expect(await redoStep({ ...part, undone: true }, messageId)).toBeNull()
    expect(await flag()).toBe(false)
    expect((await notes.read({ path: 'shared/harbour', conversationId: 'x' }))?.body).toBe('Boats')
  })
})
