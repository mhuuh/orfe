export type Role = 'user' | 'assistant' | 'divider'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'media'; blobId: string; mime: string; name?: string }
  | ToolPart

/** A tool step lives inside the reply, in order, so a reply stays one message. */
export interface ToolPart {
  type: 'tool'
  callId: string
  round: number
  /** Who made the call. Continue may switch model in the middle of a reply. */
  model: string
  name: string
  args: unknown
  /** Always stored whole. Stripping happens at render time only. */
  result: string
  status: 'running' | 'done' | 'error' | 'stopped'
  /** A write that was undone. */
  undone?: boolean
}

export type VersionStatus = 'streaming' | 'done' | 'stopped' | 'interrupted' | 'error'

export interface Reasoning {
  text: string
  details: unknown[]
  durationMs: number
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  cost: number
}

export interface Version {
  id: string
  content: ContentPart[]
  status: VersionStatus
  model?: string
  provider?: string
  promptRef?: string | null
  promptVersionHash?: string
  reasoningEffort?: string
  reasoning?: Reasoning | null
  usage?: Usage
  generationId?: string
  finishReason?: string
  error?: string | null
  createdAt: number
  editedAt?: number
  /** The reasoning_details of each tool round, stored unchanged. */
  roundReasoning?: unknown[][]
}

export interface Message {
  id: string
  conversationId: string
  order: number
  role: Role
  versions: Version[]
  activeVersion: number
  pinned: boolean
  dividerLabel?: string
  createdAt: number
}

export interface Prompt {
  id: string
  name: string
  parentId: string | null
  text: string
  updatedAt: number
  versionHash: string
  abilities?: Record<string, boolean>
}

export interface ContextSetting {
  mode: 'tokens' | 'messages'
  limit: number
  trimTo: number
}

export interface LastRequest {
  model: string
  provider: string | null
  /** Hash of the tools JSON. Null: no tools. Rows stored before this field have none. */
  toolsHash: string | null
  prefixHash: string
  prefixCount: number
  at: number
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  sessionId: string
  systemPromptRef: string | null
  capabilityNote: boolean
  windowStartMessageId: string | null
  nextModel: string
  nextEffort: string | null
  totals: Usage
  /** null = use the global setting */
  context: ContextSetting | null
  windowStartOrder: number | null
  lastRequest: LastRequest | null
  tokenRatio: number
  /** null = the defaults. */
  abilities: Record<string, boolean> | null
  /** True: no tools and no vault text in this chat. */
  plain: boolean
  /** Frozen text of the notes index. It changes only at a trim. */
  notesIndex: string | null
  /** Frozen text of the summaries. It changes only at a trim. */
  summaryBlock: string | null
}

export interface Note {
  id: string
  /** 'shared' or a conversation id. */
  shelf: string
  /** Like 'lists/insects'. Unique per shelf, ignoring case. */
  path: string
  aliases: string[]
  /** One line. Required. Shown in the index. */
  description: string
  tags: string[]
  /** Markdown. */
  body: string
  protected: boolean
  bodyHash: string
  version: number
  supersedes: string | null
  updatedAt: number
  deletedAt: number | null
}

export interface NoteRevision {
  id: string
  noteId: string
  version: number
  /** null for a create. */
  before: Note | null
  /** null for a soft delete. */
  after: Note | null
  /** A model id, 'you' or 'tidy'. */
  writer: string
  messageId: string | null
  /** Survives Edit and Continue, which copy ToolParts to a new version. */
  callId: string | null
  /** Set for a tidy run. */
  runId: string | null
  at: number
}

export interface Summary {
  id: string
  conversationId: string
  /** 0 is a chunk, 1 a chapter, 2 and up are stacked. */
  level: number
  fromOrder: number
  toOrder: number
  /** Of the active text in the span. */
  sourceHash: string
  text: string
  model: string
  stale: boolean
  editedByYou: boolean
}

export interface Settings {
  key: string | null
  streaming: boolean
  themeMode: 'system' | 'light' | 'dark'
  defaultModel: string
  context: ContextSetting
  anthropicCacheHour: boolean
  /** When the user last saved a backup file. Null: never. Stays on this phone; a backup file never sets it. */
  lastBackupAt: number | null
  tidying: boolean
  summaryModel: string
  tidyModel: string
  /** Cost of work the user did not ask for in a message: summaries and tidy runs. */
  vaultUsage: Usage
}
