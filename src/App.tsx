import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { storage } from './lib/storage'
import { Header } from './ui/Header'
import { Drawer } from './ui/Drawer'
import { Settings } from './ui/Settings'
import { KeySetup } from './ui/KeySetup'
import { ToastProvider } from './ui/Toast'
import { applyTheme } from './ui/theme'
import css from './App.module.css'

const readHash = (): string | null => /^#\/c\/(.+)$/.exec(location.hash)?.[1] ?? null

function useConversationId(): [string | null, (id: string, replace?: boolean) => void] {
  const [id, setId] = useState(readHash)
  useEffect(() => {
    const on = () => setId(readHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = useCallback((next: string, replace = false) => {
    const hash = `#/c/${next}`
    if (replace) history.replaceState(null, '', hash)
    else location.hash = hash
    setId(next)
  }, [])
  return [id, go]
}

export function App() {
  const settings = useLiveQuery(() => storage.getSettings(), [])
  const convs = useLiveQuery(() => storage.listConversations(), [])
  const [id, go] = useConversationId()
  const [drawer, setDrawer] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Id of a chat we just created that the live query has not delivered yet.
  const pendingId = useRef<string | null>(null)
  const creating = useRef(false)

  useEffect(() => {
    if (settings) applyTheme(settings.themeMode)
  }, [settings])

  // Open the requested chat; otherwise the most recent; otherwise create one.
  useEffect(() => {
    if (!convs || !settings?.key) return
    if (pendingId.current) {
      if (!convs.some((c) => c.id === pendingId.current)) return
      pendingId.current = null
    }
    if (id && convs.some((c) => c.id === id)) return
    if (convs.length > 0) {
      go(convs[0].id, true)
    } else if (!creating.current) {
      creating.current = true
      void storage
        .createConversation()
        .then((c) => {
          pendingId.current = c.id
          go(c.id, true)
        })
        .finally(() => {
          creating.current = false
        })
    }
  }, [convs, id, settings?.key, go])

  const newChat = async () => {
    const c = await storage.createConversation()
    pendingId.current = c.id
    setDrawer(false)
    go(c.id)
  }

  if (!settings) return null
  if (!settings.key) {
    return (
      <ToastProvider>
        <div className={css.app}>
          <KeySetup />
        </div>
      </ToastProvider>
    )
  }

  const current = id && convs?.some((c) => c.id === id) ? id : null

  return (
    <ToastProvider>
      <div className={css.app}>
        <Header conversationId={current} onMenu={() => setDrawer(true)} />
        <main className={css.transcript} aria-label="Conversation">
          {/* Task 8 fills the transcript. */}
        </main>
        <div className={css.composerSlot}>{/* Task 9 mounts the composer here. */}</div>
        <Drawer
          open={drawer}
          onClose={() => setDrawer(false)}
          currentId={current}
          onSelect={(cid) => {
            setDrawer(false)
            go(cid)
          }}
          onNew={() => void newChat()}
          onSettings={() => {
            setDrawer(false)
            setSettingsOpen(true)
          }}
        />
        <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    </ToastProvider>
  )
}
