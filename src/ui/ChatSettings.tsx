import { useCallback, useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { storage } from '../lib/storage'
import type { ContextSetting, Conversation, Settings } from '../lib/types'
import { Sheet } from './Sheet'
import shared from './Settings.module.css'
import css from './ChatSettings.module.css'

type Mode = ContextSetting['mode']

const LIMITS: Record<Mode, [number, number]> = { tokens: [1000, 2_000_000], messages: [2, 1000] }
/** Switching mode starts from these: a token count makes no sense as a message count. */
const MODE_DEFAULT: Record<Mode, number> = { tokens: 32000, messages: 40 }
const TRIM_MIN = 50
const TRIM_MAX = 90
const TRIM_STEP = 5

/** A typed limit, clamped to the mode's range. Not a number → `fallback`. */
export function clampLimit(mode: Mode, n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  const [lo, hi] = LIMITS[mode]
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** The trim-to share in percent, moved one step and kept on the 5 % grid within 50–90. */
export function stepTrim(trimTo: number, dir: -1 | 1): number {
  const pct = Math.round((trimTo * 100) / TRIM_STEP) * TRIM_STEP + dir * TRIM_STEP
  return Math.min(TRIM_MAX, Math.max(TRIM_MIN, pct)) / 100
}

/** 999 → "999", 12149 → "12.1k", 32000 → "32k", 2000000 → "2m". */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = Math.round(n / 100) / 10
  if (k < 1000) return `${k}k`
  return `${Math.round(n / 100_000) / 10}m`
}

/** "32k tokens", "40 messages". */
export function contextSummary(s: ContextSetting): string {
  return s.mode === 'tokens' ? `${compact(s.limit)} tokens` : `${s.limit} messages`
}

const digitsOnly = (s: string) => s.replace(/\D+/g, '')

interface CommitFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  /** The stored value. */
  value: string
  /** Shapes a typed character run (e.g. digits only). */
  filter?: (s: string) => string
  /** The value to store for a draft (trim, clamp, or fall back to `value`). */
  normalize: (draft: string) => string
  onCommit: (next: string) => void
}

/**
 * An input that keeps a local draft and stores it on blur, Enter, or when the sheet closes
 * (unmount), so Done, Back and the scrim never drop an edit.
 */
function CommitField({ value, filter, normalize, onCommit, ...rest }: CommitFieldProps) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  const latest = useRef({ draft, value, normalize, onCommit })
  latest.current = { draft, value, normalize, onCommit }
  const commit = useCallback((): string => {
    const l = latest.current
    const next = l.normalize(l.draft)
    if (next !== l.value) l.onCommit(next)
    return next
  }, [])
  useEffect(() => () => void commit(), [commit])

  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(filter ? filter(e.target.value) : e.target.value)}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        setDraft(commit())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** Mode segment, limit field and trim-to stepper. Emits patches; the caller merges them into a fresh read. */
export function ContextFields({ value, onChange }: { value: ContextSetting; onChange: (patch: Partial<ContextSetting>) => void }) {
  const uid = useId()
  const pct = Math.round(value.trimTo * 100)
  const unit = value.mode === 'tokens' ? 'tokens' : 'messages'
  return (
    <div className={css.fields}>
      <div className={shared.seg} role="radiogroup" aria-label="Limit by">
        {(['tokens', 'messages'] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={value.mode === m}
            className={`${shared.segBtn} ${value.mode === m ? shared.on : ''}`}
            onClick={() => value.mode !== m && onChange({ mode: m, limit: MODE_DEFAULT[m] })}
          >
            {m === 'tokens' ? 'Tokens' : 'Messages'}
          </button>
        ))}
      </div>
      <div className={shared.row}>
        <label htmlFor={`${uid}-limit`}>Limit</label>
        {/* One pill: the number, then its unit. Tapping the unit focuses the number. */}
        <span className={css.limit} onClick={(e) => e.currentTarget.querySelector('input')?.focus()}>
          <CommitField
            id={`${uid}-limit`}
            className={css.limitInput}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            enterKeyHint="done"
            value={String(value.limit)}
            filter={digitsOnly}
            normalize={(d) => String(d === '' ? value.limit : clampLimit(value.mode, Number(d), value.limit))}
            onCommit={(next) => onChange({ limit: Number(next) })}
          />
          <span className={css.unit}>{unit}</span>
        </span>
      </div>
      <div className={shared.row}>
        <span id={`${uid}-trim`}>Trim to</span>
        <span className={css.stepper} role="group" aria-labelledby={`${uid}-trim`}>
          <button
            className={css.step}
            aria-label="Less"
            disabled={pct <= TRIM_MIN}
            onClick={() => onChange({ trimTo: stepTrim(value.trimTo, -1) })}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 7h8" strokeLinecap="round" />
            </svg>
          </button>
          <output className={css.pct} aria-live="polite">
            {pct}%
          </output>
          <button
            className={css.step}
            aria-label="More"
            disabled={pct >= TRIM_MAX}
            onClick={() => onChange({ trimTo: stepTrim(value.trimTo, 1) })}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 7h8M7 3v8" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </div>
      <div className={shared.meta}>Over the limit, the oldest messages drop until {pct}% is left.</div>
    </div>
  )
}

