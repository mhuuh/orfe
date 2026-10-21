import { isAnyGenerating, onGenerationEnd } from './send'

/**
 * Applying an app update reloads the page. That loses an unsent draft (drafts live in
 * memory) and cuts off a reply. So a waiting update is applied only when the app is idle:
 * no draft text in any chat and nothing generating.
 */

/** Chats whose composer holds non-blank text. */
const drafts = new Set<string>()
let pending: (() => void) | null = null

/** The composer reports its text on every change. */
export function noteDraft(conversationId: string, text: string): void {
  if (text.trim() !== '') drafts.add(conversationId)
  else drafts.delete(conversationId)
}

export function isIdle(): boolean {
  return drafts.size === 0 && !isAnyGenerating()
}

/** Applies the pending update when idle. Returns whether it did. */
export function applyUpdateIfIdle(): boolean {
  if (!pending || !isIdle()) return false
  const apply = pending
  pending = null
  apply()
  return true
}

/** A new version is waiting. `apply` activates it (and reloads); runs now if idle, else later. */
export function setUpdatePending(apply: () => void): void {
  pending = apply
  applyUpdateIfIdle()
}

/** Tests only. */
export function resetAppUpdate(): void {
  drafts.clear()
  pending = null
}

onGenerationEnd(() => {
  applyUpdateIfIdle()
})
