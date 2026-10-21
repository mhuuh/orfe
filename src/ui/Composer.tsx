import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { ModelInfo } from '../lib/catalog'
import { generate, isGenerating, sendUserMessage, stop } from '../lib/send'
import { storage } from '../lib/storage'
import type { Conversation, Role } from '../lib/types'
import { shortModel } from './Divider'
import { ModelSheet } from './ModelSheet'
import { useToast } from './Toast'
import { findModel, useCatalog } from './useCatalog'
import css from './Composer.module.css'

const LONG_PRESS_MS = 500
const LINE_PX = 22
const MAX_LINES = 8
/** A second tap this soon after sending is a double tap, not a request to stop. */
export const STOP_GRACE_MS = 400

/** Unsent text per chat, kept while switching chats (not across reloads). */
const drafts = new Map<string, string>()

export type SendAction = 'stop' | 'send' | 'reply' | 'none'

/** What a tap on the round button does. Empty text after your own message asks for a reply. */
export function sendAction(text: string, lastRole: Role | undefined, busy: boolean): SendAction {
  if (busy) return 'stop'
  if (clean(text)) return 'send'
  return lastRole === 'user' ? 'reply' : 'none'
}

/** Drops leading blank lines and trailing space; keeps the first line's indent (code). */
export const clean = (text: string): string => text.replace(/^(?:[ \t]*\n)+/, '').trimEnd()

/** Whether a tap on Stop counts, given when we last started a send or reply. */
export const canStop = (now: number, startedAt: number): boolean => now - startedAt >= STOP_GRACE_MS

/** The effort the chip shows: the chosen one when this model has it, else the model's default. */
export function shownEffort(model: ModelInfo, chosen: string | null): string | null {
  if (!model.efforts) return null
  return chosen !== null && model.efforts.includes(chosen) ? chosen : model.defaultEffort
}

/** The effort after `shown` in the model's list, wrapping round. */
export function nextEffort(efforts: string[], shown: string | null): string {
  const i = shown === null ? -1 : efforts.indexOf(shown)
  return efforts[(i + 1) % efforts.length]
}

