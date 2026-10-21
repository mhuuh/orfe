import { describe, expect, it } from 'vitest'
import type { Message, Version } from './types'
import { editedVersion, versionText, withActive, withNewVersion, withoutActiveVersion, withVersionAt } from './versions'

const v = (id: string, text = id): Version => ({
  id,
  content: [{ type: 'text', text }],
  status: 'done',
  model: 'a/m',
  createdAt: 0,
})
const msg = (versions: Version[], activeVersion = 0): Message => ({
  id: 'm',
  conversationId: 'c',
  order: 1,
  role: 'assistant',
  versions,
  activeVersion,
  pinned: false,
  createdAt: 0,
})

describe('versions', () => {
  it('withNewVersion appends and activates', () => {
    const m = withNewVersion(msg([v('a')]), v('b'))
    expect(m.versions.map((x) => x.id)).toEqual(['a', 'b'])
    expect(m.activeVersion).toBe(1)
  })

  it('withActive clamps to the version range', () => {
    const m = msg([v('a'), v('b')])
    expect(withActive(m, 5).activeVersion).toBe(1)
    expect(withActive(m, -1).activeVersion).toBe(0)
  })

  it('withoutActiveVersion activates the previous neighbour and refuses the last version', () => {
    const r = withoutActiveVersion(msg([v('a'), v('b'), v('c')], 1))
    expect(r?.message.versions.map((x) => x.id)).toEqual(['a', 'c'])
    expect(r?.message.activeVersion).toBe(0)
    expect(r?.removed.id).toBe('b')
    expect(r?.index).toBe(1)
    expect(withoutActiveVersion(msg([v('a'), v('b')], 0))?.message.activeVersion).toBe(0)
    expect(withoutActiveVersion(msg([v('a')]))).toBeNull()
  })

  it('withVersionAt undoes a version delete', () => {
    const r = withoutActiveVersion(msg([v('a'), v('b'), v('c')], 1))!
    const back = withVersionAt(r.message, r.removed, r.index)
    expect(back.versions.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(back.activeVersion).toBe(1)
  })

  it('editedVersion keeps media, replaces text and stamps editedAt', () => {
    const src: Version = {
      ...v('a', 'old'),
      content: [{ type: 'media', blobId: 'b1', mime: 'image/png' }, { type: 'text', text: 'old' }],
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0.1 },
      status: 'error',
      error: 'boom',
    }
    const e = editedVersion(src, 'new', 42)
    expect(e.id).not.toBe(src.id)
    expect(e.content).toEqual([{ type: 'media', blobId: 'b1', mime: 'image/png' }, { type: 'text', text: 'new' }])
    expect(e.status).toBe('done')
    expect(e.error).toBeUndefined()
    expect(e.usage).toBeUndefined()
    expect(e.model).toBe('a/m')
    expect(e.editedAt).toBe(42)
    expect(versionText(e)).toBe('new')
  })
})
