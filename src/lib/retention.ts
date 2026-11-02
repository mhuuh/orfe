import { readOf } from './abilities/notes'
import { pointerWords, readsOnly } from './abilities/registry'
import { windowOf } from './context'
import { stripMarker } from './notes/rules'
import type { Message, ToolPart } from './types'

/**
 * Strip soon (spec §9). A big tool result becomes a one-line pointer once two user turns have passed
 * since it ran, and each big string in the call's arguments becomes a short marker, because context
 * bloat matters more here than the small cost of a strip. A pinned reply keeps both whole.
 *
 * Live check 1 decides that this ships, for all models (docs/research/live-checks-2026-11.md, rule 6).
 * Anthropic and OpenAI pay only the tail. Gemini does no worse than a normal turn. Some DeepSeek hosts
 * lose the whole prompt at a strip, at about $0.0005 each, and that is too small to need a rule.
 *
 * All of this happens at render time. `ToolPart.result` and `ToolPart.args` never change, so the
 * tool line in the UI still shows the whole text.
 */

/** A result or an argument over this many characters (about 300 tokens) gets stripped. */
export const STRIP_MIN_CHARS = 1200
/** Whole user turns that pass before a strip. The turn the step ran in does not count. */
export const STRIP_AFTER_TURNS = 2

const big = (s: string): boolean => s.length > STRIP_MIN_CHARS

/** Every string in a value, at any depth. */
function stringsIn(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  return typeof v === 'object' && v !== null ? Object.values(v).flatMap(stringsIn) : []
}

/**
 * The call ids that still render whole. Reads active versions. A step counts from its message, so
 * a rerolled reply counts from where it sits, not from when it ran. The next user message closes
 * the step's own turn, and each one after it closes one more turn. A pinned reply stays whole.
 */
export function keptWhole(messages: Message[]): Set<string> {
  const kept = new Set<string>()
  let userMessages = 0
  for (const m of [...messages].sort((a, b) => b.order - a.order)) {
    const version = m.versions[m.activeVersion]
    if (!version) continue
    if (m.role === 'user') userMessages++
    const fresh = m.pinned || userMessages - 1 < STRIP_AFTER_TURNS
    for (const p of version.content) {
      if (p.type !== 'tool') continue
      if (fresh || !(big(p.result) || stringsIn(p.args).some(big))) kept.add(p.callId)
    }
  }
  return kept
}

/** Whether a result goes out as it is. `kept` left out: every step renders whole. */
export const resultStays = (part: ToolPart, kept?: Set<string>): boolean => !kept || kept.has(part.callId) || !big(part.result)

/**
 * What a model reads in place of a stripped result. Built from the stored step only, so it never
 * shifts. Only a tool that just reads says that it reopens the text: a model must not repeat a write.
 */
export function pointerFor(part: ToolPart): string {
  return `(${pointerWords(part)} Stripped.${readsOnly(part.name) ? ` ${part.name} reopens it.` : ''})`
}

/** Arguments with each big string as a short marker. They stay valid JSON, with the same keys in the same order. */
export function shrinkArgs(v: unknown): unknown {
  if (typeof v === 'string') return big(v) ? stripMarker(v.length) : v
  if (Array.isArray(v)) return v.map(shrinkArgs)
  if (typeof v !== 'object' || v === null) return v
  return Object.fromEntries(Object.entries(v).map(([key, value]) => [key, shrinkArgs(value)]))
}

/**
 * Whether this page of this note, at this version, is whole in what the request sends. It agrees
 * with the request on all three tests: the step is inside the window, its result is not stripped, and
 * `sent` says that it goes out as a real call. A flat step carries no text.
 * An "unchanged" line is no copy, so it can't hold a repeat read back once the real copy is stripped.
 */
export function wholeInWindow(
  messages: Message[],
  startId: string | null,
  path: string,
  version: number,
  page: number,
  sent: (part: ToolPart) => boolean,
): boolean {
  const kept = keptWhole(messages)
  const inWindow = windowOf([...messages].sort((a, b) => a.order - b.order), startId)
  return inWindow.some((m) =>
    (m.versions[m.activeVersion]?.content ?? []).some((p) => {
      if (p.type !== 'tool' || !resultStays(p, kept) || !sent(p)) return false
      const read = readOf(p)
      return read?.path === path && read.version === version && read.page === page
    }),
  )
}
