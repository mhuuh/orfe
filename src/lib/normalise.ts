import type { OutMessage, OutPart } from './openrouter'
import type { ContentPart, Message } from './types'

export interface BuildOptions {
  system: string | null
  windowStartId: string | null
  /** Exclude this message and everything after it (reroll). */
  upToId?: string
  inputModalities: string[]
  blobUrl: (blobId: string) => string | undefined
}

type Role = 'user' | 'assistant'
interface Turn {
  role: Role
  parts: OutPart[]
}

function standIn(mime: string, name: string | undefined): string {
  const top = mime.split('/')[0]
  const kind = top === 'image' || top === 'audio' || top === 'video' ? top : 'file'
  return `[${kind} not shown to this model: "${name ?? mime}"]`
}

function mapPart(part: ContentPart, opts: BuildOptions): OutPart | null {
  if (part.type === 'text') {
    return part.text.trim() === '' ? null : { type: 'text', text: part.text }
  }
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

function toOut(turn: Turn): OutMessage {
  const onlyText = turn.parts.every((p) => p.type === 'text')
  if (onlyText) {
    return { role: turn.role, content: turn.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n') }
  }
  return { role: turn.role, content: turn.parts }
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

  // drop dividers, map parts, drop empties, merge consecutive same-role
  const turns: Turn[] = []
  for (const m of selected) {
    if (m.role === 'divider') continue
    const version = m.versions[m.activeVersion]
    if (!version) continue
    const parts: OutPart[] = []
    for (const p of version.content) {
      const mapped = mapPart(p, opts)
      if (mapped) parts.push(mapped)
    }
    if (parts.length === 0) continue
    const last = turns[turns.length - 1]
    if (last && last.role === m.role) {
      appendParts(last.parts, parts)
    } else {
      const fresh: OutPart[] = []
      appendParts(fresh, parts)
      turns.push({ role: m.role, parts: fresh })
    }
  }

  // fix start
  if (turns.length > 0 && turns[0].role === 'assistant') {
    turns.unshift({ role: 'user', parts: [{ type: 'text', text: '…' }] })
  }

  const out = turns.map(toOut)
  if (opts.system && opts.system.trim() !== '') {
    out.unshift({ role: 'system', content: opts.system })
  }
  return out
}
