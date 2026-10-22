import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, newId, storage } from './storage'
import type { Message, Version } from './types'

const v = (text: string): Version => ({
  id: newId(),
  content: [{ type: 'text', text }],
  status: 'done',
  createdAt: Date.now(),
})

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('storage', () => {
  it('creates a conversation with a fresh sessionId and zero totals', async () => {
    const a = await storage.createConversation()
    const b = await storage.createConversation()
    expect(a.sessionId).toBeTruthy()
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(a.title).toBe('New chat')
    expect(a.systemPromptRef).toBeNull()
    expect(a.capabilityNote).toBe(true)
    expect(a.windowStartMessageId).toBeNull()
    expect(a.nextEffort).toBeNull()
    expect(a.nextModel).toBe((await storage.getSettings()).defaultModel)
    expect(a.totals).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cost: 0,
    })
    expect(await storage.getConversation(a.id)).toEqual(a)
  })

  it('appendMessage assigns increasing order and bumps updatedAt', async () => {
    const c = await storage.createConversation({ updatedAt: 1 })
    const m1 = await storage.appendMessage(c.id, 'user', v('a'))
    const m2 = await storage.appendMessage(c.id, 'assistant', v('b'))
    expect(m2.order).toBe(m1.order + 1)
    expect(m1.activeVersion).toBe(0)
    expect(m1.pinned).toBe(false)
    expect((await storage.getConversation(c.id))!.updatedAt).toBeGreaterThan(1)
  })

  it('listMessages returns messages sorted by order', async () => {
    const c = await storage.createConversation()
    const m1 = await storage.appendMessage(c.id, 'user', v('a'))
    const m2 = await storage.appendMessage(c.id, 'assistant', v('b'))
    const m3 = await storage.appendMessage(c.id, 'user', v('c'))
    await storage.putMessage({ ...m1, order: 10 })
    const other = await storage.createConversation()
    await storage.appendMessage(other.id, 'user', v('x'))
    const list = await storage.listMessages(c.id)
    expect(list.map((m) => m.id)).toEqual([m2.id, m3.id, m1.id])
  })

  it('deleteMessage returns the removed message and restoreMessage puts it back in place', async () => {
    const c = await storage.createConversation()
    await storage.appendMessage(c.id, 'user', v('a'))
    const m2 = await storage.appendMessage(c.id, 'assistant', v('b'))
    await storage.appendMessage(c.id, 'user', v('c'))
    const removed = await storage.deleteMessage(m2.id)
    expect(removed).toEqual(m2)
    expect(await storage.listMessages(c.id)).toHaveLength(2)
    await storage.restoreMessage(removed as Message)
    const list = await storage.listMessages(c.id)
    expect(list.map((m) => m.id)[1]).toBe(m2.id)
    expect(list[1].order).toBe(m2.order)
    expect(await storage.deleteMessage('nope')).toBeUndefined()
  })

  it('deleteConversation removes its messages', async () => {
    const c = await storage.createConversation()
    const other = await storage.createConversation()
    await storage.appendMessage(c.id, 'user', v('a'))
    await storage.appendMessage(other.id, 'user', v('b'))
    await storage.deleteConversation(c.id)
    expect(await storage.getConversation(c.id)).toBeUndefined()
    expect(await storage.listMessages(c.id)).toEqual([])
    expect(await storage.listMessages(other.id)).toHaveLength(1)
  })

  it('settings have defaults: streaming true, themeMode system, key null', async () => {
    expect(await storage.getSettings()).toEqual({
      key: null,
      streaming: true,
      themeMode: 'system',
      context: { mode: 'tokens', limit: 32000, trimTo: 0.7 },
      anthropicCacheHour: false,
      defaultModel: 'anthropic/claude-sonnet-5.5',
    })
    await storage.setSettings({ streaming: false, key: 'k' })
    const s = await storage.getSettings()
    expect(s.streaming).toBe(false)
    expect(s.key).toBe('k')
    expect(s.themeMode).toBe('system')
  })

  it('cache round-trips with a timestamp', async () => {
    expect(await storage.getCache('x')).toBeUndefined()
    await storage.setCache('x', { a: 1 })
    const got = await storage.getCache<{ a: number }>('x')
    expect(got!.value).toEqual({ a: 1 })
    expect(got!.at).toBeGreaterThan(0)
  })

  it('restore after a newer append keeps distinct orders and puts the restored message first', async () => {
    const c = await storage.createConversation()
    await storage.appendMessage(c.id, 'user', v('a'))
    const last = await storage.appendMessage(c.id, 'assistant', v('b'))
    const removed = (await storage.deleteMessage(last.id)) as Message
    const newer = await storage.appendMessage(c.id, 'user', v('c'))
    expect(newer.order).toBe(removed.order)
    await storage.restoreMessage(removed)
    const list = await storage.listMessages(c.id)
    expect(new Set(list.map((m) => m.order)).size).toBe(3)
    expect(list.map((m) => m.id).slice(1)).toEqual([removed.id, newer.id])
  })

  it('mutateMessage applies the change to the stored copy, not a stale one', async () => {
    const c = await storage.createConversation()
    const m = await storage.appendMessage(c.id, 'assistant', { ...v('a'), status: 'streaming' })
    const stale = { ...m }
    await storage.putMessage({ ...m, versions: [{ ...m.versions[0], status: 'done' }] })
    const next = await storage.mutateMessage(stale.id, (x) => ({ ...x, pinned: true }))
    expect(next?.versions[0].status).toBe('done')
    const stored = await db.messages.get(m.id)
    expect(stored?.pinned).toBe(true)
    expect(stored?.versions[0].status).toBe('done')
    expect(await storage.mutateMessage('missing', (x) => x)).toBeUndefined()
  })

  it('mutateConversation patches from the stored copy, with v1 defaults filled', async () => {
    const c = await storage.createConversation()
    // A v1 row: no context, no tokenRatio.
    const { context: _c, tokenRatio: _t, ...v1 } = c
    await db.conversations.put(v1 as typeof c)
    await storage.updateConversation(c.id, { title: 'Renamed elsewhere' })
    const seen: unknown[] = []
    await storage.mutateConversation(c.id, (x) => {
      seen.push(x.context, x.tokenRatio, x.title)
      return { context: { mode: 'messages', limit: 40, trimTo: 0.7 } }
    })
    expect(seen).toEqual([null, 1, 'Renamed elsewhere'])
    const stored = await storage.getConversation(c.id)
    expect(stored?.context).toEqual({ mode: 'messages', limit: 40, trimTo: 0.7 })
    expect(stored?.title).toBe('Renamed elsewhere')
    expect(await storage.mutateConversation('missing', () => ({ title: 'x' }))).toBe(false)
  })
})

