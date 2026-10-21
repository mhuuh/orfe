import { db } from './db'
import type { Conversation, Message, Role, Settings, Usage, Version } from './types'

export { db }

export const newId = (): string => crypto.randomUUID()

export const DEFAULT_SETTINGS: Settings = {
  key: null,
  streaming: true,
  themeMode: 'system',
  defaultModel: 'anthropic/claude-sonnet-5.5',
}

export const zeroUsage = (): Usage => ({
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  cost: 0,
})

export interface Storage {
  listConversations(): Promise<Conversation[]>
  getConversation(id: string): Promise<Conversation | undefined>
  createConversation(init?: Partial<Conversation>): Promise<Conversation>
  updateConversation(id: string, patch: Partial<Conversation>): Promise<void>
  deleteConversation(id: string): Promise<void>
  listMessages(conversationId: string): Promise<Message[]>
  putMessage(m: Message): Promise<void>
  deleteMessage(id: string): Promise<Message | undefined>
  restoreMessage(m: Message): Promise<void>
  appendMessage(conversationId: string, role: Role, first: Version): Promise<Message>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<void>
  getCache<T>(key: string): Promise<{ value: T; at: number } | undefined>
  setCache<T>(key: string, value: T): Promise<void>
}

const SETTINGS_KEY = 'settings'

async function getSettings(): Promise<Settings> {
  const row = await db.settings.get(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(row?.value as Partial<Settings> | undefined) }
}

export const storage: Storage = {
  async listConversations() {
    return db.conversations.orderBy('updatedAt').reverse().toArray()
  },
  getConversation: (id) => db.conversations.get(id),
  async createConversation(init = {}) {
    const now = Date.now()
    const settings = await getSettings()
    const c: Conversation = {
      id: newId(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      sessionId: newId(),
      systemPromptRef: null,
      capabilityNote: true,
      windowStartMessageId: null,
      nextModel: settings.defaultModel,
      nextEffort: null,
      totals: zeroUsage(),
      ...init,
    }
    await db.conversations.add(c)
    return c
  },
  async updateConversation(id, patch) {
    await db.conversations.update(id, patch)
  },
  async deleteConversation(id) {
    await db.transaction('rw', db.conversations, db.messages, async () => {
      await db.messages.where('conversationId').equals(id).delete()
      await db.conversations.delete(id)
    })
  },
  listMessages: (conversationId) =>
    db.messages
      .where('[conversationId+order]')
      .between([conversationId, -Infinity], [conversationId, Infinity])
      .toArray(),
  async putMessage(m) {
    await db.messages.put(m)
  },
  async deleteMessage(id) {
    return db.transaction('rw', db.messages, async () => {
      const m = await db.messages.get(id)
      if (m) await db.messages.delete(id)
      return m
    })
  },
  async restoreMessage(m) {
    await db.transaction('rw', db.messages, async () => {
      const clash = await db.messages
        .where('[conversationId+order]')
        .equals([m.conversationId, m.order])
        .first()
      if (clash && clash.id !== m.id) {
        const later = await db.messages
          .where('[conversationId+order]')
          .between([m.conversationId, m.order], [m.conversationId, Infinity])
          .toArray()
        await db.messages.bulkPut(later.map((x) => ({ ...x, order: x.order + 1 })))
      }
      await db.messages.put(m)
    })
  },
  async appendMessage(conversationId, role, first) {
    return db.transaction('rw', db.messages, db.conversations, async () => {
      const last = await db.messages
        .where('[conversationId+order]')
        .between([conversationId, -Infinity], [conversationId, Infinity])
        .last()
      const now = Date.now()
      const m: Message = {
        id: newId(),
        conversationId,
        order: (last?.order ?? 0) + 1,
        role,
        versions: [first],
        activeVersion: 0,
        pinned: false,
        createdAt: now,
      }
      await db.messages.add(m)
      await db.conversations.update(conversationId, { updatedAt: now })
      return m
    })
  },
  getSettings,
  async setSettings(patch) {
    const next = { ...(await getSettings()), ...patch }
    await db.settings.put({ k: SETTINGS_KEY, value: next, at: Date.now() })
  },
  async getCache<T>(key: string) {
    const row = await db.cache.get(key)
    return row ? { value: row.value as T, at: row.at } : undefined
  },
  async setCache<T>(key: string, value: T) {
    await db.cache.put({ k: key, value, at: Date.now() })
  },
}
