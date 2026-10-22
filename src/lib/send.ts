import { fallbackModelInfo, type ModelInfo } from './catalog'
import { estimateTokens, fingerprint, isCold, planWindow, ttlFor } from './context'
import { buildOutgoing } from './normalise'
import { streamChat, type ChatRequest, type OutMessage, type StreamEvent } from './openrouter'
import { db, newId, storage } from './storage'
import { systemFor } from './system'
import type { ContentPart, Conversation, LastRequest, Message, Reasoning, Usage, Version } from './types'
import { settled } from './versions'

const WRITE_INTERVAL_MS = 200
/** Share of the context limit above which a cold cache triggers a trim (spec §6). */
const SOFT_THRESHOLD = 0.85
/**
 * The user's provider preference, as compared by `isCold` and stored in `lastRequest`.
 * Always null until provider pinning (Plan 4). Never the provider that served a reply:
 * that one is recorded on the version only.
 */
const PROVIDER_PREFERENCE: string | null = null
const controllers = new Map<string, AbortController>()
const NO_CONNECTION = "Couldn't reach OpenRouter."

export type GenerateTarget =
  | { kind: 'new' }
  | { kind: 'reroll'; messageId: string }
  | { kind: 'continue'; messageId: string }

export function errorText(code: number | undefined, message: string): string {
  if (code === 401) return 'Your OpenRouter key was rejected. Check it in Settings.'
  if (code === 402) return 'Out of credits on OpenRouter.'
  if (code === 429) return 'Rate limited. Try again in a moment.'
  // Chrome "Failed to fetch" / "network error", Safari "Load failed", Firefox "NetworkError when…".
  if (code === undefined && /failed to fetch|network ?error|load failed/i.test(message)) return NO_CONNECTION
  return message
}

export function isGenerating(conversationId: string): boolean {
  return controllers.has(conversationId)
}

/** Whether a reply is running in any chat. */
export const isAnyGenerating = (): boolean => controllers.size > 0

const endListeners = new Set<() => void>()
/** Calls `fn` each time a generation ends (done, stopped or failed). */
export function onGenerationEnd(fn: () => void): () => void {
  endListeners.add(fn)
  return () => {
    endListeners.delete(fn)
  }
}

export function stop(conversationId: string): void {
  controllers.get(conversationId)?.abort()
}

export interface ChatSnapshot {
  conversation: Conversation
  messages: Message[]
}

/**
 * Stops the chat's stream, then deletes it. Returns what Undo puts back, with any
 * streaming version marked stopped (it would otherwise block Reroll/Continue).
 */
export async function deleteChat(id: string): Promise<ChatSnapshot | null> {
  stop(id)
  const conversation = await storage.getConversation(id)
  if (!conversation) return null
  const messages = (await storage.listMessages(id)).map(settled)
  await storage.deleteConversation(id)
  return { conversation, messages }
}

export async function restoreChat(s: ChatSnapshot): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, async () => {
    await db.conversations.put(s.conversation)
    await db.messages.bulkPut(s.messages)
  })
}

export async function recoverInterrupted(): Promise<number> {
  let count = 0
  for (const c of await storage.listConversations()) {
    for (const m of await storage.listMessages(c.id)) {
      if (!m.versions.some((v) => v.status === 'streaming')) continue
      const versions = m.versions.map((v) => {
        if (v.status !== 'streaming') return v
        count++
        return { ...v, status: 'interrupted' as const }
      })
      await storage.putMessage({ ...m, versions })
    }
  }
  return count
}

/**
 * Appends a user message. When `reply` is set, asks for an assistant turn.
 * The UI passes the resolved `model`; without it a text-only stand-in for
 * `conversation.nextModel` is used.
 */
export async function sendUserMessage(
  conversationId: string,
  text: string,
  opts: { reply: boolean; model?: ModelInfo },
): Promise<void> {
  await storage.appendMessage(conversationId, 'user', {
    id: newId(),
    content: [{ type: 'text', text }],
    status: 'done',
    createdAt: Date.now(),
  })
  if (!opts.reply) return
  const c = await storage.getConversation(conversationId)
  if (!c) return
  await generate(conversationId, { kind: 'new' }, opts.model ?? fallbackModelInfo(c.nextModel))
}

