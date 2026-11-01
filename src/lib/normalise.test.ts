import { afterEach, describe, expect, it } from 'vitest'
import { setAbilitiesForTest, type Ability } from './abilities/registry'
import { setModelRulesForTest } from './modelRules'
import { buildOutgoing, renderRounds } from './normalise'
import type { OutMessage } from './openrouter'
import type { ContentPart, Message, Role, ToolPart, Version } from './types'

let n = 0
function ver(content: ContentPart[], extra: Partial<Version> = {}): Version {
  return { id: `v${++n}`, content, status: 'done', createdAt: 0, ...extra }
}
function msg(
  id: string,
  role: Role,
  text: string | ContentPart[],
  extra: Partial<Message> = {},
): Message {
  const content: ContentPart[] = typeof text === 'string' ? [{ type: 'text', text }] : text
  return {
    id,
    conversationId: 'c',
    order: Number(id.replace(/\D/g, '')) || 0,
    role,
    versions: [ver(content)],
    activeVersion: 0,
    pinned: false,
    createdAt: 0,
    ...extra,
  }
}
const base = {
  system: null,
  windowStartId: null,
  inputModalities: ['text'],
  blobUrl: () => undefined,
  modelId: 'm/a',
  toolsEnabled: false,
}

describe('buildOutgoing', () => {
  it('rule 1: uses active versions and only messages from windowStart on, plus pinned messages before it in original order', () => {
    const m2 = msg('m2', 'assistant', 'old2', { pinned: true })
    m2.versions.push(ver([{ type: 'text', text: 'new2' }]))
    m2.activeVersion = 1
    const messages = [
      msg('m1', 'user', 'u1'),
      m2,
      msg('m3', 'user', 'u3'),
      msg('m4', 'assistant', 'a4'),
      msg('m5', 'user', 'u5'),
    ]
    const out = buildOutgoing(messages, { ...base, windowStartId: 'm4' })
    expect(out).toEqual([
      { role: 'user', content: '…' },
      { role: 'assistant', content: 'new2\n\na4' },
      { role: 'user', content: 'u5' },
    ])
    // unsorted input and unknown window start
    const all = buildOutgoing([messages[4], messages[0], messages[1]], { ...base, windowStartId: 'nope' })
    expect(all.map((o) => o.content)).toEqual(['u1', 'new2', 'u5'])
  })

  it('rule 2: drops dividers and empty messages', () => {
    const out = buildOutgoing(
      [
        msg('m1', 'user', 'hi'),
        msg('m2', 'divider', 'label'),
        msg('m3', 'assistant', '   \n '),
        msg('m4', 'assistant', 'yo'),
      ],
      base,
    )
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ])
  })

  it('rule 3: merges consecutive same-role messages with a blank line', () => {
    const out = buildOutgoing([msg('m1', 'user', 'a'), msg('m2', 'user', 'b')], base)
    expect(out).toEqual([{ role: 'user', content: 'a\n\nb' }])
  })

  it('rule 4: inserts "…" user turn when first non-system message is assistant', () => {
    const out = buildOutgoing([msg('m1', 'assistant', 'hello')], { ...base, system: 'sys' })
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '…' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('rule 5: never includes reasoning', () => {
    const m = msg('m1', 'assistant', 'answer')
    m.versions[0].reasoning = { text: 'secret thoughts', details: [{ a: 1 }], durationMs: 5 }
    const json = JSON.stringify(buildOutgoing([msg('m0', 'user', 'q'), m], base))
    expect(json).not.toContain('reasoning')
    expect(json).not.toContain('secret thoughts')
  })

  it('rule 6: prepends system message when system is non-empty; omits it when null or empty', () => {
    const ms = [msg('m1', 'user', 'hi')]
    expect(buildOutgoing(ms, { ...base, system: 'be nice' })[0]).toEqual({ role: 'system', content: 'be nice' })
    expect(buildOutgoing(ms, { ...base, system: null })[0].role).toBe('user')
    expect(buildOutgoing(ms, { ...base, system: '' })[0].role).toBe('user')
  })

  it('rule 7: allows ending on assistant (prefill)', () => {
    const out = buildOutgoing([msg('m1', 'user', 'q'), msg('m2', 'assistant', 'Once upon')], base)
    expect(out[out.length - 1]).toEqual({ role: 'assistant', content: 'Once upon' })
  })

  it('upToId excludes the target and everything after it', () => {
    const out = buildOutgoing(
      [msg('m1', 'user', 'q'), msg('m2', 'assistant', 'a'), msg('m3', 'user', 'q2')],
      { ...base, upToId: 'm2' },
    )
    expect(out).toEqual([{ role: 'user', content: 'q' }])
  })

  it('reroll of a message at or before the window start sends everything before it', () => {
    const ms = [
      msg('m1', 'user', 'u1'),
      msg('m2', 'assistant', 'a2'),
      msg('m3', 'user', 'u3'),
      msg('m4', 'assistant', 'a4'),
      msg('m5', 'user', 'u5'),
    ]
    expect(buildOutgoing(ms, { ...base, windowStartId: 'm4', upToId: 'm2' })).toEqual([
      { role: 'user', content: 'u1' },
    ])
    expect(buildOutgoing(ms, { ...base, windowStartId: 'm4', upToId: 'm4' })).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ])
  })

  it('media-only message that maps to a stand-in is kept', () => {
    const media: ContentPart = { type: 'media', blobId: 'b1', mime: 'image/png', name: 'x.png' }
    expect(buildOutgoing([msg('m1', 'user', [media])], base)).toEqual([
      { role: 'user', content: '[image not shown to this model: "x.png"]' },
    ])
  })

  it('image then text order survives a merge', () => {
    const media: ContentPart = { type: 'media', blobId: 'b1', mime: 'image/png', name: 'x.png' }
    const out = buildOutgoing([msg('m1', 'user', [media]), msg('m2', 'user', 'after')], {
      ...base,
      inputModalities: ['image'],
      blobUrl: () => 'data:image/png;base64,Z',
    })
    expect(out[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,Z' } },
      { type: 'text', text: 'after' },
    ])
  })

  it('whitespace-only system is omitted', () => {
    expect(buildOutgoing([msg('m1', 'user', 'hi')], { ...base, system: '  \n ' })).toEqual([
      { role: 'user', content: 'hi' },
    ])
  })

  it('image becomes image_url for image-capable model and a stand-in otherwise', () => {
    const media: ContentPart = { type: 'media', blobId: 'b1', mime: 'image/jpeg', name: 'sunset.jpg' }
    const ms = [msg('m1', 'user', [{ type: 'text', text: 'look' }, media])]
    const opts = { ...base, blobUrl: (id: string) => (id === 'b1' ? 'data:image/jpeg;base64,AAA' : undefined) }
    expect(buildOutgoing(ms, { ...opts, inputModalities: ['text', 'image'] })).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
        ],
      },
    ])
    expect(buildOutgoing(ms, opts)).toEqual([
      { role: 'user', content: 'look\n\n[image not shown to this model: "sunset.jpg"]' },
    ])
    // image-capable but no data URL available: stand-in
    expect(buildOutgoing(ms, { ...base, inputModalities: ['image'] })[0].content).toContain(
      '[image not shown to this model: "sunset.jpg"]',
    )
    // other kinds, name falls back to mime
    const aud: ContentPart = { type: 'media', blobId: 'b2', mime: 'audio/mpeg' }
    const pdf: ContentPart = { type: 'media', blobId: 'b3', mime: 'application/pdf', name: 'a.pdf' }
    expect(buildOutgoing([msg('m1', 'user', [aud, pdf])], base)[0].content).toBe(
      '[audio not shown to this model: "audio/mpeg"]\n\n[file not shown to this model: "a.pdf"]',
    )
  })

  it('text-only messages are sent as plain string content, mixed ones as part arrays', () => {
    const media: ContentPart = { type: 'media', blobId: 'b1', mime: 'image/png', name: 'x.png' }
    const img = { ...base, inputModalities: ['image'], blobUrl: () => 'data:image/png;base64,Z' }
    const out = buildOutgoing(
      [msg('m1', 'user', 'plain'), msg('m2', 'assistant', 'ok'), msg('m3', 'user', [media])],
      img,
    )
    expect(typeof out[0].content).toBe('string')
    expect(typeof out[1].content).toBe('string')
    expect(Array.isArray(out[2].content)).toBe(true)
    // merging a string message with a part-array message keeps one text part then the image
    const merged = buildOutgoing([msg('m1', 'user', 'a'), msg('m2', 'user', [media])], img)
    expect(merged[0].content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,Z' } },
    ])
  })
})

