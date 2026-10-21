import { sseData } from './sse'
import type { Usage } from './types'

export const API = 'https://openrouter.ai/api/v1'

export type OutPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type OutMessage = { role: 'system' | 'user' | 'assistant'; content: string | OutPart[] }

export interface ChatRequest {
  model: string
  messages: OutMessage[]
  sessionId: string
  stream: boolean
  reasoning?: { effort: string }
  provider?: unknown
}

export type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string; details?: unknown[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'meta'; generationId?: string; provider?: string }
  | { type: 'finish'; reason: string }
  /** `kind: 'network'`: the connection failed or dropped (no HTTP status), not a reply from OpenRouter. */
  | { type: 'error'; message: string; code?: number; kind?: 'network' }

export interface RawModel {
  id: string
  name: string
  created: number
  context_length: number
  pricing: { prompt: string; completion: string }
  architecture: { input_modalities: string[]; output_modalities: string[] }
  reasoning?: { supported_efforts?: string[]; default_effort?: string }
}

/** Attribution headers for every call. `json` adds Content-Type, for requests with a JSON body only. */
export function headers(key?: string | null, json = false): Record<string, string> {
  const h: Record<string, string> = {
    'HTTP-Referer': 'https://mhuuh.github.io/orfe/',
    'X-OpenRouter-Title': 'ORFE',
    'X-OpenRouter-App-Visibility': 'hidden',
  }
  if (json) h['Content-Type'] = 'application/json'
  if (key) h['Authorization'] = `Bearer ${key}`
  return h
}

// Loose shapes for the parts of the API response we read. Everything is optional
// because providers vary; we never trust the wire format.
interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  cost?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}
interface WireError {
  code?: number | string
  message?: string
}
interface WireChoice {
  delta?: { content?: string | null; reasoning?: string | null; reasoning_details?: unknown[] }
  message?: { content?: string | null; reasoning?: string | null; reasoning_details?: unknown[] }
  finish_reason?: string | null
}
interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage
  error?: WireError
}

function mapUsage(u: WireUsage): Usage {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: u.prompt_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    cost: u.cost ?? 0,
  }
}

function errorEvent(e: WireError, fallback: string): StreamEvent {
  const code = typeof e.code === 'number' ? e.code : typeof e.code === 'string' && /^\d+$/.test(e.code) ? Number(e.code) : undefined
  const ev: StreamEvent = { type: 'error', message: e.message || fallback }
  if (code !== undefined) ev.code = code
  return ev
}

function metaEvent(res: Response): StreamEvent | null {
  const generationId = res.headers.get('X-Generation-Id') ?? undefined
  const provider = res.headers.get('X-Provider-Name') ?? undefined
  if (!generationId && !provider) return null
  const ev: StreamEvent = { type: 'meta' }
  if (generationId) ev.generationId = generationId
  if (provider) ev.provider = provider
  return ev
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError'
}

function reasoningEvent(text: string | null | undefined, details: unknown[] | undefined): StreamEvent | null {
  const hasDetails = Array.isArray(details) && details.length > 0
  if (!text && !hasDetails) return null
  const ev: StreamEvent = { type: 'reasoning', text: text ?? '' }
  if (hasDetails) ev.details = details
  return ev
}

/**
 * Streams (or fetches) a chat completion and yields normalised events.
 * Never throws for HTTP errors, network failures or mid-stream errors: those
 * become a single `error` event. It rethrows only AbortError, so the caller
 * can tell a user cancel from a failure.
 */
export async function* streamChat(req: ChatRequest, key: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: req.stream,
    session_id: req.sessionId,
  }
  if (req.reasoning !== undefined) body.reasoning = req.reasoning
  if (req.provider !== undefined) body.provider = req.provider

  let res: Response
  try {
    res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: headers(key, true),
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (isAbort(e)) throw e
    yield { type: 'error', kind: 'network', message: e instanceof Error ? e.message : 'Network error' }
    return
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const j = (await res.json()) as { error?: WireError }
      if (j.error?.message) message = j.error.message
    } catch {
      // keep the generic message
    }
    yield { type: 'error', code: res.status, message }
    return
  }

  const meta = metaEvent(res)
  if (meta) yield meta

  try {
    if (!req.stream) {
      const j = (await res.json()) as WireChunk & { id?: string }
      if (j.error) {
        yield errorEvent(j.error, 'Request failed')
        return
      }
      const choice = j.choices?.[0]
      const r = reasoningEvent(choice?.message?.reasoning, choice?.message?.reasoning_details)
      if (r) yield r
      if (choice?.message?.content) yield { type: 'content', text: choice.message.content }
      if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason }
      if (j.usage) yield { type: 'usage', usage: mapUsage(j.usage) }
      return
    }

    if (!res.body) {
      yield { type: 'error', message: 'Empty response body' }
      return
    }
    for await (const payload of sseData(res.body)) {
      let chunk: WireChunk
      try {
        chunk = JSON.parse(payload) as WireChunk
      } catch {
        continue // ignore malformed payloads
      }
      if (chunk.error) {
        yield errorEvent(chunk.error, 'Stream error')
        return
      }
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (delta) {
        const r = reasoningEvent(delta.reasoning, delta.reasoning_details)
        if (r) yield r
        if (delta.content) yield { type: 'content', text: delta.content }
      }
      if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason }
      if (chunk.usage) yield { type: 'usage', usage: mapUsage(chunk.usage) }
    }
  } catch (e) {
    if (isAbort(e)) throw e
    // A read that throws is the connection dropping (Android kills it when the app is hidden).
    yield { type: 'error', kind: 'network', message: e instanceof Error ? e.message : 'Stream failed' }
  }
}

export async function fetchModels(): Promise<RawModel[]> {
  const res = await fetch(`${API}/models?output_modalities=all`, { headers: headers() })
  if (!res.ok) throw new Error(`Model list failed: HTTP ${res.status}`)
  const j = (await res.json()) as { data?: RawModel[] }
  return j.data ?? []
}

export async function fetchKeyInfo(key: string): Promise<{ limit: number | null; limitRemaining: number | null; usage: number }> {
  const res = await fetch(`${API}/key`, { headers: headers(key) })
  if (!res.ok) throw new Error(`Key check failed: HTTP ${res.status}`)
  const j = (await res.json()) as { data?: { limit?: number | null; limit_remaining?: number | null; usage?: number } }
  const d = j.data ?? {}
  return { limit: d.limit ?? null, limitRemaining: d.limit_remaining ?? null, usage: d.usage ?? 0 }
}
