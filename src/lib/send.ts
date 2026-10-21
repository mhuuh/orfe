import type { ModelInfo } from './catalog'
import { buildOutgoing } from './normalise'
import { streamChat, type OutMessage, type StreamEvent } from './openrouter'
import { db, newId, storage } from './storage'
import type { ContentPart, Conversation, Reasoning, Usage, Version } from './types'

const WRITE_INTERVAL_MS = 200
const controllers = new Map<string, AbortController>()

export type GenerateTarget =
  | { kind: 'new' }
  | { kind: 'reroll'; messageId: string }
  | { kind: 'continue'; messageId: string }

export function errorText(code: number | undefined, message: string): string {
  if (code === 401) return 'Your OpenRouter key was rejected. Check it in Settings.'
  if (code === 402) return 'Out of credits on OpenRouter.'
  if (code === 429) return 'Rate limited. Try again in a moment.'
  return message
}

export function isGenerating(conversationId: string): boolean {
  return controllers.has(conversationId)
}

export function stop(conversationId: string): void {
  controllers.get(conversationId)?.abort()
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

function fallbackModel(id: string): ModelInfo {
  return {
    id,
    name: id,
    created: 0,
    contextLength: 0,
    priceIn: 0,
    priceOut: 0,
    inputModalities: ['text'],
    outputModalities: ['text'],
    efforts: null,
    defaultEffort: null,
    free: false,
  }
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
  await generate(conversationId, { kind: 'new' }, opts.model ?? fallbackModel(c.nextModel))
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
  }
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
  const messages = await storage.listMessages(conversationId)

  // Rule 5: send effort only when one is chosen and the model supports it.
  const effort = conversation.nextEffort !== null && model.efforts !== null ? conversation.nextEffort : undefined
  // Built before the new version exists, so a continue prefills with the old text.
  const outgoing = buildOutgoing(messages, {
    system: null,
    windowStartId: conversation.windowStartMessageId,
    upToId: target.kind === 'reroll' ? target.messageId : undefined,
    inputModalities: model.inputModalities,
    blobUrl: () => undefined,
  })

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

  await run({ conversation, stream: settings.streaming, key: settings.key, messageId, version, outgoing, model, effort, initial, controller })
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
        if (c) await storage.updateConversation(conversation.id, { totals: addUsage(c.totals, delta) })
        break
      }
      case 'error':
        errored = errorText(e.code, e.message)
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
