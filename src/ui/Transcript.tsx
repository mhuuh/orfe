import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { viewWindow } from '../lib/context'
import { DEFAULT_SETTINGS, storage } from '../lib/storage'
import type { Version } from '../lib/types'
import { AssistantMessage } from './AssistantMessage'
import { Divider, dividerLabel } from './Divider'
import { useMessageOps } from './MessageActions'
import { UserMessage } from './UserMessage'
import { useCatalog } from './useCatalog'
import css from './Transcript.module.css'

/** Coming back down to within this distance of the bottom makes the view follow new text again. */
const STICK_PX = 80
/** Closer than this counts as at the bottom (scrollTop can be fractional on phones). */
const BOTTOM_PX = 1

/**
 * Whether the view follows new text after a scroll. `dist` is the distance from the bottom,
 * `delta` the change in scrollTop (negative = up). Any upward scroll lets go, so a reader
 * scrolling up a little while text streams is not pulled back down.
 */
export function followAfterScroll(dist: number, delta: number, following: boolean): boolean {
  if (dist <= BOTTOM_PX) return true
  if (delta < 0) return false
  if (delta > 0) return dist <= STICK_PX
  return following && dist <= STICK_PX
}

const START_LABEL = 'context starts here'

const UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])
const TOUCH_SLOP_PX = 8

export function Transcript({ conversationId }: { conversationId: string | null }) {
  const data = useLiveQuery(async () => {
    if (!conversationId) return null
    const [conversation, messages] = await Promise.all([
      storage.getConversation(conversationId),
      storage.listMessages(conversationId),
    ])
    return { id: conversationId, conversation, messages }
  }, [conversationId])
  const prompts = useLiveQuery(async () => new Map((await storage.listPrompts()).map((p) => [p.id, p])), [])
  const { models } = useCatalog()
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const deselect = useCallback(() => setSelected(null), [])
  const ops = useMessageOps(data?.conversation, models, setEditing, deselect)

  const scroller = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  /** The scroller height the last resize callback saw. */
  const viewH = useRef(0)
  const lastTop = useRef(0)
  const touchY = useRef<number | null>(null)
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
  // The scroller itself is watched too: a growing composer raises its bottom padding.
  useEffect(() => {
    const el = content.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (scroller.current) viewH.current = scroller.current.clientHeight
      toBottom()
    })
    ro.observe(el)
    if (scroller.current) ro.observe(scroller.current)
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
    if (!el) return
    const delta = el.scrollTop - lastTop.current
    lastTop.current = el.scrollTop
    // The view just changed height (keyboard, rotation): this scroll is the browser's, not the reader's.
    // Leave "stick" alone so the resize callback can pin the bottom again.
    if (el.clientHeight !== viewH.current) return
    stick.current = followAfterScroll(el.scrollHeight - el.scrollTop - el.clientHeight, delta, stick.current)
  }

  // An upward gesture lets go at once, before its scroll event, so a resize in between cannot snap back.
  // Nothing above to scroll to (short chat): ignore, or nothing would turn following back on.
  const letGo = () => {
    if ((scroller.current?.scrollTop ?? 0) > 0) stick.current = false
  }

  const messages = data?.id === conversationId ? (data?.messages ?? []) : []
  const busy = messages.some((m) => m.versions.some((v) => v.status === 'streaming'))
  const lastId = messages[messages.length - 1]?.id

  // Where the stored window starts, resolved exactly as a send resolves it, never trimmed here.
  // The start does not depend on the limit or the system text, so defaults stand in for them.
  const conv = data?.conversation
  const startId = conv
    ? viewWindow({
        messages,
        windowStartId: conv.windowStartMessageId,
        windowStartOrder: conv.windowStartOrder,
        setting: conv.context ?? DEFAULT_SETTINGS.context,
        system: null,
        ratio: 1,
      }).startId
    : null
  const startIdx = startId === null ? -1 : messages.findIndex((m) => m.id === startId)
  // Nothing to mark when no real message comes before the start.
  const marked = startIdx > 0 && messages.slice(0, startIdx).some((m) => m.role !== 'divider')

  const items: ReactNode[] = []
  let prev: Version | undefined
  /** A stored prompt-swap divider came after the previous reply. */
  let swapped = false
  messages.forEach((m, i) => {
    const isStart = marked && i === startIdx
    if (isStart) items.push(<Divider key="ctx-start" label={START_LABEL} />)
    const toggle = () => setSelected((s) => (s === m.id ? null : m.id))
    const common = {
      message: m,
      isLast: m.id === lastId,
      busy,
      selected: selected === m.id,
      editing: editing === m.id,
      ops,
      onToggle: toggle,
      outside: marked && i < startIdx && !m.pinned,
    }
    if (m.role === 'divider') {
      if (m.dividerLabel) items.push(<Divider key={m.id} label={m.dividerLabel} />)
      swapped = true
    } else if (m.role === 'user') {
      items.push(<UserMessage key={m.id} {...common} />)
    } else {
      const v = m.versions[m.activeVersion] ?? m.versions[0]
      const promptName = v?.promptRef ? prompts?.get(v.promptRef)?.name : null
      const label = v ? dividerLabel(prev, v, promptName, swapped) : null
      // At the window start the marker already draws the hairline: one line carries both labels.
      if (label && isStart) items[items.length - 1] = <Divider key="ctx-start" label={`${START_LABEL} · ${label}`} />
      else if (label) items.push(<Divider key={`d-${m.id}`} label={label} />)
      items.push(<AssistantMessage key={m.id} {...common} afterDivider={label !== null || isStart} prompts={prompts} />)
      prev = v
      swapped = false
    }
  })

  return (
    <main
      ref={scroller}
      className={css.transcript}
      aria-label="Conversation"
      onScroll={onScroll}
      onWheel={(e) => {
        if (e.deltaY < 0) letGo()
      }}
      onTouchStart={(e) => {
        touchY.current = e.touches[0]?.clientY ?? null
      }}
      onTouchMove={(e) => {
        const y = e.touches[0]?.clientY
        if (y === undefined) return
        // Finger moving down the screen scrolls the text up. A few pixels of tap jitter do not count.
        if (touchY.current !== null && y - touchY.current > TOUCH_SLOP_PX) letGo()
      }}
      onKeyDown={(e) => {
        if (UP_KEYS.has(e.key)) letGo()
      }}
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
