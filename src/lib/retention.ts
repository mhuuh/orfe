import { readOf } from './abilities/notes'
import { pointerWords } from './abilities/registry'
import { windowOf } from './context'
import type { Message, ToolPart } from './types'

/**
 * Strip soon (spec §9). A big tool result becomes a one-line pointer once two user turns have passed
 * since it ran, because context bloat matters more here than the small cost of a strip.
 *
 * Live check 1 decides that this ships, for all models (docs/research/live-checks-2026-11.md, rule 6).
 * Anthropic and OpenAI pay only the tail. Gemini does no worse than a normal turn. Some DeepSeek hosts
 * lose the whole prompt at a strip, at about $0.0005 each, and that is too small to need a rule.
 *
 * All of this happens at render time. `ToolPart.result` never changes, so the tool line in the UI
 * still shows the whole text.
 */

/** A result over this many characters (about 300 tokens) gets stripped. */
export const STRIP_MIN_CHARS = 1200
/** Whole user turns that pass before a strip. The turn the step ran in does not count. */
export const STRIP_AFTER_TURNS = 2

/**
 * The call ids that still render whole. Reads active versions. A step counts from its message, so
 * a rerolled reply counts from where it sits, not from when it ran. The next user message closes
 * the step's own turn, and each one after it closes one more turn.
 */
export function keptWhole(messages: Message[]): Set<string> {
  const kept = new Set<string>()
  let userMessages = 0
  for (const m of [...messages].sort((a, b) => b.order - a.order)) {
    const version = m.versions[m.activeVersion]
    if (!version) continue
    if (m.role === 'user') userMessages++
    const fresh = userMessages - 1 < STRIP_AFTER_TURNS
    for (const p of version.content) {
      if (p.type === 'tool' && (fresh || p.result.length <= STRIP_MIN_CHARS)) kept.add(p.callId)
    }
  }
  return kept
}

/** What a model reads in place of a stripped result. Built from the stored step only, so it never shifts. */
export function pointerFor(part: ToolPart): string {
  return `(${pointerWords(part)} Stripped. ${part.name} reopens it.)`
}

/**
 * Whether this page of this note, at this version, is whole in what the request sends. It agrees
 * with the request on all three tests: the step is inside the window, `keptWhole` keeps it, and
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
      if (p.type !== 'tool' || !kept.has(p.callId) || !sent(p)) return false
      const read = readOf(p)
      return read?.path === path && read.version === version && read.page === page
    }),
  )
}
