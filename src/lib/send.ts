import { UNCHECKED } from './abilities/outcome'
import { activeAbilities, needsOk, runTool, toolsFor, wantsIndex, type Ability } from './abilities/registry'
import { fallbackModelInfo, type ModelInfo } from './catalog'
import { estimateTokens, fingerprint, isCold, planWindow, ttlFor, windowOf } from './context'
import { buildOutgoing, renderRounds, sendsCall, stepCounter } from './normalise'
import { buildIndex } from './notes/index'
import { notes, writeResult, type UndoReport } from './notes/store'
import { mergeReasoning, streamChat, type ChatRequest, type OutMessage, type StreamEvent } from './openrouter'
import { wholeInWindow } from './retention'
import { searchIndex } from './search/termIndex'
import { db, newId, storage } from './storage'
import { systemFor, systemText } from './system'
import type { ContentPart, Conversation, LastRequest, Message, Reasoning, ToolPart, Usage, Version } from './types'
import { editedVersion, settled, settledVersion, STOPPED, withActive, withNewVersion, withoutActiveVersion, withVersionAt } from './versions'

/**
 * Tool rounds in one run. The last one gets ROUND_LIMIT instead of running, so the model answers.
 * A Continue is a new run, so it gets a fresh count.
 */
export const MAX_ROUNDS = 8
const ROUND_LIMIT = 'Round limit reached. Answer now.'
const OUT_OF_ROUNDS = 'The model used all its steps without an answer.'
const REFUSED = 'The provider refused this reply. Try again, or pick another model.'
/**
 * Closes a Continue's request that would end on an assistant message. Some models refuse such a
 * request, and the others start the answer again. This message is never stored.
 */
const CONTINUE_TURN: OutMessage = {
  role: 'user',
  content: 'Continue exactly where you stopped. Do not repeat what you already wrote. Do not repeat a tool call that already ran.',
}
const WRITE_INTERVAL_MS = 200
/** One backfill slice. Short enough to go unnoticed between taps. */
const BACKFILL_BUDGET_MS = 30
/** Share of the context limit above which a cold cache triggers a trim (spec §6). */
const SOFT_THRESHOLD = 0.85
/**
 * The user's provider preference, as compared by `isCold` and stored in `lastRequest`.
 * Always null until provider pinning (Plan 4). Never the provider that served a reply:
 * that one is recorded on the version only.
 */
const PROVIDER_PREFERENCE: string | null = null
const controllers = new Map<string, AbortController>()
/** The step that waits for an OK, by chat. A chat runs one step at a time. */
const waits = new Map<string, { callId: string; release: () => void }>()
const NO_CONNECTION = "Couldn't reach OpenRouter."

/**
 * The stored result of a call that already ran, or null. A Continue asks this for parts left open,
 * so it never runs a write twice, and Stop asks it, so a write that landed does not read as stopped.
 * A write that an undo took back counts as not done.
 * A fresh call is never looked up: it can't have run yet, and a reused id could only give a wrong skip.
 */
export type AlreadyDone = (callId: string, messageId: string) => Promise<string | null>
const fromRevisions: AlreadyDone = async (callId, messageId) => {
  const rev = await notes.byCall(callId, messageId)
  return rev && (await notes.stands(rev)) ? writeResult(rev) : null
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

/** Passes still to run. Never above 2: a pass that is running, and one whole pass after it. */
let passes = 0
let sliceWaiting = false

/** Asks for the next slice when the page is idle. A reply holds it back: `generate` calls this at its end. */
function nextSlice(): void {
  if (passes === 0 || sliceWaiting || isAnyGenerating()) return
  sliceWaiting = true
  const run = () => void backfillSlice()
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run)
  else setTimeout(run)
}

async function backfillSlice(): Promise<void> {
  try {
    // A reply may have started since this slice was asked for.
    if (!isAnyGenerating() && (await searchIndex.backfill(BACKFILL_BUDGET_MS))) passes--
  } catch (e) {
    console.error('backfill failed', e)
    passes = 0
  }
  sliceWaiting = false
  nextSlice()
}

