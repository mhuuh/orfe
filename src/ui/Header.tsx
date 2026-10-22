import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { viewWindow } from '../lib/context'
import { storage } from '../lib/storage'
import { systemFor } from '../lib/system'
import type { Message } from '../lib/types'
import { ChatSettings, compact } from './ChatSettings'
import css from './Header.module.css'

export type CacheState = 'warm' | 'cold' | 'none'

/** "5 turns · 12.1k / 32k ctx · warm cache", "5 turns · 14 / 40 msgs · cold", "… · –" before any reply. */
export function headerMeta(input: {
  turns: number
  size: number
  limit: number
  mode: 'tokens' | 'messages'
  cache: CacheState
}): string {
  const turns = `${input.turns} ${input.turns === 1 ? 'turn' : 'turns'}`
  const unit = input.mode === 'tokens' ? 'ctx' : 'msgs'
  const window = `${compact(input.size)} / ${compact(input.limit)} ${unit}`
  const cache = input.cache === 'warm' ? 'warm cache' : input.cache === 'cold' ? 'cold' : '–'
  return `${turns} · ${window} · ${cache}`
}

/** The newest reply that reported usage: warm if it read from the cache, cold if not, none before any. */
export function cacheState(messages: Message[]): CacheState {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const u = m.versions[m.activeVersion]?.usage
    if (u) return u.cachedTokens > 0 ? 'warm' : 'cold'
  }
  return 'none'
}

export function Header({ conversationId, onMenu }: { conversationId: string | null; onMenu: () => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const info = useLiveQuery(async () => {
    if (!conversationId) return null
    const [conv, messages, settings] = await Promise.all([
      storage.getConversation(conversationId),
      storage.listMessages(conversationId),
      storage.getSettings(),
    ])
    if (!conv) return null
    const { system } = await systemFor(conv)
    const setting = conv.context ?? settings.context
    // Display only: the stored window, never trimmed here. Sending decides trims.
    const view = viewWindow({
      messages,
      windowStartId: conv.windowStartMessageId,
      windowStartOrder: conv.windowStartOrder,
      setting,
      system,
      ratio: conv.tokenRatio,
    })
    const meta = headerMeta({
      turns: messages.filter((m) => m.role === 'user').length,
      size: view.size,
      limit: view.limit,
      mode: setting.mode,
      cache: cacheState(messages),
    })
    return { id: conversationId, title: conv.title, meta }
  }, [conversationId])

  const current = info && info.id === conversationId ? info : null

  return (
    <>
      <header className={css.header}>
        {current ? (
          // Tapping the title opens the chat's settings.
          <button className={`${css.text} ${css.tap}`} onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
            <span className={css.title}>{current.title || 'ORFE'}</span>
            <span className={css.meta}>{current.meta}</span>
          </button>
        ) : (
          <div className={css.text}>
            <h1 className={css.title}>ORFE</h1>
          </div>
        )}
        <button className={css.menu} onClick={onMenu} aria-label="Open menu">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 5.5h14M3 10h14M3 14.5h14" />
          </svg>
        </button>
      </header>
      {conversationId && (
        <ChatSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} conversationId={conversationId} />
      )}
    </>
  )
}