export function SwitchRow({ id, label, checked, onToggle }: { id: string; label: string; checked: boolean; onToggle: () => void }) {
  return (
    <div className={shared.row}>
      <span id={id}>{label}</span>
      <button className={shared.switch} role="switch" aria-checked={checked} aria-labelledby={id} onClick={onToggle}>
        <span className={shared.knob} />
      </button>
    </div>
  )
}

const num = new Intl.NumberFormat('en-US')

export function ChatSettings({ open, onClose, conversationId }: { open: boolean; onClose: () => void; conversationId: string }) {
  const data = useLiveQuery(async () => {
    const [conv, settings] = await Promise.all([storage.getConversation(conversationId), storage.getSettings()])
    return conv ? { conv, settings } : null
  }, [conversationId])

  return (
    <Sheet open={open} onClose={onClose} title="Chat">
      {data && data.conv.id === conversationId && <Body {...data} />}
    </Sheet>
  )
}

function Body({ conv, settings }: { conv: Conversation; settings: Settings }) {
  const id = conv.id
  const custom = conv.context
  const t = conv.totals

  /** Context writes re-read the chat, so a patch never lands on a stale copy. */
  const patchContext = (patch: Partial<ContextSetting>) =>
    void storage.mutateConversation(id, (c) => ({ context: { ...(c.context ?? settings.context), ...patch } }))

  return (
    <div className={shared.body}>
      <section className={shared.group}>
        <h3 className={shared.label}>
          <label htmlFor="chat-title">Title</label>
        </h3>
        <CommitField
          id="chat-title"
          className={css.field}
          autoComplete="off"
          enterKeyHint="done"
          value={conv.title}
          normalize={(d) => d.trim() || conv.title}
          onCommit={(title) => void storage.updateConversation(id, { title })}
        />
      </section>

      <section className={shared.group}>
        <h3 className={shared.label}>Context</h3>
        <SwitchRow
          id="ctx-default"
          label={`Use default (${contextSummary(settings.context)})`}
          checked={custom === null}
          onToggle={() =>
            void storage.mutateConversation(id, (c) => ({ context: c.context === null ? { ...settings.context } : null }))
          }
        />
        {custom !== null && <ContextFields value={custom} onChange={patchContext} />}
      </section>

      <section className={shared.group}>
        <SwitchRow
          id="cap-note"
          label="Capability note"
          checked={conv.capabilityNote}
          onToggle={() => void storage.mutateConversation(id, (c) => ({ capabilityNote: !c.capabilityNote }))}
        />
        <div className={shared.meta}>Tells the model it can use Markdown and inline styling.</div>
      </section>

      <section className={shared.group}>
        <h3 className={shared.label}>Usage</h3>
        <dl className={css.totals}>
          <dt>Tokens in / out</dt>
          <dd>
            {num.format(t.promptTokens)} / {num.format(t.completionTokens)}
          </dd>
          <dt>Cached</dt>
          <dd>{num.format(t.cachedTokens)}</dd>
          <dt>Cost</dt>
          <dd>${t.cost.toFixed(4)}</dd>
        </dl>
      </section>
    </div>
  )
}
