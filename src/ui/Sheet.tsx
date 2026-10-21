import { useEffect, useRef, useState, type ReactNode } from 'react'
import { openSheet } from './sheetHistory'
import css from './Sheet.module.css'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** 'bottom' is the default sheet; 'left' is used by the drawer. */
  side?: 'bottom' | 'left'
}

const EXIT_MS = 180

export function Sheet({ open, onClose, title, children, side = 'bottom' }: Props) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(t)
  }, [open])

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    // Back and Escape close only the top sheet (the model sheet over Settings).
    const me = openSheet(() => close.current())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && me.isTop()) close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      me.release()
    }
  }, [open])

  if (!mounted) return null
  return (
    <div className={`${css.root} ${shown ? css.shown : ''}`}>
      <div className={css.scrim} onClick={onClose} />
      <section
        className={`${css.panel} ${side === 'left' ? css.left : css.bottom}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {side === 'bottom' && (
          <header className={css.head}>
            <h2 className={css.title}>{title}</h2>
            <button className={css.close} onClick={onClose} aria-label="Close">
              Done
            </button>
          </header>
        )}
        <div className={css.body}>{children}</div>
      </section>
    </div>
  )
}
