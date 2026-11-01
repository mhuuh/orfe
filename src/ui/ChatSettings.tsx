import { useCallback, useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ABILITIES, abilityOn } from '../lib/abilities/registry'
import { notes } from '../lib/notes/store'
import { setAbility, setPlain } from '../lib/send'
import { NO_WINDOW_START, storage } from '../lib/storage'
import type { ContextSetting, Conversation, Prompt, Settings } from '../lib/types'
import { Sheet } from './Sheet'
import { noteCount } from './Vault'
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

interface SwitchRowProps {
  id: string
  label: string
  /** A second line, in mute. */
  hint?: string
  checked: boolean
  /** Greyed out. The value stays. */
  disabled?: boolean
  onToggle: () => void
}

export function SwitchRow({ id, label, hint, checked, disabled = false, onToggle }: SwitchRowProps) {
  return (
    <div className={`${shared.row} ${hint ? shared.hinted : ''} ${disabled ? shared.greyed : ''}`}>
      <span>
        <span id={id} className={shared.name}>
          {label}
        </span>
        {hint && <span className={shared.hint}>{hint}</span>}
      </span>
      <button className={shared.switch} role="switch" aria-checked={checked} aria-labelledby={id} disabled={disabled} onClick={onToggle}>
        <span className={shared.knob} />
      </button>
    </div>
  )
}

/** One row per ability, in registry order, with each switch as it reads now. */
export function abilityRows(conv: Conversation, prompt: Prompt | null) {
  return ABILITIES.map((a) => ({ id: a.id, title: a.title, summary: a.summary, on: abilityOn(conv, prompt, a.id) }))
}

const num = new Intl.NumberFormat('en-US')

interface Props {
  open: boolean
  onClose: () => void
  conversationId: string
  /** Show this chat's notes in the vault. */
  onNotes: () => void
}

export function ChatSettings({ open, onClose, conversationId, onNotes }: Props) {
  const data = useLiveQuery(async () => {
    const [conv, settings, shelf] = await Promise.all([
      storage.getConversation(conversationId),
      storage.getSettings(),
      notes.list(conversationId),
    ])
    // A ref to a deleted prompt reads as no prompt.
    const prompt = conv?.systemPromptRef ? ((await storage.getPrompt(conv.systemPromptRef)) ?? null) : null
    return conv ? { conv, settings, prompt, notesOnShelf: shelf.length } : null
  }, [conversationId])

  return (
    <Sheet open={open} onClose={onClose} title="Chat">
      {data && data.conv.id === conversationId && <Body {...data} onNotes={onNotes} />}
    </Sheet>
  )
}

interface BodyProps {
  conv: Conversation
  settings: Settings
  prompt: Prompt | null
  notesOnShelf: number
  onNotes: () => void
}

function Body({ conv, settings, prompt, notesOnShelf, onNotes }: BodyProps) {
  const id = conv.id
  const custom = conv.context
  const t = conv.totals

  /** Context writes re-read the chat, so a patch never lands on a stale copy. Raising the limit clears the stored start. */
  const patchContext = (patch: Partial<ContextSetting>) =>
    void storage.setChatContext(id, (own, def) => ({ ...(own ?? def), ...patch }))
  const stored = conv.windowStartMessageId !== null || conv.windowStartOrder !== null

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
        <h3 className={shared.label}>Abilities</h3>
        <SwitchRow
          id="plain-chat"
          label="Plain chat"
          hint="Only the prompt and the messages"
          checked={conv.plain}
          onToggle={() => void setPlain(id, !conv.plain)}
        />
        {abilityRows(conv, prompt).map((a) => (
          <SwitchRow
            key={a.id}
            id={`ability-${a.id}`}
            label={a.title}
            hint={a.summary}
            checked={a.on}
            disabled={conv.plain}
            onToggle={() => void setAbility(id, a.id, !a.on)}
          />
        ))}
        <div className={shared.meta}>A change makes the next reply cost more, once, because the cache starts over.</div>
      </section>

      <section className={shared.group}>
        <h3 className={shared.label}>Notes</h3>
        <button className={css.link} onClick={onNotes}>
          <span>
            <span className={shared.name}>This chat's notes</span>
            <span className={shared.hint}>{noteCount(notesOnShelf)}</span>
          </span>
          <span className={css.chev} aria-hidden="true">
            ›
          </span>
        </button>
      </section>

      <section className={shared.group}>
        <h3 className={shared.label}>Context</h3>
        <SwitchRow
          id="ctx-default"
          label={`Use default (${contextSummary(settings.context)})`}
          checked={custom === null}
          onToggle={() => void storage.setChatContext(id, (own, def) => (own === null ? { ...def } : null))}
        />
        {custom !== null && <ContextFields value={custom} onChange={patchContext} />}
        {stored && (
          <>
            <div className={`${shared.row} ${css.reset}`}>
              <span id="ctx-reset">Reset context window</span>
              <button
                className={shared.pill}
                aria-describedby="ctx-reset-note"
                onClick={() => void storage.mutateConversation(id, () => NO_WINDOW_START)}
              >
                Reset
              </button>
            </div>
            <div id="ctx-reset-note" className={shared.meta}>
              Sends from the beginning again; trims to the limit if needed.
            </div>
          </>
        )}
      </section>

      <section className={shared.group}>
        <SwitchRow
          id="cap-note"
          label="Capability note"
          checked={conv.capabilityNote}
          disabled={conv.plain}
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
