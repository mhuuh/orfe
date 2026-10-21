// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamChat, type ChatRequest, type StreamEvent } from './openrouter'

const enc = new TextEncoder()

function sseResponse(lines: string[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(lines.join('')))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

const req: ChatRequest = {
  model: 'anthropic/claude-x',
  messages: [{ role: 'user', content: 'hi' }],
  sessionId: 'sess-1',
  stream: true,
}

async function run(r: ChatRequest = req): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of streamChat(r, 'sk-test', new AbortController().signal)) out.push(e)
  return out
}

afterEach(() => vi.unstubAllGlobals())

describe('streamChat', () => {
  it('maps content, reasoning, usage and finish events in order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ': OPENROUTER PROCESSING\n\n',
          ev({ choices: [{ delta: { reasoning: 'think ' } }] }),
          ev({ choices: [{ delta: { reasoning: 'more', reasoning_details: [{ type: 'reasoning.text', text: 'more' }] } }] }),
          ev({ choices: [{ delta: { content: 'Hel' } }] }),
          ev({ choices: [{ delta: { content: 'lo' } }] }),
          ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          ev({
            choices: [],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 50,
              cost: 0.0123,
              prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 10 },
              completion_tokens_details: { reasoning_tokens: 20 },
            },
          }),
          'data: [DONE]\n\n',
        ]),
      ),
    )
    const events = await run()
    expect(events.map((e) => e.type)).toEqual(['reasoning', 'reasoning', 'content', 'content', 'finish', 'usage'])
    expect(events[0]).toEqual({ type: 'reasoning', text: 'think ' })
    expect(events[1]).toMatchObject({ type: 'reasoning', text: 'more', details: [{ type: 'reasoning.text', text: 'more' }] })
    expect(events[4]).toEqual({ type: 'finish', reason: 'stop' })
    const usage = events[5]
    if (usage.type !== 'usage') throw new Error('expected usage')
    expect(usage.usage.cachedTokens).toBe(900)
    expect(usage.usage.cost).toBe(0.0123)
    expect(usage.usage).toEqual({
      promptTokens: 1000,
      completionTokens: 50,
      cachedTokens: 900,
      cacheWriteTokens: 10,
      reasoningTokens: 20,
      cost: 0.0123,
    })
  })

  it('emits meta from the response headers first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([ev({ choices: [{ delta: { content: 'x' } }] }), 'data: [DONE]\n\n'], {
          headers: { 'X-Generation-Id': 'gen-1', 'X-Provider-Name': 'Anthropic' },
        }),
      ),
    )
    const events = await run()
    expect(events[0]).toEqual({ type: 'meta', generationId: 'gen-1', provider: 'Anthropic' })
    expect(events[1]).toEqual({ type: 'content', text: 'x' })
  })

  it('yields a single error event for HTTP 401 with the body message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 401, message: 'No auth credentials found' } }), { status: 401 })),
    )
    expect(await run()).toEqual([{ type: 'error', code: 401, message: 'No auth credentials found' }])
  })

  it('yields error for non-JSON HTTP failure bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })))
    expect(await run()).toEqual([{ type: 'error', code: 502, message: 'HTTP 502' }])
  })

  it('yields error for mid-stream error object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ev({ choices: [{ delta: { content: 'part' } }] }),
          ev({ error: { code: 502, message: 'Provider disconnected' }, choices: [{ delta: {}, finish_reason: 'error' }] }),
          'data: [DONE]\n\n',
        ]),
      ),
    )
    const events = await run()
    expect(events).toEqual([
      { type: 'content', text: 'part' },
      { type: 'error', code: 502, message: 'Provider disconnected' },
    ])
  })

  it('yields a network error event when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    expect(await run()).toEqual([{ type: 'error', message: 'Failed to fetch' }])
  })

  it('rethrows AbortError so the caller sees the abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('sends session_id, stream, reasoning and attribution headers', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    await run({ ...req, reasoning: { effort: 'high' } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      model: 'anthropic/claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      session_id: 'sess-1',
      reasoning: { effort: 'high' },
    })
    expect('provider' in body).toBe(false)
    const h = init.headers as Record<string, string>
    expect(h['Authorization']).toBe('Bearer sk-test')
    expect(h['HTTP-Referer']).toBe('https://mhuuh.github.io/orfe/')
    expect(h['X-OpenRouter-Title']).toBe('ORFE')
    expect(h['X-OpenRouter-App-Visibility']).toBe('hidden')
    expect(h['Content-Type']).toBe('application/json')
  })

  it('omits reasoning and provider from the body when undefined', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect('reasoning' in body).toBe(false)
    expect('provider' in body).toBe(false)
  })

  it('non-streaming mode yields content, reasoning, usage, finish from JSON', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 'gen-9',
            choices: [
              {
                message: { role: 'assistant', content: 'Hello', reasoning: 'hmm', reasoning_details: [{ type: 'reasoning.text', text: 'hmm' }] },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              cost: 0.001,
              prompt_tokens_details: { cached_tokens: 4 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          }),
          { status: 200, headers: { 'X-Generation-Id': 'gen-9' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const events = await run({ ...req, stream: false })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).stream).toBe(false)
    expect(events).toEqual([
      { type: 'meta', generationId: 'gen-9' },
      { type: 'reasoning', text: 'hmm', details: [{ type: 'reasoning.text', text: 'hmm' }] },
      { type: 'content', text: 'Hello' },
      { type: 'finish', reason: 'stop' },
      {
        type: 'usage',
        usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 4, cacheWriteTokens: 0, reasoningTokens: 2, cost: 0.001 },
      },
    ])
  })
})
