import { newId } from './storage'
import type { ContentPart, Message, ToolPart, Version } from './types'

/** Pure edits on a Message's versions. Apply them through `storage.mutateMessage`. */

/** The result of a call that a stop cut off. */
export const STOPPED = 'Stopped by the user.'

export const versionText = (v: Version | undefined): string =>
  (v?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')

export type Segment = { kind: 'text'; text: string } | { kind: 'tool'; part: ToolPart }

/** A reply in reading order: text and tool steps. Adjacent text parts merge. Media is left out. */
export function segments(content: ContentPart[]): Segment[] {
  const out: Segment[] = []
  for (const p of content) {
    if (p.type === 'tool') out.push({ kind: 'tool', part: p })
    else if (p.type === 'text' && p.text !== '') {
      const last = out[out.length - 1]
      if (last?.kind === 'text') last.text += p.text
      else out.push({ kind: 'text', text: p.text })
    }
  }
  return out
}

export const withNewVersion = (m: Message, v: Version): Message => ({
  ...m,
  versions: [...m.versions, v],
  activeVersion: m.versions.length,
})

export const withActive = (m: Message, index: number): Message => ({
  ...m,
  activeVersion: Math.min(Math.max(0, index), m.versions.length - 1),
})

/** Removes the active version and activates the one before it. Null when it is the only one. */
export function withoutActiveVersion(m: Message): { message: Message; removed: Version; index: number } | null {
  if (m.versions.length < 2) return null
  const index = Math.min(Math.max(0, m.activeVersion), m.versions.length - 1)
  const versions = m.versions.filter((_, i) => i !== index)
  return { message: { ...m, versions, activeVersion: Math.max(0, index - 1) }, removed: m.versions[index], index }
}

/** Puts a removed version back at its place and activates it (undo). */
export function withVersionAt(m: Message, v: Version, index: number): Message {
  if (m.versions.some((x) => x.id === v.id)) return m
  const at = Math.min(Math.max(0, index), m.versions.length)
  const versions = [...m.versions.slice(0, at), v, ...m.versions.slice(at)]
  return { ...m, versions, activeVersion: at }
}

/**
 * For an undo snapshot. A version still marked streaming would block Reroll/Continue forever,
 * and a step left open would run on Continue, though the user stopped it.
 */
export function settledVersion(v: Version): Version {
  if (v.status !== 'streaming') return v
  const content = v.content.map((p) => (p.type === 'tool' && p.status === 'running' ? { ...p, status: 'stopped' as const, result: STOPPED } : p))
  return { ...v, status: 'stopped', content }
}

export function settled(m: Message): Message {
  if (!m.versions.some((v) => v.status === 'streaming')) return m
  return { ...m, versions: m.versions.map(settledVersion) }
}

/** A new version holding edited text. Media and tool parts stay, in order. Text parts become one, after them. */
export function editedVersion(source: Version, text: string, now = Date.now()): Version {
  const kept = source.content.filter((p) => p.type !== 'text')
  return {
    id: newId(),
    content: [...kept, { type: 'text', text }],
    status: 'done',
    model: source.model,
    provider: source.provider,
    promptRef: source.promptRef,
    promptVersionHash: source.promptVersionHash,
    reasoningEffort: source.reasoningEffort,
    createdAt: now,
    editedAt: now,
  }
}