/** Runs a pass over all messages when idle. It fills in old messages and repairs any gap the index has. */
export function backfillSoon(): void {
  passes = Math.min(passes + 1, 2)
  nextSlice()
}

/**
 * Brings the message's index row in line with what is stored. Called when a message settles, not on
 * each stream write: tokenising a stream every 200 ms would slow the phone. Not awaited, and it never
 * throws: a send must not wait on the index or fail with it.
 */
function syncIndex(messageId: string): void {
  searchIndex.index(messageId).catch((e: unknown) => {
    console.error('index failed', e)
    backfillSoon()
  })
}

/** The visible OK on a step that waits. A tap for any other step does nothing. */
export function okStep(conversationId: string, callId: string): void {
  const wait = waits.get(conversationId)
  if (wait?.callId === callId) wait.release()
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
  const snapshot = await db.transaction('rw', db.conversations, db.messages, db.notes, db.noteRevisions, async () => {
    const conversation = await storage.getConversation(id)
    if (!conversation) return null
    const messages = (await storage.listMessages(id)).map(settled)
    await storage.deleteConversation(id)
    const notesDeletedAt = Date.now()
    await notes.trashShelf(id, notesDeletedAt)
    return { conversation, messages, notesDeletedAt }
  })
  for (const m of snapshot?.messages ?? []) syncIndex(m.id)
  return snapshot
}

export async function restoreChat(s: ChatSnapshot): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, db.notes, db.noteRevisions, async () => {
    await db.conversations.put(s.conversation)
    await db.messages.bulkPut(s.messages)
    await notes.restoreShelf(s.conversation.id, s.notesDeletedAt)
  })
  // A chat can be long, so its rows come back in idle slices.
  backfillSoon()
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
  const m = await storage.appendMessage(conversationId, 'user', {
    id: newId(),
    content: [{ type: 'text', text }],
    status: 'done',
    createdAt: Date.now(),
  })
  syncIndex(m.id)
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

/** Marks one call as undone or not, on each version that holds it. Re-reads the message first. */
export async function setToolUndone(messageId: string, callId: string, undone: boolean): Promise<void> {
  await mapSteps(messageId, (p) => (p.callId === callId ? { ...p, undone, kept: false } : p))
}

/** One transaction over a reply and its notes. */
const withNotes = <T>(fn: () => Promise<T>): Promise<T> => db.transaction('rw', db.messages, db.notes, db.noteRevisions, fn)

const callIds = (versions: Version[]): string[] => versions.flatMap((v) => v.content.filter(isTool).map((p) => p.callId))

/** Changes steps on each version of a reply. A Continue or an Edit copies a step, so one call can show on two versions. */
async function mapSteps(messageId: string, fn: (p: ToolPart) => ToolPart): Promise<void> {
  await storage.mutateMessage(messageId, (m) => ({
    ...m,
    versions: m.versions.map((v) => ({ ...v, content: v.content.map((p) => (isTool(p) ? fn(p) : p)) })),
  }))
}

/**
 * Undoes the chat-shelf writes of these versions and marks their steps. Shared-shelf writes stay.
 * A write on a note that changed later stays too, and its step gets `kept`.
 */
export async function undoReplyWrites(messageId: string, versions: Version[]): Promise<UndoReport> {
  const ids = callIds(versions)
  if (ids.length === 0) return { undone: [], kept: [] }
  return withNotes(async () => {
    const report = await notes.undoCalls(messageId, ids, 'chat')
    await mapSteps(messageId, (p) => {
      if (report.undone.includes(p.callId)) return { ...p, undone: true, kept: false }
      return report.kept.includes(p.callId) ? { ...p, kept: true } : p
    })
    return report
  })
}

/**
 * Takes back an undo. Only calls that the reply still holds come back. A write whose note changed
 * since stays out, and its step stays marked undone.
 */
async function redoReplyWrites(messageId: string, report: UndoReport): Promise<void> {
  await withNotes(async () => {
    const m = await db.messages.get(messageId)
    if (!m) return
    const held = new Set(callIds(m.versions))
    const { redone } = await notes.redoCalls(report.undone.filter((id) => held.has(id)), messageId)
    await mapSteps(messageId, (p) => {
      if (redone.includes(p.callId)) return { ...p, undone: false }
      return report.kept.includes(p.callId) ? { ...p, kept: false } : p
    })
  })
}

