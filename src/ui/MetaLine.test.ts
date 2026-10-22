import { describe, expect, it } from 'vitest'
import type { Prompt, Version } from '../lib/types'
import { metaDetails, promptDetails } from './MetaLine'

const prompt = (id: string, name: string, versionHash: string): Prompt => ({
  id,
  name,
  parentId: null,
  text: 'x',
  updatedAt: 0,
  versionHash,
})
const version = (extra: Partial<Version> = {}): Version => ({
  id: 'v',
  content: [{ type: 'text', text: 'x' }],
  status: 'done',
  model: 'a/m',
  createdAt: 0,
  ...extra,
})
const index = new Map([['p1', prompt('p1', 'Co-writer', 'h2')]])

describe('promptDetails', () => {
  it('names the prompt a reply was made with', () => {
    expect(promptDetails(version({ promptRef: 'p1', promptVersionHash: 'h2' }), index)).toEqual(['prompt: Co-writer'])
  })

  it('notes a reply made before the prompt was edited', () => {
    expect(promptDetails(version({ promptRef: 'p1', promptVersionHash: 'h1' }), index)).toEqual([
      'prompt: Co-writer',
      'made with an older version',
    ])
  })

  it('says "deleted" when the prompt is gone', () => {
    expect(promptDetails(version({ promptRef: 'gone', promptVersionHash: 'h1' }), index)).toEqual(['prompt: deleted'])
  })

  it('says nothing for a reply without a prompt, or before prompts load', () => {
    expect(promptDetails(version({ promptRef: null }), index)).toEqual([])
    expect(promptDetails(version({ promptRef: 'p1' }), undefined)).toEqual([])
  })

  it('comes after usage and before "edited" in the expanded meta', () => {
    const v = version({
      promptRef: 'p1',
      promptVersionHash: 'h1',
      provider: 'Anthropic',
      editedAt: 1,
      usage: { promptTokens: 1200, completionTokens: 300, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0.0123 },
    })
    expect(metaDetails(v, index)).toEqual([
      'Anthropic',
      '1,200 in / 300 out',
      '0 cached',
      '$0.0123',
      'prompt: Co-writer',
      'made with an older version',
      'edited',
    ])
  })
})
