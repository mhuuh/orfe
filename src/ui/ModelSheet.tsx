import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { chatModels, groupByMonth, search, sortAZ, type ModelInfo } from '../lib/catalog'
import { Sheet } from './Sheet'
import { useCatalog } from './useCatalog'
import css from './ModelSheet.module.css'

interface Props {
  open: boolean
  onClose: () => void
  onPick: (m: ModelInfo) => void
  /** The id that gets the check. */
  current: string
  title?: string
}

/** USD per 1M tokens: "3", "0.075", "1.25". */
const price = (n: number): string => `$${+n.toPrecision(3)}`

const context = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

/** The quiet mono line under a model name: "$3 / $15 · 200k", "free · 128k", "price varies". */
export function modelMeta(m: ModelInfo): string {
  const cost = m.free ? 'free' : m.priceIn === 0 && m.priceOut === 0 ? 'price varies' : `${price(m.priceIn)} / ${price(m.priceOut)}`
  return m.contextLength > 0 ? `${cost} · ${context(m.contextLength)}` : cost
}

export function ModelSheet({ open, onClose, onPick, current, title = 'Model' }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {/* Mounted only while open, so each open re-checks the catalog (refetched when older than 1 h). */}
      <ModelList onPick={onPick} current={current} />
    </Sheet>
  )
}

type Mode = 'newest' | 'az'

function ModelList({ onPick, current }: { onPick: (m: ModelInfo) => void; current: string }) {
  const { models, error, reload } = useCatalog()
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<Mode>('newest')
  const list = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)

  const found = useMemo(() => search(chatModels(models), q), [models, q])
  const groups = useMemo(
    () => (mode === 'newest' ? groupByMonth(found) : [{ label: '', models: sortAZ(found) }]),
    [found, mode],
  )

  // Open on the current model once the list first has rows.
  useLayoutEffect(() => {
    if (scrolled.current || found.length === 0) return
    scrolled.current = true
    const el = list.current?.querySelector<HTMLElement>('[aria-current="true"]')
    const box = list.current
    if (el && box) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2
  }, [found.length])

  const row = (m: ModelInfo) => {
    const on = m.id === current
    return (
      <li key={m.id}>
        <button className={css.row} aria-current={on ? 'true' : undefined} onClick={() => onPick(m)}>
          <span className={css.text}>
            <span className={css.name}>{m.name}</span>
            <span className={css.meta}>{modelMeta(m)}</span>
          </span>
          {on && (
            <svg className={css.check} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </li>
    )
  }

  let body
  if (models.length === 0 && error) {
    body = (
      <div className={css.empty}>
        <p className={css.emptyText}>Couldn't load models.</p>
        <button className={css.retry} onClick={reload}>
          Retry
        </button>
      </div>
    )
  } else if (models.length === 0) {
    body = <p className={css.note}>Loading models…</p>
  } else if (found.length === 0) {
    body = <p className={css.note}>No models match.</p>
  } else {
    body = groups.map((g) => (
      <section key={g.label || 'all'} aria-label={g.label || 'All models'}>
        {g.label && <h3 className={css.month}>{g.label}</h3>}
        <ul className={css.rows}>{g.models.map(row)}</ul>
      </section>
    ))
  }

  return (
    <div className={css.root}>
      <div className={css.top}>
        <input
          className={css.search}
          type="search"
          placeholder="Search models"
          aria-label="Search models"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        <div className={css.seg} role="radiogroup" aria-label="Sort">
          {(
            [
              ['newest', 'Newest'],
              ['az', 'A–Z'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="radio"
              aria-checked={mode === k}
              className={`${css.segBtn} ${mode === k ? css.on : ''}`}
              onClick={() => setMode(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {error && models.length > 0 && <p className={css.offline}>Offline — showing saved list</p>}
      </div>
      <div ref={list} className={css.list}>
        {body}
      </div>
    </div>
  )
}