/** Visible thinking text from reasoning_details when the plain text field is empty. */
function textFromDetails(details: unknown[]): string {
  let out = ''
  for (const d of details) {
    if (typeof d !== 'object' || d === null) continue
    const item = d as { type?: string; text?: unknown; summary?: unknown }
    if (item.type === 'reasoning.text' && typeof item.text === 'string') out += item.text
    else if (item.type === 'reasoning.summary' && typeof item.summary === 'string') out += item.summary
  }
  return out
}

const versionHasText = (content: ContentPart[]): boolean => content.some((p) => p.type === 'text' && p.text.trim() !== '')

function addUsage(a: Usage, b: Usage, sign: 1 | -1 = 1): Usage {
  return {
    promptTokens: a.promptTokens + sign * b.promptTokens,
    completionTokens: a.completionTokens + sign * b.completionTokens,
    cachedTokens: a.cachedTokens + sign * b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + sign * b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + sign * b.reasoningTokens,
    cost: a.cost + sign * b.cost,
  }
}

/** Re-reads the message so edits made elsewhere during a stream are not clobbered. */
export async function patchVersion(messageId: string, versionId: string, patch: Partial<Version>): Promise<void> {
  await db.transaction('rw', db.messages, async () => {
    const m = await db.messages.get(messageId)
    if (!m) return
    await db.messages.put({ ...m, versions: m.versions.map((v) => (v.id === versionId ? { ...v, ...patch } : v)) })
  })
}

export async function generate(conversationId: string, target: GenerateTarget, model: ModelInfo): Promise<void> {
  if (controllers.has(conversationId)) return
  // Register before any await so a second call (double tap) sees it and stop() works at once.
  const controller = new AbortController()
  controllers.set(conversationId, controller)
  try {
    await generateInner(conversationId, target, model, controller)
  } finally {
    if (controllers.get(conversationId) === controller) controllers.delete(conversationId)
    for (const fn of endListeners) {
      try {
        fn()
      } catch (e) {
        console.error(e)
      }
    }
  }
}

/** Sorted by order; for a reroll, only the messages before the target (the cut). */
function sendable(messages: Message[], upToId: string | undefined): Message[] {
  const sorted = [...messages].sort((a, b) => a.order - b.order)
  if (upToId === undefined) return sorted
  const cut = sorted.findIndex((m) => m.id === upToId)
  return cut >= 0 ? sorted.slice(0, cut) : sorted
}

function outgoingFor(messages: Message[], system: string | null, windowStartId: string | null, model: ModelInfo): OutMessage[] {
  return buildOutgoing(messages, {
    system,
    windowStartId,
    inputModalities: model.inputModalities,
    blobUrl: () => undefined,
  })
}

/** The messages `buildOutgoing` sends for this start (from the start on, plus pinned ones before it). */
function windowOf(sorted: Message[], startId: string | null): Message[] {
  const start = startId === null ? 0 : Math.max(0, sorted.findIndex((m) => m.id === startId))
  return sorted.filter((m, i) => i >= start || m.pinned)
}

export interface ColdInput {
  lastRequest: LastRequest | null
  /** What the request is built from: already cut for a reroll. */
  messages: Message[]
  system: string | null
  /** The stored window start, before this request's planning. */
  windowStartId: string | null
  model: ModelInfo
  anthropicCacheHour: boolean
  now: number
}

/**
 * Whether the provider's prompt cache is surely gone for the next request. Builds the request as
 * it would go out with the stored window (the "provisional" outgoing) and compares it with
 * `lastRequest`. Pure; `generateInner` uses it to decide a cold trim.
 */
