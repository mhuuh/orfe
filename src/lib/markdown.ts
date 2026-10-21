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
// `style` passes through unchanged for now; Plan 5 swaps in the property allowlist (spec 7.1).
const ALLOWED_ATTR = ['href', 'title', 'class', 'style']

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
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
