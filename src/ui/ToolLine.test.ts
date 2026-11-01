import { describe, expect, it } from 'vitest'
import type { ContentPart, ToolPart } from '../lib/types'
import { segments } from '../lib/versions'
import { lineView } from './ToolLine'

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

describe('lineView', () => {
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

  it('the detail is the first lines of the result', () => {
    const v = lineView(tool({ result: 'a\nb\nc\nd\ne' }))
    expect(v.detail).toEqual(['a', 'b', 'c'])
    expect(v.more).toBe(true)
  })
})
