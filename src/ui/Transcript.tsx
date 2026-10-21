import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { storage } from '../lib/storage'
import type { Version } from '../lib/types'
import { AssistantMessage } from './AssistantMessage'
import { Divider, dividerLabel } from './Divider'
import { useMessageOps } from './MessageActions'
import { UserMessage } from './UserMessage'
import { useCatalog } from './useCatalog'
import css from './Transcript.module.css'

/** Within this distance of the bottom, the view follows new text. */
const STICK_PX = 80

export function Transcript({ conversationId }: { conversationId: string | null }) {
  const data = useLiveQuery(async () => {
    if (!conversationId) return null
    const [conversation, messages] = await Promise.all([
      storage.getConversation(conversationId),
      storage.listMessages(conversationId),
    ])
    return { id: conversationId, conversation, messages }
  }, [conversationId])
  const { models } = useCatalog()
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const deselect = useCallback(() => setSelected(null), [])
  const ops = useMessageOps(data?.conversation, models, setEditing, deselect)

  const scroller = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const seen = useRef<{ id: string | null; count: number }>({ id: null, count: 0 })

  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [])

  // A new chat, or a new message (you sent one), pins the view to the bottom again.
  useLayoutEffect(() => {
    if (!data) return
    const count = data.messages.length
    if (data.id !== seen.current.id || count > seen.current.count) stick.current = true
    seen.current = { id: data.id, count }
    toBottom()
  }, [data, toBottom])

  // Streaming text, folding thoughts and late fonts change the height without a new message.
  useEffect(() => {
    const el = content.current
    if (!el) return
    const ro = new ResizeObserver(toBottom)
    ro.observe(el)
    return () => ro.disconnect()
  }, [toBottom])

  useEffect(() => {
    setSelected(null)
    setEditing(null)
  }, [conversationId])

  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const onScroll = () => {
    const el = scroller.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
  }

  const messages = data?.id === conversationId ? (data?.messages ?? []) : []
  const busy = messages.some((m) => m.versions.some((v) => v.status === 'streaming'))
  const lastId = messages[messages.length - 1]?.id

  const items: ReactNode[] = []
  let prev: Version | undefined
  for (const m of messages) {
    const toggle = () => setSelected((s) => (s === m.id ? null : m.id))
    const common = {
      message: m,
      isLast: m.id === lastId,
      busy,
      selected: selected === m.id,
      editing: editing === m.id,
      ops,
      onToggle: toggle,
    }
    if (m.role === 'divider') {
      if (m.dividerLabel) items.push(<Divider key={m.id} label={m.dividerLabel} />)
    } else if (m.role === 'user') {
      items.push(<UserMessage key={m.id} {...common} />)
    } else {
      const v = m.versions[m.activeVersion] ?? m.versions[0]
      const label = v ? dividerLabel(prev, v) : null
      if (label) items.push(<Divider key={`d-${m.id}`} label={label} />)
      items.push(<AssistantMessage key={m.id} {...common} afterDivider={label !== null} />)
      prev = v
    }
  }

  return (
    <main
      ref={scroller}
      className={css.transcript}
      aria-label="Conversation"
      onScroll={onScroll}
      onClick={(e) => {
        if (selected && !(e.target as HTMLElement).closest('article')) setSelected(null)
      }}
    >
      <div ref={content} className={css.content}>
        {items}
      </div>
    </main>
  )
}
