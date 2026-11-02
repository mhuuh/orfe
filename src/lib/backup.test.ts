import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupDue, exportBackup, importBackup } from './backup'
import { fallbackModelInfo } from './catalog'
import { searchIndex } from './search/termIndex'
import { generate, isGenerating, stop } from './send'
import { db, storage } from './storage'

const DAY = 86_400_000

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

async function seed() {
  await storage.setSettings({ key: 'sk-or-secret-123', streaming: false })
  const chat = await storage.createConversation({ title: 'Hello' })
  await storage.savePrompt({ name: 'P', parentId: null, text: 'be brief' })
  await storage.setCache('models', { big: true })
  return chat
}

describe('backup', () => {
  it('round-trips every table and leaves the key out', async () => {
    const chat = await seed()
    const before = {
      conversations: await db.conversations.toArray(),
      prompts: await db.prompts.toArray(),
    }
    const file = await exportBackup()
    const text = await file.text()
    expect(text).not.toContain('sk-or-secret-123')
    expect(text).not.toContain('"models"') // cache is skipped

    await Promise.all(db.tables.map((t) => t.clear()))
    await storage.setSettings({ key: 'sk-or-other' })
    await importBackup(file, 'replace')

    expect(await db.conversations.toArray()).toEqual(before.conversations)
    expect(await db.prompts.toArray()).toEqual(before.prompts)
    expect((await storage.getConversation(chat.id))?.title).toBe('Hello')
    const s = await storage.getSettings()
    expect(s.streaming).toBe(false)
    expect(s.key).toBe('sk-or-other')
    expect(await storage.getCache('models')).toBeUndefined()
  })

  it('merge keeps rows that are not in the file', async () => {
    const a = await storage.createConversation({ title: 'A' })
    const file = await exportBackup()
    const b = await storage.createConversation({ title: 'B' })
    const res = await importBackup(file, 'merge')
    expect(res.added).toBe(0)
    expect(await storage.getConversation(a.id)).toBeTruthy()
    expect(await storage.getConversation(b.id)).toBeTruthy()
  })

  it('merge counts rows that are new to the phone', async () => {
    const a = await storage.createConversation({ title: 'A' })
    const file = await exportBackup()
    await storage.deleteConversation(a.id)
    expect((await importBackup(file, 'merge')).added).toBe(1)
  })

  it('replace removes rows that are not in the file', async () => {
    const a = await storage.createConversation({ title: 'A' })
    const file = await exportBackup()
    const b = await storage.createConversation({ title: 'B' })
    await importBackup(file, 'replace')
    expect(await storage.getConversation(a.id)).toBeTruthy()
    expect(await storage.getConversation(b.id)).toBeUndefined()
  })

  it('rejects a file that is not an ORFE backup', async () => {
    const a = await storage.createConversation({ title: 'A' })
    const empty = '{"format":"orfe-backup","version":1,"tables":{}}'
    const unknown = '{"format":"orfe-backup","version":1,"tables":{"nope":[{"id":"x"}]}}'
    for (const bad of ['not json', '{"hello":1}', '{"format":"orfe-backup","version":1}', empty, unknown]) {
      await expect(importBackup(new Blob([bad]), 'replace')).rejects.toThrow()
    }
    expect(await storage.getConversation(a.id)).toBeTruthy()
  })

  it('replace leaves a table alone when the file does not have it', async () => {
    const chat = await storage.createConversation({ title: 'Mine' })
    await storage.savePrompt({ name: 'P', parentId: null, text: 'x' })
    const file = new Blob([
      JSON.stringify({ format: 'orfe-backup', version: 1, exportedAt: 1, tables: { prompts: [] } }),
    ])
    await importBackup(file, 'replace')
    expect(await db.prompts.count()).toBe(0) // in the file, so replaced
    expect(await storage.getConversation(chat.id)).toBeTruthy() // not in the file, so kept
  })

  it('restores a backup from an older schema', async () => {
    const old = {
      id: 'old1',
      title: 'Old',
      createdAt: 1,
      updatedAt: 1,
      sessionId: 's',
      systemPromptRef: null,
      capabilityNote: true,
      windowStartMessageId: null,
      nextModel: 'm',
      nextEffort: null,
      totals: {},
    }
    const file = new Blob([
      JSON.stringify({ format: 'orfe-backup', version: 1, exportedAt: 1, tables: { conversations: [old] } }),
    ])
    await importBackup(file, 'merge')
    const c = await storage.getConversation('old1')
    expect(c?.context).toBeNull()
    expect(c?.tokenRatio).toBe(1)
  })

  it('leaves the term index out of the file, and ignores it in one', async () => {
    const chat = await seed()
    await db.searchDocs.put({ n: 1, messageId: 'm1', conversationId: chat.id, terms: ['kissa'], textHash: 'x' })
    const file = await exportBackup()
    expect(JSON.parse(await file.text()).tables).not.toHaveProperty('searchDocs')

    await db.searchDocs.clear()
    const row = { n: 2, messageId: 'm2', conversationId: chat.id, terms: ['koira'], textHash: 'x' }
    const forged = new Blob([JSON.stringify({ format: 'orfe-backup', version: 1, exportedAt: 1, tables: { prompts: [], searchDocs: [row] } })])
    await importBackup(forged, 'replace')
    expect(await db.searchDocs.count()).toBe(0)
  })

  it('a restore brings the term index in line with the file', async () => {
    const chat = await seed()
    const m = await storage.appendMessage(chat.id, 'user', { id: 'v1', content: [{ type: 'text', text: 'kissa' }], status: 'done', createdAt: 1 })
    const file = await exportBackup()
    await importBackup(file, 'replace')
    await vi.waitFor(async () => expect((await searchIndex.search(chat.id, 'kissa', 5)).map((h) => h.messageId)).toEqual([m.id]))
  })

  it('keeps the existing key after replace', async () => {
    await storage.setSettings({ key: 'sk-or-mine' })
    const file = await exportBackup()
    await storage.setSettings({ key: 'sk-or-newer' })
    await importBackup(file, 'replace')
    expect((await storage.getSettings()).key).toBe('sk-or-newer')
  })

  it('does not let a file overwrite lastBackupAt', async () => {
    await storage.setSettings({ lastBackupAt: 5 })
    const file = await exportBackup()
    await storage.setSettings({ lastBackupAt: 99 })
    await importBackup(file, 'replace')
    expect((await storage.getSettings()).lastBackupAt).toBe(99)
  })
})

