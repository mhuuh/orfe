import { beforeEach, describe, expect, it } from 'vitest'
import { db, storage } from './storage'
import { CAPABILITY_NOTE, assembleSystem, systemFor } from './system'

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
  it('missing prompt ref assembles as no prompt', async () => {
    const c = await storage.createConversation()
    const r = await systemFor({ ...c, systemPromptRef: 'gone', capabilityNote: true })
    expect(r.prompt).toBeNull()
    expect(r.system).toBe(CAPABILITY_NOTE)
  })
  it('resolves an existing prompt', async () => {
    const p = await storage.savePrompt({ name: 'P', parentId: null, text: 'Hi' })
    const c = await storage.createConversation()
    const r = await systemFor({ ...c, systemPromptRef: p.id, capabilityNote: false })
    expect(r.prompt?.id).toBe(p.id)
    expect(r.system).toBe('Hi')
  })
})
