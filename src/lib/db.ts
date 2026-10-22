import Dexie, { type EntityTable } from 'dexie'
import type { Conversation, Message, Prompt } from './types'

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
  prompts!: EntityTable<Prompt, 'id'>

  constructor() {
    super('orfe')
    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: 'id, conversationId, [conversationId+order]',
      settings: 'k',
      cache: 'k',
    })
    // New fields on old rows get their defaults on read (storage.ts), so no upgrade function.
    this.version(2).stores({ prompts: 'id, parentId' })
    // Another tab opened a newer schema. Dexie's own handler runs first: it closes this connection
    // (so the upgrade is not blocked) and keeps auto-open on, so the next query would reopen the db.
    // Our close() turns auto-open off: this tab runs code for the old schema, so it stops reading and
    // writing (queries fail with DatabaseClosedError) until the reload the toast offers.
    this.on('versionchange', () => {
      this.close()
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('orfe:db-outdated'))
    })
  }
}

export const db = new OrfeDb()
