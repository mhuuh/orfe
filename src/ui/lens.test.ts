import { afterEach, describe, expect, it, vi } from 'vitest'
import { lensMap, supportsBackdropUrl } from './lens'

const W = 360
const H = 100
const R = 22
const RIM = 16
const map = lensMap(W, H, R, RIM)
const px = (x: number, y: number) => {
  const i = (y * W + x) * 4
  return { r: map[i], g: map[i + 1], b: map[i + 2], a: map[i + 3] }
}

describe('lensMap', () => {
  it('is w × h RGBA', () => {
    expect(map).toBeInstanceOf(Uint8ClampedArray)
    expect(map.length).toBe(W * H * 4)
  })

  it('centre pixel is neutral', () => {
    expect(px(W / 2, H / 2)).toEqual({ r: 128, g: 128, b: 128, a: 255 })
    // Just inside the rim is neutral too: the middle stays clear.
    expect(px(RIM + 2, H / 2)).toMatchObject({ r: 128, g: 128 })
  })

  it('rim pixel near the left edge samples rightwards (R > 128)', () => {
    const p = px(2, H / 2)
    expect(p.r).toBeGreaterThan(128)
    expect(p.g).toBe(128)
    // Stronger nearer the edge: (1 - d/rim)².
    expect(px(1, H / 2).r).toBeGreaterThan(px(8, H / 2).r)
  })

  it('rim pixel near the top edge samples downwards (G > 128)', () => {
    const p = px(W / 2, 2)
    expect(p.g).toBeGreaterThan(128)
    expect(p.r).toBe(128)
  })

  it('right and bottom edges sample back inwards', () => {
    expect(px(W - 3, H / 2).r).toBeLessThan(128)
    expect(px(W / 2, H - 3).g).toBeLessThan(128)
  })

  it('corner pixel samples diagonally inward', () => {
    // On the 45° line of the top-left corner arc, a few pixels in from the curve.
    const c = Math.round(R - (R - 4) / Math.SQRT2)
    const p = px(c, c)
    expect(p.r).toBeGreaterThan(128)
    expect(p.g).toBeGreaterThan(128)
    expect(Math.abs(p.r - p.g)).toBeLessThanOrEqual(2)
  })

  it('outside the rounded corner is neutral', () => {
    expect(px(0, 0)).toMatchObject({ r: 128, g: 128 })
  })
})

describe('supportsBackdropUrl', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks CSS.supports for backdrop-filter url() in Chromium', () => {
    const supports = vi.fn(() => true)
    vi.stubGlobal('CSS', { supports })
    vi.stubGlobal('navigator', { userAgentData: { brands: [] } })
    expect(supportsBackdropUrl()).toBe(true)
    expect(supports).toHaveBeenCalledWith('backdrop-filter', 'url(#x)')
  })

  it('is false where CSS.supports is missing', () => {
    vi.stubGlobal('CSS', undefined)
    vi.stubGlobal('navigator', { userAgentData: { brands: [] } })
    expect(supportsBackdropUrl()).toBe(false)
  })

  it('is false outside Chromium even when CSS.supports parses the url() (Firefox, Safari)', () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Firefox/140.0' })
    expect(supportsBackdropUrl()).toBe(false)
  })

  it('is false where CSS.supports says no, even in Chromium', () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) })
    vi.stubGlobal('navigator', { userAgentData: { brands: [] } })
    expect(supportsBackdropUrl()).toBe(false)
  })
})
