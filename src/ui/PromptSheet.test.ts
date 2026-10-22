import { describe, expect, it } from 'vitest'
import type { Prompt } from '../lib/types'
import { promptRows, variantParent } from './PromptSheet'

const p = (id: string, name: string, parentId: string | null = null): Prompt => ({
  id,
  name,
  parentId,
  text: 'x',
  updatedAt: 0,
  versionHash: 'h',
})

const coWriter = p('cw', 'Co-writer')
const tighter = p('cwt', 'Co-writer, tighter prose', 'cw')
const warm = p('cww', 'Co-writer, warm', 'cw')
const editor = p('ed', 'Editor')

describe('promptRows', () => {
  it('lists parents by name, each followed by its variants by name', () => {
    const rows = promptRows([editor, warm, coWriter, tighter])
    expect(rows.map((r) => [r.prompt.name, r.variant])).toEqual([
      ['Co-writer', false],
      ['Co-writer, tighter prose', true],
      ['Co-writer, warm', true],
      ['Editor', false],
    ])
  })

  it('shows a prompt whose parent is gone (or that names itself) as a parent', () => {
    const rows = promptRows([p('o', 'Orphan', 'missing'), p('s', 'Self', 's')])
    expect(rows.map((r) => [r.prompt.name, r.variant])).toEqual([
      ['Orphan', false],
      ['Self', false],
    ])
  })
})

describe('variantParent', () => {
  const all = [coWriter, tighter, warm, editor]

  it('attaches a variant of a parent to that parent', () => {
    expect(variantParent(coWriter, all)).toBe('cw')
  })

  it('attaches a variant of a variant to the root parent, never nesting', () => {
    expect(variantParent(tighter, all)).toBe('cw')
  })

  it('treats a prompt with a missing parent as the root', () => {
    expect(variantParent(p('o', 'Orphan', 'missing'), all)).toBe('o')
  })
})

describe('bad parent links', () => {
  it('shows a nested variant under the top parent and attaches its variants there', () => {
    const nested = p('n', 'Co-writer, nested', 'cwt')
    const all = [coWriter, tighter, nested]
    expect(promptRows(all).map((r) => [r.prompt.name, r.variant])).toEqual([
      ['Co-writer', false],
      ['Co-writer, nested', true],
      ['Co-writer, tighter prose', true],
    ])
    expect(variantParent(nested, all)).toBe('cw')
  })

  it('shows prompts in a parent loop as parents', () => {
    const rows = promptRows([p('a', 'A', 'b'), p('b', 'B', 'a')])
    expect(rows.map((r) => [r.prompt.name, r.variant])).toEqual([
      ['A', false],
      ['B', false],
    ])
  })
})
