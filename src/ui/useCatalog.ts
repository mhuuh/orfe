import { useCallback, useEffect, useRef, useState } from 'react'
import { fallbackModelInfo, loadCatalog, type ModelInfo } from '../lib/catalog'

interface CatalogState {
  models: ModelInfo[]
  error?: string
  stale: boolean
}

/** The model catalog (cached for an hour by `loadCatalog`). `reload` forces a fetch. */
export function useCatalog(): CatalogState & { reload(): void } {
  const [state, setState] = useState<CatalogState>({ models: [], stale: false })
  const seq = useRef(0)

  const load = useCallback((force: boolean) => {
    const id = ++seq.current
    void loadCatalog({ force }).then(
      (r) => {
        if (id === seq.current) setState({ models: r.models, error: r.error, stale: r.stale })
      },
      (e: unknown) => {
        if (id === seq.current) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }))
      },
    )
  }, [])

  useEffect(() => {
    load(false)
    return () => {
      seq.current++
    }
  }, [load])

  const reload = useCallback(() => load(true), [load])
  return { ...state, reload }
}

/** The catalog entry for `id`, or a text-only stand-in when it is not listed. */
export function findModel(models: ModelInfo[], id: string): ModelInfo {
  return models.find((m) => m.id === id) ?? fallbackModelInfo(id)
}
