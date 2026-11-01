import { useEffect } from 'react'
import { noteDraft } from '../lib/appUpdate'

/**
 * An app update reloads the page, so it waits while an editor holds unsaved edits. `key` names
 * the editor. The gate gets a marker and not the text: an emptied body is an edit too, and blank
 * text would count as no draft.
 */
export function useUnsavedGate(key: string, dirty: boolean): void {
  useEffect(() => {
    noteDraft(key, dirty ? 'unsaved' : '')
    return () => noteDraft(key, '')
  }, [key, dirty])
}
