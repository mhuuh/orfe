import { StrictMode } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource/geist-mono/400.css'
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './App'
import { DEFAULT_SETTINGS, storage } from './lib/storage'
import { requestPersist } from './lib/backup'
import { backfillAtStart, recoverInterrupted } from './lib/send'
import { applyUpdateIfIdle, setUpdatePending } from './lib/appUpdate'
import { applyTheme } from './ui/theme'

async function start() {
  let recovered = 0
  try {
    recovered = await recoverInterrupted()
  } catch (e) {
    console.error('recoverInterrupted failed', e)
  }
  try {
    applyTheme((await storage.getSettings()).themeMode)
  } catch (e) {
    console.error('could not load settings; using defaults', e)
    applyTheme(DEFAULT_SETTINGS.themeMode)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  void backfillAtStart(recovered)
}

/**
 * Registers the service worker. registerType is 'prompt': a new version waits instead of
 * taking over, because taking over reloads the page. We apply it only when idle (no draft,
 * nothing generating): at once if idle, else when the app is hidden or a reply finishes.
 * An installed app is rarely cold-started, so it also checks for updates on each return.
 */
function registerServiceWorker() {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      setUpdatePending(() => void updateSW(true))
    },
    onRegisteredSW(_url, registration) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration?.update().catch(() => {})
        // The user left the app: the best moment to swap versions.
        else applyUpdateIfIdle()
      })
    },
  })
}

// The bench page runs in place of the app: it must not touch the real database, and a normal load
// never fetches its chunk (the service worker's precache leaves it out too).
if (new URLSearchParams(location.search).has('bench')) {
  const root = document.getElementById('root')!
  // The bench is not precached, so it can fail to load offline.
  import('./bench/bench').then(
    ({ mountBench }) => mountBench(root),
    () => {
      root.textContent = "Couldn't load the bench. Check the connection and open this page again."
    },
  )
} else {
  void start()
  registerServiceWorker()
  void requestPersist()
}
