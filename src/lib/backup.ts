import { db } from './db'
import { storage } from './storage'
import type { Settings } from './types'

const FORMAT = 'orfe-backup'
const VERSION = 1
const DAY = 86_400_000
/** Tables that rebuild by themselves. `searchDocs` is a later table: a name with no table is harmless. */
const SKIP = new Set(['cache', 'searchDocs'])
/** Settings fields that belong to this phone. A file never sets or reads them. */
const LOCAL_ONLY = ['key', 'lastBackupAt'] as const

interface BackupFile {
  format: typeof FORMAT
  version: number
  exportedAt: number
  tables: Record<string, unknown[]>
}

const kept = () => db.tables.filter((t) => !SKIP.has(t.name))

/** Strips the fields that must stay on this phone from a settings row. */
function scrub(row: unknown): unknown {
  const r = row as { value?: Record<string, unknown> }
  if (!r?.value || typeof r.value !== 'object') return row
  const value = { ...r.value }
  for (const f of LOCAL_ONLY) delete value[f]
  return { ...r, value }
}

/** Walks `db.tables`, so a table added later is in the file with no change here. Never writes the key. */
export async function exportBackup(): Promise<Blob> {
  const tables: Record<string, unknown[]> = {}
  for (const t of kept()) {
    const rows = await t.toArray()
    tables[t.name] = t.name === 'settings' ? rows.map(scrub) : rows
  }
  const file: BackupFile = { format: FORMAT, version: VERSION, exportedAt: Date.now(), tables }
  return new Blob([JSON.stringify(file)], { type: 'application/json' })
}

async function parse(file: Blob): Promise<BackupFile> {
  let data: unknown
  try {
    data = JSON.parse(await file.text())
  } catch {
    throw new Error('This file is not an ORFE backup.')
  }
  const f = data as Partial<BackupFile> | null
  if (f?.format !== FORMAT || typeof f.version !== 'number' || !f.tables || typeof f.tables !== 'object') {
    throw new Error('This file is not an ORFE backup.')
  }
  if (f.version > VERSION) throw new Error('This backup is from a newer version of ORFE.')
  return f as BackupFile
}

/**
 * Merge adds the file's rows by id and keeps the rest; settings on the phone stay as they are.
 * Replace makes the phone match the file. Both keep this phone's key. `added` counts rows that were new here.
 */
export async function importBackup(file: Blob, mode: 'merge' | 'replace'): Promise<{ added: number }> {
  const data = await parse(file)
  const tables = kept()
  return db.transaction('rw', tables, async () => {
    const own = await storage.getSettings()
    let added = 0
    for (const t of tables) {
      const rows = data.tables[t.name]
      if (t.name === 'settings') {
        if (mode !== 'replace' || !Array.isArray(rows)) continue
        // Rows are keyed by `k`; the key and backup time of this phone go back in after the swap.
        await t.clear()
        await t.bulkPut(rows)
        await storage.setSettings({ key: own.key, lastBackupAt: own.lastBackupAt })
        continue
      }
      if (mode === 'replace') await t.clear()
      if (!Array.isArray(rows) || rows.length === 0) continue
      const keyPath = t.schema.primKey.keyPath as string
      if (mode === 'merge') {
        const have = await t.bulkGet(rows.map((r) => (r as Record<string, unknown>)[keyPath] as string))
        added += have.filter((h) => h === undefined).length
      } else {
        added += rows.length
      }
      await t.bulkPut(rows)
    }
    return { added }
  })
}

export const backupFileName = (now = Date.now()) => `orfe-backup-${new Date(now).toISOString().slice(0, 10)}.json`

/**
 * Hands the file to the share sheet when the browser can share files, else downloads it.
 * False if the user closed the share sheet.
 */
export async function shareBackup(blob: Blob, name = backupFileName()): Promise<boolean> {
  const file = new File([blob], name, { type: 'application/json' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return true
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false
      // Share failed for another reason: fall through to the download.
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

/** Asks the browser not to evict our data. True if it will keep it. */
export async function requestPersist(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

/** True when the last backup is over 14 days old (or none) and something changed since. */
export function backupDue(s: Pick<Settings, 'lastBackupAt'>, lastChange: number, now: number): boolean {
  const last = s.lastBackupAt ?? 0
  return now - last > 14 * DAY && lastChange > last
}
