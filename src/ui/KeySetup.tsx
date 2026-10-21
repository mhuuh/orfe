import { useState } from 'react'
import { storage } from '../lib/storage'
import { fetchKeyInfo } from '../lib/openrouter'
import { errorText } from '../lib/send'
import css from './KeySetup.module.css'

/** Validates a key against OpenRouter. Returns a readable error, or null when valid. */
export async function checkKey(key: string): Promise<string | null> {
  try {
    await fetchKeyInfo(key)
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const m = /HTTP (\d{3})/.exec(msg)
    if (m) return errorText(Number(m[1]), msg)
    return 'Could not reach OpenRouter. Check your connection and try again.'
  }
}

export function KeySetup({ onSaved, inline = false }: { onSaved?: () => void; inline?: boolean }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const key = value.trim()
    if (!key) return
    setBusy(true)
    setError(null)
    const err = await checkKey(key)
    if (err) {
      setError(err)
      setBusy(false)
      return
    }
    await storage.setSettings({ key })
    setBusy(false)
    setValue('')
    onSaved?.()
  }

  return (
    <form
      className={inline ? css.inline : css.page}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {!inline && <h1 className={css.brand}>ORFE</h1>}
      <p className={css.lead}>Paste your OpenRouter key. It stays on this phone.</p>
      <input
        className={css.input}
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="sk-or-v1-..."
        aria-label="OpenRouter key"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
      <button className={css.save} type="submit" disabled={busy || !value.trim()}>
        {busy ? 'Checking...' : 'Save'}
      </button>
      <p className={css.tip}>Tip: give this key a credit limit on openrouter.ai/settings/keys.</p>
    </form>
  )
}
