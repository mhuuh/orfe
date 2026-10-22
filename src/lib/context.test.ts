import { describe, expect, it } from 'vitest'
import { estimateTokens, fingerprint, isCold, planWindow, ttlFor } from './context'
import { buildOutgoing } from './normalise'
import type { OutMessage } from './openrouter'
import type { ContentPart, ContextSetting, LastRequest, Message, Role } from './types'

function msg(order: number, role: Role, text: string | ContentPart[], extra: Partial<Message> = {}): Message {
  const content: ContentPart[] = typeof text === 'string' ? [{ type: 'text', text }] : text
  return {
    id: `m${order}`,
    conversationId: 'c',
    order,
    role,
    versions: [{ id: `v${order}`, content, status: 'done', createdAt: 0 }],
    activeVersion: 0,
    pinned: false,
    createdAt: 0,
    ...extra,
  }
}

/** `count` messages, orders 1..count, alternating user/assistant, each `chars` long (ratio 1 → chars/4 tokens). */
function transcript(count: number, chars = 40): Message[] {
  return Array.from({ length: count }, (_, i) => msg(i + 1, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(chars)))
}

const tokens100: ContextSetting = { mode: 'tokens', limit: 100, trimTo: 0.7 }
const base = {
  windowStartId: null,
  windowStartOrder: null,
  setting: tokens100,
  system: null,
  ratio: 1,
  cold: false,
  soft: 0.85,
}

describe('estimateTokens', () => {
  it('estimateTokens counts chars over four times ratio', () => {
    const m2 = msg(2, 'assistant', 'old text that is not active')
    m2.versions.push({ id: 'v2b', content: [{ type: 'text', text: 'y'.repeat(12) }], status: 'done', createdAt: 0 })
    m2.activeVersion = 1
    const messages = [
      msg(1, 'user', [
        { type: 'text', text: 'abcdefgh' },
        { type: 'media', blobId: 'b1', mime: 'image/png' },
      ]),
      m2,
      msg(3, 'divider', [], { dividerLabel: 'Context starts here' }),
    ]
    // 8 + 12 + system 4 = 24 chars → 6 → × 1.5 = 9
    expect(estimateTokens(messages, 'sys!', 1.5)).toBe(9)
    expect(estimateTokens(messages, null, 1)).toBe(5)
    // rounds up: 5 chars → 1.25 → 2
    expect(estimateTokens([msg(1, 'user', 'abcde')], null, 1)).toBe(2)
    expect(estimateTokens([], null, 1)).toBe(0)
  })
})

describe('ttlFor', () => {
  it('ttlFor anthropic hour, gpt-5.6+, default', () => {
    expect(ttlFor('anthropic/claude-sonnet-4.5', true)).toBe(3_600_000)
    expect(ttlFor('anthropic/claude-sonnet-4.5', false)).toBe(300_000)
    expect(ttlFor('openai/gpt-5.6', false)).toBe(1_800_000)
    expect(ttlFor('openai/gpt-5.6-mini', true)).toBe(1_800_000)
    expect(ttlFor('openai/gpt-5.10', false)).toBe(1_800_000)
    expect(ttlFor('openai/gpt-6', false)).toBe(1_800_000)
    expect(ttlFor('openai/gpt-6.1', false)).toBe(1_800_000)
    expect(ttlFor('openai/gpt-5.5', false)).toBe(300_000)
    expect(ttlFor('openai/gpt-5', false)).toBe(300_000)
    expect(ttlFor('openai/gpt-4o', false)).toBe(300_000)
    expect(ttlFor('openai/gpt-oss-120b', false)).toBe(300_000)
    expect(ttlFor('google/gemini-3-pro', true)).toBe(300_000)
  })
})

