import { useMemo, type KeyboardEvent, type MouseEvent } from 'react'
import { renderMarkdown } from '../lib/markdown'
import type { Message, Version } from '../lib/types'
import { segments, versionText } from '../lib/versions'
import { EditBox, MessageActions, type MessageOps } from './MessageActions'
import { MetaLine, type PromptIndex } from './MetaLine'
import { Thinking } from './Thinking'
import { ToolLine } from './ToolLine'
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

/** What the status line says and offers. Null when the reply needs no line. */
export function statusNote(version: Version, isLast: boolean): { text: string; retry: boolean; more: boolean } | null {
  switch (version.status) {
    case 'stopped':
      return { text: 'Stopped', retry: true, more: isLast }
    case 'interrupted':
      return { text: version.error || 'Interrupted', retry: true, more: isLast }
    case 'error':
      // Retry runs the tools again and keeps shared-shelf writes. Continue goes on from the steps.
      return { text: version.error || 'Something went wrong', retry: true, more: isLast && version.content.some((p) => p.type === 'tool') }
    default:
      return version.finishReason === 'length' ? { text: 'Hit the length limit', retry: false, more: isLast } : null
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
  const note = statusNote(version, isLast)
  if (!note) return null
  const { text, retry, more } = note
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
  // A reroll in flight owns the writes of the old versions too, so a flip back does not unlock them.
  const writing = message.versions.some((v) => v.status === 'streaming')
  // While the model is only thinking, the open Thinking block shows activity instead of a caret.
  const caret = streaming && !(text === '' && version.reasoning)
  // The caret trails the last text, and only when text is last. Between rounds a finished tool line is.
  const parts = useMemo(() => {
    const segs = segments(version.content)
    return segs.map((x, i) => {
      if (x.kind === 'tool') return x
      const out = renderMarkdown(x.text)
      return { ...x, html: caret && i === segs.length - 1 ? withCaret(out) : out, afterTool: segs[i - 1]?.kind === 'tool' }
    })
  }, [version.content, caret])
  const firstText = parts.findIndex((x) => x.kind === 'text')

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
      {parts.map((x, i) => {
        if (x.kind === 'tool') return <ToolLine
            key={`${x.part.round}:${x.part.callId}`}
            part={x.part}
            messageId={message.id}
            locked={writing}
            waitingIn={streaming && version.waitingFor === x.part.callId ? message.conversationId : undefined}
          />
        if (editing) {
          return i === firstText ? (
            <EditBox key="edit" initial={text} prose onSave={(t) => ops.saveEdit(message.id, t)} onCancel={ops.cancelEdit} />
          ) : null
        }
        return <div key={i} className={`${css.prose} ${x.afterTool ? css.afterTool : ''}`} dangerouslySetInnerHTML={{ __html: x.html }} />
      })}
      {editing && firstText < 0 && (
        <EditBox initial={text} prose onSave={(t) => ops.saveEdit(message.id, t)} onCancel={ops.cancelEdit} />
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
