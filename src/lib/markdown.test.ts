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

  it('keeps inline span style for now', () => {
    const el = dom(renderMarkdown('a <span style="color: #c96; font-style: italic">warm</span> word'))
    const span = el.querySelector('span')
    expect(span?.getAttribute('style')).toBe('color: #c96; font-style: italic')
  })
})