export function computeCold(a: ColdInput): boolean {
  return isCold(a.lastRequest, {
    model: a.model.id,
    provider: PROVIDER_PREFERENCE,
    outgoing: outgoingFor(a.messages, a.system, a.windowStartId, a.model),
    now: a.now,
    ttlMs: ttlFor(a.model.id, a.anthropicCacheHour),
  })
}

async function generateInner(
  conversationId: string,
  target: GenerateTarget,
  model: ModelInfo,
  controller: AbortController,
): Promise<void> {
  const conversation = await storage.getConversation(conversationId)
  if (!conversation) return
  const settings = await storage.getSettings()
  // A reroll plans and sends only what comes before its target, so the window can never
  // point past the cut (buildOutgoing would then fall back to the whole transcript).
  const isReroll = target.kind === 'reroll'
  const messages = sendable(await storage.listMessages(conversationId), isReroll ? target.messageId : undefined)
  const { system, prompt } = await systemFor(conversation)
  const setting = conversation.context ?? settings.context

  // The stored start. For a reroll before it (nothing in the cut is at or after the start),
  // the chat's window does not apply: plan the cut from its beginning instead.
  let storedId = conversation.windowStartMessageId
  let storedOrder = conversation.windowStartOrder
  if (isReroll && (storedId !== null || storedOrder !== null)) {
    const inCut =
      (storedId !== null && messages.some((m) => m.id === storedId)) ||
      (storedOrder !== null && messages.some((m) => m.order >= (storedOrder as number)))
    if (!inCut) {
      storedId = null
      storedOrder = null
    }
  }

  const cold = computeCold({
    lastRequest: conversation.lastRequest,
    messages,
    system,
    windowStartId: storedId,
    model,
    anthropicCacheHour: settings.anthropicCacheHour,
    now: Date.now(),
  })
  const plan = planWindow({
    messages,
    windowStartId: storedId,
    windowStartOrder: storedOrder,
    setting,
    system,
    ratio: conversation.tokenRatio,
    cold,
    soft: SOFT_THRESHOLD,
  })

  // Store the start whenever it moved (a trim, or a deleted start snapped to the next message),
  // so the order fallback keeps working. A reroll's window is a local view of the cut: it never
  // moves the chat's start.
  if (!isReroll && (plan.startId !== conversation.windowStartMessageId || plan.startOrder !== conversation.windowStartOrder)) {
    await db.transaction('rw', db.conversations, async () => {
      const c = await db.conversations.get(conversationId)
      // Skip if the start changed meanwhile: that newer choice wins.
      if (!c || (c.windowStartMessageId ?? null) !== conversation.windowStartMessageId) return
      if ((c.windowStartOrder ?? null) !== conversation.windowStartOrder) return
      await db.conversations.update(conversationId, { windowStartMessageId: plan.startId, windowStartOrder: plan.startOrder })
    })
  }

  // Rule 5: send effort only when one is chosen and the model supports it. For a stand-in
  // (catalog not loaded) we cannot know, so a chosen effort is still sent rather than dropped.
  const effort =
    conversation.nextEffort !== null && (model.efforts !== null || model.unlisted === true) ? conversation.nextEffort : undefined
  // Built before the new version exists, so a continue prefills with the old text.
  const outgoing = outgoingFor(messages, system, plan.startId, model)
  // Ratio 1: tokenRatio is the correction to this raw estimate, not a correction of a correction.
  const estimate = estimateTokens(windowOf(messages, plan.startId), system, 1)
  const cacheControl: ChatRequest['cacheControl'] = model.id.startsWith('anthropic/')
    ? { type: 'ephemeral', ...(settings.anthropicCacheHour ? { ttl: '1h' as const } : {}) }
    : undefined

  let initial: ContentPart[] = []
  if (target.kind === 'continue') {
    const m = messages.find((x) => x.id === target.messageId)
    initial = (m?.versions[m.activeVersion]?.content ?? []).map((p) => ({ ...p }))
  }
  const version: Version = {
    id: newId(),
    content: initial,
    status: 'streaming',
    model: model.id,
    promptRef: prompt?.id ?? null,
    ...(prompt ? { promptVersionHash: prompt.versionHash } : {}),
    reasoningEffort: effort,
    createdAt: Date.now(),
  }

  let messageId: string
  if (target.kind === 'new') {
    messageId = (await storage.appendMessage(conversationId, 'assistant', version)).id
  } else {
    const added = await db.transaction('rw', db.messages, async () => {
      const m = await db.messages.get(target.messageId)
      if (!m) return false
      await db.messages.put({ ...m, versions: [...m.versions, version], activeVersion: m.versions.length })
      return true
    })
    if (!added) return
    messageId = target.messageId
  }

  await run({
    conversation,
    stream: settings.streaming,
    key: settings.key,
    messageId,
    version,
    outgoing,
    model,
    effort,
    cacheControl,
    estimate,
    initial,
    controller,
  })
}

