import { safeCut } from './notes/rules'
import { sseData } from './sse'
import type { ToolDef } from './abilities/registry'
import type { Usage } from './types'

export const API = 'https://openrouter.ai/api/v1'
/** Longest error text the app shows. */
const ERROR_CHARS = 300

export type OutPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export interface OutToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
export type OutMessage =
  | { role: 'system' | 'user'; content: string | OutPart[] }
  | { role: 'assistant'; content: string | OutPart[] | null; tool_calls?: OutToolCall[]; reasoning_details?: unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ChatRequest {
  model: string
  messages: OutMessage[]
  sessionId: string
  stream: boolean
  reasoning?: { effort: string }
  provider?: unknown
  /** Top-level prompt caching (Anthropic models). Sent as `cache_control`. */
  cacheControl?: { type: 'ephemeral'; ttl?: '1h' }
  /** Sent as `{ type: 'function', function }`, in this order, so the bytes never change. */
  tools?: ToolDef[]
  /** Sent only together with `tools`. */
  toolChoice?: 'auto'
}

export type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string; details?: unknown[] }
  /** The finished calls of one reply, once, just before `finish`. `arguments` is the raw string: the caller parses it. */
  | { type: 'tool_calls'; calls: { id: string; name: string; arguments: string }[] }
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
  supported_parameters?: string[]
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
  metadata?: { raw?: unknown; provider_name?: unknown } | null
}
interface WireToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}
interface WireChoice {
  delta?: { content?: string | null; reasoning?: string | null; reasoning_details?: unknown[]; tool_calls?: WireToolCall[] }
  message?: { content?: string | null; reasoning?: string | null; reasoning_details?: unknown[]; tool_calls?: WireToolCall[] }
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

/**
 * The text inside a provider's raw error, or undefined when it holds none. It is JSON in many
 * shapes, or plain text. Each place is tried in turn, so a place with no text can't hide a good one.
 */
function innerMessage(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    try {
      return innerMessage(JSON.parse(raw))
    } catch {
      return raw.trim() === '' ? undefined : raw
    }
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { error, message, detail } = raw as Record<string, unknown>
  for (const place of Array.isArray(raw) ? raw : [error, message, detail]) {
    const text = innerMessage(place)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * What an error says. `message` is often only "Provider returned error", and the real reason is in
 * `metadata`. The result is one line, and the app shows it as text, never as HTML.
 */
function errorMessage(e: WireError): string | undefined {
  // The wire can send any type here, and the app stores this text and shows it as a React child.
  const message = typeof e.message === 'string' ? e.message : undefined
  const inner = innerMessage(e.metadata?.raw)?.trim()
  const name = e.metadata?.provider_name
  const provider = typeof name === 'string' && name !== '' ? `${name}: ` : ''
  if (!inner && !provider) return message
  const text = inner || message
  if (!text) return undefined
  const line = `${provider}${text}`.replace(/\s+/g, ' ')
  return line.length > ERROR_CHARS ? `${safeCut(line, ERROR_CHARS)}…` : line
}

function errorEvent(e: WireError, fallback: string): StreamEvent {
  const code = typeof e.code === 'number' ? e.code : typeof e.code === 'string' && /^\d+$/.test(e.code) ? Number(e.code) : undefined
  const ev: StreamEvent = { type: 'error', message: errorMessage(e) || fallback }
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

const JOINED = ['text', 'summary', 'signature'] as const

/**
 * Joins `reasoning_details` deltas by `index`: the text, summary and signature strings
 * are added together. It never joins across indexes (that gives "Invalid signature").
 * A delta with no index is its own entry. It returns a new list and changes neither input.
 */
export function mergeReasoning(list: unknown[], d: unknown[]): unknown[] {
  const out = list.map((x) => (x && typeof x === 'object' ? { ...(x as Record<string, unknown>) } : x))
  for (const item of d) {
    if (!item || typeof item !== 'object') {
      out.push(item)
      continue
    }
    const delta = item as Record<string, unknown>
    const at = typeof delta.index === 'number' ? out.findIndex((x) => x && typeof x === 'object' && (x as Record<string, unknown>).index === delta.index) : -1
    if (at < 0) {
      out.push({ ...delta })
      continue
    }
    const into = out[at] as Record<string, unknown>
    for (const [k, v] of Object.entries(delta)) {
      const old = into[k]
      if ((JOINED as readonly string[]).includes(k) && typeof v === 'string' && typeof old === 'string') into[k] = old + v
      else if (old === undefined) into[k] = v
    }
  }
  return out
}

/**
 * Where a piece with no `index` goes. Weak models send odd shapes: an id we know goes to its entry,
 * a new id starts one, and with no id it goes by its place in the chunk or to the newest entry.
 */
function slotFor(p: WireToolCall, i: number, count: number, into: Map<number, { id: string }>): number {
  const keys = [...into.keys()]
  const next = keys.length ? Math.max(...keys) + 1 : 0
  if (p.id) return keys.find((k) => into.get(k)?.id === p.id) ?? next
  return count > 1 || next === 0 ? i : next - 1
}

/** Collects streamed tool call pieces by `index`. An id and a name come once; `arguments` come in pieces. */
function toolCallsFrom(pieces: WireToolCall[], into: Map<number, { id: string; name: string; arguments: string }>): void {
  pieces.forEach((p, i) => {
    const at = typeof p.index === 'number' ? p.index : slotFor(p, i, pieces.length, into)
    const c = into.get(at) ?? { id: '', name: '', arguments: '' }
    if (p.id) c.id = p.id
    if (p.function?.name && c.name === '') c.name = p.function.name
    if (p.function?.arguments) c.arguments += p.function.arguments
    into.set(at, c)
  })
}

function callsEvent(m: Map<number, { id: string; name: string; arguments: string }>): StreamEvent | null {
  if (m.size === 0) return null
  return { type: 'tool_calls', calls: [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c) }
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
  if (req.cacheControl !== undefined) body.cache_control = req.cacheControl
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    body.tool_choice = req.toolChoice ?? 'auto'
  }

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
      if (j.error) message = errorMessage(j.error) || message
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
      const calls = new Map<number, { id: string; name: string; arguments: string }>()
      toolCallsFrom(choice?.message?.tool_calls ?? [], calls)
      const ce = callsEvent(calls)
      if (ce) yield ce
      if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason }
      if (j.usage) yield { type: 'usage', usage: mapUsage(j.usage) }
      return
    }

    if (!res.body) {
      yield { type: 'error', message: 'Empty response body' }
      return
    }
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    let callsSent = false
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
        if (Array.isArray(delta.tool_calls)) toolCallsFrom(delta.tool_calls, calls)
      }
      if (choice?.finish_reason) {
        const ce = callsSent ? null : callsEvent(calls)
        if (ce) {
          callsSent = true
          yield ce
        }
        yield { type: 'finish', reason: choice.finish_reason }
      }
      if (chunk.usage) yield { type: 'usage', usage: mapUsage(chunk.usage) }
    }
    // A stream with no finish chunk hands over no calls: they may be cut off, so they must not run.
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
