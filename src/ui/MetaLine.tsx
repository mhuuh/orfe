import { useState } from 'react'
import type { Prompt, Version } from '../lib/types'
import { shortModel } from './Divider'
import css from './MetaLine.module.css'

const num = new Intl.NumberFormat('en-US')

/** Prompts by id, as the transcript knows them. */
export type PromptIndex = ReadonlyMap<string, Prompt>

/**
 * "prompt: Name", plus "made with an older version" when the prompt was edited since,
 * or "prompt: deleted". Nothing for a reply made without a prompt, or before prompts load.
 */
export function promptDetails(v: Version, prompts: PromptIndex | undefined): string[] {
  if (!v.promptRef || !prompts) return []
  const p = prompts.get(v.promptRef)
  if (!p) return ['prompt: deleted']
  const parts = [`prompt: ${p.name}`]
  if (v.promptVersionHash && v.promptVersionHash !== p.versionHash) parts.push('made with an older version')
  return parts
}

/** provider · effort · tokens in/out · cached · $cost · prompt, skipping what is unknown. */
export function metaDetails(v: Version, prompts?: PromptIndex): string[] {
  const parts: string[] = []
  if (v.provider) parts.push(v.provider)
  if (v.reasoningEffort) parts.push(`effort ${v.reasoningEffort}`)
  if (v.usage) {
    parts.push(`${num.format(v.usage.promptTokens)} in / ${num.format(v.usage.completionTokens)} out`)
    parts.push(`${num.format(v.usage.cachedTokens)} cached`)
    parts.push(`$${v.usage.cost.toFixed(4)}`)
  }
  parts.push(...promptDetails(v, prompts))
  if (v.editedAt) parts.push('edited')
  return parts
}

/** Mono model id above a reply. Tap to show provider, effort, tokens, cost and prompt. */
export function MetaLine({ version, prompts }: { version: Version; prompts?: PromptIndex }) {
  const [open, setOpen] = useState(false)
  const details = metaDetails(version, prompts)
  const model = shortModel(version.model) || 'assistant'
  if (details.length === 0) return <span className={css.meta}>{model}</span>
  return (
    <button className={`${css.meta} ${css.button}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      {model}
      {open && details.map((d) => <span key={d}> · <span className={css.part}>{d}</span></span>)}
    </button>
  )
}