describe('backupDue', () => {
  const s = (lastBackupAt: number | null) => ({ lastBackupAt })
  const now = 100 * DAY
  it('is true after 14 days with new content, false without', () => {
    expect(backupDue(s(now - 15 * DAY), now - 1 * DAY, now)).toBe(true)
    expect(backupDue(s(now - 15 * DAY), now - 16 * DAY, now)).toBe(false) // nothing new
    expect(backupDue(s(now - 3 * DAY), now - 1 * DAY, now)).toBe(false) // too soon
    expect(backupDue(s(null), now - 1 * DAY, now)).toBe(true) // never backed up
    expect(backupDue(s(null), 0, now)).toBe(false) // no content at all
  })
})

describe('restore during a reply', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is refused, on both modes, and changes nothing', async () => {
    const chat = await seed()
    const file = await exportBackup()
    await storage.updateConversation(chat.id, { title: 'Changed' })
    await storage.appendMessage(chat.id, 'user', { id: 'v', content: [{ type: 'text', text: 'hi' }], status: 'done', createdAt: 1 })
    // A request that hangs until Stop, like a reply that waits.
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    )
    const running = generate(chat.id, { kind: 'new' }, fallbackModelInfo('a/b'))
    expect(isGenerating(chat.id)).toBe(true)

    await expect(importBackup(file, 'replace')).rejects.toThrow('Wait for the reply to finish, then restore.')
    await expect(importBackup(file, 'merge')).rejects.toThrow('Wait for the reply to finish, then restore.')
    expect((await storage.getConversation(chat.id))?.title).toBe('Changed')

    stop(chat.id)
    await running
    await expect(importBackup(file, 'replace')).resolves.toBeDefined()
    expect((await storage.getConversation(chat.id))?.title).toBe('Hello')
  })
})
