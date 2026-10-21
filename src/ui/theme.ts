import type { Settings } from '../lib/types'

export function applyTheme(mode: Settings['themeMode']): void {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
  const meta = document.querySelector('meta[name="theme-color"]')
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
  if (meta && bg) meta.setAttribute('content', bg)
}
