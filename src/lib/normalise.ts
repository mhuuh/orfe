import { describeStep } from './abilities/registry'
import { ruleFor } from './modelRules'
import type { OutMessage, OutPart, OutToolCall } from './openrouter'
import type { ContentPart, Message, ToolPart } from './types'

export interface RoundOptions {
  modelId: string
  /** False: every step flattens to text. */
  toolsEnabled: boolean
  /** The reasoning_details of each round, by `ToolPart.round`. Pass only for the turn in flight. */
  reasoning?: unknown[][]
}

/** What decides how stored steps go out. */
export interface StepContext {
  modelId: string
  /** False: every step flattens to text. */
  toolsEnabled: boolean
  /** A plain chat sends no steps at all. They stay stored, so turning Plain off brings them back. */
  plain: boolean
}

export interface BuildOptions extends StepContext {
  system: string | null
  windowStartId: string | null
  /** Exclude this message and everything after it (reroll). */
  upToId?: string
  inputModalities: string[]
  blobUrl: (blobId: string) => string | undefined
}

type MediaOptions = Pick<BuildOptions, 'inputModalities' | 'blobUrl'>

type TurnRole = 'user' | 'assistant'
interface Turn {
  role: TurnRole
  parts: OutPart[]
}

function standIn(mime: string, name: string | undefined): string {
  const top = mime.split('/')[0]
  const kind = top === 'image' || top === 'audio' || top === 'video' ? top : 'file'
  return `[${kind} not shown to this model: "${name ?? mime}"]`
}

function mapPart(part: ContentPart, opts: MediaOptions): OutPart | null {
  if (part.type === 'text') {
    return part.text.trim() === '' ? null : { type: 'text', text: part.text }
  }
  if (part.type === 'tool') return { type: 'text', text: describeStep(part).past }
  if (part.mime.startsWith('image/') && opts.inputModalities.includes('image')) {
    const url = opts.blobUrl(part.blobId)
    if (url) return { type: 'image_url', image_url: { url } }
  }
  return { type: 'text', text: standIn(part.mime, part.name) }
}

/** Append parts to a turn; adjacent text parts are joined with a blank line. */
function appendParts(target: OutPart[], parts: OutPart[]): void {
  for (const p of parts) {
    const last = target[target.length - 1]
    if (p.type === 'text' && last && last.type === 'text') {
      target[target.length - 1] = { type: 'text', text: `${last.text}\n\n${p.text}` }
    } else {
      target.push(p)
    }
  }
}

function contentOf(parts: OutPart[]): string | OutPart[] {
  const onlyText = parts.every((p) => p.type === 'text')
  return onlyText ? parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n') : parts
}

function toOut(turn: Turn): OutMessage {
  return { role: turn.role, content: contentOf(turn.parts) }
}

/** The result a model reads for a call. A running step has none yet, and its call must still get an answer. */
const UNFINISHED = 'This call did not finish. Its result is not known. Check before you run it again.'

/** The name pattern strict providers enforce. One bad name would make them refuse every later turn. */
const CALL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** A step that goes out as a real call. Any other step flattens to text. */
function isCall(part: ContentPart, o: RoundOptions): part is ToolPart {
  return part.type === 'tool' && o.toolsEnabled && part.model === o.modelId && CALL_NAME.test(part.name)
}

/** How stored steps render. A plain chat or a model rule can turn real calls off. */
function storedRounds(s: StepContext): RoundOptions {
  const rule = ruleFor(s.modelId)
  return { modelId: s.modelId, toolsEnabled: s.toolsEnabled && !s.plain && !rule.flattenAll && !rule.noTools }
}

function toCall(part: ToolPart): OutToolCall {
  // Providers need a JSON object. Bad arguments from a weak model go out as an empty one.
  const args = typeof part.args === 'object' && part.args !== null && !Array.isArray(part.args) ? part.args : {}
  return { id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(args) } }
}

