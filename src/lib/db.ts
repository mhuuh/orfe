import Dexie, { type EntityTable } from 'dexie'
import type { Conversation, Message, Note, NoteRevision, Prompt, SearchDoc, Summary } from './types'

export interface KvRow {
  k: string
  value: unknown
  at: number
}

/** Shared with the bench, which runs the term index on a database of its own. */
export const MESSAGES_SCHEMA = 'id, conversationId, [conversationId+order]'
export const CACHE_SCHEMA = 'k'
export const SEARCH_DOCS_SCHEMA = 'messageId, conversationId, *terms'

class OrfeDb extends Dexie {
  conversations!: EntityTable<Conversation, 'id'>
  messages!: EntityTable<Message, 'id'>
  settings!: EntityTable<KvRow, 'k'>
  cache!: EntityTable<KvRow, 'k'>
  prompts!: EntityTable<Prompt, 'id'>
  notes!: EntityTable<Note, 'id'>
  noteRevisions!: EntityTable<NoteRevision, 'id'>
  summaries!: EntityTable<Summary, 'id'>
  searchDocs!: EntityTable<SearchDoc, 'messageId'>

  constructor() {
    super('orfe')
    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: MESSAGES_SCHEMA,
      settings: 'k',
      cache: CACHE_SCHEMA,
    })
    // New fields on old rows get their defaults on read (storage.ts), so no upgrade function.
    this.version(2).stores({ prompts: 'id, parentId' })
    this.version(3).stores({
      notes: 'id, shelf, [shelf+path], deletedAt',
      noteRevisions: 'id, noteId, callId, [noteId+version]',
      summaries: 'id, conversationId, [conversationId+level]',
    })
    // Empty on an old database. The backfill fills it when idle.
    this.version(4).stores({ searchDocs: SEARCH_DOCS_SCHEMA })
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
