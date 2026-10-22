import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { storage } from '../lib/storage'
import { fetchKeyInfo } from '../lib/openrouter'
import type { Settings as SettingsT } from '../lib/types'
import { Sheet } from './Sheet'
import { KeySetup } from './KeySetup'
import { ModelSheet } from './ModelSheet'
import { ContextFields, SwitchRow } from './ChatSettings'
import css from './Settings.module.css'

type KeyInfo = Awaited<ReturnType<typeof fetchKeyInfo>>

const THEMES: SettingsT['themeMode'][] = ['system', 'light', 'dark']

const mask = (key: string) => `${key.slice(0, 6)}…${key.slice(-4)}`
const money = (n: number | null) => (n === null ? 'no limit' : `$${n.toFixed(2)}`)

export function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useLiveQuery(() => storage.getSettings(), [])
  const [info, setInfo] = useState<KeyInfo | null>(null)
  const [infoError, setInfoError] = useState(false)
  const [changing, setChanging] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [picking, setPicking] = useState(false)
  const key = settings?.key ?? null

  useEffect(() => {
    if (!open || !key) return
    let live = true
    setInfo(null)
    setInfoError(false)
    fetchKeyInfo(key)
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfoError(true))
    return () => {
      live = false
    }
  }, [open, key])

  useEffect(() => {
    if (!open) {
      setChanging(false)
      setConfirmRemove(false)
      setPicking(false)
    }
  }, [open])

  if (!settings) return null

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Settings">
        <div className={css.body}>
          <section className={css.group}>
            <h3 className={css.label}>OpenRouter key</h3>
            {changing ? (
              <KeySetup inline onSaved={() => setChanging(false)} />
            ) : (
              <>
                <div className={css.row}>
                  <span className={css.mono}>{key ? mask(key) : 'not set'}</span>
                  <span className={css.btns}>
                    <button className={css.pill} onClick={() => setChanging(true)}>
                      Change
                    </button>
                    <button
                      className={css.pill}
                      onClick={() => {
                        if (!confirmRemove) return setConfirmRemove(true)
                        void storage.setSettings({ key: null })
                        onClose()
                      }}
                    >
                      {confirmRemove ? 'Tap to confirm' : 'Remove'}
                    </button>
                  </span>
                </div>
                <div className={css.meta}>
                  {infoError
                    ? 'Could not load key info.'
                    : info
                      ? `limit ${money(info.limit)} · left ${money(info.limitRemaining)} · used $${info.usage.toFixed(2)}`
                      : 'Loading key info...'}
                </div>
              </>
            )}
          </section>
  
          <section className={css.group}>
            <div className={css.row}>
              <span id="stream-label">Stream replies</span>
              <button
                className={css.switch}
                role="switch"
                aria-checked={settings.streaming}
                aria-labelledby="stream-label"
                onClick={() => void storage.setSettings({ streaming: !settings.streaming })}
              >
                <span className={css.knob} />
              </button>
            </div>
          </section>
  
          <section className={css.group}>
            <h3 className={css.label}>Theme</h3>
            <div className={css.seg} role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={settings.themeMode === t}
                  className={`${css.segBtn} ${settings.themeMode === t ? css.on : ''}`}
                  onClick={() => void storage.setSettings({ themeMode: t })}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </section>
  
          <section className={css.group}>
            <h3 className={css.label}>Default model</h3>
            <div className={css.row}>
              <span className={css.mono}>{settings.defaultModel}</span>
              <button className={css.pill} onClick={() => setPicking(true)}>
                Change
              </button>
            </div>
            <div className={css.meta}>New chats start with this model.</div>
          </section>

          <section className={css.group}>
            <h3 className={css.label}>Context</h3>
            <ContextFields
              value={settings.context}
              onChange={(patch) =>
                // setSettings replaces nested objects: always write the whole context, from a fresh read.
                void storage.getSettings().then((s) => storage.setSettings({ context: { ...s.context, ...patch } }))
              }
            />
          </section>

          <section className={css.group}>
            <h3 className={css.label}>Cache</h3>
            <SwitchRow
              id="cache-hour"
              label="Keep Anthropic cache for 1 hour"
              checked={settings.anthropicCacheHour}
              onToggle={() => void storage.setSettings({ anthropicCacheHour: !settings.anthropicCacheHour })}
            />
            <div className={css.meta}>Costs 2× to write. The default keeps it for 5 minutes.</div>
          </section>
        </div>
      </Sheet>
      <ModelSheet
        open={picking}
        title="Default model"
        current={settings.defaultModel}
        onClose={() => setPicking(false)}
        onPick={(m) => {
          setPicking(false)
          void storage.setSettings({ defaultModel: m.id })
        }}
      />
    </>
  )
}
