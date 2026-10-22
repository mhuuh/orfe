/*
 * The lens edge on the composer glass (mockup child 3). The rim of the composer bends what
 * scrolls under it, like the edge of thick glass; the middle stays clear.
 *
 * It works through an SVG filter used as a backdrop-filter: feDisplacementMap moves each
 * backdrop pixel by a map image, where R is the x shift and G the y shift (128 = none).
 * Only Chromium supports `backdrop-filter: url(…)`; elsewhere the plain blur glass stays.
 */

/** Signed distance to a w × h rounded rectangle of radius r: negative inside, 0 on the edge. */
function roundedRectSdf(w: number, h: number, r: number) {
  return (x: number, y: number): number => {
    const qx = Math.abs(x - w / 2) - (w / 2 - r)
    const qy = Math.abs(y - h / 2) - (h / 2 - r)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  }
}

/**
 * RGBA displacement data for a w × h rounded rectangle. Within `rim` px of the edge, each pixel
 * samples inward along the inward normal, with strength (1 - d/rim)², so the rim magnifies.
 * R and G encode x and y as 128 + 127 × component. Everything else is neutral 128/128.
 */
export function lensMap(w: number, h: number, radius: number, rim: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  const sdf = roundedRectSdf(w, h, radius)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const cx = x + 0.5
      const cy = y + 0.5
      const d = -sdf(cx, cy) // depth inside the shape
      let dx = 0
      let dy = 0
      if (d > 0 && d < rim) {
        const t = (1 - d / rim) ** 2
        // The SDF gradient points outward; sample the other way.
        const gx = sdf(cx + 1, cy) - sdf(cx - 1, cy)
        const gy = sdf(cx, cy + 1) - sdf(cx, cy - 1)
        const n = Math.hypot(gx, gy) || 1
        dx = (-gx / n) * t
        dy = (-gy / n) * t
      }
      data[i] = 128 + 127 * dx
      data[i + 1] = 128 + 127 * dy
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  return data
}

/** The map as a PNG data URL for feImage, or null where there is no 2D canvas. */
export function lensMapUrl(w: number, h: number, radius: number, rim: number): string | null {
  if (w < 1 || h < 1) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(w, h)
  img.data.set(lensMap(w, h, radius, rim))
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL()
}

/**
 * Whether `backdrop-filter` takes an SVG filter reference. True only in Chromium.
 *
 * CSS.supports alone is not enough: it checks only that the value parses, and Firefox and Safari
 * parse `url(#x)` but then render no backdrop at all (no blur, only the tint). So it also needs a
 * Chromium-only signal: `navigator.userAgentData` (Chrome, Edge, Samsung Internet; secure contexts,
 * which GitHub Pages and localhost are).
 */
export function supportsBackdropUrl(): boolean {
  const chromium = typeof navigator !== 'undefined' && 'userAgentData' in navigator
  return (
    chromium && typeof CSS !== 'undefined' && typeof CSS?.supports === 'function' && CSS.supports('backdrop-filter', 'url(#x)')
  )
}
