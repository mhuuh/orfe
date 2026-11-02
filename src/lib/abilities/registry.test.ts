import { afterEach, describe, expect, it } from 'vitest'
import type { ModelInfo } from '../catalog'
import { fallbackModelInfo } from '../catalog'
import type { Conversation, Prompt, ToolPart } from '../types'
import { UNCHECKED } from './outcome'
import {
  ABILITIES,
  type Ability,
  type AbilityCtx,
  abilityOn,
  describeStep,
  enabledAbilities,
  needsOk,
  runTool,
  setAbilitiesForTest,
  toolsFor,
  writesNotes,
} from './registry'

const model: ModelInfo = { ...fallbackModelInfo('m/x'), tools: true }
const ctx = {
  conversationId: 'c',
  messageId: 'm',
  callId: 'k',
  model: 'm/x',
  key: 'k',
  signal: new AbortController().signal,
} as AbilityCtx

function conv(over: Partial<Conversation> = {}): Conversation {
  return { abilities: null, plain: false, ...over } as Conversation
}

function fake(id: string, tools: string[], run?: Ability['run']): Ability {
  return {
    id,
    title: id,
    summary: id,
    tools: tools.map((name) => ({ name, description: `d ${name}`, parameters: { type: 'object' } })),
    run: run ?? (async (n) => `ran ${n}`),
    describe: (p) => ({ running: `doing ${p.name}…`, done: `did ${p.name}`, past: `(Did ${p.name}.)` }),
    traits: {},
  }
}

const part = (name: string): ToolPart => ({
  type: 'tool',
  callId: 'k',
  round: 0,
  model: 'm',
  name,
  args: {},
  result: '',
  status: 'done',
})

afterEach(() => setAbilitiesForTest())

describe('registry', () => {
  it('toolsFor gives byte-identical JSON on every call', () => {
    setAbilitiesForTest([fake('a', ['a1', 'a2']), fake('b', ['b1'])])
    const one = toolsFor(conv(), null, model)!
    const two = toolsFor(conv(), null, model)!
    expect(one.json).toBe(two.json)
    expect(one.hash).toBe(two.hash)
    expect(one.tools.map((t) => t.name)).toEqual(['a1', 'a2', 'b1'])
    expect(Object.keys(JSON.parse(one.json)[0])).toEqual(['name', 'description', 'parameters'])
  })

  it('toolsFor is null for a model without tools', () => {
    setAbilitiesForTest([fake('a', ['a1'])])
    expect(toolsFor(conv(), null, { ...model, tools: false })).toBeNull()
  })

  it('a switched-off ability leaves the list', () => {
    setAbilitiesForTest([fake('a', ['a1']), fake('b', ['b1'])])
    const c = conv({ abilities: { a: false } })
    expect(enabledAbilities(c, null).map((a) => a.id)).toEqual(['b'])
    expect(toolsFor(c, null, model)!.tools.map((t) => t.name)).toEqual(['b1'])
  })

  it('c.abilities wins over the prompt, and the prompt over the defaults', () => {
    setAbilitiesForTest([fake('a', ['a1']), fake('b', ['b1'])])
    const p = { id: 'p', name: 'p', parentId: null, text: '', updatedAt: 0, versionHash: '', abilities: { a: false } } satisfies Prompt
    expect(enabledAbilities(conv(), null).map((a) => a.id)).toEqual(['a', 'b'])
    expect(enabledAbilities(conv(), p).map((a) => a.id)).toEqual(['b'])
    expect(enabledAbilities(conv({ abilities: { b: false } }), p).map((a) => a.id)).toEqual(['a'])
  })

  it('a plain chat has no abilities and no tools, whatever its switches say', () => {
    setAbilitiesForTest([fake('a', ['a1'])])
    const c = conv({ plain: true, abilities: { a: true } })
    expect(enabledAbilities(c, null)).toEqual([])
    expect(toolsFor(c, null, model)).toBeNull()
  })

  it('runTool returns a readable error for an unknown tool', async () => {
    const out = await runTool('nope', '{}', ctx, [fake('a', ['a1'])])
    expect(out).toContain('nope')
    expect(out).toContain('a1')
  })

  it('runTool returns a readable error for bad JSON, naming the tool', async () => {
    const out = await runTool('a1', '{oops', ctx, [fake('a', ['a1'])])
    expect(out).toContain('a1')
    expect(out).toContain('JSON')
  })

  it('runTool returns a readable error when run throws', async () => {
    const a = fake('a', ['a1'], async () => {
      throw new Error('disk gone')
    })
    const out = await runTool('a1', '{}', ctx, [a])
    expect(out).toContain('a1')
    expect(out).toContain('disk gone')
  })

  it('runTool runs a known tool', async () => {
    expect(await runTool('a1', '{}', ctx, [fake('a', ['a1'])])).toBe('ran a1')
  })

  it('describeStep falls back to the tool name for an unknown tool', () => {
    expect(describeStep(part('mystery'))).toEqual({
      running: 'mystery…',
      done: 'mystery',
      past: '(Used mystery.)',
    })
    setAbilitiesForTest([fake('a', ['a1'])])
    expect(describeStep(part('a1')).done).toBe('did a1')
  })

  it('the fallback words do not read as finished for a step that did not finish', () => {
    const words = (over: Partial<ToolPart>) => describeStep({ ...part('mystery'), ...over })
    expect(words({ status: 'error', result: 'Error: no.' })).toMatchObject({ done: 'mystery failed', past: '(Tried mystery. It failed.)' })
    expect(words({ status: 'stopped' })).toMatchObject({ done: 'mystery stopped', past: '(Stopped mystery before it finished.)' })
    const doubt = '(Started mystery. It may or may not have happened.)'
    expect(words({ status: 'running' }).past).toBe(doubt)
    expect(words({ status: 'error', result: UNCHECKED }).past).toBe(doubt)
  })

  it('a reset brings back the abilities that ship', () => {
    setAbilitiesForTest([])
    expect(ABILITIES).toEqual([])
    setAbilitiesForTest()
    expect(ABILITIES.map((a) => a.id)).toEqual(['notes'])
  })
})

