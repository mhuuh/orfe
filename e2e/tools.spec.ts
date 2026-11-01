import { TOOLCALL, expect, send, signIn, test } from './fixtures'
import type { Page } from '@playwright/test'
import type { Ability } from '../src/lib/abilities/registry'

/** Swaps the abilities in the app's own registry, through the dev server. */
async function setAbilities(page: Page, list: 'echo' | 'none'): Promise<void> {
  await page.evaluate(async (list) => {
    const url = '/orfe/src/lib/abilities/registry.ts'
    const registry = (await import(/* @vite-ignore */ url)) as { setAbilitiesForTest(list: Ability[]): void }
    const echo: Ability = {
      id: 'echo',
      title: 'Echo',
      summary: '',
      tools: [{ name: 'echo', description: 'Say it back.', parameters: { type: 'object', properties: {} } }],
      run: async (_name, args) => `echoed ${JSON.stringify(args)}`,
      describe: () => ({ running: 'echoing', done: 'echoed', past: '(Echoed.)' }),
      traits: {},
    }
    registry.setAbilitiesForTest(list === 'echo' ? [echo] : [])
  }, list)
}

test('a tool call round trips and the reply appears', async ({ page, api }) => {
  await signIn(page)
  await setAbilities(page, 'echo')
  await send(page, `${TOOLCALL}:echo:{"word":"river"}`)
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()

  expect(api.chats).toHaveLength(2)
  expect(api.chats[0].tools).toHaveLength(1)
  expect(api.chats[0].tool_choice).toBe('auto')
  expect(api.chats[1].tools).toEqual(api.chats[0].tools)
  expect(api.chats[1].messages.slice(-2)).toMatchObject([
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'echo' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'echoed {"word":"river"}' },
  ])
})

test('the notes tools ship: a model writes a note and reads it back', async ({ page, api }) => {
  await signIn(page)
  const args = JSON.stringify({ path: 'chat/harbour', description: 'The harbour', body: 'Boats at dawn.' })
  await send(page, `${TOOLCALL}:notes_write:${args}`)
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()

  const names = (api.chats[0].tools as { function: { name: string } }[]).map((t) => t.function.name)
  expect(names).toEqual(['notes_search', 'notes_read', 'notes_write', 'notes_edit', 'notes_delete'])
  expect(api.chats[0].messages[0].content).toContain('notes_search before you say')
  expect(api.chats[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'Wrote chat/harbour. It is at version 1.' })

  await send(page, `${TOOLCALL}:notes_read:{"path":"chat/harbour"}`)
  await expect(page.getByText(/^Reply 4 /)).toBeVisible()
  expect(JSON.stringify(api.chats[3].messages.at(-1))).toContain('1| Boats at dawn.')
})

test('no ability means no tools field, even on a model that can take tools', async ({ page, api }) => {
  await signIn(page)
  await setAbilities(page, 'none')
  await send(page, 'hi')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  expect(api.chats[0]).not.toHaveProperty('tools')
  expect(api.chats[0]).not.toHaveProperty('tool_choice')
})

test('tool line shows, opens, and Undo restores the note', async ({ page }) => {
  await signIn(page)
  const first = JSON.stringify({ path: 'shared/harbour', description: 'The harbour', body: 'Boats at dawn.' })
  const second = JSON.stringify({ path: 'shared/harbour', description: 'The harbour', body: 'Boats at dusk.', expected_version: 1 })
  await send(page, `${TOOLCALL}:notes_write:${first}`)
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  await send(page, `${TOOLCALL}:notes_write:${second}`)
  await expect(page.getByText(/^Reply 4 /)).toBeVisible()

  const body = () =>
    page.evaluate(async () => {
      const url = '/orfe/src/lib/notes/store.ts'
      const store = (await import(/* @vite-ignore */ url)) as {
        notes: { read(ref: { path: string; conversationId: string }): Promise<{ body: string } | undefined> }
      }
      return (await store.notes.read({ path: 'shared/harbour', conversationId: 'none' }))?.body
    })
  expect(await body()).toBe('Boats at dusk.')

  const lines = page.getByRole('button', { name: /^wrote Harbour/ })
  await expect(lines).toHaveCount(2)
  const line = lines.nth(1)
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  // The tap opened the line, not the message actions.
  await expect(page.getByRole('toolbar', { name: 'Message actions' })).toHaveCount(0)
  await expect(page.getByText(/^Wrote shared\/harbour/).last()).toBeVisible()

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('button', { name: /^wrote Harbour undone/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeVisible()
  expect(await body()).toBe('Boats at dawn.')

  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  expect(await body()).toBe('Boats at dusk.')
})

test('a tap on the reply text still opens the message actions', async ({ page }) => {
  await signIn(page)
  await send(page, 'hi')
  const reply = page.getByText(/^Reply 1 /)
  await expect(reply).toBeVisible()
  await reply.click()
  await expect(page.getByRole('toolbar', { name: 'Message actions' })).toBeVisible()
})
