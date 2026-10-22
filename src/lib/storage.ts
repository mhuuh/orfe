import { db } from './db'
import { hashText } from './hash'
import type { Conversation, ContextSetting, Message, Prompt, Role, Settings, Usage, Version } from './types'

export { db }

export const newId = (): string => crypto.randomUUID()

export const DEFAULT_SETTINGS: Settings = {
  key: null,
  streaming: true,
  themeMode: 'system',
  defaultModel: 'anthropic/claude-sonnet-5.5',
  context: { mode: 'tokens', limit: 32000, trimTo: 0.7 },
  anthropicCacheHour: false,
}

/** Fills fields that rows written before schema v2 do not have. Not written back. */
function withConversationDefaults(c: Conversation): Conversation {
  return {
    ...c,
    context: c.context ?? null,
    windowStartOrder: c.windowStartOrder ?? null,
    lastRequest: c.lastRequest ?? null,
    tokenRatio: c.tokenRatio ?? 1,
  }
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
  /** Re-reads the conversation (defaults filled) inside a write transaction and applies the patch `fn` returns. False if it is gone. */
  mutateConversation(id: string, fn: (c: Conversation) => Partial<Conversation>): Promise<boolean>
  deleteConversation(id: string): Promise<void>
  listMessages(conversationId: string): Promise<Message[]>
  putMessage(m: Message): Promise<void>
  deleteMessage(id: string): Promise<Message | undefined>
  restoreMessage(m: Message): Promise<void>
  /** Re-reads the message inside a write transaction and stores what `fn` returns. */
  mutateMessage(id: string, fn: (m: Message) => Message): Promise<Message | undefined>
  appendMessage(conversationId: string, role: Role, first: Version): Promise<Message>
  listPrompts(): Promise<Prompt[]>
  getPrompt(id: string): Promise<Prompt | undefined>
  savePrompt(p: { id?: string; name: string; parentId: string | null; text: string }): Promise<Prompt>
  /** Refuses (and deletes nothing) while other prompts name this one as their parent. */
  deletePrompt(id: string): Promise<'deleted' | 'has-variants'>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<void>
  getCache<T>(key: string): Promise<{ value: T; at: number } | undefined>
  setCache<T>(key: string, value: T): Promise<void>
}

const SETTINGS_KEY = 'settings'

async function getSettings(): Promise<Settings> {
  const row = await db.settings.get(SETTINGS_KEY)
  const stored = (row?.value ?? {}) as Partial<Settings>
  const context: ContextSetting = { ...DEFAULT_SETTINGS.context, ...stored.context }
  return { ...DEFAULT_SETTINGS, ...stored, context }
}

export const storage: Storage = {
  async listConversations() {
    return (await db.conversations.orderBy('updatedAt').reverse().toArray()).map(withConversationDefaults)
  },
  async getConversation(id) {
    const c = await db.conversations.get(id)
    return c && withConversationDefaults(c)
  },
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
      context: null,
      windowStartOrder: null,
      lastRequest: null,
      tokenRatio: 1,
      ...init,
    }
    await db.conversations.add(c)
    return c
  },
  async updateConversation(id, patch) {
    await db.conversations.update(id, patch)
  },
  async mutateConversation(id, fn) {
    return db.transaction('rw', db.conversations, async () => {
      const c = await db.conversations.get(id)
      if (!c) return false
      await db.conversations.update(id, fn(withConversationDefaults(c)))
      return true
    })
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
  async mutateMessage(id, fn) {
    return db.transaction('rw', db.messages, async () => {
      const m = await db.messages.get(id)
      if (!m) return undefined
      const next = fn(m)
      await db.messages.put(next)
      return next
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
  async listPrompts() {
    const all = await db.prompts.toArray()
    return all.sort((a, b) => a.name.localeCompare(b.name))
  },
  getPrompt: (id) => db.prompts.get(id),
  async savePrompt(p) {
    const row: Prompt = {
      id: p.id ?? newId(),
      name: p.name,
      parentId: p.parentId,
      text: p.text,
      updatedAt: Date.now(),
      versionHash: hashText(p.text),
    }
    await db.prompts.put(row)
    return row
  },
  async deletePrompt(id) {
    return db.transaction('rw', db.prompts, async () => {
      if ((await db.prompts.where('parentId').equals(id).count()) > 0) return 'has-variants'
      await db.prompts.delete(id)
      return 'deleted'
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
