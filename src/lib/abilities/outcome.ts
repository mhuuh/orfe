import type { ToolPart } from '../types'

/** The result of a call left open when the check for its write failed. It may have run. */
export const UNCHECKED = 'Error: could not check if this call already finished, so it did not run again. Check before you run it again.'

/** How a step ended, as words must tell it. `unknown`: it may or may not have run. */
export type Outcome = 'done' | 'failed' | 'stopped' | 'unknown'

export function outcome(part: ToolPart): Outcome {
  if (part.status === 'running' || part.result === UNCHECKED) return 'unknown'
  if (part.status === 'error') return 'failed'
  return part.status === 'stopped' ? 'stopped' : 'done'
}