describe('switches and the trust gate', () => {
  const step = (name: string, status: ToolPart['status'] = 'done'): ToolPart => ({
    type: 'tool',
    callId: name,
    round: 0,
    model: 'm/x',
    name,
    args: {},
    result: 'x',
    status,
  })

  it('abilityOn reads the chat, then the prompt, then on. Plain does not change a switch', () => {
    const p = { abilities: { a: false } } as unknown as Prompt
    expect(abilityOn(conv(), null, 'a')).toBe(true)
    expect(abilityOn(conv(), p, 'a')).toBe(false)
    expect(abilityOn(conv({ abilities: { a: true } }), p, 'a')).toBe(true)
    expect(abilityOn(conv({ abilities: { a: false }, plain: true }), null, 'a')).toBe(false)
    expect(abilityOn(conv({ abilities: { a: true }, plain: true }), null, 'a')).toBe(true)
  })

  it('the shipped notes tools that change a note are the writes', () => {
    const names = ['notes_search', 'notes_read', 'notes_write', 'notes_edit', 'notes_delete']
    expect(names.filter(writesNotes)).toEqual(['notes_write', 'notes_edit', 'notes_delete'])
  })

  it('needsOk holds a write or an outward tool after an untrusted result, and nothing else', () => {
    setAbilitiesForTest([
      { ...fake('web', ['web']), traits: { untrusted: true } },
      { ...fake('out', ['out']), traits: { outward: true } },
      { ...fake('note', ['save', 'read']), writes: ['save'] },
    ])
    const read = [step('web')]
    expect(needsOk('save', ABILITIES, read)).toBe(true)
    expect(needsOk('out', ABILITIES, read)).toBe(true)
    expect(needsOk('read', ABILITIES, read)).toBe(false)
    expect(needsOk('web', ABILITIES, read)).toBe(false)
    expect(needsOk('save', ABILITIES, [])).toBe(false)
    expect(needsOk('save', ABILITIES, [step('read')])).toBe(false)
    // An error can still quote what it read. A stopped or open call gave nothing.
    expect(needsOk('save', ABILITIES, [step('web', 'error')])).toBe(true)
    expect(needsOk('save', ABILITIES, [step('web', 'stopped')])).toBe(false)
    expect(needsOk('save', ABILITIES, [step('web', 'running')])).toBe(false)
    // A tool that is switched off has nothing to hold: `runTool` refuses it.
    expect(needsOk('save', ABILITIES.filter((a) => a.id !== 'note'), read)).toBe(false)
    // An untrusted result still counts after its own ability went off.
    expect(needsOk('save', ABILITIES.filter((a) => a.id !== 'web'), read)).toBe(true)
  })

  it('nothing shipped is untrusted, so the gate stays closed', () => {
    expect(ABILITIES.filter((a) => a.traits.untrusted)).toEqual([])
    expect(needsOk('notes_write', ABILITIES, [step('notes_read')])).toBe(false)
  })
})
