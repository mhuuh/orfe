import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { fallbackModelInfo, getCatalog, refreshCatalog, subscribeCatalog, type CatalogState, type ModelInfo } from '../lib/catalog'

/**
 * The model catalog, shared by every caller. The saved list shows at once; a list older
 * than an hour is refreshed in the background (one request for all callers). `reload` forces a fetch.
 */
export function useCatalog(): CatalogState & { reload(): void } {
  const state = useSyncExternalStore(subscribeCatalog, getCatalog)

  useEffect(() => {
    void refreshCatalog()
  }, [])

  const reload = useCallback(() => void refreshCatalog({ force: true }), [])
  return { ...state, reload }
}

/** The catalog entry for `id`, or a text-only stand-in when it is not listed. */
export function findModel(models: ModelInfo[], id: string): ModelInfo {
  return models.find((m) => m.id === id) ?? fallbackModelInfo(id)
}
