import Dexie, { type EntityTable } from 'dexie'
import type { Conversation, Message } from './types'

export interface KvRow {
  k: string
  value: unknown
  at: number
}

class OrfeDb extends Dexie {
  conversations!: EntityTable<Conversation, 'id'>
  messages!: EntityTable<Message, 'id'>
  settings!: EntityTable<KvRow, 'k'>
  cache!: EntityTable<KvRow, 'k'>

  constructor() {
    super('orfe')
    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: 'id, conversationId, [conversationId+order]',
      settings: 'k',
      cache: 'k',
    })
  }
}

export const db = new OrfeDb()