function step(callId: string, extra: Partial<ToolPart> = {}): ToolPart {
  return {
    type: 'tool',
    callId,
    round: 0,
    model: 'm/a',
    name: 'lookup',
    args: { q: callId },
    result: `result of ${callId}`,
    status: 'done',
    ...extra,
  }
}
const text = (t: string): ContentPart => ({ type: 'text', text: t })
const call = (id: string) => ({ id, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ q: id }) } })
const toolMsg = (id: string): OutMessage => ({ role: 'tool', tool_call_id: id, content: `result of ${id}` })
const withTools = { ...base, toolsEnabled: true }
const inFlight = { modelId: 'm/a', toolsEnabled: true }

/** The rule a provider enforces: each tool message answers a call of the assistant before it, in order, with none left open. */
function expectPaired(out: OutMessage[]): void {
  let open: string[] = []
  for (const m of out) {
    if (m.role === 'tool') {
      expect(m.tool_call_id).toBe(open[0])
      open = open.slice(1)
      continue
    }
    expect(open).toEqual([])
    if (m.role === 'assistant' && m.tool_calls) open = m.tool_calls.map((c) => c.id)
  }
  expect(open).toEqual([])
}

describe('tool steps', () => {
  afterEach(() => {
    setAbilitiesForTest()
    setModelRulesForTest()
  })

  it('a tool step by the current model goes out as tool_calls then a tool message', () => {
    const out = buildOutgoing(
      [msg('m1', 'user', 'q'), msg('m2', 'assistant', [text('Looking.'), step('c1'), text('Found it.')])],
      withTools,
    )
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'Looking.', tool_calls: [call('c1')] },
      toolMsg('c1'),
      { role: 'assistant', content: 'Found it.' },
    ])
  })

  it('a step by another model flattens to one past-tense line', () => {
    const notes = {
      id: 'notes',
      tools: [{ name: 'lookup', description: '', parameters: {} }],
      describe: () => ({ running: '', done: '', past: "(Looked in notes for 'river': found 2 notes.)" }),
    } as unknown as Ability
    setAbilitiesForTest([notes])
    const out = buildOutgoing(
      [msg('m1', 'user', 'q'), msg('m2', 'assistant', [text('Looking.'), step('c1', { model: 'm/b' }), text('Found it.')])],
      withTools,
    )
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: "Looking.\n\n(Looked in notes for 'river': found 2 notes.)\n\nFound it." },
    ])
  })

  it('a mixed reply keeps text order around the rounds', () => {
    const content = [text('one'), step('c1'), step('c2'), text('two'), step('c3', { round: 1 }), text('three')]
    expect(renderRounds(content, inFlight)).toEqual([
      { role: 'assistant', content: 'one', tool_calls: [call('c1'), call('c2')] },
      toolMsg('c1'),
      toolMsg('c2'),
      { role: 'assistant', content: 'two', tool_calls: [call('c3')] },
      toolMsg('c3'),
      { role: 'assistant', content: 'three' },
    ])
  })

  it('tools off flattens everything', () => {
    const out = buildOutgoing([msg('m1', 'user', 'q'), msg('m2', 'assistant', [step('c1'), text('done'), step('c2')])], base)
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '(Used lookup.)\n\ndone\n\n(Used lookup.)' },
    ])
    expect(JSON.stringify(out)).not.toContain('tool_calls')
  })

  it('a reply with only tool steps renders, and the turn after it is valid', () => {
    const out = buildOutgoing(
      [msg('m1', 'user', 'q'), msg('m2', 'assistant', [step('c1')]), msg('m3', 'user', 'next')],
      withTools,
    )
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [call('c1')] },
      toolMsg('c1'),
      { role: 'user', content: 'next' },
    ])
  })

  it('every tool_calls id has a tool message, in order', () => {
    const out = buildOutgoing(
      [
        msg('m1', 'user', 'q'),
        msg('m2', 'assistant', [step('c1'), step('c2'), step('c3', { round: 1 }), text('mid'), step('c4', { round: 2, status: 'error' })]),
        msg('m3', 'user', 'next'),
        msg('m4', 'assistant', [step('c5', { model: 'm/b' }), step('c6'), step('c7', { status: 'stopped' })]),
        msg('m5', 'user', 'last'),
      ],
      withTools,
    )
    expectPaired(out)
    expect(out.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []))).toEqual(['c1', 'c2', 'c3', 'c4', 'c6', 'c7'])
  })

  it('each round is its own assistant message, so an earlier request stays a prefix', () => {
    const round0 = [step('c1')]
    const round1 = [step('c2', { round: 1 })]
    const first = renderRounds(round0, inFlight)
    const second = renderRounds([...round0, ...round1], inFlight)
    expect(second.slice(0, first.length)).toEqual(first)
    expect(second).toHaveLength(4)
  })

  it('a running step still gets a tool message, so the next request stays valid', () => {
    const out = buildOutgoing(
      [msg('m1', 'user', 'q'), msg('m2', 'assistant', [step('c1', { status: 'running', result: '' })]), msg('m3', 'user', 'next')],
      withTools,
    )
    expectPaired(out)
    const tool = out.find((m) => m.role === 'tool')
    expect(tool?.content).toMatch(/did not finish/)
  })

  it('a reply at the window start still follows a user turn', () => {
    const out = buildOutgoing([msg('m1', 'assistant', [step('c1')]), msg('m2', 'user', 'next')], { ...withTools, system: 'sys' })
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(out[1].content).toBe('…')
  })

  it('a reply with real steps does not merge into the turns around it', () => {
    const out = buildOutgoing(
      [msg('m1', 'user', 'a'), msg('m2', 'assistant', [step('c1'), text('end')]), msg('m3', 'user', 'b'), msg('m4', 'user', 'c')],
      withTools,
    )
    expect(out).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: null, tool_calls: [call('c1')] },
      toolMsg('c1'),
      { role: 'assistant', content: 'end' },
      { role: 'user', content: 'b\n\nc' },
    ])
  })

  it('a flattened reply still merges like plain text', () => {
    const out = buildOutgoing(
      [msg('m1', 'user', 'q'), msg('m2', 'assistant', 'first'), msg('m3', 'assistant', [step('c1', { model: 'm/b' })])],
      withTools,
    )
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'first\n\n(Used lookup.)' },
    ])
  })

  it('arguments always go out as a JSON object', () => {
    const argsOf = (args: unknown) => {
      const [m] = renderRounds([step('c1', { args })], inFlight)
      return m.role === 'assistant' ? m.tool_calls?.[0].function.arguments : undefined
    }
    expect(argsOf({ q: 'river' })).toBe('{"q":"river"}')
    expect(argsOf(undefined)).toBe('{}')
    expect(argsOf('{"broken')).toBe('{}')
    expect(argsOf(['a'])).toBe('{}')
  })

  it('finished replies send no reasoning_details; the turn in flight does', () => {
    const content = [step('c1'), step('c2', { round: 1 }), text('end')]
    const m2 = msg('m2', 'assistant', content)
    m2.versions[0].roundReasoning = [[{ id: 'r0' }], [{ id: 'r1' }]]
    const finished = JSON.stringify(buildOutgoing([msg('m1', 'user', 'q'), m2], withTools))
    expect(finished).not.toContain('reasoning')

    expect(renderRounds(content, { ...inFlight, reasoning: [[{ id: 'r0' }], [{ id: 'r1' }]] })).toEqual([
      { role: 'assistant', content: null, tool_calls: [call('c1')], reasoning_details: [{ id: 'r0' }] },
      toolMsg('c1'),
      { role: 'assistant', content: null, tool_calls: [call('c2')], reasoning_details: [{ id: 'r1' }] },
      toolMsg('c2'),
      { role: 'assistant', content: 'end' },
    ])
  })

  it('reasoning of a flattened round stays out, and an empty round adds no field', () => {
    const content = [step('c1', { model: 'm/b' }), step('c2', { round: 1 }), step('c3', { round: 2 })]
    const out = renderRounds(content, { ...inFlight, reasoning: [[{ id: 'foreign' }], [], [{ id: 'r2' }]] })
    expect(JSON.stringify(out)).not.toContain('foreign')
    expect(out[0]).not.toHaveProperty('reasoning_details')
    expect(out[2]).toHaveProperty('reasoning_details', [{ id: 'r2' }])
  })

  it('keepReasoning keeps it for that model only', () => {
    setModelRulesForTest([{ pattern: /^keep\//, rule: { keepReasoning: true } }])
    const reply = (model: string) => {
      const m = msg('m2', 'assistant', [step('c1', { model }), text('end')])
      m.versions[0].roundReasoning = [[{ id: 'r0' }]]
      return [msg('m1', 'user', 'q'), m]
    }
    const kept = buildOutgoing(reply('keep/x'), { ...withTools, modelId: 'keep/x' })
    expect(kept[1]).toHaveProperty('reasoning_details', [{ id: 'r0' }])
    // A stored step by that model, sent to another model, flattens and carries none.
    expect(JSON.stringify(buildOutgoing(reply('keep/x'), withTools))).not.toContain('reasoning')
    expect(JSON.stringify(buildOutgoing(reply('m/a'), withTools))).not.toContain('reasoning')
  })

  it('flattenAll and noTools flatten stored steps for that model', () => {
    setModelRulesForTest([
      { pattern: /^flat\//, rule: { flattenAll: true } },
      { pattern: /^none\//, rule: { noTools: true } },
    ])
    for (const modelId of ['flat/x', 'none/x']) {
      const ms = [msg('m1', 'user', 'q'), msg('m2', 'assistant', [step('c1', { model: modelId })])]
      expect(buildOutgoing(ms, { ...withTools, modelId })[1]).toEqual({ role: 'assistant', content: '(Used lookup.)' })
    }
  })
})