describe('schema v2 and prompts', () => {
  it('v1 database upgrades to v2 without losing rows', async () => {
    db.close()
    await Dexie.delete('orfe')
    const old = new Dexie('orfe')
    old.version(1).stores({
      conversations: 'id, updatedAt',
      messages: 'id, conversationId, [conversationId+order]',
      settings: 'k',
      cache: 'k',
    })
    await old.table('conversations').add({
      id: 'c1',
      title: 'Old chat',
      createdAt: 1,
      updatedAt: 2,
      sessionId: 's',
      systemPromptRef: null,
      capabilityNote: true,
      windowStartMessageId: null,
      nextModel: 'm',
      nextEffort: null,
      totals: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0 },
    })
    await old.table('messages').add({
      id: 'm1',
      conversationId: 'c1',
      order: 1,
      role: 'user',
      versions: [v('hi')],
      activeVersion: 0,
      pinned: false,
      createdAt: 1,
    })
    old.close()
    await db.open()
    expect(await db.messages.count()).toBe(1)
    expect(await db.conversations.count()).toBe(1)
    const c = await storage.getConversation('c1')
    expect(c?.title).toBe('Old chat')
    expect(c?.context).toBeNull()
    expect(c?.tokenRatio).toBe(1)
    expect(c?.lastRequest).toBeNull()
    expect(c?.windowStartOrder).toBeNull()
    expect((await storage.listConversations())[0].context).toBeNull()
  })

  it('savePrompt sets versionHash and updatedAt', async () => {
    const before = Date.now()
    const p = await storage.savePrompt({ name: 'Terse', parentId: null, text: 'Be brief.' })
    expect(p.id).toBeTruthy()
    expect(p.versionHash).toMatch(/^[0-9a-f]{8}$/)
    expect(p.updatedAt).toBeGreaterThanOrEqual(before)
    const p2 = await storage.savePrompt({ id: p.id, name: 'Terse', parentId: null, text: 'Be very brief.' })
    expect(p2.id).toBe(p.id)
    expect(p2.versionHash).not.toBe(p.versionHash)
    expect(await storage.getPrompt(p.id)).toEqual(p2)
  })

  it('listPrompts sorts by name', async () => {
    await storage.savePrompt({ name: 'banana', parentId: null, text: 'x' })
    await storage.savePrompt({ name: 'Apple', parentId: null, text: 'x' })
    await storage.savePrompt({ name: 'cherry', parentId: null, text: 'x' })
    expect((await storage.listPrompts()).map((p) => p.name)).toEqual(['Apple', 'banana', 'cherry'])
  })

  it('deletePrompt refuses while variants exist', async () => {
    const parent = await storage.savePrompt({ name: 'Parent', parentId: null, text: 'x' })
    const child = await storage.savePrompt({ name: 'Child', parentId: parent.id, text: 'y' })
    expect(await storage.deletePrompt(parent.id)).toBe('has-variants')
    expect(await storage.getPrompt(parent.id)).toBeDefined()
    expect(await storage.deletePrompt(child.id)).toBe('deleted')
    expect(await storage.deletePrompt(parent.id)).toBe('deleted')
    expect(await storage.listPrompts()).toEqual([])
  })

  it('settings default context is tokens 32000 at 0.7', async () => {
    const s = await storage.getSettings()
    expect(s.context).toEqual({ mode: 'tokens', limit: 32000, trimTo: 0.7 })
    expect(s.anthropicCacheHour).toBe(false)
    // an old stored row without the new fields, and a partial context, still resolve
    await db.settings.put({ k: 'settings', value: { key: 'k', context: { limit: 100 } }, at: 1 })
    const s2 = await storage.getSettings()
    expect(s2.key).toBe('k')
    expect(s2.context).toEqual({ mode: 'tokens', limit: 100, trimTo: 0.7 })
  })
})
