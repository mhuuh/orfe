/**
 * Reads a Server-Sent Events body and yields each `data:` payload string.
 * Comment lines (starting with ":") are skipped. Stops at `[DONE]`.
 * Bytes are decoded with a streaming TextDecoder, so multi-byte characters
 * split across chunks stay intact; lines are buffered until a newline arrives.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        const payload = dataPayload(line)
        if (payload === null) continue
        if (payload === '[DONE]') return
        yield payload
      }
    }
    // Stream ended without a trailing newline: flush the last line.
    const payload = dataPayload(buffer.replace(/\r$/, ''))
    if (payload !== null && payload !== '[DONE]') yield payload
  } finally {
    // Cancel the underlying stream on early exit ([DONE], caller break, error).
    await reader.cancel().catch(() => undefined)
  }
}

function dataPayload(line: string): string | null {
  if (!line.startsWith('data:')) return null // comments (":"), blanks, other fields
  const rest = line.slice(5)
  return rest.startsWith(' ') ? rest.slice(1) : rest
}
