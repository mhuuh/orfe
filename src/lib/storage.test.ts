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
})
