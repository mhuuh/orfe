import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, storage } from '../lib/storage'
import { Sheet } from './Sheet'
import { useToast } from './Toast'
import css from './Drawer.module.css'

interface Props {
  open: boolean
  onClose: () => void
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onSettings: () => void
}

const LONG_PRESS_MS = 450

export function Drawer({ open, onClose, currentId, onSelect, onNew, onSettings }: Props) {
  const convs = useLiveQuery(() => storage.listConversations(), [], [])
  const toast = useToast()
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null)

  const startPress = (id: string) => {
    const p = { fired: false, timer: setTimeout(() => ((p.fired = true), setMenuId(id)), LONG_PRESS_MS) }
    press.current = p
  }
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer)
  }

  const commitRename = async () => {
    const id = renameId
    setRenameId(null)
    const title = draft.trim()
    if (id && title) await storage.updateConversation(id, { title })
  }

  const remove = async (id: string) => {
    setMenuId(null)
    const conv = await storage.getConversation(id)
    if (!conv) return
    const msgs = await storage.listMessages(id)
    await storage.deleteConversation(id)
    toast.show('Chat deleted', {
      label: 'Undo',
      run: () => {
        void db.transaction('rw', db.conversations, db.messages, async () => {
          await db.conversations.put(conv)
          await db.messages.bulkPut(msgs)
        })
      },
    })
  }

  return (
    <Sheet open={open} onClose={onClose} title="Chats" side="left">
      <div className={css.wrap}>
        <button className={css.new} onClick={onNew}>
          <span className={css.plus} aria-hidden="true">
            +
          </span>
          New chat
        </button>
        <ul className={css.list}>
          {(convs ?? []).map((c) => (
            <li key={c.id}>
              {renameId === c.id ? (
                <input
                  className={css.rename}
                  autoFocus
                  value={draft}
                  aria-label="Chat name"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') setRenameId(null)
                  }}
                />
              ) : (
                <button
                  className={`${css.row} ${c.id === currentId ? css.current : ''}`}
                  onPointerDown={() => startPress(c.id)}
                  onPointerUp={endPress}
                  onPointerLeave={endPress}
                  onPointerCancel={endPress}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenuId(c.id)
                  }}
                  onClick={() => {
                    if (press.current?.fired) {
                      press.current.fired = false
                      return
                    }
                    setMenuId(null)
                    onSelect(c.id)
                  }}
                >
                  <span className={css.name}>{c.title}</span>
                  <span className={css.when}>{formatWhen(c.updatedAt)}</span>
                </button>
              )}
              {menuId === c.id && (
                <div className={css.actions}>
                  <button
                    className={css.act}
                    onClick={() => {
                      setDraft(c.title)
                      setRenameId(c.id)
                      setMenuId(null)
                    }}
                  >
                    Rename
                  </button>
                  <button className={css.act} onClick={() => void remove(c.id)}>
                    Delete
                  </button>
                  <button className={css.act} onClick={() => setMenuId(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <button className={css.settings} onClick={onSettings}>
          Settings
        </button>
      </div>
    </Sheet>
  )
}

function formatWhen(t: number): string {
  const d = new Date(t)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
