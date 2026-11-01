import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { storage } from '../lib/storage'
import { fetchKeyInfo } from '../lib/openrouter'
import { exportBackup, importBackup, requestPersist, shareBackup } from '../lib/backup'
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
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [backupMsg, setBackupMsg] = useState('')
  const [confirmReplace, setConfirmReplace] = useState(false)
  const restoreMode = useRef<'merge' | 'replace'>('merge')
  const fileInput = useRef<HTMLInputElement>(null)
  const key = settings?.key ?? null

  useEffect(() => {
    if (!open) return
    void requestPersist().then(setPersisted)
  }, [open])

  const backUp = async () => {
    setBackupMsg('')
    try {
      if (await shareBackup(await exportBackup())) await storage.setSettings({ lastBackupAt: Date.now() })
    } catch {
      setBackupMsg('Could not save the backup.')
    }
  }

  const restore = async (file: File | undefined) => {
    if (!file) return
    setConfirmReplace(false)
    try {
      const { added } = await importBackup(file, restoreMode.current)
      setBackupMsg(restoreMode.current === 'replace' ? 'Restored. Your data now matches the file.' : `Restored. ${added} new.`)
    } catch (e) {
      setBackupMsg((e as Error).message)
    }
  }

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
      setConfirmReplace(false)
      setBackupMsg('')
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
              // Writes the whole context from a fresh read; raising the limit clears the stored
              // window start of the chats that use this default.
              onChange={(patch) => void storage.setDefaultContext(patch)}
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

          <section className={css.group}>
            <h3 className={css.label}>Backup</h3>
            <div className={css.row}>
              <span>Save a copy of your data</span>
              <button className={css.pill} onClick={() => void backUp()}>
                Back up
              </button>
            </div>
            <div className={css.row}>
              <span>Restore from a file</span>
              <span className={css.btns}>
                <button
                  className={css.pill}
                  onClick={() => {
                    restoreMode.current = 'merge'
                    fileInput.current?.click()
                  }}
                >
                  Merge
                </button>
                <button
                  className={css.pill}
                  onClick={() => {
                    if (!confirmReplace) return setConfirmReplace(true)
                    restoreMode.current = 'replace'
                    fileInput.current?.click()
                  }}
                >
                  {confirmReplace ? 'Tap to confirm' : 'Replace'}
                </button>
              </span>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="Backup file"
              onChange={(e) => {
                void restore(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <div className={css.meta}>
              {backupMsg ||
                (settings.lastBackupAt
                  ? `Last backup ${new Date(settings.lastBackupAt).toLocaleDateString()}. `
                  : 'Never backed up. ') + 'Merge adds to your data. Replace swaps it. The file has no key.'}
            </div>
            <div className={css.meta}>
              {persisted === null
                ? ''
                : persisted
                  ? 'Storage is protected from clean-up.'
                  : 'Storage may be cleared by the browser. Back up often.'}
            </div>
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
