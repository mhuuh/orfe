// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchKeyInfo, fetchModels, mergeReasoning, streamChat, type ChatRequest, type StreamEvent } from './openrouter'

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
    expect(await run()).toEqual([{ type: 'error', kind: 'network', message: 'Failed to fetch' }])
  })

  it('tags a connection drop mid-stream as a network error, after the text that arrived', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        // First read gives a chunk; the next one fails like Android dropping the socket.
        if (pulls++ === 0) c.enqueue(enc.encode(ev({ choices: [{ delta: { content: 'half' } }] })))
        else c.error(new TypeError('network error'))
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    expect(await run()).toEqual([
      { type: 'content', text: 'half' },
      { type: 'error', kind: 'network', message: 'network error' },
    ])
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

  it('sends cache_control when given', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    await run({ ...req, cacheControl: { type: 'ephemeral', ttl: '1h' } })
    await run({ ...req, cacheControl: { type: 'ephemeral' } })
    await run()
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string))
    expect(bodies[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(bodies[1].cache_control).toEqual({ type: 'ephemeral' })
    expect('cache_control' in bodies[2]).toBe(false)
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

describe('streamChat tool calls', () => {
  const tc = (index: number, f: Record<string, unknown>, id?: string) => ({ index, ...(id ? { id, type: 'function' } : {}), function: f })

  it('joins tool call arguments split across chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ev({ choices: [{ delta: { tool_calls: [tc(0, { name: 'note_read', arguments: '' }, 'call_1')] } }] }),
          ev({ choices: [{ delta: { tool_calls: [tc(0, { arguments: '{"ti' })] } }] }),
          ev({ choices: [{ delta: { tool_calls: [tc(0, { arguments: 'tle":"A"}' })] } }] }),
          ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
      ),
    )
    const events = await run()
    expect(events).toEqual([
      { type: 'tool_calls', calls: [{ id: 'call_1', name: 'note_read', arguments: '{"title":"A"}' }] },
      { type: 'finish', reason: 'tool_calls' },
    ])
  })

  it('keeps two parallel calls apart by index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ev({ choices: [{ delta: { tool_calls: [tc(0, { name: 'a', arguments: '{"x"' }, 'c0'), tc(1, { name: 'b', arguments: '{"y"' }, 'c1')] } }] }),
          ev({ choices: [{ delta: { tool_calls: [tc(1, { arguments: ':2}' })] } }] }),
          ev({ choices: [{ delta: { tool_calls: [tc(0, { arguments: ':1}' })] } }] }),
          ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        ]),
      ),
    )
    const events = await run()
    expect(events[0]).toEqual({
      type: 'tool_calls',
      calls: [
        { id: 'c0', name: 'a', arguments: '{"x":1}' },
        { id: 'c1', name: 'b', arguments: '{"y":2}' },
      ],
    })
  })

  it('a non-streamed reply yields tool_calls too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'a', arguments: '{}' } }] },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    )
    const events = await run({ ...req, stream: false })
    expect(events).toEqual([
      { type: 'tool_calls', calls: [{ id: 'c9', name: 'a', arguments: '{}' }] },
      { type: 'finish', reason: 'tool_calls' },
    ])
  })

  it('passes a call with no id or broken arguments through as strings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ev({ choices: [{ delta: { tool_calls: [tc(0, { name: 'a', arguments: '{"x"' })] } }] }),
          ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        ]),
      ),
    )
    const events = await run()
    expect(events[0]).toEqual({ type: 'tool_calls', calls: [{ id: '', name: 'a', arguments: '{"x"' }] })
  })

  it('sends tools and tool_choice, and neither when absent', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    await run()
    const plain = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(plain).not.toHaveProperty('tools')
    expect(plain).not.toHaveProperty('tool_choice')
    const def = { name: 'note_read', description: 'Read a note.', parameters: { type: 'object', properties: {} } }
    await run({ ...req, tools: [def], toolChoice: 'auto' })
    const raw = fetchMock.mock.calls[1][1].body as string
    const withTools = JSON.parse(raw)
    expect(withTools.tools).toEqual([{ type: 'function', function: def }])
    expect(withTools.tool_choice).toBe('auto')
    expect(raw).toContain('"function":{"name":"note_read","description":"Read a note.","parameters"')
  })

  it('sends no tool_choice for an empty tools list', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    await run({ ...req, tools: [], toolChoice: 'auto' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
  })
})

describe('mergeReasoning', () => {
  it('joins by index and never across', () => {
    const a = [{ type: 'reasoning.text', index: 0, text: 'ab' }]
    const out = mergeReasoning(a, [
      { type: 'reasoning.text', index: 0, text: 'cd', signature: 'sg' },
      { type: 'reasoning.text', index: 1, text: 'x' },
      { type: 'reasoning.summary', index: 1, summary: 'y' },
      { type: 'reasoning.text', index: 0, signature: 'n' },
    ])
    expect(out).toEqual([
      { type: 'reasoning.text', index: 0, text: 'abcd', signature: 'sgn' },
      { type: 'reasoning.text', index: 1, text: 'x', summary: 'y' },
    ])
    expect(a).toEqual([{ type: 'reasoning.text', index: 0, text: 'ab' }])
  })

  it('keeps a delta with no index as its own entry', () => {
    const out = mergeReasoning([{ type: 'reasoning.text', text: 'a' }], [{ type: 'reasoning.text', text: 'b' }])
    expect(out).toEqual([
      { type: 'reasoning.text', text: 'a' },
      { type: 'reasoning.text', text: 'b' },
    ])
  })
})

describe('GET requests', () => {
  it('send attribution headers but no Content-Type (there is no body)', async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) =>
      new Response(JSON.stringify(url.includes('/key') ? { data: { usage: 1 } } : { data: [] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await fetchModels()
    await fetchKeyInfo('sk-test')
    for (const [, init] of fetchMock.mock.calls) {
      const h = init.headers as Record<string, string>
      expect('Content-Type' in h).toBe(false)
      expect(h['HTTP-Referer']).toBe('https://mhuuh.github.io/orfe/')
      expect(h['X-OpenRouter-Title']).toBe('ORFE')
      expect(h['X-OpenRouter-App-Visibility']).toBe('hidden')
    }
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>)['Authorization']).toBeUndefined()
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test')
  })
})