describe('isCold', () => {
  const old: OutMessage[] = [
    { role: 'system', content: 'be kind' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
    { role: 'user', content: 'next' },
  ]
  const last: LastRequest = { model: 'm/a', provider: 'P', ...fingerprint(old), at: 1_000 }
  const extended: OutMessage[] = [...old, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'more' }]
  const next = { model: 'm/a', provider: 'P', outgoing: extended, now: 2_000, ttlMs: 300_000 }

  it('fingerprint hashes the JSON of the outgoing array and counts it', () => {
    const fp = fingerprint(old)
    expect(fp.prefixCount).toBe(4)
    expect(fp.prefixHash).toMatch(/^[0-9a-f]{8}$/)
    expect(fingerprint([...old]).prefixHash).toBe(fp.prefixHash)
  })

  it('isCold when no last request', () => {
    expect(isCold(null, next)).toBe(true)
  })

  it('isCold on model change', () => {
    expect(isCold(last, { ...next, model: 'm/b' })).toBe(true)
    expect(isCold(last, { ...next, provider: 'Q' })).toBe(true)
    expect(isCold(last, { ...next, provider: null })).toBe(true)
  })

  it('isCold after ttl', () => {
    expect(isCold(last, { ...next, now: 1_000 + 300_000 })).toBe(false)
    expect(isCold(last, { ...next, now: 1_000 + 300_001 })).toBe(true)
  })

  it('isCold when an earlier message changed', () => {
    const edited = extended.map((m) => (m.content === 'hello' ? { ...m, content: 'hellp' } : m))
    expect(edited).toHaveLength(extended.length)
    expect(isCold(last, { ...next, outgoing: edited })).toBe(true)
    const newSystem = extended.map((m) => (m.role === 'system' ? { ...m, content: 'be kinf' } : m))
    expect(isCold(last, { ...next, outgoing: newSystem })).toBe(true)
  })

  it('isCold when the new request is shorter than the old prefix', () => {
    expect(isCold(last, { ...next, outgoing: old.slice(0, 3) })).toBe(true)
  })

  it('warm when new request extends the old one', () => {
    expect(isCold(last, next)).toBe(false)
    // same request again (e.g. reroll of an identical prefix) is also warm
    expect(isCold(last, { ...next, outgoing: old })).toBe(false)
  })
})

