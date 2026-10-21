import { useId, useState } from 'react'
import type { Reasoning } from '../lib/types'
import css from './Thinking.module.css'

export const thoughtLabel = (ms: number): string => `Thought for ${Math.max(1, Math.round(ms / 1000))} s`

/**
 * Open while the model is still thinking (streaming, no reply text yet),
 * folded to one line once the reply starts. A tap overrides either way.
 */
export function Thinking({ reasoning, thinking }: { reasoning: Reasoning; thinking: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? thinking
  const id = useId()
  return (
    <div className={css.thinking}>
      <button
        className={css.head}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation()
          setUserOpen(!open)
        }}
      >
        <span>{thinking ? 'Thinking…' : thoughtLabel(reasoning.durationMs)}</span>
        <svg className={css.chev} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <div className={`${css.fold} ${open ? css.open : ''}`} id={id}>
        <div className={css.inner}>
          <div className={css.text}>{reasoning.text || '…'}</div>
        </div>
      </div>
    </div>
  )
}