/** The version a reroll replaces. A try with no output has no writes: they stay with the version before it. */
const replacedBy = (m: Message): Version | undefined =>
  m.versions.slice(0, m.activeVersion + 1).reverse().find((v) => hasOutput(v.content))

/**
 * The start of a reroll, or of a Continue from a try with no output: that one writes a new reply
 * too. Null when there is nothing to take back.
 */
async function undoReplaced(target: GenerateTarget): Promise<UndoReport | null> {
  if (target.kind === 'new') return null
  const m = await db.messages.get(target.messageId)
  if (!m) return null
  if (target.kind === 'continue' && hasOutput(m.versions[m.activeVersion]?.content ?? [])) return null
  const v = replacedBy(m)
  return v ? undoReplyWrites(target.messageId, [v]) : null
}

/** A try with no output replaced nothing, so the writes it undid come back. No version: it never got that far. */
async function putBackIfEmpty(messageId: string, versionId: string, report: UndoReport): Promise<void> {
  const v = (await db.messages.get(messageId))?.versions.find((x) => x.id === versionId)
  if (!v || !hasOutput(v.content)) await redoReplyWrites(messageId, report)
}

/** Stops the chat's stream and waits for its end, so that no write can land after this. */
function streamEnded(conversationId: string): Promise<void> {
  if (!controllers.has(conversationId)) return Promise.resolve()
  return new Promise((resolve) => {
    const off = onGenerationEnd(() => {
      if (controllers.has(conversationId)) return
      off()
      resolve()
    })
    stop(conversationId)
  })
}

export interface MessageSnapshot {
  message: Message
  report: UndoReport
}

/**
 * Deletes a message and undoes its writes. A hidden version may still stream: that one stops first.
 * Returns what Undo puts back.
 */
export async function deleteMessage(id: string): Promise<MessageSnapshot | null> {
  const m = await db.messages.get(id)
  if (m?.versions.some((v) => v.status === 'streaming')) await streamEnded(m.conversationId)
  const snapshot = await withNotes(async () => {
    const found = await db.messages.get(id)
    if (!found) return null
    const report = await undoReplyWrites(id, found.versions)
    const removed = await storage.deleteMessage(id)
    return removed ? { message: settled(removed), report } : null
  })
  syncIndex(id)
  return snapshot
}

export async function restoreMessage(s: MessageSnapshot): Promise<void> {
  await withNotes(async () => {
    await storage.restoreMessage(s.message)
    await redoReplyWrites(s.message.id, s.report)
  })
  syncIndex(s.message.id)
}

export interface VersionSnapshot {
  messageId: string
  removed: Version
  index: number
  report: UndoReport
}

/**
 * Deletes the active version and undoes its writes. Returns what Undo puts back, or null when it
 * is the only version. A step that another version also holds is not this version's to undo.
 */
export async function deleteVersion(id: string): Promise<VersionSnapshot | null> {
  const snapshot = await withNotes(async () => {
    const m = await db.messages.get(id)
    const cut = m && withoutActiveVersion(m)
    if (!cut) return null
    const held = new Set(callIds(cut.message.versions))
    const own = cut.removed.content.filter((p) => !isTool(p) || !held.has(p.callId))
    const report = await undoReplyWrites(id, [{ ...cut.removed, content: own }])
    // The undo marked steps on this version only, so `cut.message` is still right.
    const removed = (await db.messages.get(id))?.versions[cut.index] ?? cut.removed
    await db.messages.put(cut.message)
    return { messageId: id, removed: settledVersion(removed), index: cut.index, report }
  })
  syncIndex(id)
  return snapshot
}

