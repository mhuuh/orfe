import { test as base, expect, type Page, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'

export { expect }

const models = JSON.parse(readFileSync(new URL('../src/lib/__fixtures__/models.json', import.meta.url), 'utf8')) as { id: string }[]

export const MODEL_A = 'anthropic/claude-sonnet-5.5'
/** MODEL_A can take tools. No tools go out unless a test adds an ability. */
const withTools = models.map((m) => (m.id === MODEL_A ? { ...m, supported_parameters: ['tools'] } : m))
export const MODEL_B = 'openai/gpt-6'
export const MODEL_B_NAME = 'OpenAI: GPT-6'
/** A user message containing this word gets the slow stream (one chunk, then it hangs). */
export const SLOW = 'SLOWSTREAM'
export const PARTIAL = 'Partial words so far'
/** The last user message `TOOLCALL:<name>:<json>` makes the mock ask for that call. The next request gets text. */
export const TOOLCALL = 'TOOLCALL'
/** `TWOCALLS:<first>:<second>` makes the mock ask for both in one round, with no arguments. */
export const TWOCALLS = 'TWOCALLS'

export interface ChatBody {
  model: string
  session_id: string
  messages: { role: string; content: unknown; tool_calls?: { id: string; function: { name: string } }[]; tool_call_id?: string }[]
  tools?: unknown[]
  tool_choice?: string
}

export interface Api {
  /** Every /chat/completions request body, in order. */
  chats: ChatBody[]
}

const sse = (chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
const delta = (content: string) => ({ choices: [{ delta: { content } }] })
const usage = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }

/** The SSE chunks for a tool call, when the request ends on a user message that asks for one. */
function toolCallChunks(body: ChatBody, n: number): unknown[] | null {
  const last = body.messages[body.messages.length - 1]
  if (last?.role !== 'user' || typeof last.content !== 'string') return null
  const asks = (...calls: { name: string; arguments: string }[]) => [
    { choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, id: i === 0 ? `call_${n}` : `call_${n}_${i}`, function: c })) } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    usage,
  ]
  const two = new RegExp(`${TWOCALLS}:([^:]+):(.+)`).exec(last.content)
  if (two) return asks({ name: two[1], arguments: '{}' }, { name: two[2], arguments: '{}' })
  const m = new RegExp(`${TOOLCALL}:([^:]+):(.*)`, 's').exec(last.content)
  if (!m) return null
  return asks({ name: m[1], arguments: m[2] })
}

const cors ={ 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

/**
 * route.fulfill cannot stream, so the slow case is faked in the page instead: fetch is wrapped
 * so a request carrying SLOW returns one SSE chunk and then hangs until the app aborts it.
 * (route.continue cannot redirect to a local http server: the protocol must match.)
 */
const slowFetchScript = ({ marker, partial }: { marker: string; partial: string }): void => {
  const real = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? init.body : ''
    if (!url.endsWith('/chat/completions') || !body.includes(marker)) return real(input, init)
    const signal = init?.signal
    const enc = new TextEncoder()
    const chunk = (text: string) => enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}

`)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // The app saves progress at most every 200 ms and only when an event arrives,
        // so the second chunk comes later to get the partial text written.
        controller.enqueue(chunk(partial.slice(0, 7)))
        const timer = setTimeout(() => controller.enqueue(chunk(partial.slice(7))), 450)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          controller.error(new DOMException('Aborted', 'AbortError'))
        })
      },
    })
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  }
}

export const test = base.extend<{ api: Api }>({
  api: [
    async ({ page }, use) => {
    const api: Api = { chats: [] }
    let n = 0
    await page.addInitScript(slowFetchScript, { marker: SLOW, partial: PARTIAL })

    await page.route('https://openrouter.ai/api/v1/**', async (route: Route) => {
      const req = route.request()
      const path = new URL(req.url()).pathname.replace('/api/v1', '')
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      if (path === '/key') return json({ data: { limit: 10, limit_remaining: 9, usage: 1 } })
      if (path === '/models') return json({ data: withTools })
      if (path === '/chat/completions') {
        const body = JSON.parse(req.postData() ?? '{}') as ChatBody
        api.chats.push(body)
        n += 1
        return route.fulfill({
          status: 200,
          headers: { ...cors, 'content-type': 'text/event-stream' },
          body: sse(
            toolCallChunks(body, n) ?? [
              delta(`Reply ${n} `),
              delta(`from ${body.model}`),
              { choices: [{ delta: {}, finish_reason: 'stop' }] },
              usage,
            ],
          ),
        })
      }
      return route.fulfill({ status: 404, body: '{}' })
    })
    await use(api)
    },
    { auto: true },
  ],
})

/** Opens the app, pastes a key and waits for the composer. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('')
  await page.getByLabel('OpenRouter key').fill('sk-or-v1-test')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

/** Types a message and taps send. */
export async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: /^Send/ }).click()
}
