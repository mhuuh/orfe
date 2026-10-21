export type Role = 'user' | 'assistant' | 'divider'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'media'; blobId: string; mime: string; name?: string }

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
}

export interface Settings {
  key: string | null
  streaming: boolean
  themeMode: 'system' | 'light' | 'dark'
  defaultModel: string
}
