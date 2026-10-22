import { hashText } from './hash'
import type { OutMessage } from './openrouter'
import type { ContextSetting, LastRequest, Message } from './types'

/** Characters of a message's active version that count towards the estimate. Media and dividers count 0. */
function messageChars(m: Message): number {
  if (m.role === 'divider') return 0
  const version = m.versions[m.activeVersion]
  if (!version) return 0
  let chars = 0
  for (const p of version.content) if (p.type === 'text') chars += p.text.length
  return chars
}

function charsToTokens(chars: number, ratio: number): number {
  return Math.ceil((chars / 4) * ratio)
}

/**
 * Token estimate: active-version text characters ÷ 4, plus the system text, times `ratio`
 * (the correction from the last real `usage.prompt_tokens`), rounded up.
 */
export function estimateTokens(messages: Message[], system: string | null, ratio: number): number {
  let chars = system?.length ?? 0
  for (const m of messages) chars += messageChars(m)
  return charsToTokens(chars, ratio)
}

const MIN = 60_000

/** How long the provider keeps a prompt cache, in ms (spec §6, research §5). */
export function ttlFor(modelId: string, anthropicCacheHour: boolean): number {
  if (modelId.startsWith('anthropic/')) return anthropicCacheHour ? 60 * MIN : 5 * MIN
  const gpt = /^openai\/gpt-(\d+)(?:\.(\d+))?/.exec(modelId)
  if (gpt) {
    const major = Number(gpt[1])
    const minor = gpt[2] === undefined ? 0 : Number(gpt[2])
    if (major > 5 || (major === 5 && minor >= 6)) return 30 * MIN
  }
  return 5 * MIN
}

/**
 * Fingerprint of a request's messages, stored as `conversation.lastRequest`.
 *
 * JSON.stringify is a safe byte-level comparison here because `buildOutgoing` always builds
 * objects with the same shape and key order (`{ role, content }`, parts `{ type, text }` or
 * `{ type, image_url: { url } }`), so equal content always gives equal JSON.
 */
export function fingerprint(outgoing: OutMessage[]): { prefixHash: string; prefixCount: number } {
  return { prefixHash: hashText(JSON.stringify(outgoing)), prefixCount: outgoing.length }
}

/**
 * True when the provider's prompt cache is surely gone: no last request, another model or
 * provider, the TTL ran out, or the old request is no longer an exact prefix of the new one
 * (an edit, delete, trim, or system prompt change).
 */
export function isCold(
  last: LastRequest | null,
  next: { model: string; provider: string | null; outgoing: OutMessage[]; now: number; ttlMs: number },
): boolean {
  if (!last) return true
  if (last.model !== next.model || last.provider !== next.provider) return true
  if (next.now - last.at > next.ttlMs) return true
  if (next.outgoing.length < last.prefixCount) return true
  return hashText(JSON.stringify(next.outgoing.slice(0, last.prefixCount))) !== last.prefixHash
}

export interface PlanInput {
  messages: Message[]
  windowStartId: string | null
  windowStartOrder: number | null
  setting: ContextSetting
  system: string | null
  ratio: number
  cold: boolean
  /** Share of the limit above which a cold cache triggers a trim (default 0.85). */
  soft: number
}

export interface Plan {
  /** null = the window starts at the beginning (nothing stored, nothing trimmed). */
  startId: string | null
  startOrder: number | null
  /** True only when this plan moved the start forward to shrink the window. */
  trimmed: boolean
  /** Window + pinned-before-window, in estimated tokens (system included) or messages. */
  size: number
  limit: number
}

/**
 * Decide where the sent window starts. Agrees with `buildOutgoing`: it sends every message from
 * the start on, plus pinned messages before it, and drops dividers.
 *
 * Rules: the start lands on a non-divider; it never passes the last user message; trims (hard:
 * size > limit; cold: cold and size > soft × limit) move it forward one message at a time until
 * size ≤ trimTo × limit. Pinned messages always count and never leave.
 */
export function planWindow(input: PlanInput): Plan {
  const { setting, ratio } = input
  const limit = setting.limit
  const sorted = [...input.messages].sort((a, b) => a.order - b.order)
  const n = sorted.length

  let lastUser = -1
  let lastReal = -1
  for (let i = 0; i < n; i++) {
    if (sorted[i].role === 'user') lastUser = i
    if (sorted[i].role !== 'divider') lastReal = i
  }

  // Resolve the stored start: id first, then the order as fallback (the id's message was deleted).
  const stored = input.windowStartId !== null || input.windowStartOrder !== null
  let idx = 0
  if (input.windowStartId !== null && sorted.some((m) => m.id === input.windowStartId)) {
    idx = sorted.findIndex((m) => m.id === input.windowStartId)
  } else if (input.windowStartOrder !== null) {
    const order = input.windowStartOrder
    idx = sorted.findIndex((m) => m.order >= order)
    if (idx < 0) idx = n
  }
  while (idx < n && sorted[idx].role === 'divider') idx++
  // The newest turn is always sent: never start after the last user message.
  const ceiling = lastUser >= 0 ? lastUser : lastReal
  if (ceiling >= 0 && idx > ceiling) idx = ceiling

  // Size as a running sum over window + pinned-before-window.
  const weight = (m: Message): number =>
    m.role === 'divider' ? 0 : setting.mode === 'tokens' ? messageChars(m) : 1
  let sum = setting.mode === 'tokens' ? (input.system?.length ?? 0) : 0
  for (let i = 0; i < n; i++) if (i >= idx || sorted[i].pinned) sum += weight(sorted[i])
  const sizeOf = (s: number): number => (setting.mode === 'tokens' ? charsToTokens(s, ratio) : s)

  let size = sizeOf(sum)
  let trimmed = false
  const mustTrim = size > limit || (input.cold && size > input.soft * limit)
  if (mustTrim && lastUser >= 0) {
    const target = setting.trimTo * limit
    while (size > target && idx < lastUser) {
      // Leave sorted[idx]: it stops counting unless pinned. Then land on the next non-divider.
      if (!sorted[idx].pinned) sum -= weight(sorted[idx])
      idx++
      while (idx < lastUser && sorted[idx].role === 'divider') idx++
      size = sizeOf(sum)
      trimmed = true
    }
  }

  if (n === 0 || idx >= n || (!stored && !trimmed)) {
    return { startId: null, startOrder: null, trimmed, size, limit }
  }
  return { startId: sorted[idx].id, startOrder: sorted[idx].order, trimmed, size, limit }
}