/**
 * Switches the chat's system prompt. When the chat already has messages and the ref changed,
 * a divider marks the switch in the transcript ("→ Name", or "→ No prompt").
 */
export async function setPrompt(conversationId: string, promptRef: string | null): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, db.prompts, async () => {
    const c = await db.conversations.get(conversationId)
    if (!c || (c.systemPromptRef ?? null) === promptRef) return
    await db.conversations.update(conversationId, { systemPromptRef: promptRef })
    const count = await db.messages
      .where('[conversationId+order]')
      .between([conversationId, -Infinity], [conversationId, Infinity])
      .count()
    if (count === 0) return
    const prompt = promptRef === null ? undefined : await db.prompts.get(promptRef)
    const divider = await storage.appendMessage(conversationId, 'divider', {
      id: newId(),
      content: [],
      status: 'done',
      createdAt: Date.now(),
    })
    await db.messages.update(divider.id, { dividerLabel: `→ ${prompt?.name ?? 'No prompt'}` })
  })
}

/**
 * Sets the chat's prompt ref to `to` only while it is still `from`, with no divider.
 * For deleting the prompt a chat uses (and undoing that): the chat's prompt did not
 * change by choice, and an undo should leave the transcript as it was.
 */
export async function replacePromptRef(conversationId: string, from: string | null, to: string | null): Promise<boolean> {
  return db.transaction('rw', db.conversations, async () => {
    const c = await db.conversations.get(conversationId)
    if (!c || (c.systemPromptRef ?? null) !== from) return false
    await db.conversations.update(conversationId, { systemPromptRef: to })
    return true
  })
}

interface RunArgs {
  conversation: Conversation
  stream: boolean
  key: string | null
  messageId: string
  version: Version
  outgoing: OutMessage[]
  model: ModelInfo
  effort: string | undefined
  cacheControl: ChatRequest['cacheControl']
  /** Raw token estimate (ratio 1) of what is sent; usage.promptTokens over this is the new tokenRatio. */
  estimate: number
  initial: ContentPart[]
  controller: AbortController
}

