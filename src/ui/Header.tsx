import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/storage'
import css from './Header.module.css'

export function Header({ conversationId, onMenu }: { conversationId: string | null; onMenu: () => void }) {
  const info = useLiveQuery(async () => {
    if (!conversationId) return null
    const conv = await db.conversations.get(conversationId)
    const msgs = await db.messages
      .where('[conversationId+order]')
      .between([conversationId, -Infinity], [conversationId, Infinity])
      .toArray()
    const turns = msgs.filter((m) => m.role === 'user').length
    let last = null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'assistant') continue
      const u = m.versions[m.activeVersion]?.usage
      if (u) {
        last = u
        break
      }
    }
    return { title: conv?.title ?? '', turns, last }
  }, [conversationId])

  const ctx = info?.last ? `${(info.last.promptTokens / 1000).toFixed(1)}k ctx` : '0k ctx'
  const cache = info?.last && info.last.cachedTokens > 0 ? 'warm cache' : 'cold'
  const meta = `${info?.turns ?? 0} turns · ${ctx} · ${cache}`

  return (
    <header className={css.header}>
      <div className={css.text}>
        <h1 className={css.title}>{info?.title || 'ORFE'}</h1>
        <div className={css.meta}>{meta}</div>
      </div>
      <button className={css.menu} onClick={onMenu} aria-label="Open menu">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M3 5.5h14M3 10h14M3 14.5h14" />
        </svg>
      </button>
    </header>
  )
}
