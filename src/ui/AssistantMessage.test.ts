import { describe, expect, it } from 'vitest'
import type { ToolPart, Version } from '../lib/types'
import { statusNote } from './AssistantMessage'

const step: ToolPart = { type: 'tool', callId: 'c1', round: 0, model: 'a/m', name: 'echo', args: {}, result: 'ok', status: 'done' }
const version = (over: Partial<Version>): Version => ({ id: 'v', content: [], status: 'done', model: 'a/m', createdAt: 0, ...over })

describe('statusNote', () => {
  it('an error with tool steps offers Continue, so the tools need not run again', () => {
    expect(statusNote(version({ status: 'error', error: 'Busy', content: [step] }), true)).toEqual({ text: 'Busy', retry: true, more: true })
  })

  it('an error with no tool steps offers Retry only', () => {
    expect(statusNote(version({ status: 'error', error: 'Busy', content: [{ type: 'text', text: 'Some' }] }), true)?.more).toBe(false)
  })

  it('Continue stays on the last message only', () => {
    expect(statusNote(version({ status: 'error', content: [step] }), false)).toEqual({ text: 'Something went wrong', retry: true, more: false })
    expect(statusNote(version({ status: 'stopped' }), false)?.more).toBe(false)
  })

  it('an interrupted reply says why when it knows, and offers Continue', () => {
    const why = 'The model used all its steps without an answer.'
    expect(statusNote(version({ status: 'interrupted', error: why, content: [step] }), true)).toEqual({ text: why, retry: true, more: true })
    expect(statusNote(version({ status: 'interrupted' }), true)).toEqual({ text: 'Interrupted', retry: true, more: true })
  })

  it('a reply that is fine has no note', () => {
    expect(statusNote(version({}), true)).toBeNull()
    expect(statusNote(version({ finishReason: 'length' }), true)).toEqual({ text: 'Hit the length limit', retry: false, more: true })
  })
})
