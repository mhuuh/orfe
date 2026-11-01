import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import taskLists from 'markdown-it-task-lists'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
md.use(footnote).use(taskLists)

// The task-list plugin emits <input type="checkbox">, which the allowlist drops.
// Swap it for a styled span so the checked state survives sanitising.
const CHECKBOX = /^<input class="task-list-item-checkbox"( checked="")? disabled="" type="checkbox">$/
md.core.ruler.after('github-task-lists', 'orfe-task-box', (state) => {
  for (const block of state.tokens) {
    for (const t of block.children ?? []) {
      if (t.type !== 'html_inline') continue
      const m = CHECKBOX.exec(t.content)
      if (m) t.content = m[1] ? '<span class="task-box done" title="done"></span>' : '<span class="task-box" title="to do"></span>'
    }
  }
})

// Wide tables scroll inside their own box instead of widening the page.
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n'
md.renderer.rules.table_close = () => '</table></div>\n'

const ALLOWED_TAGS = [
  'p', 'br', 'b', 'i', 'u', 's', 'em', 'strong', 'mark', 'small', 'sub', 'sup', 'kbd', 'code', 'pre',
  'blockquote', 'hr', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'details', 'summary',
]
const ALLOWED_ATTR = ['href', 'title', 'class', 'style']

// Spec 7.1. A remote url() in a style loads with no click, so a reply could carry
// private text to any server. Each declaration is rebuilt only from what passes here.
const STYLE_PROPS = new Set([
  'color', 'background', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'line-height', 'text-align', 'text-decoration', 'text-transform',
  'border', 'border-radius', 'padding', 'margin', 'opacity', 'display', 'width', 'max-width',
])
const STYLE_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'lab', 'lch', 'oklab', 'oklch', 'color-mix',
  'linear-gradient', 'radial-gradient', 'calc', 'min', 'max', 'clamp',
])
// Backslashes are CSS escapes (u\72l is url); the rest can't appear in a value we allow.
const STYLE_FORBIDDEN = /[\\<>@{}!]|\/\*/
const FONT_SIZE = /^(\d*\.?\d+)(px|em|rem)$/
const MAX_FONT_PX = 48

function safeDeclaration(prop: string, value: string): boolean {
  if (!STYLE_PROPS.has(prop) || !value || STYLE_FORBIDDEN.test(value)) return false
  for (const [, name] of value.matchAll(/([a-z-]*)\s*\(/gi)) {
    if (!STYLE_FUNCTIONS.has(name.toLowerCase())) return false
  }
  if (prop === 'display') return value === 'block' || value === 'inline-block'
  if (prop === 'margin') return !value.includes('-')
  if (prop === 'font-size') {
    const m = FONT_SIZE.exec(value)
    return !!m && Number(m[1]) * (m[2] === 'px' ? 1 : 16) <= MAX_FONT_PX
  }
  return true
}

function safeStyle(style: string): string {
  return style
    .split(';')
    .map((part) => {
      const colon = part.indexOf(':')
      if (colon < 0) return ''
      const prop = part.slice(0, colon).trim().toLowerCase()
      const value = part.slice(colon + 1).trim()
      return safeDeclaration(prop, value) ? `${prop}: ${value}` : ''
    })
    .filter(Boolean)
    .join('; ')
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.hasAttribute('style')) {
    const style = safeStyle(node.getAttribute('style') ?? '')
    if (style) node.setAttribute('style', style)
    else node.removeAttribute('style')
  }
  if (node.tagName !== 'A') return
  const href = (node.getAttribute('href') ?? '').trim()
  // The app routes on location.hash, so an in-page link (footnotes, or a raw
  // "#/c/<id>") would switch or lose the chat. Ids are stripped anyway, so
  // such links could never reach a target: keep the text, drop the link.
  if (href.startsWith('#')) {
    node.removeAttribute('href')
    return
  }
  node.setAttribute('target', '_blank')
  node.setAttribute('rel', 'noopener noreferrer')
})

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(md.render(src), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  })
}
