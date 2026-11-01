import { beforeEach, describe, expect, it } from 'vitest'
import { fallbackModelInfo } from './catalog'
import { db, storage } from './storage'
import { CAPABILITY_NOTE, assembleSystem, systemFor } from './system'

const model = fallbackModelInfo('m/x')

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('system assembly', () => {
  it('prompt only', () => {
    expect(assembleSystem('Be brief.', false)).toBe('Be brief.')
  })
  it('note only', () => {
    expect(assembleSystem(null, true)).toBe(CAPABILITY_NOTE)
    expect(assembleSystem('   ', true)).toBe(CAPABILITY_NOTE)
  })
  it('prompt then blank line then note', () => {
    expect(assembleSystem('Be brief.', true)).toBe(`Be brief.\n\n${CAPABILITY_NOTE}`)
  })
  it('both empty returns null', () => {
    expect(assembleSystem(null, false)).toBeNull()
    expect(assembleSystem('  \n ', false)).toBeNull()
  })
  it('assembleSystem joins prompt, note and extras, skipping nulls', () => {
    expect(assembleSystem('Be brief.', true, ['Rules.', null, 'Index.', '  ', 'Summary.'])).toBe(
      `Be brief.\n\n${CAPABILITY_NOTE}\n\nRules.\n\nIndex.\n\nSummary.`,
    )
    expect(assembleSystem(null, false, [null, 'Only this.'])).toBe('Only this.')
    expect(assembleSystem(null, false, [null, null])).toBeNull()
  })
  it('missing prompt ref assembles as no prompt', async () => {
    const c = await storage.createConversation()
    const r = await systemFor({ ...c, systemPromptRef: 'gone', capabilityNote: true }, model)
    expect(r.prompt).toBeNull()
    expect(r.system).toBe(CAPABILITY_NOTE)
  })
  it('resolves an existing prompt', async () => {
    const p = await storage.savePrompt({ name: 'P', parentId: null, text: 'Hi' })
    const c = await storage.createConversation()
    const r = await systemFor({ ...c, systemPromptRef: p.id, capabilityNote: false }, model)
    expect(r.prompt?.id).toBe(p.id)
    expect(r.system).toBe('Hi')
  })
})
