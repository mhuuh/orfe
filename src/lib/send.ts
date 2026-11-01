import { enabledAbilities, runTool, toolsFor, type Ability } from './abilities/registry'
import { fallbackModelInfo, type ModelInfo } from './catalog'
import { estimateTokens, fingerprint, isCold, planWindow, ttlFor } from './context'
import { buildOutgoing, renderRounds } from './normalise'
import { notes, writeResult } from './notes/store'
import { mergeReasoning, streamChat, type ChatRequest, type OutMessage, type StreamEvent } from './openrouter'
import { db, newId, storage } from './storage'
import { systemFor } from './system'
import type { ContentPart, Conversation, LastRequest, Message, Reasoning, ToolPart, Usage, Version } from './types'
import { settled } from './versions'

/** Tool rounds in one reply. The last one gets ROUND_LIMIT instead of running, so the model answers. */
export const MAX_ROUNDS = 8
const ROUND_LIMIT = 'Round limit reached. Answer now.'
const STOPPED = 'Stopped by the user.'
const REFUSED = 'The provider refused this reply. Try again, or pick another model.'
const UNCHECKED = 'Error: could not check if this call already finished, so it did not run again. Check before you run it again.'
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

/**
 * The stored result of a call that already ran, or null. A Continue asks this for parts left open,
 * so it never runs a write twice, and Stop asks it, so a write that landed does not read as stopped.
 * A fresh call is never looked up: it can't have run yet, and a reused id could only give a wrong skip.
 */
export type AlreadyDone = (callId: string, messageId: string) => Promise<string | null>
const fromRevisions: AlreadyDone = async (callId, messageId) => {
  const rev = await notes.byCall(callId, messageId)
  return rev ? writeResult(rev) : null
}
let alreadyDone = fromRevisions

/** Test seam: swap the lookup. Call with no argument to reset. */
export function setAlreadyDoneForTest(fn: AlreadyDone = fromRevisions): void {
  alreadyDone = fn
}

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
  /** The stamp on the chat's notes in Trash. Undo brings back those notes and no others. */
  notesDeletedAt: number
}

/**
 * Stops the chat's stream, then deletes it and sends its shelf to Trash. Returns what Undo puts
 * back, with any streaming version marked stopped (it would otherwise block Reroll/Continue).
 */
export async function deleteChat(id: string): Promise<ChatSnapshot | null> {
  stop(id)
  return db.transaction('rw', db.conversations, db.messages, db.notes, db.noteRevisions, async () => {
    const conversation = await storage.getConversation(id)
    if (!conversation) return null
    const messages = (await storage.listMessages(id)).map(settled)
    await storage.deleteConversation(id)
    const notesDeletedAt = Date.now()
    await notes.trashShelf(id, notesDeletedAt)
    return { conversation, messages, notesDeletedAt }
  })
}

