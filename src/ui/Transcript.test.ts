import { describe, expect, it } from 'vitest'
import { followAfterScroll } from './Transcript'

describe('followAfterScroll', () => {
  it('lets go on any upward scroll, even within the 80 px zone', () => {
    expect(followAfterScroll(30, -30, true)).toBe(false)
    expect(followAfterScroll(5, -2, true)).toBe(false)
  })

  it('follows again only when the reader comes back down near the bottom', () => {
    expect(followAfterScroll(200, 40, false)).toBe(false)
    expect(followAfterScroll(60, 40, false)).toBe(true)
    expect(followAfterScroll(0.4, 0, false)).toBe(true) // at the bottom (fractional pixels)
  })

  it('a scroll without movement keeps the current choice inside the zone', () => {
    expect(followAfterScroll(40, 0, false)).toBe(false)
    expect(followAfterScroll(40, 0, true)).toBe(true)
    expect(followAfterScroll(300, 0, true)).toBe(false)
  })

  it('content shrinking clamps the view to the bottom: follow', () => {
    expect(followAfterScroll(0, -120, false)).toBe(true)
  })
})
