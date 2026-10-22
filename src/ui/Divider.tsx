import type { Version } from '../lib/types'
import css from './Divider.module.css'

/** "anthropic/claude-sonnet-5.5" -> "claude-sonnet-5.5". */
export const shortModel = (id: string | undefined): string => (id ?? '').slice((id ?? '').indexOf('/') + 1)

/**
 * The label for the hairline before an assistant reply, or null when the
 * model and prompt are the same as the previous reply's (or there is none).
 * `afterSwap`: a stored prompt-swap divider ("→ Editor") already sits between the two
 * replies, so a prompt change alone needs no second hairline.
 */
export function dividerLabel(
  prev: Version | undefined,
  curr: Version,
  promptName?: string | null,
  afterSwap = false,
): string | null {
  if (!prev) return null
  const sameModel = (prev.model ?? '') === (curr.model ?? '')
  const samePrompt = (prev.promptRef ?? null) === (curr.promptRef ?? null)
  if (sameModel && (samePrompt || afterSwap)) return null
  const model = shortModel(curr.model)
  return promptName ? `${model} · ${promptName}` : model
}

export function Divider({ label }: { label: string }) {
  return (
    <div className={css.divider} role="separator" aria-label={label}>
      <span className={css.label}>{label}</span>
    </div>
  )
}
