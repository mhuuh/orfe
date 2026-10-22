import { useMemo, type KeyboardEvent, type MouseEvent } from 'react'
import { renderMarkdown } from '../lib/markdown'
import type { Message, Version } from '../lib/types'
import { versionText } from '../lib/versions'
import { EditBox, MessageActions, type MessageOps } from './MessageActions'
import { MetaLine, type PromptIndex } from './MetaLine'
import { Thinking } from './Thinking'
import { Versions } from './Versions'
import css from './AssistantMessage.module.css'

const CARET = '<span class="caret" aria-hidden="true"></span>'

/** Puts the caret inside the last element, so it trails the last word and not a new line. */
export function withCaret(html: string): string {
  let end = html.length
  for (;;) {
    while (end > 0 && /\s/.test(html[end - 1])) end--
    if (html[end - 1] !== '>') break
    const open = html.lastIndexOf('<', end - 1)
    if (open < 0 || html[open + 1] !== '/') break
    end = open
  }
  return html.slice(0, end) + CARET + html.slice(end)
}

/** Tapping a message toggles its actions, unless the tap hit a control or ended a text selection. */
export function tapHandlers(onToggle: () => void) {
  return {
    onClick(e: MouseEvent<HTMLElement>) {
      if ((e.target as HTMLElement).closest('a, button, textarea, input, summary')) return
      if (window.getSelection()?.toString()) return
      onToggle()
    },
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onToggle()
      }
    },
  }
}

interface NoteProps {
  version: Version
  isLast: boolean
  busy: boolean
  onRetry(): void
  onContinue(): void
}

/** One mono line for stopped / interrupted / error / cut-off replies, with the fitting actions. */
function StatusNote({ version, isLast, busy, onRetry, onContinue }: NoteProps) {
  let text: string
  let retry = true
  let more = isLast
  switch (version.status) {
    case 'stopped':
      text = 'Stopped'
      break
    case 'interrupted':
      text = 'Interrupted'
      break
    case 'error':
      text = version.error || 'Something went wrong'
      more = false
      break
    default:
      if (version.finishReason !== 'length') return null
      text = 'Hit the length limit'
      retry = false
  }
  return (
    <div className={css.note} role={version.status === 'error' ? 'alert' : undefined}>
      <span className={css.noteText}>{text}</span>
      {more && (
        <button className={css.noteAction} onClick={onContinue} disabled={busy}>
          Continue
        </button>
      )}
      {retry && (
        <button className={css.noteAction} onClick={onRetry} disabled={busy}>
          Retry
        </button>
      )}
    </div>
  )
}

interface Props {
  message: Message
  isLast: boolean
  busy: boolean
  selected: boolean
  editing: boolean
  afterDivider: boolean
  /** For the meta line's "prompt: …" detail. */
  prompts?: PromptIndex
  ops: MessageOps
  onToggle(): void
  /** Before the context window start and not pinned: not sent, shown in mute. */
  outside?: boolean
}

export function AssistantMessage({ message, isLast, busy, selected, editing, afterDivider, prompts, ops, onToggle, outside }: Props) {
  const version = message.versions[message.activeVersion] ?? message.versions[0]
  const text = versionText(version)
  const streaming = version.status === 'streaming'
  // While the model is only thinking, the open Thinking block shows activity instead of a caret.
  const caret = streaming && !(text === '' && version.reasoning)
  const html = useMemo(() => {
    const out = text ? renderMarkdown(text) : ''
    return caret ? withCaret(out) : out
  }, [text, caret])

  return (
    <article
      className={`${css.assistant} ${afterDivider ? css.afterDivider : ''} ${outside ? css.outside : ''}`}
      aria-label={`Reply from ${version.model ?? 'assistant'}`}
      aria-busy={streaming}
      tabIndex={0}
      {...tapHandlers(onToggle)}
    >
      <div className={css.head}>
        <span className={css.lead}>
          <MetaLine version={version} prompts={prompts} />
          {message.pinned && <span className={css.pinned}>pinned</span>}
        </span>
        <Versions count={message.versions.length} active={message.activeVersion} onPick={(i) => ops.setActive(message.id, i)} />
      </div>
      {version.reasoning && <Thinking key={version.id} reasoning={version.reasoning} thinking={streaming && text === ''} />}
      {editing ? (
        <EditBox initial={text} prose onSave={(t) => ops.saveEdit(message.id, t)} onCancel={ops.cancelEdit} />
      ) : (
        html && <div className={css.prose} dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {!editing && (
        <StatusNote
          version={version}
          isLast={isLast}
          busy={busy}
          onRetry={() => ops.reroll(message.id)}
          onContinue={() => ops.cont(message.id)}
        />
      )}
      {selected && !editing && <MessageActions message={message} isLast={isLast} busy={busy} ops={ops} />}
    </article>
  )
}