describe('planWindow', () => {
  it('no trim while under limit', () => {
    const r = planWindow({ ...base, messages: transcript(5), system: 'x'.repeat(40) })
    // 5 × 10 + system 10
    expect(r).toEqual({ startId: null, startOrder: null, trimmed: false, size: 60, limit: 100 })
  })

  it('keeps a stored start when under limit', () => {
    const r = planWindow({ ...base, messages: transcript(10), windowStartId: 'm4', windowStartOrder: 4 })
    expect(r).toEqual({ startId: 'm4', startOrder: 4, trimmed: false, size: 70, limit: 100 })
  })

  it('hard trim to trimTo when over the limit', () => {
    // 12 × 10 = 120 > 100 → drop oldest until ≤ 70
    const r = planWindow({ ...base, messages: transcript(12) })
    expect(r).toEqual({ startId: 'm6', startOrder: 6, trimmed: true, size: 70, limit: 100 })
  })

  it('hard trim counts the system text', () => {
    // 10 × 10 + system 10 = 110 > 100 → window ≤ 60 → start m5
    const r = planWindow({ ...base, messages: transcript(10), system: 'x'.repeat(40) })
    expect(r).toMatchObject({ startId: 'm5', trimmed: true, size: 70 })
  })

  it('accepts unsorted input', () => {
    const r = planWindow({ ...base, messages: transcript(12).reverse() })
    expect(r).toMatchObject({ startId: 'm6', trimmed: true, size: 70 })
  })

  it('cold trim when over soft threshold', () => {
    // 90 > 85 and cold → trim to ≤ 70
    const r = planWindow({ ...base, messages: transcript(9), cold: true })
    expect(r).toEqual({ startId: 'm3', startOrder: 3, trimmed: true, size: 70, limit: 100 })
  })

  it('no cold trim under soft threshold', () => {
    expect(planWindow({ ...base, messages: transcript(8), cold: true })).toMatchObject({ trimmed: false, size: 80 })
    // over soft but warm: the cache is worth keeping, so no trim
    expect(planWindow({ ...base, messages: transcript(9), cold: false })).toMatchObject({ trimmed: false, size: 90 })
  })

  it('messages mode counts messages', () => {
    const setting: ContextSetting = { mode: 'messages', limit: 10, trimTo: 0.7 }
    const messages = transcript(13).map((m) =>
      m.order === 3 ? { ...m, role: 'divider' as const, versions: [], activeVersion: 0, dividerLabel: 'x' } : m,
    )
    // 12 non-dividers > 10 → keep ≤ 7 → m7..m13; system is not a message
    const r = planWindow({ ...base, messages, setting, system: 'a long system prompt' })
    expect(r).toEqual({ startId: 'm7', startOrder: 7, trimmed: true, size: 7, limit: 10 })
    const under = planWindow({ ...base, messages: messages.slice(0, 10), setting })
    expect(under).toMatchObject({ trimmed: false, size: 9 })
  })

  it('pinned messages before the window are counted and never trimmed', () => {
    const stored = transcript(10).map((m) => (m.order === 2 ? { ...m, pinned: true } : m))
    // window m4..m10 = 70 + pinned m2 = 80
    expect(planWindow({ ...base, messages: stored, windowStartId: 'm4', windowStartOrder: 4 })).toMatchObject({
      trimmed: false,
      size: 80,
    })

    const messages = transcript(12).map((m) => (m.order === 3 ? { ...m, pinned: true } : m))
    // moving past pinned m3 frees nothing; m7..m12 (60) + m3 (10) = 70
    const r = planWindow({ ...base, messages })
    expect(r).toEqual({ startId: 'm7', startOrder: 7, trimmed: true, size: 70, limit: 100 })

    const setting: ContextSetting = { mode: 'messages', limit: 10, trimTo: 0.7 }
    // messages mode: 12 > 10 → keep ≤ 7: m7..m12 (6) + pinned m3 = 7
    expect(planWindow({ ...base, messages, setting })).toMatchObject({ startId: 'm7', size: 7 })
  })

  it('missing window start snaps to the next message by order', () => {
    const messages = transcript(10).filter((m) => m.order !== 4)
    const r = planWindow({ ...base, messages, windowStartId: 'm4', windowStartOrder: 4 })
    // m5..m10 = 60, not the whole transcript (90)
    expect(r).toEqual({ startId: 'm5', startOrder: 5, trimmed: false, size: 60, limit: 100 })
    // no id stored, only the order
    expect(planWindow({ ...base, messages, windowStartId: null, windowStartOrder: 4 })).toMatchObject({
      startId: 'm5',
      size: 60,
    })
  })

  it('a start on a divider moves to the next non-divider', () => {
    const messages = transcript(8).map((m) =>
      m.order === 5 ? { ...m, role: 'divider' as const, versions: [], dividerLabel: 'x' } : m,
    )
    const r = planWindow({ ...base, messages, windowStartId: 'm5', windowStartOrder: 5 })
    expect(r).toEqual({ startId: 'm6', startOrder: 6, trimmed: false, size: 30, limit: 100 })
  })

  it('missing window start past the end falls back to the last user message', () => {
    // stored start m9 was deleted along with everything after it; last user is m7
    const messages = transcript(8)
    const r = planWindow({ ...base, messages, windowStartId: 'm9', windowStartOrder: 9 })
    expect(r).toMatchObject({ startId: 'm7', startOrder: 7, size: 20 })
  })

  it('never trims the last user turn even when it alone exceeds the limit', () => {
    const messages = [
      msg(1, 'user', 'x'.repeat(40)),
      msg(2, 'assistant', 'x'.repeat(40)),
      msg(3, 'user', 'x'.repeat(800)),
      msg(4, 'assistant', 'x'.repeat(40)),
    ]
    const r = planWindow({ ...base, messages })
    // m3 + m4 = 210: still over, but the start stops at the last user message
    expect(r).toEqual({ startId: 'm3', startOrder: 3, trimmed: true, size: 210, limit: 100 })
    // already at the last user message: nothing to move
    expect(planWindow({ ...base, messages, windowStartId: 'm3', windowStartOrder: 3 })).toMatchObject({
      startId: 'm3',
      trimmed: false,
      size: 210,
    })
  })

  it('does not trim when there is no user message', () => {
    const messages = transcript(12).map((m) => ({ ...m, role: 'assistant' as const }))
    expect(planWindow({ ...base, messages })).toMatchObject({ startId: null, trimmed: false, size: 120 })
  })

  it('the planned window is exactly what buildOutgoing sends', () => {
    const messages = transcript(12).map((m) => (m.order === 3 ? { ...m, pinned: true } : m))
    const r = planWindow({ ...base, messages })
    const out = buildOutgoing(messages, {
      system: null,
      windowStartId: r.startId,
      inputModalities: ['text'],
      blobUrl: () => undefined,
    })
    // pinned m3 (user) + m7 (user) merge into one turn, then m8..m12
    expect(out).toHaveLength(6)
    const sentChars = out.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0)
    // 7 messages × 40 chars, plus the one "\n\n" join of m3 and m7
    expect(sentChars).toBe(7 * 40 + 2)
    expect(r.size).toBe(70)
  })

  it('bad settings are clamped', () => {
    const msgs4: ContextSetting = { mode: 'messages', limit: 4, trimTo: 0.7 }
    const ten = transcript(10)
    // limit: below 1 → 1, NaN / Infinity → 32000
    expect(planWindow({ ...base, messages: ten, setting: { ...msgs4, limit: 0 } }).limit).toBe(1)
    expect(planWindow({ ...base, messages: ten, setting: { ...msgs4, limit: -5 } }).limit).toBe(1)
    expect(planWindow({ ...base, messages: ten, setting: { ...msgs4, limit: Number.NaN } }).limit).toBe(32000)
    expect(planWindow({ ...base, messages: ten, setting: { ...msgs4, limit: Infinity } }).limit).toBe(32000)
    // trimTo: above 0.95 → 0.95 (target 3.8 → 3 kept), NaN → 0.7 (target 2.8 → 2 kept)
    expect(planWindow({ ...base, messages: ten, setting: { ...msgs4, trimTo: 5 } }).size).toBe(3)
    expect(planWindow({ ...base, messages: ten, setting: { ...msgs4, trimTo: Number.NaN } }).size).toBe(2)
    // trimTo below 0.1 → 0.1: with limit 40 the target is 4 kept, not trimmed down to the last user turn
    const forty: ContextSetting = { mode: 'messages', limit: 40, trimTo: -1 }
    expect(planWindow({ ...base, messages: transcript(50), setting: forty }).size).toBe(4)
    // soft: below trimTo → trimTo; above 1 → 1; NaN → 0.85
    expect(planWindow({ ...base, messages: transcript(3), setting: msgs4, cold: true, soft: 0 }).trimmed).toBe(true) // 3 > 0.7×4
    expect(planWindow({ ...base, messages: transcript(4), setting: msgs4, cold: true, soft: Number.NaN }).trimmed).toBe(true) // 4 > 0.85×4
    expect(planWindow({ ...base, messages: transcript(4), setting: msgs4, cold: true, soft: 5 }).trimmed).toBe(false) // 4 ≤ 1×4
    // ratio 0 / NaN / negative → 1, so tokens mode still trims (12 × 10 tokens > 100)
    for (const ratio of [0, Number.NaN, -2]) {
      const p = planWindow({ ...base, messages: transcript(12), ratio })
      expect(p.trimmed).toBe(true)
      expect(p.size).toBeLessThanOrEqual(70)
    }
  })

  it('empty transcript', () => {
    expect(planWindow({ ...base, messages: [], system: 'abcd' })).toEqual({
      startId: null,
      startOrder: null,
      trimmed: false,
      size: 1,
      limit: 100,
    })
  })
})
