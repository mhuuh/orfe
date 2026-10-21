// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { sseData } from './sse'

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c)
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const p of sseData(body)) out.push(p)
  return out
}

describe('sseData', () => {
  it('yields data payloads and stops at [DONE]', async () => {
    const out = await collect(streamOf('data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\ndata: {"a":3}\n\n'))
    expect(out).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('skips comment lines like ": OPENROUTER PROCESSING"', async () => {
    const out = await collect(streamOf(': OPENROUTER PROCESSING\n\ndata: {"a":1}\n\n: keep-alive\n\ndata: [DONE]\n\n'))
    expect(out).toEqual(['{"a":1}'])
  })

  it('parses events split across chunk and UTF-8 boundaries', async () => {
    const json = '{"t":"Hyvää päivää 🌙"}'
    const bytes = new TextEncoder().encode(`data: ${json}\n\n`)
    const cut1 = bytes.indexOf(0xc3) + 1 // inside the first ä
    const cut2 = bytes.indexOf(0xf0) + 2 // inside the emoji
    const chunks = [bytes.slice(0, cut1), bytes.slice(cut1, cut2), bytes.slice(cut2)]
    const out = await collect(streamOf(...chunks))
    expect(out).toEqual([json])
  })

  it('handles \r\n line endings', async () => {
    const out = await collect(streamOf('data: {"a":1}\r\n\r\n: c\r\n\r\ndata: {"a":2}\r\n\r\ndata: [DONE]\r\n\r\n'))
    expect(out).toEqual(['{"a":1}', '{"a":2}'])
  })
})
