import { newId } from './storage'
import type { Message, Version } from './types'

/** Pure edits on a Message's versions. Apply them through `storage.mutateMessage`. */

export const versionText = (v: Version | undefined): string =>
  (v?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')

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

/** A new version holding edited text. Media parts stay; text parts become one. */
export function editedVersion(source: Version, text: string, now = Date.now()): Version {
  const media = source.content.filter((p) => p.type !== 'text')
  return {
    id: newId(),
    content: [...media, { type: 'text', text }],
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
