import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUpdateIfIdle, isIdle, noteDraft, resetAppUpdate, setUpdatePending } from './appUpdate'
import { generate, stop } from './send'
import { db, storage } from './storage'
import { fallbackModelInfo } from './catalog'

/** A chat request that hangs until aborted. */
function stubHangingFetch() {
  vi.stubGlobal(
    'fetch',
    (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
  )
}

beforeEach(async () => {
  resetAppUpdate()
  await Promise.all([db.conversations.clear(), db.messages.clear(), db.settings.clear()])
  await storage.setSettings({ key: 'sk-test' })
})
afterEach(() => vi.unstubAllGlobals())

describe('app update idle check', () => {
  it('is idle only with no unsent draft in any chat', () => {
    expect(isIdle()).toBe(true)
    noteDraft('a', 'half a thought')
    noteDraft('b', 'another')
    expect(isIdle()).toBe(false)
    noteDraft('a', '')
    expect(isIdle()).toBe(false)
    noteDraft('b', '   \n')
    expect(isIdle()).toBe(true)
  })

  it('is not idle while any chat is generating', async () => {
    stubHangingFetch()
    const c = await storage.createConversation()
    const p = generate(c.id, { kind: 'new' }, fallbackModelInfo('x/y'))
    expect(isIdle()).toBe(false)
    stop(c.id)
    await p
    expect(isIdle()).toBe(true)
  })

  it('holds a pending update while busy and applies it once, when idle', () => {
    const apply = vi.fn()
    noteDraft('a', 'typing')
    setUpdatePending(apply)
    expect(apply).not.toHaveBeenCalled()
    expect(applyUpdateIfIdle()).toBe(false)
    noteDraft('a', '')
    expect(applyUpdateIfIdle()).toBe(true)
    expect(applyUpdateIfIdle()).toBe(false)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('applies at once when already idle', () => {
    const apply = vi.fn()
    setUpdatePending(apply)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('applies after a generation finishes', async () => {
    stubHangingFetch()
    const c = await storage.createConversation()
    const p = generate(c.id, { kind: 'new' }, fallbackModelInfo('x/y'))
    const apply = vi.fn()
    setUpdatePending(apply)
    expect(apply).not.toHaveBeenCalled()
    stop(c.id)
    await p
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
