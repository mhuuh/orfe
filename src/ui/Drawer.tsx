import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { deleteChat, restoreChat } from '../lib/send'
import { backupDue } from '../lib/backup'
import { db, storage } from '../lib/storage'
import { NoteSheet } from './NoteSheet'
import { Sheet } from './Sheet'
import { useToast } from './Toast'
import { Vault } from './Vault'
import css from './Drawer.module.css'

interface Props {
  open: boolean
  onClose: () => void
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onSettings: () => void
  /** Goes up when chat settings asks for this chat's notes. */
  vaultAsked: number
}

const LONG_PRESS_MS = 450

const TABS = ['Chats', 'Vault'] as const

export function Drawer({ open, onClose, currentId, onSelect, onNew, onSettings, vaultAsked }: Props) {
  const convs = useLiveQuery(() => storage.listConversations(), [], [])
  const toast = useToast()
  const due = useLiveQuery(async () => {
    // Prompts have no updatedAt index; there are few of them.
    const [settings, newestChat, prompts] = await Promise.all([
      storage.getSettings(),
      db.conversations.orderBy('updatedAt').last(),
      db.prompts.toArray(),
    ])
    const lastChange = Math.max(newestChat?.updatedAt ?? 0, ...prompts.map((p) => p.updatedAt))
    return backupDue(settings, lastChange, Date.now())
  }, [open])
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<(typeof TABS)[number]>('Chats')
  /** The ask the vault should scroll for. A tap on a tab clears it. */
  const [jump, setJump] = useState(0)
  /** Stays set while the sheet slides out, so the note does not blank during the exit. */
  const [noteId, setNoteId] = useState<string | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null)

  useEffect(() => {
    if (vaultAsked === 0) return
    setTab('Vault')
    setJump(vaultAsked)
  }, [vaultAsked])

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
    const undo = await deleteChat(id)
    if (!undo) return
    toast.show('Chat deleted', { label: 'Undo', run: () => void restoreChat(undo) })
  }

  const vault = tab === 'Vault'

  return (
    <>
      <Sheet open={open} onClose={onClose} title={tab} side="left" tone={vault ? 'bg' : 'surface'}>
        <div className={css.wrap}>
          <div className={css.head}>
            <span className={css.title}>{tab}</span>
            <button className={css.done} onClick={onClose} aria-label="Close">
              Done
            </button>
          </div>
          <div className={`${css.seg} ${vault ? css.onBg : ''}`} role="tablist">
            {TABS.map((t) => (
              <button
                key={t}
                className={`${css.tab} ${t === tab ? css.on : ''}`}
                role="tab"
                aria-selected={t === tab}
                onClick={() => {
                  setTab(t)
                  setJump(0)
                }}
              >
                {t}
              </button>
            ))}
          </div>
          {vault ? (
            <Vault
              conversationId={currentId}
              jump={jump}
              onOpen={(id) => {
                setNoteId(id)
                setNoteOpen(true)
              }}
            />
          ) : (
            <>
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
              {due && (
                <button className={css.nudge} onClick={onSettings}>
                  Back up your data. It has been over 14 days.
                </button>
              )}
              <button className={css.settings} onClick={onSettings}>
                Settings
              </button>
            </>
          )}
        </div>
      </Sheet>
      <NoteSheet noteId={noteId} open={noteOpen} onClose={() => setNoteOpen(false)} conversationId={currentId} />
    </>
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