export function Composer({ conversationId: id }: { conversationId: string }) {
  const data = useLiveQuery(async () => {
    const [conversation, messages] = await Promise.all([storage.getConversation(id), storage.listMessages(id)])
    const turns = messages.filter((m) => m.role !== 'divider')
    return {
      conversation,
      lastRole: turns[turns.length - 1]?.role,
      streaming: messages.some((m) => m.versions.some((v) => v.status === 'streaming')),
    }
  }, [id])
  const { models } = useCatalog()
  const toast = useToast()

  const [text, setText] = useState(() => drafts.get(id) ?? '')
  const [pending, setPending] = useState(false)
  const [sheet, setSheet] = useState(false)
  // A model picked in the sheet may come from a fresher catalog than ours.
  const [picked, setPicked] = useState<ModelInfo | null>(null)

  const root = useRef<HTMLElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const longPressed = useRef(false)
  const startedAt = useRef(-Infinity)

  const conv: Conversation | undefined = data?.conversation
  const modelId = conv?.nextModel ?? ''
  const model = picked && picked.id === modelId ? picked : findModel(models, modelId)
  const effort = shownEffort(model, conv?.nextEffort ?? null)
  const busy = pending || (data?.streaming ?? false)
  const action = data ? sendAction(text, data.lastRole, busy) : 'none'

  // Grow with the text, 1 to 8 lines, then scroll inside.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, LINE_PX * MAX_LINES)}px`
  }, [text])

  // Tell the transcript how much room to leave at the bottom (composer, gap and safe area).
  useLayoutEffect(() => {
    const el = root.current
    const host = el?.parentElement
    if (!el || !host) return
    const set = () => {
      const h = Math.ceil(host.getBoundingClientRect().bottom - el.getBoundingClientRect().top)
      document.documentElement.style.setProperty('--composer-h', `${h}px`)
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--composer-h')
    }
  }, [])

  const edit = (next: string) => {
    setText(next)
    if (next) drafts.set(id, next)
    else drafts.delete(id)
  }

  /** Puts unsent text back, unless something new was typed meanwhile. */
  const restore = (body: string) => {
    if (!drafts.get(id)) edit(body)
  }

  const run = (work: Promise<void>) => {
    startedAt.current = Date.now()
    setPending(true)
    work
      .catch((e: unknown) => {
        console.error(e)
        toast.show("Couldn't send.")
      })
      .finally(() => setPending(false))
  }

  /** Sends the text. Never while a reply runs: a second request would be dropped. */
  const submit = (reply: boolean) => {
    const body = clean(text)
    if (!body || !data || busy || isGenerating(id)) return
    edit('')
    if (reply) {
      // Two steps instead of sendUserMessage({reply:true}), so a failed append can give the text back.
      run(
        (async () => {
          try {
            await sendUserMessage(id, body, { reply: false })
          } catch (e) {
            restore(body)
            throw e
          }
          await generate(id, { kind: 'new' }, model)
        })(),
      )
      return
    }
    sendUserMessage(id, body, { reply: false }).then(
      () => toast.show('Added without reply', undefined, 2500),
      (e: unknown) => {
        console.error(e)
        restore(body)
        toast.show("Couldn't add the message.")
      },
    )
  }

  /** Tap or Ctrl/Cmd+Enter. */
  const primary = () => {
    if (action === 'send') submit(true)
    else if (action === 'reply' && !isGenerating(id)) run(generate(id, { kind: 'new' }, model))
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      primary()
    }
  }

  const cancelPress = () => clearTimeout(pressTimer.current)
  const startPress = () => {
    longPressed.current = false
    if (action !== 'send') return
    cancelPress()
    pressTimer.current = setTimeout(() => {
      longPressed.current = true
      navigator.vibrate?.(10)
      submit(false)
    }, LONG_PRESS_MS)
  }
  const onButton = () => {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (action === 'stop') {
      if (canStop(Date.now(), startedAt.current)) stop(id)
    } else primary()
  }

  const pick = (m: ModelInfo) => {
    setPicked(m)
    setSheet(false)
    const patch: Partial<Conversation> = { nextModel: m.id }
    // An effort the new model does not offer would not be sent; drop it so the chip tells the truth.
    if (conv?.nextEffort && !m.efforts?.includes(conv.nextEffort)) patch.nextEffort = null
    void storage.updateConversation(id, patch)
  }

  const cycleEffort = () => {
    if (!model.efforts) return
    void storage.updateConversation(id, { nextEffort: nextEffort(model.efforts, effort) })
  }

  const label =
    action === 'stop' ? 'Stop' : action === 'reply' ? 'Ask for a reply' : 'Send (hold to add without reply)'

  // The sheet sits outside the glass: backdrop-filter would trap its fixed position.
  return (
    <>
      <section ref={root} className={css.composer} aria-label="Composer">
        <textarea
          ref={field}
          className={css.field}
          rows={1}
          value={text}
          placeholder="Reply…"
          aria-label="Message"
          enterKeyHint="enter"
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKey}
        />
        <div className={css.tools}>
          <button className={css.chip} onClick={() => setSheet(true)} aria-label={`Model: ${model.name}. Change`}>
            <span className={css.chipText}>{modelId ? shortModel(modelId) : 'model'}</span>
            <span className={css.caret} aria-hidden="true">
              ▾
            </span>
          </button>
          {model.efforts && (
            <button className={css.chip} onClick={cycleEffort} aria-label={`Reasoning effort: ${effort ?? 'default'}. Change`}>
              <span className={css.chipText}>effort: {effort ?? 'default'}</span>
            </button>
          )}
          <button
            className={`${css.send} ${action === 'stop' ? css.stop : ''}`}
            disabled={action === 'none'}
            aria-label={label}
            title={label}
            onClick={onButton}
            onPointerDown={startPress}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
            onContextMenu={(e) => e.preventDefault()}
            // Keep the keyboard up on phones: the field keeps focus.
            onMouseDown={(e) => e.preventDefault()}
          >
            {action === 'stop' ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M7 12V2M3 6l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </section>
      <ModelSheet open={sheet} onClose={() => setSheet(false)} onPick={pick} current={modelId} />
    </>
  )
}