export async function restoreChat(s: ChatSnapshot): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, db.notes, db.noteRevisions, async () => {
    await db.conversations.put(s.conversation)
    await db.messages.bulkPut(s.messages)
    await notes.restoreShelf(s.conversation.id, s.notesDeletedAt)
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

const isTool = (p: ContentPart): p is ToolPart => p.type === 'tool'

/** Text or a tool step: something worth keeping when a connection drops. */
const hasOutput = (content: ContentPart[]): boolean => content.some((p) => isTool(p) || (p.type === 'text' && p.text.trim() !== ''))

/** The round after the last one here. Rounds number from 0 inside a reply. */
const nextRound = (content: ContentPart[]): number => content.reduce((n, p) => (isTool(p) ? Math.max(n, p.round + 1) : n), 0)

const resultOf = (result: string): Partial<ToolPart> => ({ status: result.startsWith('Error:') ? 'error' : 'done', result })

/**
 * How a call ends at Stop. A write that landed just before Stop keeps its result, or the model
 * repeats it on Continue. A failed lookup gives the model the doubt.
 */
async function endAtStop(callId: string, messageId: string): Promise<Partial<ToolPart>> {
  try {
    const stored = await alreadyDone(callId, messageId)
    return stored === null ? { status: 'stopped', result: STOPPED } : resultOf(stored)
  } catch {
    return resultOf(UNCHECKED)
  }
}

async function stoppedOpen(content: ContentPart[], messageId: string): Promise<ContentPart[]> {
  const out: ContentPart[] = []
  for (const p of content) out.push(isTool(p) && p.status === 'running' ? { ...p, ...(await endAtStop(p.callId, messageId)) } : p)
  return out
}

/** Bad JSON stays as the raw string, so it can be shown and `runTool` can answer it. */
function parseArgs(raw: string): unknown {
  try {
    return raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    return raw
  }
}

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

function outgoingFor(
  messages: Message[],
  system: string | null,
  windowStartId: string | null,
  model: ModelInfo,
  toolsEnabled: boolean,
): OutMessage[] {
  return buildOutgoing(messages, {
    system,
    windowStartId,
    inputModalities: model.inputModalities,
    blobUrl: () => undefined,
    modelId: model.id,
    toolsEnabled,
  })
}

/** The frozen base plus the turn in flight. A turn can't open a request, so it gets the same stand-in as `buildOutgoing`. */
function withTurn(base: OutMessage[], turn: OutMessage[]): OutMessage[] {
  const opens = turn[0]?.role === 'assistant' && base.every((m) => m.role === 'system')
  return opens ? [...base, { role: 'user', content: '…' }, ...turn] : [...base, ...turn]
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
  /** Hash of the tools JSON that goes out. Null: no tools. */
  toolsHash: string | null
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
    toolsHash: a.toolsHash,
    outgoing: outgoingFor(a.messages, a.system, a.windowStartId, a.model, a.toolsHash !== null),
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
  const tools = toolsFor(conversation, prompt, model)
  const overheadChars = tools?.json.length ?? 0

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
    toolsHash: tools?.hash ?? null,
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
    overheadChars,
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
  const outgoing = outgoingFor(messages, system, plan.startId, model, tools !== null)
  // Ratio 1: tokenRatio is the correction to this raw estimate, not a correction of a correction.
  const estimate = estimateTokens(windowOf(messages, plan.startId), system, 1, overheadChars)
  const cacheControl: ChatRequest['cacheControl'] = model.id.startsWith('anthropic/')
    ? { type: 'ephemeral', ...(settings.anthropicCacheHour ? { ttl: '1h' as const } : {}) }
    : undefined

  let initial: ContentPart[] = []
  let roundReasoning: unknown[][] | undefined
  if (target.kind === 'continue') {
    const m = messages.find((x) => x.id === target.messageId)
    const old = m?.versions[m.activeVersion]
    initial = (old?.content ?? []).map((p) => ({ ...p }))
    roundReasoning = old?.roundReasoning
  }
  // A continued reply goes out from its own parts, each round. If the base held it too, each call
  // would go out twice. A text reply keeps its old first request: `outgoing` with the old text as prefill.
  const base = target.kind === 'continue' ? outgoingFor(sendable(messages, target.messageId), system, plan.startId, model, tools !== null) : outgoing
  const prefill = target.kind === 'continue' && !initial.some(isTool) ? outgoing : null
  const version: Version = {
    id: newId(),
    content: initial,
    status: 'streaming',
    model: model.id,
    promptRef: prompt?.id ?? null,
    ...(prompt ? { promptVersionHash: prompt.versionHash } : {}),
    reasoningEffort: effort,
    createdAt: Date.now(),
    ...(roundReasoning ? { roundReasoning } : {}),
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
    base,
    prefill,
    tools,
    // A model without tools has no abilities, so a call it makes up finds nothing to run.
    enabled: tools ? enabledAbilities(conversation, prompt) : [],
    model,
    effort,
    cacheControl,
    estimate,
    initial,
    roundReasoning,
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
  /** History before the reply. Frozen for the whole reply, so each round extends the one before it. */
  base: OutMessage[]
  /** A continue of a text reply: its first request, with the old text at the end. */
  prefill: OutMessage[] | null
  tools: ReturnType<typeof toolsFor>
  enabled: Ability[]
  model: ModelInfo
  effort: string | undefined
  cacheControl: ChatRequest['cacheControl']
  /** Raw token estimate (ratio 1) of what is sent; usage.promptTokens over this is the new tokenRatio. */
  estimate: number
  initial: ContentPart[]
  roundReasoning: unknown[][] | undefined
  controller: AbortController
}

type ToolCall = Extract<StreamEvent, { type: 'tool_calls' }>['calls'][number]

/** How one request ended. */
interface RoundEnd {
  finished: boolean
  reason?: string
  calls: ToolCall[]
  /** This round gave text. */
  replied: boolean
  errored: string | null
  aborted: boolean
}

async function run(a: RunArgs): Promise<void> {
  const { conversation, key, messageId, version, controller } = a
  if (key === null) {
    await patchVersion(messageId, version.id, { status: 'error', error: errorText(401, 'No OpenRouter key set.') })
    return
  }

  if (controller.signal.aborted) {
    await patchVersion(messageId, version.id, { status: 'stopped', content: await stoppedOpen(a.initial, messageId) })
    return
  }

  let content: ContentPart[] = a.initial
  let roundReasoning = a.roundReasoning
  let round = nextRound(content)
  let reasoningText = ''
  let reasoned = false
  // Finished rounds, then this round. Reasoning never merges across rounds: indexes start over in each.
  let pastDetails: unknown[] = []
  let roundDetails: unknown[] = []
  let pastMs = 0
  let reasoningStart: number | null = null
  let durationMs: number | null = null
  let pastUsage: Usage | null = null
  const patch: Partial<Version> = {}
  let lastWrite = Date.now()

  const snapshot = (): Partial<Version> => {
    const p: Partial<Version> = { ...patch, content }
    if (roundReasoning) p.roundReasoning = roundReasoning
    if (reasoned) {
      const roundMs = reasoningStart === null ? 0 : (durationMs ?? Date.now() - reasoningStart)
      const reasoning: Reasoning = { text: reasoningText, details: [...pastDetails, ...roundDetails], durationMs: pastMs + roundMs }
      p.reasoning = reasoning
    }
    return p
  }

  const appendText = (text: string): void => {
    const last = content[content.length - 1]
    if (last && last.type === 'text') content = [...content.slice(0, -1), { type: 'text', text: last.text + text }]
    else content = [...content, { type: 'text', text }]
  }

  /** One request and its stream. `first`: the first request of this run. */
  const streamRound = async (first: boolean): Promise<RoundEnd> => {
    const end: RoundEnd = { finished: false, calls: [], replied: false, errored: null, aborted: false }
    const outgoing =
      first && a.prefill
        ? a.prefill
        : withTurn(a.base, renderRounds(content, { modelId: a.model.id, toolsEnabled: a.tools !== null, reasoning: roundReasoning }))
    let counted: Usage | null = null
    let accepted = false

    /** Returns false when the stream should stop. */
    const handle = async (e: StreamEvent): Promise<boolean> => {
      const took =
        e.type === 'content' ||
        e.type === 'reasoning' ||
        e.type === 'tool_calls' ||
        // A refusal comes as a filter finish with all-zero usage: the provider took nothing.
        (e.type === 'usage' && e.usage.promptTokens > 0) ||
        (e.type === 'finish' && e.reason !== 'content_filter')
      if (!accepted && took) {
        // The first output (text, thinking, calls, usage or a finish) means the provider took the request,
        // so its prompt is now what the cache holds. `meta` is not enough: it comes with the HTTP 200,
        // and an in-stream error can still follow before any token. A failed request is not recorded.
        accepted = true
        const lastRequest: LastRequest = {
          model: a.model.id,
          provider: PROVIDER_PREFERENCE,
          toolsHash: a.tools?.hash ?? null,
          ...fingerprint(outgoing),
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
          reasoned = true
          if (reasoningStart === null) reasoningStart = Date.now()
          reasoningText += e.text === '' && e.details ? textFromDetails(e.details) : e.text
          if (e.details) roundDetails = mergeReasoning(roundDetails, e.details)
          break
        case 'content':
          if (reasoningStart !== null && durationMs === null) durationMs = Date.now() - reasoningStart
          appendText(e.text)
          if (e.text.trim() !== '') end.replied = true
          break
        case 'tool_calls':
          end.calls = e.calls
          break
        case 'finish':
          // Some providers repeat finish_reason on the usage chunk; keep the first.
          if (!end.finished) end.reason = e.reason
          end.finished = true
          break
        case 'usage': {
          // A repeated usage chunk replaces the earlier one instead of double counting.
          const delta = counted ? addUsage(e.usage, counted, -1) : e.usage
          counted = e.usage
          patch.usage = pastUsage ? addUsage(pastUsage, e.usage) : e.usage
          const c = await storage.getConversation(conversation.id)
          if (c) {
            const update: Partial<Conversation> = { totals: addUsage(c.totals, delta) }
            // promptTokens 0 means the provider did not report it: keep the old ratio. Later rounds
            // hold tool text that the estimate leaves out, so only the first request counts.
            if (first && e.usage.promptTokens > 0 && a.estimate > 0) {
              update.tokenRatio = Math.min(2, Math.max(0.5, e.usage.promptTokens / a.estimate))
            }
            await storage.updateConversation(conversation.id, update)
          }
          break
        }
        case 'error':
          // A dropped connection after some output is an interruption: keep it and offer Continue.
          // Not an error then: the version ends 'interrupted' below, as no finish arrived.
          if (!(e.kind === 'network' && hasOutput(content))) end.errored = e.kind === 'network' ? NO_CONNECTION : errorText(e.code, e.message)
          return false
      }
      return true
    }

    try {
      const events = streamChat(
        {
          model: a.model.id,
          messages: outgoing,
          sessionId: conversation.sessionId,
          stream: a.stream,
          ...(a.effort !== undefined ? { reasoning: { effort: a.effort } } : {}),
          ...(a.cacheControl !== undefined ? { cacheControl: a.cacheControl } : {}),
          ...(a.tools ? { tools: a.tools.tools, toolChoice: 'auto' as const } : {}),
        },
        key,
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
      if (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError') end.aborted = true
      else end.errored = e instanceof Error ? e.message : 'Stream failed'
    }
    if (reasoningStart !== null && durationMs === null) durationMs = Date.now() - reasoningStart
    return end
  }

  /**
   * An older version of this reply wrote under this id. A part must not share it: on Continue that
   * write would pass for this call, and this call's write would be lost. If we can't tell, say yes.
   */
  const usedByOldVersion = (id: string): Promise<boolean> =>
    notes.byCall(id, messageId).then(
      (rev) => rev !== undefined,
      () => true,
    )

  /**
   * Turns the model's calls into parts. A weak model can send no id, or repeat one from this reply,
   * an earlier one or an older version of this one, and a request needs each id once.
   */
  const partsFrom = async (calls: ToolCall[]): Promise<ToolPart[]> => {
    const history = a.base.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : []))
    const seen = new Set([...history, ...content.filter(isTool).map((p) => p.callId)])
    const parts: ToolPart[] = []
    for (const c of calls) {
      const callId = c.id && !seen.has(c.id) && !(await usedByOldVersion(c.id)) ? c.id : `call_${newId()}`
      seen.add(callId)
      parts.push({ type: 'tool', callId, round, model: a.model.id, name: c.name, args: parseArgs(c.arguments), result: '', status: 'running' })
    }
    return parts
  }

  /** Files this round's reasoning under its number and starts the next round clean. */
  const closeRound = (): void => {
    if (roundDetails.length > 0) {
      const list = Array.from({ length: round + 1 }, (_, i) => roundReasoning?.[i] ?? [])
      list[round] = roundDetails
      roundReasoning = list
    }
    pastDetails = [...pastDetails, ...roundDetails]
    roundDetails = []
    if (reasoningStart !== null) pastMs += durationMs ?? 0
    reasoningStart = null
    durationMs = null
    pastUsage = patch.usage ?? pastUsage
  }

  /** Saves how a call ended. */
  const closePart = async (callId: string, closed: Partial<ToolPart>): Promise<void> => {
    content = content.map((p) => (isTool(p) && p.callId === callId ? { ...p, ...closed } : p))
    await patchVersion(messageId, version.id, snapshot())
  }

  const runPart = async (part: ToolPart): Promise<void> => {
    const raw = typeof part.args === 'string' ? part.args : JSON.stringify(part.args)
    const ctx = { conversationId: conversation.id, messageId, callId: part.callId, model: part.model, key, signal: controller.signal }
    const result = await runTool(part.name, raw, ctx, a.enabled)
    // A stopped tool can hand back any text, so its text does not count.
    await closePart(part.callId, controller.signal.aborted ? await endAtStop(part.callId, messageId) : resultOf(result))
  }

  /** Runs the parts in order, one at a time. Each result is saved as it comes. */
  const runParts = async (parts: ToolPart[]): Promise<void> => {
    for (const part of parts) {
      if (controller.signal.aborted) return
      await runPart(part)
    }
  }

  /** A Continue first finishes what a lost run left open. Only these parts can have run before. */
  const finishOpen = async (): Promise<void> => {
    for (const part of content.filter(isTool).filter((p) => p.status === 'running')) {
      if (controller.signal.aborted) return
      let stored: string | null
      try {
        stored = await alreadyDone(part.callId, messageId)
      } catch {
        // Running it could write twice, so the model gets the doubt instead.
        await closePart(part.callId, resultOf(UNCHECKED))
        continue
      }
      if (stored !== null) await closePart(part.callId, resultOf(stored))
      else if (!controller.signal.aborted) await runPart(part)
    }
  }

  await finishOpen()

  let end: RoundEnd | null = null
  let first = true
  while (!controller.signal.aborted) {
    end = await streamRound(first)
    first = false
    if (end.errored !== null || end.aborted || !end.finished) break
    if (end.reason === 'content_filter' && !end.replied) {
      end.errored = REFUSED
      break
    }
    // Any other finish with calls left them cut off, as with 'length'. Those must not run.
    if (end.calls.length === 0 || (end.reason !== 'tool_calls' && end.reason !== 'stop')) break

    const parts = await partsFrom(end.calls)
    closeRound()
    if (round >= MAX_ROUNDS - 1) {
      content = [...content, ...parts.map((p) => ({ ...p, status: 'error' as const, result: ROUND_LIMIT }))]
      await patchVersion(messageId, version.id, snapshot())
      // Past the last round the model had its chance to answer.
      if (round >= MAX_ROUNDS) break
    } else {
      content = [...content, ...parts]
      await patchVersion(messageId, version.id, snapshot())
      await runParts(parts)
    }
    round++
  }

  const stopped = end?.aborted === true || controller.signal.aborted
  if (stopped) content = await stoppedOpen(content, messageId)
  const final = snapshot()
  if (end?.reason !== undefined) final.finishReason = end.reason
  if (end && end.errored !== null) {
    final.status = 'error'
    final.error = end.errored
  } else if (stopped) {
    final.status = 'stopped'
  } else {
    final.status = end?.finished ? 'done' : 'interrupted'
  }
  await patchVersion(messageId, version.id, final)
}