function render(content: ContentPart[], o: RoundOptions, media: MediaOptions): OutMessage[] {
  const out: OutMessage[] = []
  let parts: OutPart[] = []
  let i = 0
  while (i < content.length) {
    const part = content[i]
    if (!isCall(part, o)) {
      const mapped = mapPart(part, media)
      if (mapped) appendParts(parts, [mapped])
      i++
      continue
    }
    // A new round is a new message even with no text between. Otherwise the next round would
    // rewrite this message, and each request would no longer extend the one before it.
    const calls: ToolPart[] = []
    while (i < content.length) {
      const next = content[i]
      if (!isCall(next, o) || next.round !== part.round) break
      calls.push(next)
      i++
    }
    const details = o.reasoning?.[part.round]
    out.push({
      role: 'assistant',
      content: parts.length > 0 ? contentOf(parts) : null,
      tool_calls: calls.map(toCall),
      ...(details && details.length > 0 ? { reasoning_details: details } : {}),
    })
    for (const c of calls) {
      out.push({ role: 'tool', tool_call_id: c.callId, content: c.status === 'running' ? UNFINISHED : c.result })
    }
    parts = []
  }
  if (parts.length > 0) out.push({ role: 'assistant', content: contentOf(parts) })
  return out
}

/**
 * The characters a stored step adds to a request, for the window count. Follows the same test as
 * `buildOutgoing`: a real call sends its name, arguments and result, any other step sends one flat
 * line, and a plain chat sends nothing.
 */
export function stepCounter(s: StepContext): (part: ToolPart) => number {
  if (s.plain) return () => 0
  const o = storedRounds(s)
  return (part) => {
    if (!isCall(part, o)) return describeStep(part).past.length
    const { name, arguments: args } = toCall(part).function
    return name.length + args.length + part.result.length
  }
}

/**
 * One reply as messages: text before a round goes on that round's `assistant` message, then one
 * `tool` message per call. Text after the last round is a last `assistant` message. Serves stored
 * turns and the turn in flight.
 */
export function renderRounds(content: ContentPart[], o: RoundOptions): OutMessage[] {
  return render(content, o, { inputModalities: [], blobUrl: () => undefined })
}

export function buildOutgoing(messages: Message[], opts: BuildOptions): OutMessage[] {
  // select
  let sorted = [...messages].sort((a, b) => a.order - b.order)
  if (opts.upToId !== undefined) {
    const cut = sorted.findIndex((m) => m.id === opts.upToId)
    if (cut >= 0) sorted = sorted.slice(0, cut)
  }
  let start = opts.windowStartId === null ? -1 : sorted.findIndex((m) => m.id === opts.windowStartId)
  if (start < 0) start = 0
  const selected = sorted.filter((m, i) => i >= start || m.pinned)

  const rule = ruleFor(opts.modelId)
  const stored = storedRounds(opts)

  // drop dividers, map parts, drop empties, merge consecutive same-role
  // A reply with real calls stays apart as a block: a merge would break its call and tool pairs.
  const turns: (Turn | OutMessage[])[] = []
  for (const m of selected) {
    if (m.role === 'divider') continue
    const version = m.versions[m.activeVersion]
    if (!version) continue
    if (m.role === 'assistant' && version.content.some((p) => isCall(p, stored))) {
      const reasoning = rule.keepReasoning ? version.roundReasoning : undefined
      turns.push(render(version.content, { ...stored, reasoning }, opts))
      continue
    }
    const parts: OutPart[] = []
    for (const p of version.content) {
      if (opts.plain && p.type === 'tool') continue
      const mapped = mapPart(p, opts)
      if (mapped) parts.push(mapped)
    }
    if (parts.length === 0) continue
    const last = turns[turns.length - 1]
    if (last && !Array.isArray(last) && last.role === m.role) {
      appendParts(last.parts, parts)
    } else {
      const fresh: OutPart[] = []
      appendParts(fresh, parts)
      turns.push({ role: m.role, parts: fresh })
    }
  }

  // fix start
  const first = turns[0]
  if (first && (Array.isArray(first) || first.role === 'assistant')) {
    turns.unshift({ role: 'user', parts: [{ type: 'text', text: '…' }] })
  }

  const out = turns.flatMap((t) => (Array.isArray(t) ? t : [toOut(t)]))
  if (opts.system && opts.system.trim() !== '') {
    out.unshift({ role: 'system', content: opts.system })
  }
  return out
}
