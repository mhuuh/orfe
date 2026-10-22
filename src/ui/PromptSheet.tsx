import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { isGenerating, replacePromptRef, setPrompt } from '../lib/send'
import { storage } from '../lib/storage'
import type { Prompt } from '../lib/types'
import { Sheet } from './Sheet'
import { openSheet } from './sheetHistory'
import { useToast } from './Toast'
import css from './PromptSheet.module.css'

interface Props {
  open: boolean
  onClose: () => void
  conversationId: string
  /** The chat's prompt ref. A ref to a deleted prompt counts as "No prompt". */
  current: string | null
}

export interface PromptRow {
  prompt: Prompt
  variant: boolean
}

/** Finds a prompt's top parent. A prompt whose parent is gone, or that sits in a parent loop, is its own top. */
function rootFinder(prompts: Prompt[]): (p: Prompt) => Prompt {
  const byId = new Map(prompts.map((p) => [p.id, p]))
  return (p) => {
    const seen = new Set<string>()
    let at = p
    while (at.parentId !== null && byId.has(at.parentId) && !seen.has(at.id)) {
      seen.add(at.id)
      at = byId.get(at.parentId)!
    }
    return seen.has(at.id) ? p : at
  }
}

/**
 * Parents by name, each followed by its variants by name. Bad links never hide a prompt:
 * see `rootFinder`; a variant of a variant is shown under the top parent.
 */
export function promptRows(prompts: Prompt[]): PromptRow[] {
  const byName = (a: Prompt, b: Prompt) => a.name.localeCompare(b.name)
  const rootOf = rootFinder(prompts)
  const groups = new Map<string, Prompt[]>()
  const parents: Prompt[] = []
  for (const p of prompts) {
    const root = rootOf(p)
    if (root === p) parents.push(p)
    else groups.set(root.id, [...(groups.get(root.id) ?? []), p])
  }
  const rows: PromptRow[] = []
  for (const parent of parents.sort(byName)) {
    rows.push({ prompt: parent, variant: false })
    for (const v of (groups.get(parent.id) ?? []).sort(byName)) rows.push({ prompt: v, variant: true })
  }
  return rows
}

/** The parent a new variant of `p` attaches to: always a top parent, so variants never nest. */
export function variantParent(p: Prompt, prompts: Prompt[]): string {
  return rootFinder(prompts)(p).id
}

const VARIANT_SUFFIX = 'variant'

/** What the editor works on: a saved prompt, or a new one. */
type Draft = { prompt: Prompt | null; focusName: boolean }

export function PromptSheet({ open, onClose, conversationId, current }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)

  // Each open starts on the list.
  useEffect(() => {
    if (open) setDraft(null)
  }, [open])

  const title = draft === null ? 'Prompt' : draft.prompt ? 'Edit prompt' : 'New prompt'
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <PromptBody
        open={open}
        onClose={onClose}
        conversationId={conversationId}
        current={current}
        draft={draft}
        setDraft={setDraft}
      />
    </Sheet>
  )
}

interface BodyProps extends Props {
  draft: Draft | null
  setDraft: (d: Draft | null) => void
}

function PromptBody({ open, onClose, conversationId, current, draft, setDraft }: BodyProps) {
  const prompts = useLiveQuery(() => storage.listPrompts(), [])
  const toast = useToast()
  const editing = draft !== null

  // The editor gets its own Back step: Back (and Escape) return to the list, not out of the sheet.
  const toList = useRef(() => setDraft(null))
  toList.current = () => setDraft(null)
  useEffect(() => {
    if (!open || !editing) return
    const me = openSheet(() => toList.current())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && me.isTop()) toList.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      me.release()
    }
  }, [open, editing])

  if (!prompts) return null

  if (draft) {
    return (
      <Editor
        key={draft.prompt?.id ?? 'new'}
        draft={draft}
        prompts={prompts}
        conversationId={conversationId}
        current={current}
        onDone={() => setDraft(null)}
        onOpen={(p) => setDraft({ prompt: p, focusName: true })}
        toast={toast}
      />
    )
  }

  const known = current !== null && prompts.some((p) => p.id === current)
  const active = known ? current : null

  const pick = (ref: string | null) => {
    if (isGenerating(conversationId)) {
      toast.show('Wait for the reply to finish.')
      return
    }
    onClose()
    if (ref === active) return
    setPrompt(conversationId, ref).catch((e: unknown) => {
      console.error(e)
      toast.show("Couldn't change the prompt.")
    })
  }

  return (
    <ul className={css.rows}>
      <li className={css.item}>
        <button className={css.pick} aria-current={active === null ? 'true' : undefined} onClick={() => pick(null)}>
          <span className={css.name}>No prompt</span>
          {active === null && <Check />}
        </button>
        {/* Keeps the check in the same column as on the rows with an Edit pill. */}
        <span className={css.editSpace} aria-hidden="true" />
      </li>
      {promptRows(prompts).map(({ prompt: p, variant }) => (
        <li key={p.id} className={`${css.item} ${variant ? css.variant : ''}`}>
          <button className={css.pick} aria-current={p.id === active ? 'true' : undefined} onClick={() => pick(p.id)}>
            <span className={css.name}>{p.name}</span>
            {p.id === active && <Check />}
          </button>
          <button className={css.edit} onClick={() => setDraft({ prompt: p, focusName: false })} aria-label={`Edit ${p.name}`}>
            Edit
          </button>
        </li>
      ))}
      <li className={css.item}>
        <button className={`${css.pick} ${css.add}`} onClick={() => setDraft({ prompt: null, focusName: true })}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M8 3v10M3 8h10" strokeLinecap="round" />
          </svg>
          <span className={css.name}>New prompt</span>
        </button>
      </li>
    </ul>
  )
}

