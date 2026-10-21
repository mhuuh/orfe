/**
 * Makes Android Back (and browser Back) close the top sheet instead of leaving the chat.
 *
 * While any sheet is open, one extra history entry sits on top: same URL, a marker in
 * `history.state`. Back pops it; we close the top sheet and, if sheets remain (the model
 * sheet over Settings), push a new marker for them. A sheet closed any other way (scrim,
 * Done, Escape) removes the marker again with `history.back()`.
 *
 * Changes are applied in a microtask, so one sheet closing while another opens in the
 * same render (drawer -> Settings) keeps the single entry instead of popping and pushing.
 */

const MARK = 'orfeSheet'

interface Entry {
  close(): void
}

const stack: Entry[] = []
/** Our marker entry is the current history entry. */
let marked = false
/** We called history.back() and wait for its popstate before touching history again. */
let backPending = false
let scheduled = false

/** Whether the current history entry is a sheet's marker (navigation should replace it). */
export function onSheetEntry(): boolean {
  const s: unknown = history.state
  return typeof s === 'object' && s !== null && (s as Record<string, unknown>)[MARK] === true
}

function sync(): void {
  scheduled = false
  if (backPending) return
  if (stack.length > 0 && !marked) {
    history.pushState({ [MARK]: true }, '')
    marked = true
  } else if (stack.length === 0 && marked) {
    marked = false
    // Only step back over our own entry; a navigation may already have replaced it.
    if (onSheetEntry()) {
      backPending = true
      history.back()
    }
  }
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(sync)
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (backPending) {
      backPending = false
      schedule()
      return
    }
    if (!marked) return
    // Back popped our entry: close the top sheet. Take it off the stack now, so the
    // remaining sheets get a fresh entry without waiting for React to unmount it.
    marked = false
    const top = stack.pop()
    schedule()
    top?.close()
  })
}

/** Registers an open sheet. Call the returned function when it closes. */
export function openSheet(close: () => void): { isTop(): boolean; release(): void } {
  const entry: Entry = { close }
  stack.push(entry)
  schedule()
  return {
    isTop: () => stack[stack.length - 1] === entry,
    release() {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
      schedule()
    },
  }
}
