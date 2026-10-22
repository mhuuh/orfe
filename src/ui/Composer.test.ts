import { describe, expect, it } from 'vitest'
import { fallbackModelInfo, type ModelInfo } from '../lib/catalog'
import { canStop, clean, nextEffort, promptChipLabel, sendAction, shownEffort, STOP_GRACE_MS } from './Composer'
import { modelMeta } from './ModelSheet'

const reasoning: ModelInfo = {
  ...fallbackModelInfo('anthropic/claude-sonnet-5.5'),
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
}

describe('sendAction', () => {
  it('is Stop while a reply runs, even with text typed', () => {
    expect(sendAction('hello', 'assistant', true)).toBe('stop')
  })
  it('sends when there is text', () => {
    expect(sendAction('hello', 'assistant', false)).toBe('send')
  })
  it('asks for a reply when empty after your own message', () => {
    expect(sendAction('  \n', 'user', false)).toBe('reply')
  })
  it('does nothing when empty after a reply or in a new chat', () => {
    expect(sendAction('', 'assistant', false)).toBe('none')
    expect(sendAction('', undefined, false)).toBe('none')
  })
})

describe('canStop', () => {
  it('ignores Stop right after a send (a double tap) and allows it after the grace period', () => {
    expect(canStop(1000 + 150, 1000)).toBe(false)
    expect(canStop(1000 + STOP_GRACE_MS, 1000)).toBe(true)
  })
  it('allows Stop for a reply this composer did not start', () => {
    expect(canStop(1000, -Infinity)).toBe(true)
  })
})

describe('clean', () => {
  it('drops leading blank lines and trailing space but keeps the first indent', () => {
    expect(clean('\n  \n    code()\n\n')).toBe('    code()')
  })
})

describe('effort chip', () => {
  it('shows the model default until one is chosen', () => {
    expect(shownEffort(reasoning, null)).toBe('medium')
    expect(shownEffort(reasoning, 'high')).toBe('high')
  })
  it('ignores a chosen effort the model does not offer', () => {
    expect(shownEffort(reasoning, 'minimal')).toBe('medium')
  })
  it('is absent for models without efforts', () => {
    expect(shownEffort(fallbackModelInfo('x/y'), 'high')).toBeNull()
  })
  it('cycles through the list and wraps', () => {
    expect(nextEffort(['low', 'medium', 'high'], 'medium')).toBe('high')
    expect(nextEffort(['low', 'medium', 'high'], 'high')).toBe('low')
    expect(nextEffort(['low', 'medium', 'high'], null)).toBe('low')
  })
})

describe('modelMeta', () => {
  const m = (p: Partial<ModelInfo>): ModelInfo => ({ ...fallbackModelInfo('a/b'), ...p })
  it('shows price per 1M in and out, and context', () => {
    expect(modelMeta(m({ priceIn: 3, priceOut: 15, contextLength: 200_000 }))).toBe('$3 / $15 · 200k')
    expect(modelMeta(m({ priceIn: 0.075, priceOut: 0.3, contextLength: 1_048_576 }))).toBe('$0.075 / $0.3 · 1M')
  })
  it('says free for free models and "price varies" for routers', () => {
    expect(modelMeta(m({ free: true, contextLength: 131_072 }))).toBe('free · 131k')
    expect(modelMeta(m({ free: false, contextLength: 2_000_000 }))).toBe('price varies · 2M')
  })
})

describe('promptChipLabel', () => {
  it('shows "No prompt" without a prompt', () => {
    expect(promptChipLabel(null)).toBe('No prompt')
    expect(promptChipLabel(undefined)).toBe('No prompt')
  })

  it('keeps names up to 16 characters and cuts longer ones to 16 with "…"', () => {
    expect(promptChipLabel('Co-writer')).toBe('Co-writer')
    expect(promptChipLabel('Sixteen chars ok')).toBe('Sixteen chars ok')
    expect(promptChipLabel('Co-writer, tighter prose')).toBe('Co-writer, tigh…')
    expect(Array.from(promptChipLabel('Co-writer, tighter prose'))).toHaveLength(16)
  })

  it('does not leave a space before the ellipsis', () => {
    expect(promptChipLabel('Editor (strict), long')).toBe('Editor (strict)…')
    expect(promptChipLabel('Fourteen chars a b')).toBe('Fourteen chars…')
  })
})