function Check() {
  return (
    <svg className={css.check} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface EditorProps {
  draft: Draft
  prompts: Prompt[]
  conversationId: string
  current: string | null
  onDone: () => void
  onOpen: (p: Prompt) => void
  toast: ReturnType<typeof useToast>
}

function Editor({ draft, prompts, conversationId, current, onDone, onOpen, toast }: EditorProps) {
  const saved = draft.prompt
  const [name, setName] = useState(saved?.name ?? '')
  const [text, setText] = useState(saved?.text ?? '')
  const [working, setWorking] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)
  const textField = useRef<HTMLTextAreaElement>(null)

  // Grow with the text; CSS caps it at 60% of the screen, then it scrolls inside.
  useLayoutEffect(() => {
    const el = textField.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  // A new prompt or a fresh variant starts in the name. A variant's suffix is selected, ready to retype.
  useLayoutEffect(() => {
    const el = nameField.current
    if (!el || !draft.focusName) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(el.value.endsWith(VARIANT_SUFFIX) ? end - VARIANT_SUFFIX.length : end, end)
  }, [draft.focusName])

  const cleanName = name.trim()
  const changed = saved === null || cleanName !== saved.name || text !== saved.text
  const canSave = cleanName !== '' && text.trim() !== '' && !working

  const act = async (work: () => Promise<void>, fail: string) => {
    setWorking(true)
    try {
      await work()
    } catch (e) {
      console.error(e)
      toast.show(fail)
    } finally {
      setWorking(false)
    }
  }

  const save = () =>
    act(async () => {
      if (changed) await storage.savePrompt({ id: saved?.id, name: cleanName, parentId: saved?.parentId ?? null, text })
      onDone()
    }, "Couldn't save the prompt.")

  // The copy takes what is on screen; the original keeps its saved text.
  const duplicate = () =>
    act(async () => {
      if (!saved) return
      const copy = await storage.savePrompt({
        name: `${cleanName || saved.name}, ${VARIANT_SUFFIX}`,
        parentId: variantParent(saved, prompts),
        text,
      })
      onOpen(copy)
    }, "Couldn't make the variant.")

  const remove = () =>
    act(async () => {
      if (!saved) return
      if ((await storage.deletePrompt(saved.id)) === 'has-variants') {
        toast.show('Delete its variants first')
        return
      }
      // The chat that used it falls back to "No prompt". Other chats keep the ref and read it as none.
      const wasCurrent = current === saved.id && (await replacePromptRef(conversationId, saved.id, null))
      onDone()
      toast.show('Prompt deleted', {
        label: 'Undo',
        run: () => {
          void (async () => {
            await storage.savePrompt({ id: saved.id, name: saved.name, parentId: saved.parentId, text: saved.text })
            if (wasCurrent) await replacePromptRef(conversationId, null, saved.id)
          })().catch((e: unknown) => {
            console.error(e)
            toast.show("Couldn't restore the prompt.")
          })
        },
      })
    }, "Couldn't delete the prompt.")

  return (
    <div className={css.editor}>
      <input
        ref={nameField}
        className={css.nameField}
        value={name}
        placeholder="Name"
        aria-label="Prompt name"
        autoComplete="off"
        enterKeyHint="next"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            textField.current?.focus()
          }
        }}
      />
      <textarea
        ref={textField}
        className={css.textField}
        value={text}
        rows={5}
        placeholder="What the model should know or do"
        aria-label="Prompt text"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSave) void save()
        }}
      />
      <div className={css.bar}>
        {saved && (
          <>
            <button className={css.quiet} onClick={() => void duplicate()} disabled={working}>
              Duplicate as variant
            </button>
            <button className={css.quiet} onClick={() => void remove()} disabled={working}>
              Delete
            </button>
          </>
        )}
        <button className={css.save} onClick={() => void save()} disabled={!canSave}>
          Save
        </button>
      </div>
    </div>
  )
}
