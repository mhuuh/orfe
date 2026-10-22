import type { Message } from '../lib/types'
import { versionText } from '../lib/versions'
import { tapHandlers } from './AssistantMessage'
import { EditBox, MessageActions, type MessageOps } from './MessageActions'
import { Versions } from './Versions'
import css from './UserMessage.module.css'

interface Props {
  message: Message
  isLast: boolean
  busy: boolean
  selected: boolean
  editing: boolean
  ops: MessageOps
  onToggle(): void
  /** Before the context window start and not pinned: not sent, shown in mute. */
  outside?: boolean
}

export function UserMessage({ message, isLast, busy, selected, editing, ops, onToggle, outside }: Props) {
  const version = message.versions[message.activeVersion] ?? message.versions[0]
  const text = versionText(version)
  const media = version.content.filter((p) => p.type === 'media').length
  const many = message.versions.length > 1
  return (
    <article className={`${css.user} ${outside ? css.outside : ''}`} aria-label="You" tabIndex={0} {...tapHandlers(onToggle)}>
      {editing ? (
        <EditBox initial={text} onSave={(t) => ops.saveEdit(message.id, t)} onCancel={ops.cancelEdit} />
      ) : (
        <div className={css.bubble}>
          {text}
          {media > 0 && <span className={css.media}>{media === 1 ? '1 attachment' : `${media} attachments`}</span>}
        </div>
      )}
      {!editing && (many || selected || message.pinned) && (
        <div className={css.foot}>
          {selected && <MessageActions message={message} isLast={isLast} busy={busy} ops={ops} />}
          <Versions count={message.versions.length} active={message.activeVersion} onPick={(i) => ops.setActive(message.id, i)} />
          {message.pinned && <span className={css.pinned}>pinned</span>}
        </div>
      )}
    </article>
  )
}
