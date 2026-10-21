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
import { recoverInterrupted } from './lib/send'
import { applyUpdateIfIdle, setUpdatePending } from './lib/appUpdate'
import { applyTheme } from './ui/theme'

async function start() {
  try {
    await recoverInterrupted()
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

/** Ask the browser not to evict our IndexedDB under storage pressure. Never blocks start-up. */
function requestPersistentStorage() {
  try {
    void navigator.storage
      ?.persist?.()
      .catch(() => {})
  } catch {
    // Not supported: nothing to do.
  }
}

void start()
registerServiceWorker()
requestPersistentStorage()
