import css from './Versions.module.css'

/** `‹ 2/3 ›` when a message has more than one version. */
export function Versions({ count, active, onPick }: { count: number; active: number; onPick(index: number): void }) {
  if (count < 2) return null
  return (
    <div className={css.versions} role="group" aria-label={`Version ${active + 1} of ${count}`}>
      <button className={css.step} onClick={() => onPick(active - 1)} disabled={active <= 0} aria-label="Previous version">
        ‹
      </button>
      <span className={css.count}>
        {active + 1}/{count}
      </span>
      <button className={css.step} onClick={() => onPick(active + 1)} disabled={active >= count - 1} aria-label="Next version">
        ›
      </button>
    </div>
  )
}
