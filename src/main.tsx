import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource/geist-mono/400.css'
import '@fontsource-variable/newsreader'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './App'
import { DEFAULT_SETTINGS, storage } from './lib/storage'
import { recoverInterrupted } from './lib/send'
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

void start()
