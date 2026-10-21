import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import css from './Toast.module.css'

interface ToastAction {
  label: string
  run: () => void
}
interface ToastApi {
  show(text: string, action?: ToastAction, ms?: number): void
}

const Ctx = createContext<ToastApi>({ show: () => {} })
export const useToast = (): ToastApi => useContext(Ctx)

interface Item {
  id: number
  text: string
  action?: ToastAction
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<Item | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)

  const show = useCallback((text: string, action?: ToastAction, ms = 6000) => {
    clearTimeout(timer.current)
    setItem({ id: ++seq.current, text, action })
    timer.current = setTimeout(() => setItem(null), ms)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div className={css.region} role="status" aria-live="polite">
        {item && (
          <div className={css.toast} key={item.id}>
            <span className={css.text}>{item.text}</span>
            {item.action && (
              <button
                className={css.action}
                onClick={() => {
                  item.action?.run()
                  clearTimeout(timer.current)
                  setItem(null)
                }}
              >
                {item.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  )
}