async function run(a: RunArgs): Promise<void> {
  const { conversation, messageId, version, controller } = a
  if (a.key === null) {
    await patchVersion(messageId, version.id, { status: 'error', error: errorText(401, 'No OpenRouter key set.') })
    return
  }

  if (controller.signal.aborted) {
    await patchVersion(messageId, version.id, { status: 'stopped' })
    return
  }

  let content: ContentPart[] = a.initial
  let reasoningText = ''
  const reasoningDetails: unknown[] = []
  let reasoningStart: number | null = null
  let durationMs: number | null = null
  let finished = false
  let finishReason: string | undefined
  let errored: string | null = null
  let aborted = false
  let counted: Usage | null = null
  let accepted = false
  const patch: Partial<Version> = {}
  let lastWrite = Date.now()

  const snapshot = (): Partial<Version> => {
    const p: Partial<Version> = { ...patch, content }
    if (reasoningStart !== null) {
      const reasoning: Reasoning = {
        text: reasoningText,
        details: [...reasoningDetails],
        durationMs: durationMs ?? Date.now() - reasoningStart,
      }
      p.reasoning = reasoning
    }
    return p
  }

  const appendText = (text: string): void => {
    const last = content[content.length - 1]
    if (last && last.type === 'text') content = [...content.slice(0, -1), { type: 'text', text: last.text + text }]
    else content = [...content, { type: 'text', text }]
  }

  /** Returns false when the stream should stop. */
  const handle = async (e: StreamEvent): Promise<boolean> => {
    if (!accepted && (e.type === 'content' || e.type === 'reasoning' || e.type === 'usage' || e.type === 'finish')) {
      // The first output (text, thinking, usage or a finish) means the provider took the request,
      // so its prompt is now what the cache holds. `meta` is not enough: it comes with the HTTP 200,
      // and an in-stream error can still follow before any token. A failed request is not recorded.
      accepted = true
      const lastRequest: LastRequest = {
        model: a.model.id,
        provider: PROVIDER_PREFERENCE,
        ...fingerprint(a.outgoing),
        at: Date.now(),
      }
      await storage.updateConversation(conversation.id, { lastRequest })
    }
    switch (e.type) {
      case 'meta':
        if (e.generationId) patch.generationId = e.generationId
        if (e.provider) patch.provider = e.provider
        break
      case 'reasoning':
        if (reasoningStart === null) reasoningStart = Date.now()
        reasoningText += e.text === '' && e.details ? textFromDetails(e.details) : e.text
        if (e.details) reasoningDetails.push(...e.details)
        break
      case 'content':
        if (reasoningStart !== null && durationMs === null) durationMs = Date.now() - reasoningStart
        appendText(e.text)
        break
      case 'finish':
        // Some providers repeat finish_reason on the usage chunk; keep the first.
        if (!finished) finishReason = e.reason
        finished = true
        break
      case 'usage': {
        // A repeated usage chunk replaces the earlier one instead of double counting.
        const delta = counted ? addUsage(e.usage, counted, -1) : e.usage
        counted = e.usage
        patch.usage = e.usage
        const c = await storage.getConversation(conversation.id)
        if (c) {
          const update: Partial<Conversation> = { totals: addUsage(c.totals, delta) }
          // promptTokens 0 means the provider did not report it: keep the old ratio.
          if (e.usage.promptTokens > 0 && a.estimate > 0) {
            update.tokenRatio = Math.min(2, Math.max(0.5, e.usage.promptTokens / a.estimate))
          }
          await storage.updateConversation(conversation.id, update)
        }
        break
      }
      case 'error':
        // A dropped connection after some text is an interruption: keep the text and offer Continue.
        // Not an error then: the version ends 'interrupted' below, as no finish arrived.
        if (!(e.kind === 'network' && versionHasText(content))) errored = e.kind === 'network' ? NO_CONNECTION : errorText(e.code, e.message)
        return false
    }
    return true
  }

  try {
    const events = streamChat(
      {
        model: a.model.id,
        messages: a.outgoing,
        sessionId: conversation.sessionId,
        stream: a.stream,
        ...(a.effort !== undefined ? { reasoning: { effort: a.effort } } : {}),
        ...(a.cacheControl !== undefined ? { cacheControl: a.cacheControl } : {}),
      },
      a.key,
      controller.signal,
    )
    for await (const e of events) {
      if (!(await handle(e))) break
      if (Date.now() - lastWrite >= WRITE_INTERVAL_MS) {
        lastWrite = Date.now()
        await patchVersion(messageId, version.id, snapshot())
      }
    }
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError') aborted = true
    else errored = e instanceof Error ? e.message : 'Stream failed'
  }

  if (reasoningStart !== null && durationMs === null) durationMs = Date.now() - reasoningStart
  const final = snapshot()
  if (finishReason !== undefined) final.finishReason = finishReason
  if (errored !== null) {
    final.status = 'error'
    final.error = errored
  } else if (aborted || controller.signal.aborted) {
    final.status = 'stopped'
  } else {
    final.status = finished ? 'done' : 'interrupted'
  }
  await patchVersion(messageId, version.id, final)
}
