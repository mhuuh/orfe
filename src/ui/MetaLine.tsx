import { useState } from 'react'
import type { Version } from '../lib/types'
import { shortModel } from './Divider'
import css from './MetaLine.module.css'

const num = new Intl.NumberFormat('en-US')

/** provider · effort · tokens in/out · cached · $cost, skipping what is unknown. */
export function metaDetails(v: Version): string[] {
  const parts: string[] = []
  if (v.provider) parts.push(v.provider)
  if (v.reasoningEffort) parts.push(`effort ${v.reasoningEffort}`)
  if (v.usage) {
    parts.push(`${num.format(v.usage.promptTokens)} in / ${num.format(v.usage.completionTokens)} out`)
    parts.push(`${num.format(v.usage.cachedTokens)} cached`)
    parts.push(`$${v.usage.cost.toFixed(4)}`)
  }
  if (v.editedAt) parts.push('edited')
  return parts
}

/** Mono model id above a reply. Tap to show provider, effort, tokens and cost. */
export function MetaLine({ version }: { version: Version }) {
  const [open, setOpen] = useState(false)
  const details = metaDetails(version)
  const model = shortModel(version.model) || 'assistant'
  if (details.length === 0) return <span className={css.meta}>{model}</span>
  return (
    <button className={`${css.meta} ${css.button}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      {model}
      {open && details.map((d) => <span key={d}> · <span className={css.part}>{d}</span></span>)}
    </button>
  )
}
