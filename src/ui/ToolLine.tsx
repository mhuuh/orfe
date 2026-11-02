import { useState } from 'react'
import { describeStep, writesNotes } from '../lib/abilities/registry'
import { notes, YOU } from '../lib/notes/store'
import { okStep, setToolUndone } from '../lib/send'
import type { ToolPart } from '../lib/types'
import css from './ToolLine.module.css'

const DETAIL_LINES = 3
const STAYS = 'The note changed since. This write stays.'

export interface LineView {
  text: string
  live: boolean
  undone: boolean
  /** A reroll or a delete left this write in place. */
  kept: boolean
  canUndo: boolean
  canRedo: boolean
  /** The first lines of the result. */
  detail: string[]
  more: boolean
}

/** What a line shows. The words come from `describeStep`; this adds no words of its own. */
export function lineView(part: ToolPart, locked = false): LineView {
  const words = describeStep(part)
  const live = part.status === 'running'
  // Only a finished write can be undone. While the reply streams, its writer also saves the steps,
  // so a flag set now would be overwritten.
  const write = writesNotes(part.name) && part.status === 'done' && !locked
  const undone = part.undone === true
  const lines = part.result.split('\n')
  return {
    text: live ? words.running : words.done,
    live,
    undone,
    kept: part.kept === true,
    canUndo: write && !undone,
    canRedo: write && undone,
    detail: lines.slice(0, DETAIL_LINES),
    more: lines.length > DETAIL_LINES,
  }
}

/** Undoes one write. Returns a line for Mikael when it did not apply, or null when it did. */
export async function undoStep(part: ToolPart, messageId: string): Promise<string | null> {
  try {
    const rev = await notes.byCall(part.callId, messageId)
    if (!rev) return 'Nothing to undo.'
    if ((await notes.revert(rev.id, YOU)) === 'changed-later') return STAYS
    await setToolUndone(messageId, part.callId, true)
    return null
  } catch {
    return 'Could not undo.'
  }
}

/** Puts one write back. The line stays undone when the note changed since. */
export async function redoStep(part: ToolPart, messageId: string): Promise<string | null> {
  try {
    const { redone } = await notes.redoCalls([part.callId], messageId)
    if (!redone.includes(part.callId)) return 'The note changed since. It stays undone.'
    await setToolUndone(messageId, part.callId, false)
    return null
  } catch {
    return 'Could not redo.'
  }
}

interface Props {
  part: ToolPart
  messageId: string
  /** The reply is still streaming. Undo and Redo are off. */
  locked?: boolean
  /** Set while this step waits for a visible OK: the chat it runs in. */
  waitingIn?: string
}

/** One step of the reply, in mono. Tap to see what it read or changed. */
export function ToolLine({ part, messageId, locked = false, waitingIn }: Props) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const v = lineView(part, locked)
  const said = note ?? (v.kept ? STAYS : null)

  async function run(step: typeof undoStep) {
    setWorking(true)
    setNote(null)
    try {
      setNote(await step(part, messageId))
    } finally {
      setWorking(false)
    }
  }

  const label = (
    <>
      <span className={css.dot} aria-hidden="true" />
      <span className={css.text}>{v.text}</span>
      {v.undone && <span className={css.undone}>undone</span>}
      {v.kept && <span className={css.undone}>kept</span>}
    </>
  )

  if (v.live) {
    return (
      <div>
        <div className={`${css.line} ${css.live}`} role="status">
          {label}
        </div>
        {waitingIn !== undefined && (
          <div className={css.detail} onClick={(e) => e.stopPropagation()}>
            <div className={css.note}>This reply read outside text, so this step waits for your OK. Stop ends the reply.</div>
            <button className={`${css.action} ${css.ok}`} onClick={() => okStep(waitingIn, part.callId)}>
              OK
            </button>
          </div>
        )}
      </div>
    )
  }
  return (
    <div>
      <button className={css.line} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        <span className={css.chev} aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <div className={css.detail} onClick={(e) => e.stopPropagation()}>
          <div className={css.result}>
            {v.detail.join('\n')}
            {v.more && '\n…'}
          </div>
          {(v.canUndo || v.canRedo) && (
            <button className={css.action} onClick={() => run(v.canUndo ? undoStep : redoStep)} disabled={working}>
              {v.canUndo ? 'Undo' : 'Redo'}
            </button>
          )}
          {said && (
            <div className={css.note} role="status">
              {said}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
