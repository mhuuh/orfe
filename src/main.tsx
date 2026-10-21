import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource/geist-mono/400.css'
import '@fontsource-variable/newsreader'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './App'
import { storage } from './lib/storage'
import { recoverInterrupted } from './lib/send'
import { applyTheme } from './ui/theme'

async function start() {
  await recoverInterrupted()
  applyTheme((await storage.getSettings()).themeMode)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
