import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '../lib/catalog'
import { generate } from '../lib/send'
import { storage } from '../lib/storage'
import type { Conversation, Message } from '../lib/types'
import { editedVersion, versionText, withActive, withNewVersion, withoutActiveVersion, withVersionAt } from '../lib/versions'
import { useToast } from './Toast'
import { findModel } from './useCatalog'
import css from './MessageActions.module.css'

export interface MessageOps {
  edit(id: string): void
  cancelEdit(): void
  saveEdit(id: string, text: string): void
  reroll(id: string): void
  cont(id: string): void
  copy(m: Message): void
  remove(id: string): void
  removeVersion(id: string): void
  setActive(id: string, index: number): void
}

/**
 * Every write goes through `storage.mutateMessage`, which re-reads the message
 * inside a transaction, so a stale live-query copy is never written back.
 */
export function useMessageOps(
  conversation: Conversation | undefined,
  models: ModelInfo[],
  setEditing: (id: string | null) => void,
  deselect: () => void,
): MessageOps {
  const toast = useToast()
  const latest = useRef({ conversation, models })
  latest.current = { conversation, models }

  const run = useCallback((kind: 'reroll' | 'continue', messageId: string) => {
    const c = latest.current.conversation
    if (!c) return
    deselect()
    void generate(c.id, { kind, messageId }, findModel(latest.current.models, c.nextModel))
  }, [deselect])

  return useMemo<MessageOps>(
    () => ({
      edit(id) {
        setEditing(id)
      },
      cancelEdit() {
        setEditing(null)
        deselect()
      },
      saveEdit(id, text) {
        setEditing(null)
        deselect()
        void storage.mutateMessage(id, (m) => withNewVersion(m, editedVersion(m.versions[m.activeVersion], text)))
      },
      reroll: (id) => run('reroll', id),
      cont: (id) => run('continue', id),
      copy(m) {
        deselect()
        navigator.clipboard.writeText(versionText(m.versions[m.activeVersion])).then(
          () => toast.show('Copied', undefined, 2000),
          () => toast.show("Couldn't copy"),
        )
      },
      remove(id) {
        deselect()
        void storage.deleteMessage(id).then((removed) => {
          if (removed) toast.show('Message deleted', { label: 'Undo', run: () => void storage.restoreMessage(removed) })
        })
      },
      removeVersion(id) {
        deselect()
        const undo: { r: ReturnType<typeof withoutActiveVersion> } = { r: null }
        void storage
          .mutateMessage(id, (m) => {
            undo.r = withoutActiveVersion(m)
            return undo.r ? undo.r.message : m
          })
          .then(() => {
            const u = undo.r
            if (!u) return
            toast.show('Version deleted', {
              label: 'Undo',
              run: () => void storage.mutateMessage(id, (m) => withVersionAt(m, u.removed, u.index)),
            })
          })
      },
      setActive(id, index) {
        void storage.mutateMessage(id, (m) => withActive(m, index))
      },
    }),
    [run, setEditing, deselect, toast],
  )
}

interface ActionsProps {
  message: Message
  isLast: boolean
  /** A reply is streaming somewhere in this conversation. */
  busy: boolean
  ops: MessageOps
}

export function MessageActions({ message, isLast, busy, ops }: ActionsProps) {
  const assistant = message.role === 'assistant'
  const streamingHere = message.versions[message.activeVersion]?.status === 'streaming'
  const items: { label: string; run: () => void; disabled?: boolean }[] = []
  if (!streamingHere) items.push({ label: 'Edit', run: () => ops.edit(message.id) })
  if (assistant) items.push({ label: 'Reroll', run: () => ops.reroll(message.id), disabled: busy })
  if (assistant && isLast) items.push({ label: 'Continue', run: () => ops.cont(message.id), disabled: busy })
  items.push({ label: 'Copy', run: () => ops.copy(message) })
  if (!streamingHere) {
    items.push({ label: 'Delete', run: () => ops.remove(message.id) })
    if (message.versions.length > 1) items.push({ label: 'Delete this version', run: () => ops.removeVersion(message.id) })
  }
  return (
    <div className={`${css.row} ${assistant ? '' : css.end}`} role="toolbar" aria-label="Message actions">
      {items.map((it) => (
        <button key={it.label} className={css.action} onClick={it.run} disabled={it.disabled}>
          {it.label}
        </button>
      ))}
    </div>
  )
}

interface EditProps {
  initial: string
  prose?: boolean
  onSave(text: string): void
  onCancel(): void
}

/** The message text as a textarea in place. Ctrl/Cmd+Enter saves, Escape cancels. */
export function EditBox({ initial, prose, onSave, onCancel }: EditProps) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const changed = text !== initial && text.trim() !== ''
  const save = () => (changed ? onSave(text) : onCancel())

  return (
    <div className={css.edit}>
      <textarea
        ref={ref}
        className={`${css.field} ${prose ? css.prose : ''}`}
        value={text}
        rows={1}
        aria-label="Edit message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
        }}
      />
      <div className={css.editBar}>
        <button className={css.action} onClick={onCancel}>
          Cancel
        </button>
        <button className={css.save} onClick={save} disabled={!changed}>
          Save
        </button>
      </div>
    </div>
  )
}