export async function restoreVersion(s: VersionSnapshot): Promise<void> {
  await withNotes(async () => {
    await storage.mutateMessage(s.messageId, (m) => {
      // A call that another version holds may have changed since. That version has the news.
      const held = new Map(m.versions.flatMap((v) => v.content.filter(isTool)).map((p) => [p.callId, p]))
      const content = s.removed.content.map((p) => {
        const sibling = isTool(p) ? held.get(p.callId) : undefined
        return sibling ? { ...p, undone: sibling.undone, kept: sibling.kept } : p
      })
      return withVersionAt(m, { ...s.removed, content }, s.index)
    })
    await redoReplyWrites(s.messageId, s.report)
  })
  syncIndex(s.messageId)
}

/** Saves edited text as a new active version. */
export async function editMessage(id: string, text: string): Promise<void> {
  await storage.mutateMessage(id, (m) => withNewVersion(m, editedVersion(m.versions[m.activeVersion], text)))
  syncIndex(id)
}

/** Makes another version the active one. */
export async function flipVersion(id: string, index: number): Promise<void> {
  await storage.mutateMessage(id, (m) => withActive(m, index))
  syncIndex(id)
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
    nextSlice()
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
  plain: boolean,
): OutMessage[] {
  return buildOutgoing(messages, {
    system,
    windowStartId,
    inputModalities: model.inputModalities,
    blobUrl: () => undefined,
    modelId: model.id,
    toolsEnabled,
    plain,
  })
}

/** The frozen base plus the turn in flight. A turn can't open a request, so it gets the same stand-in as `buildOutgoing`. */
function withTurn(base: OutMessage[], turn: OutMessage[]): OutMessage[] {
  const opens = turn[0]?.role === 'assistant' && base.every((m) => m.role === 'system')
  return opens ? [...base, { role: 'user', content: '…' }, ...turn] : [...base, ...turn]
}

/** The request with `CONTINUE_TURN` after it, if it would end on an assistant message. */
const withContinue = (out: OutMessage[]): OutMessage[] => (out.at(-1)?.role === 'assistant' ? [...out, CONTINUE_TURN] : out)

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
  plain: boolean
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
    outgoing: outgoingFor(a.messages, a.system, a.windowStartId, a.model, a.toolsHash !== null, a.plain),
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
  // First of all, so the new reply can't read the old writes and the index can't list them.
  const undid = await undoReplaced(target)
  const versionId = newId()
  try {
    await startReply(conversation, target, model, controller, versionId, (undid?.undone.length ?? 0) > 0)
  } finally {
    if (undid && target.kind !== 'new') await putBackIfEmpty(target.messageId, versionId, undid)
  }
}

