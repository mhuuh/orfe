import { describe, expect, it } from 'vitest'
import type { Version } from '../lib/types'
import { dividerLabel } from './Divider'

const v = (model: string, promptRef: string | null = null): Version => ({
  id: model,
  content: [{ type: 'text', text: 'x' }],
  status: 'done',
  model,
  promptRef,
  createdAt: 0,
})

describe('dividerLabel', () => {
  it('labels a model change', () => {
    expect(dividerLabel(v('deepseek/deepseek-v4.1-flash'), v('anthropic/claude-sonnet-5.5'))).toBe('claude-sonnet-5.5')
  })

  it('returns null when model and prompt are unchanged', () => {
    expect(dividerLabel(v('anthropic/claude-sonnet-5.5', 'p1'), v('anthropic/claude-sonnet-5.5', 'p1'))).toBeNull()
  })

  it('returns null for the first assistant message', () => {
    expect(dividerLabel(undefined, v('anthropic/claude-sonnet-5.5'))).toBeNull()
  })

  it('adds the prompt name only when one exists', () => {
    expect(dividerLabel(v('a/m'), v('a/m', 'p2'), 'Co-writer, warm')).toBe('m · Co-writer, warm')
    expect(dividerLabel(v('a/m'), v('a/m', 'p2'))).toBe('m')
  })
})

describe('dividerLabel after a stored prompt swap', () => {
  it('draws no second hairline when only the prompt changed', () => {
    expect(dividerLabel(v('a/m', 'p1'), v('a/m', 'p2'), 'Editor', true)).toBeNull()
  })

  it('still marks a model change, with the prompt name', () => {
    expect(dividerLabel(v('a/m', 'p1'), v('b/n', 'p2'), 'Editor', true)).toBe('n · Editor')
  })
})
