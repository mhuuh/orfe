import { describe, expect, it } from 'vitest'
import { buildOutgoing } from './normalise'
import type { ContentPart, Message, Role, Version } from './types'

let n = 0
function ver(content: ContentPart[], extra: Partial<Version> = {}): Version {
  return { id: `v${++n}`, content, status: 'done', createdAt: 0, ...extra }
}
function msg(
  id: string,
  role: Role,
  text: string | ContentPart[],
  extra: Partial<Message> = {},
): Message {
  const content: ContentPart[] = typeof text === 'string' ? [{ type: 'text', text }] : text
  return {
    id,
    conversationId: 'c',
    order: Number(id.replace(/\D/g, '')) || 0,
    role,
    versions: [ver(content)],
    activeVersion: 0,
    pinned: false,
    createdAt: 0,
    ...extra,
  }
}
const base = {
  system: null,
  windowStartId: null,
  inputModalities: ['text'],
  blobUrl: () => undefined,
}

describe('buildOutgoing', () => {
  it('rule 1: uses active versions and only messages from windowStart on, plus pinned messages before it in original order', () => {
    const m2 = msg('m2', 'assistant', 'old2', { pinned: true })
    m2.versions.push(ver([{ type: 'text', text: 'new2' }]))
    m2.activeVersion = 1
    const messages = [
      msg('m1', 'user', 'u1'),
      m2,
      msg('m3', 'user', 'u3'),
      msg('m4', 'assistant', 'a4'),
      msg('m5', 'user', 'u5'),
    ]
    const out = buildOutgoing(messages, { ...base, windowStartId: 'm4' })
    expect(out).toEqual([
      { role: 'user', content: '…' },
      { role: 'assistant', content: 'new2\n\na4' },
      { role: 'user', content: 'u5' },
    ])
    // unsorted input and unknown window start
    const all = buildOutgoing([messages[4], messages[0], messages[1]], { ...base, windowStartId: 'nope' })
    expect(all.map((o) => o.content)).toEqual(['u1', 'new2', 'u5'])
  })

  it('rule 2: drops dividers and empty messages', () => {
    const out = buildOutgoing(
      [
        msg('m1', 'user', 'hi'),
        msg('m2', 'divider', 'label'),
        msg('m3', 'assistant', '   \n '),
        msg('m4', 'assistant', 'yo'),
      ],
      base,
    )
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ])
  })

  it('rule 3: merges consecutive same-role messages with a blank line', () => {
    const out = buildOutgoing([msg('m1', 'user', 'a'), msg('m2', 'user', 'b')], base)
    expect(out).toEqual([{ role: 'user', content: 'a\n\nb' }])
  })

  it('rule 4: inserts "…" user turn when first non-system message is assistant', () => {
    const out = buildOutgoing([msg('m1', 'assistant', 'hello')], { ...base, system: 'sys' })
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '…' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('rule 5: never includes reasoning', () => {
    const m = msg('m1', 'assistant', 'answer')
    m.versions[0].reasoning = { text: 'secret thoughts', details: [{ a: 1 }], durationMs: 5 }
    const json = JSON.stringify(buildOutgoing([msg('m0', 'user', 'q'), m], base))
    expect(json).not.toContain('reasoning')
    expect(json).not.toContain('secret thoughts')
  })

  it('rule 6: prepends system message when system is non-empty; omits it when null or empty', () => {
    const ms = [msg('m1', 'user', 'hi')]
    expect(buildOutgoing(ms, { ...base, system: 'be nice' })[0]).toEqual({ role: 'system', content: 'be nice' })
    expect(buildOutgoing(ms, { ...base, system: null })[0].role).toBe('user')
    expect(buildOutgoing(ms, { ...base, system: '' })[0].role).toBe('user')
  })

  it('rule 7: allows ending on assistant (prefill)', () => {
    const out = buildOutgoing([msg('m1', 'user', 'q'), msg('m2', 'assistant', 'Once upon')], base)
    expect(out[out.length - 1]).toEqual({ role: 'assistant', content: 'Once upon' })
  })

  it('upToId excludes the target and everything after it', () => {
    const out = buildOutgoing(
      [msg('m1', 'user', 'q'), msg('m2', 'assistant', 'a'), msg('m3', 'user', 'q2')],
      { ...base, upToId: 'm2' },
    )
    expect(out).toEqual([{ role: 'user', content: 'q' }])
  })

  it('image becomes image_url for image-capable model and a stand-in otherwise', () => {
    const media: ContentPart = { type: 'media', blobId: 'b1', mime: 'image/jpeg', name: 'sunset.jpg' }
    const ms = [msg('m1', 'user', [{ type: 'text', text: 'look' }, media])]
    const opts = { ...base, blobUrl: (id: string) => (id === 'b1' ? 'data:image/jpeg;base64,AAA' : undefined) }
    expect(buildOutgoing(ms, { ...opts, inputModalities: ['text', 'image'] })).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
        ],
      },
    ])
    expect(buildOutgoing(ms, opts)).toEqual([
      { role: 'user', content: 'look\n\n[image not shown to this model: "sunset.jpg"]' },
    ])
    // image-capable but no data URL available: stand-in
    expect(buildOutgoing(ms, { ...base, inputModalities: ['image'] })[0].content).toContain(
      '[image not shown to this model: "sunset.jpg"]',
    )
    // other kinds, name falls back to mime
    const aud: ContentPart = { type: 'media', blobId: 'b2', mime: 'audio/mpeg' }
    const pdf: ContentPart = { type: 'media', blobId: 'b3', mime: 'application/pdf', name: 'a.pdf' }
    expect(buildOutgoing([msg('m1', 'user', [aud, pdf])], base)[0].content).toBe(
      '[audio not shown to this model: "audio/mpeg"]\n\n[file not shown to this model: "a.pdf"]',
    )
  })

  it('text-only messages are sent as plain string content, mixed ones as part arrays', () => {
    const media: ContentPart = { type: 'media', blobId: 'b1', mime: 'image/png', name: 'x.png' }
    const img = { ...base, inputModalities: ['image'], blobUrl: () => 'data:image/png;base64,Z' }
    const out = buildOutgoing(
      [msg('m1', 'user', 'plain'), msg('m2', 'assistant', 'ok'), msg('m3', 'user', [media])],
      img,
    )
    expect(typeof out[0].content).toBe('string')
    expect(typeof out[1].content).toBe('string')
    expect(Array.isArray(out[2].content)).toBe(true)
    // merging a string message with a part-array message keeps one text part then the image
    const merged = buildOutgoing([msg('m1', 'user', 'a'), msg('m2', 'user', [media])], img)
    expect(merged[0].content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,Z' } },
    ])
  })
})