/** Plans the request, adds the version and runs it. `staleIndex`: an undo just changed the notes. */
async function startReply(
  conversation: Conversation,
  target: GenerateTarget,
  model: ModelInfo,
  controller: AbortController,
  versionId: string,
  staleIndex: boolean,
): Promise<void> {
  const conversationId = conversation.id
  const settings = await storage.getSettings()
  // A reroll plans and sends only what comes before its target, so the window can never
  // point past the cut (buildOutgoing would then fall back to the whole transcript).
  const isReroll = target.kind === 'reroll'
  const messages = sendable(await storage.listMessages(conversationId), isReroll ? target.messageId : undefined)
  const frozen = await systemFor(conversation, model)
  const { prompt } = frozen
  let system = frozen.system
  const setting = conversation.context ?? settings.context
  const tools = toolsFor(conversation, prompt, model)
  const overheadChars = tools?.json.length ?? 0
  const stepChars = stepCounter({ modelId: model.id, toolsEnabled: tools !== null, plain: conversation.plain }, messages)
  // With no abilities, a call that a model makes up finds nothing to run.
  const enabled = activeAbilities(conversation, prompt, model)

  /** The index moves only here: at a cold moment, a trim or an undo, where the prefix is broken anyway. */
  let indexFresh = false
  const refreshIndex = async (): Promise<void> => {
    const notesIndex = buildIndex(await notes.list('shared'), await notes.list(conversationId))
    await storage.updateConversation(conversationId, { notesIndex })
    system = systemText(conversation, prompt, model, notesIndex)
    indexFresh = true
  }

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
    plain: conversation.plain,
    anthropicCacheHour: settings.anthropicCacheHour,
    now: Date.now(),
  })
  if (wantsIndex(enabled) && (cold || staleIndex || conversation.notesIndex === null)) await refreshIndex()
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
    stepChars,
  })
  // A warm send can still trim. The plan used the old index: a larger new one shows at the next send.
  if (wantsIndex(enabled) && plan.trimmed && !indexFresh) await refreshIndex()

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
  // Built before the new version exists, so a Continue sends the old text.
  const outgoing = outgoingFor(messages, system, plan.startId, model, tools !== null, conversation.plain)
  // Ratio 1: tokenRatio is the correction to this raw estimate, not a correction of a correction.
  const estimate = estimateTokens(windowOf(messages, plan.startId), system, 1, overheadChars, stepChars)
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
  // A continued reply goes out from its own parts. If the base held it too, each call would go out
  // twice. A text reply goes out as `outgoing`, because there it joins a reply before it.
  const continues = target.kind === 'continue'
  const history = continues ? sendable(messages, target.messageId) : messages
  const base = continues ? outgoingFor(history, system, plan.startId, model, tools !== null, conversation.plain) : outgoing
  const textReply = continues && !initial.some(isTool) ? outgoing : null
  const version: Version = {
    id: versionId,
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

  try {
    await run({
      conversation,
      stream: settings.streaming,
      key: settings.key,
      messageId,
      version,
      history,
      startId: plan.startId,
      base,
      continues,
      textReply,
      tools,
      enabled,
      model,
      effort,
      cacheControl,
      estimate,
      initial,
      roundReasoning,
      controller,
    })
  } finally {
    syncIndex(messageId)
  }
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

/**
 * Sets one ability switch for this chat. The first change copies what the chat follows now, so its
 * other switches keep their values. From then on the chat has its own set.
 */
export async function setAbility(conversationId: string, id: string, on: boolean): Promise<void> {
  await db.transaction('rw', db.conversations, db.prompts, async () => {
    const ref = (await storage.getConversation(conversationId))?.systemPromptRef
    const prompt = ref ? await db.prompts.get(ref) : undefined
    await storage.mutateConversation(conversationId, (c) => ({ abilities: { ...(c.abilities ?? prompt?.abilities), [id]: on } }))
  })
}

/** Plain on or off. The ability switches keep their values, so off brings them back. */
export async function setPlain(conversationId: string, on: boolean): Promise<void> {
  await storage.mutateConversation(conversationId, () => ({ plain: on }))
}

interface RunArgs {
  conversation: Conversation
  stream: boolean
  key: string | null
  messageId: string
  version: Version
  /** The stored messages that `base` is built from. */
  history: Message[]
  /** Where the sent window starts. */
  startId: string | null
  /** History before the reply. Frozen for the whole reply, so each round extends the one before it. */
  base: OutMessage[]
  continues: boolean
  /** A Continue of a text reply: the history with the old text at the end. */
  textReply: OutMessage[] | null
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
  const firstRound = round
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

  const rendered = (parts: ContentPart[]): OutMessage[] =>
    renderRounds(parts, { modelId: a.model.id, toolsEnabled: a.tools !== null, reasoning: roundReasoning })

  /** What this run added to a Continue. New text joins the old last text in `content`, so only its tail counts. */
  const added = (): ContentPart[] => {
    const at = a.initial.length - 1
    const [was, is] = [a.initial[at], content[at]]
    const tail = was?.type === 'text' && is?.type === 'text' ? is.text.slice(was.text.length) : ''
    return [...(tail === '' ? [] : [{ type: 'text' as const, text: tail }]), ...content.slice(a.initial.length)]
  }

  const sent = sendsCall({ modelId: a.model.id, toolsEnabled: a.tools !== null, plain: conversation.plain })

  /** Asks about what the next request holds: the frozen history, then this reply, last and never stripped. */
  const wholeCopy = (path: string, noteVersion: number, page: number): boolean => {
    const turn: Message = {
      id: messageId,
      conversationId: conversation.id,
      order: Infinity,
      role: 'assistant',
      versions: [{ ...version, content }],
      activeVersion: 0,
      pinned: false,
      createdAt: version.createdAt,
    }
    return wholeInWindow([...a.history, turn], a.startId, path, noteVersion, page, sent)
  }

  /** A Continue's old reply and the line. Set at its first request, so each round extends the one before it. */
  let resumed: OutMessage[] | null = null

  /** The request for this round. It runs after open calls closed, so their results go out. */
  const nextRequest = (): OutMessage[] => {
    if (!a.continues) return withTurn(a.base, rendered(content))
    resumed ??= withContinue(a.textReply ?? withTurn(a.base, rendered(content)))
    return withContinue(withTurn(resumed, rendered(added())))
  }

  /** One request and its stream. `first`: the first request of this run. */
  const streamRound = async (first: boolean): Promise<RoundEnd> => {
    const end: RoundEnd = { finished: false, calls: [], replied: false, errored: null, aborted: false }
    const outgoing = nextRequest()
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
        // The line is not stored, and new text joins the text before it, so after a Continue with
        // the line the next send repeats only the history before the reply.
        accepted = true
        const lastRequest: LastRequest = {
          model: a.model.id,
          provider: PROVIDER_PREFERENCE,
          toolsHash: a.tools?.hash ?? null,
          ...fingerprint(outgoing.includes(CONTINUE_TURN) ? a.base : outgoing),
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
   * an earlier one or any version of this one, and a request needs each id once. An id stays
   * unique across versions, or a Continue of an old open part would find the newer write.
   */
  const partsFrom = async (calls: ToolCall[]): Promise<ToolPart[]> => {
    const history = a.base.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : []))
    const versions = (await db.messages.get(messageId))?.versions ?? []
    const siblings = versions.flatMap((v) => v.content.filter(isTool).map((p) => p.callId))
    const seen = new Set([...history, ...siblings, ...content.filter(isTool).map((p) => p.callId)])
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

  /**
   * Holds the run until the OK or Stop. There is no timer: a lock freezes the page with the wait
   * still open, and a lost run ends `interrupted`, where Continue comes back here and asks again.
   */
  const waitForOk = async (callId: string): Promise<void> => {
    patch.waitingFor = callId
    await patchVersion(messageId, version.id, snapshot())
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) return resolve()
      const release = () => {
        waits.delete(conversation.id)
        controller.signal.removeEventListener('abort', release)
        resolve()
      }
      waits.set(conversation.id, { callId, release })
      controller.signal.addEventListener('abort', release)
    })
    patch.waitingFor = undefined
    await patchVersion(messageId, version.id, snapshot())
  }

  const runPart = async (part: ToolPart): Promise<void> => {
    if (needsOk(part.name, a.enabled, content.filter(isTool))) {
      await waitForOk(part.callId)
      // Stop: the end of the run closes this part with the other open ones.
      if (controller.signal.aborted) return
    }
    const raw = typeof part.args === 'string' ? part.args : JSON.stringify(part.args)
    const ctx = { conversationId: conversation.id, messageId, callId: part.callId, model: part.model, key, signal: controller.signal, wholeCopy }
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
      if (stored !== null) {
        await closePart(part.callId, resultOf(stored))
      } else if (!controller.signal.aborted) {
        // An undone write runs again, so it stands once more on each copy of the step.
        if (part.undone) {
          await setToolUndone(messageId, part.callId, false)
          await closePart(part.callId, { undone: false })
        }
        await runPart(part)
      }
    }
  }

  await finishOpen()

  let end: RoundEnd | null = null
  let first = true
  let outOfRounds = false
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
    const used = round - firstRound
    if (used >= MAX_ROUNDS - 1) {
      content = [...content, ...parts.map((p) => ({ ...p, status: 'error' as const, result: ROUND_LIMIT }))]
      await patchVersion(messageId, version.id, snapshot())
      // Past the last round the model had its chance to answer.
      if (used >= MAX_ROUNDS) {
        outOfRounds = !end.replied
        break
      }
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
  } else if (outOfRounds) {
    final.status = 'interrupted'
    final.error = OUT_OF_ROUNDS
  } else {
    final.status = end?.finished ? 'done' : 'interrupted'
  }
  await patchVersion(messageId, version.id, final)
}
