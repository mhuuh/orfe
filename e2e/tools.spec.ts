import { MODEL_A, MODEL_B, MODEL_B_NAME, TOOLCALL, TWOCALLS, expect, send, signIn, test } from './fixtures'
import type { Page } from '@playwright/test'
import type { Ability } from '../src/lib/abilities/registry'

/** Swaps the abilities in the app's own registry, through the dev server. */
async function setAbilities(page: Page, list: 'echo' | 'trust' | 'none'): Promise<void> {
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
    const web: Ability = { ...echo, id: 'web', tools: [{ ...echo.tools[0], name: 'web' }], traits: { untrusted: true } }
    const save: Ability = { ...echo, id: 'save', tools: [{ ...echo.tools[0], name: 'save' }], writes: ['save'] }
    registry.setAbilitiesForTest(list === 'echo' ? [echo] : list === 'trust' ? [web, save] : [])
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

/** The paths of the live notes on the chat's shelf. */
const chatNotes = (page: Page) =>
  page.evaluate(async () => {
    const storeUrl = '/orfe/src/lib/notes/store.ts'
    const storageUrl = '/orfe/src/lib/storage.ts'
    const { notes } = (await import(/* @vite-ignore */ storeUrl)) as { notes: { list(shelf: string): Promise<{ path: string }[]> } }
    const { storage } = (await import(/* @vite-ignore */ storageUrl)) as { storage: { listConversations(): Promise<{ id: string }[]> } }
    const [chat] = await storage.listConversations()
    return (await notes.list(chat.id)).map((n) => n.path)
  })

const harbour = JSON.stringify({ path: 'chat/harbour', description: 'The harbour', body: 'Boats at dawn.' })

test('a reroll leaves no ghost note, and the old version shows its write as undone', async ({ page, api }) => {
  await signIn(page)
  await send(page, `${TOOLCALL}:notes_write:${harbour}`)
  await page.getByText(/^Reply 2 /).click()
  await page.getByRole('button', { name: 'Reroll' }).click()
  await expect(page.getByText(/^Reply 4 /)).toBeVisible()

  // The mock asks for the same write again. That is a new note, so the old one is gone by then.
  expect(JSON.stringify(api.chats[2].messages[0])).not.toContain('harbour')
  expect(await chatNotes(page)).toEqual(['harbour'])

  await page.getByRole('button', { name: 'Previous version' }).click()
  const line = page.getByRole('button', { name: /^wrote Harbour undone/ })
  await expect(line).toBeVisible()
  await line.click()
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(page.getByText('The note changed since. It stays undone.')).toBeVisible()
  expect(await chatNotes(page)).toEqual(['harbour'])
})

test('deleting a reply takes its note away, and toast Undo brings both back', async ({ page }) => {
  await signIn(page)
  await send(page, `${TOOLCALL}:notes_write:${harbour}`)
  await page.getByText(/^Reply 2 /).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText(/^Reply 2 /)).toHaveCount(0)
  expect(await chatNotes(page)).toEqual([])

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  await expect(page.getByRole('button', { name: /^wrote Harbour/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^wrote Harbour undone/ })).toHaveCount(0)
  expect(await chatNotes(page)).toEqual(['harbour'])
})

test('a tap on the reply text still opens the message actions', async ({ page }) => {
  await signIn(page)
  await send(page, 'hi')
  const reply = page.getByText(/^Reply 1 /)
  await expect(reply).toBeVisible()
  await reply.click()
  await expect(page.getByRole('toolbar', { name: 'Message actions' })).toBeVisible()
})

/** Opens the chat's settings by tapping the title. */
async function chatSettings(page: Page) {
  await page.locator('header').getByRole('button', { name: /turn/ }).click()
  return page.getByRole('dialog', { name: 'Chat' })
}

test('switching notes off removes the tools from the request', async ({ page, api }) => {
  await signIn(page)
  await send(page, 'hi')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  expect(api.chats[0].tools).toHaveLength(5)

  const sheet = await chatSettings(page)
  const notes = sheet.getByRole('switch', { name: 'Notes' })
  await expect(notes).toBeChecked()
  await expect(sheet.getByText('Read and write the vault')).toBeVisible()
  await expect(sheet.getByText(/next reply cost more/)).toBeVisible()
  await notes.click()
  await expect(notes).not.toBeChecked()
  await sheet.getByRole('button', { name: 'Close' }).click()

  await send(page, 'again')
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  expect(api.chats[1]).not.toHaveProperty('tools')
  expect(JSON.stringify(api.chats[1].messages)).not.toContain('notes_search')
})

test('a plain chat sends only the prompt and the messages', async ({ page, api }) => {
  await signIn(page)
  await page.getByRole('button', { name: /^Prompt:/ }).click()
  await page.getByRole('button', { name: 'New prompt' }).click()
  await page.getByLabel('Prompt name').fill('Chef')
  await page.getByLabel('Prompt text').fill('You are a chef.')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Chef', exact: true }).click()
  await send(page, 'hi')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  expect(api.chats[0].messages[0].content).toContain('notes_search')

  const sheet = await chatSettings(page)
  const notes = sheet.getByRole('switch', { name: 'Notes' })
  await sheet.getByRole('switch', { name: 'Plain chat' }).click()
  await expect(notes).toBeDisabled()
  await expect(notes).toBeChecked()
  await expect(sheet.getByRole('switch', { name: 'Capability note' })).toBeDisabled()
  await sheet.getByRole('button', { name: 'Close' }).click()

  await send(page, 'plain now')
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  expect(api.chats[1]).not.toHaveProperty('tools')
  expect(api.chats[1]).not.toHaveProperty('tool_choice')
  expect(api.chats[1].messages).toEqual([
    { role: 'system', content: 'You are a chef.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: `Reply 1 from ${MODEL_A}` },
    { role: 'user', content: 'plain now' },
  ])

  // Off again, the switches are as they were and the model has its tools back.
  await chatSettings(page)
  await sheet.getByRole('switch', { name: 'Plain chat' }).click()
  await expect(notes).toBeEnabled()
  await sheet.getByRole('button', { name: 'Close' }).click()
  await send(page, 'tools again')
  await expect(page.getByText(/^Reply 3 /)).toBeVisible()
  expect(api.chats[2].tools).toHaveLength(5)
})

test("a prompt's Abilities row sets what its chats follow", async ({ page, api }) => {
  await signIn(page)
  await page.getByRole('button', { name: /^Prompt:/ }).click()
  await page.getByRole('button', { name: 'New prompt' }).click()
  await page.getByLabel('Prompt name').fill('Chef')
  await page.getByLabel('Prompt text').fill('You are a chef.')
  await page.getByRole('switch', { name: 'Notes' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Chef', exact: true }).click()
  await send(page, 'hi')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  expect(api.chats[0]).not.toHaveProperty('tools')

  // The chat reads the prompt's value until it sets its own.
  const sheet = await chatSettings(page)
  const notes = sheet.getByRole('switch', { name: 'Notes' })
  await expect(notes).not.toBeChecked()
  await notes.click()
  await sheet.getByRole('button', { name: 'Close' }).click()
  await send(page, 'again')
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  expect(api.chats[1].tools).toHaveLength(5)

  // The editor reads the switch back, and a delete's Undo keeps it.
  const openEditor = async () => {
    await page.getByRole('button', { name: /^Prompt:/ }).click()
    await page.getByRole('button', { name: 'Edit Chef' }).click()
  }
  await openEditor()
  await expect(page.getByRole('switch', { name: 'Notes' })).not.toBeChecked()
  await page.getByRole('dialog', { name: 'Edit prompt' }).getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: 'Edit Chef' }).click()
  await expect(page.getByRole('switch', { name: 'Notes' })).not.toBeChecked()
})

test('a no-tools model shows the notice and still replies', async ({ page, api }) => {
  await signIn(page)
  const notice = page.getByText("This model can't use notes.")
  await expect(page.getByRole('button', { name: /^Model:/ })).toBeVisible()
  await expect(notice).toHaveCount(0)

  await page.getByRole('button', { name: /^Model:/ }).click()
  await page.getByRole('button', { name: new RegExp(MODEL_B_NAME) }).click()
  await expect(notice).toBeVisible()

  await send(page, 'hi')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  await expect(notice).toHaveCount(0)
  expect(api.chats[0].model).toBe(MODEL_B)
  expect(api.chats[0]).not.toHaveProperty('tools')

  // Once per model: a reload and a way back do not repeat it.
  await page.reload()
  await expect(page.getByLabel('Message')).toBeVisible()
  await expect(page.getByRole('button', { name: `Model: ${MODEL_B_NAME}. Change` })).toBeVisible()
  await expect(notice).toHaveCount(0)
})

test('a plain chat on a no-tools model shows no notice', async ({ page }) => {
  await signIn(page)
  await send(page, 'hi')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  const sheet = await chatSettings(page)
  await sheet.getByRole('switch', { name: 'Plain chat' }).click()
  await sheet.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: /^Model:/ }).click()
  await page.getByRole('button', { name: new RegExp(MODEL_B_NAME) }).click()
  await expect(page.getByRole('button', { name: `Model: ${MODEL_B_NAME}. Change` })).toBeVisible()
  await expect(page.getByText("This model can't use notes.")).toHaveCount(0)
})

test('after untrusted content a write waits for a visible OK', async ({ page, api }) => {
  await signIn(page)
  await setAbilities(page, 'trust')
  await send(page, `${TWOCALLS}:web:save`)

  const ok = page.getByRole('button', { name: 'OK', exact: true })
  await expect(ok).toBeVisible()
  await expect(page.getByText(/waits for your OK/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  expect(api.chats).toHaveLength(1)

  await ok.click()
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  await expect(ok).toHaveCount(0)
  expect(api.chats[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'echoed {}' })
})

test('a lock during the wait leaves Continue, and Continue asks again', async ({ page, api }) => {
  await signIn(page)
  await setAbilities(page, 'trust')
  await send(page, `${TWOCALLS}:web:save`)
  const ok = page.getByRole('button', { name: 'OK', exact: true })
  await expect(ok).toBeVisible()

  // A lost page: the run is gone, so the OK must go too. Reload resets the test abilities.
  await page.reload()
  await expect(page.getByLabel('Message')).toBeVisible()
  await setAbilities(page, 'trust')
  await expect(ok).toHaveCount(0)
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(ok).toBeVisible()
  expect(api.chats).toHaveLength(1)
  await ok.click()
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
})

test('Stop ends a reply that waits for an OK', async ({ page }) => {
  await signIn(page)
  await setAbilities(page, 'trust')
  await send(page, `${TWOCALLS}:web:save`)
  const ok = page.getByRole('button', { name: 'OK', exact: true })
  await expect(ok).toBeVisible()
  // Past the grace after a send, a tap on Stop counts.
  await page.waitForTimeout(450)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(ok).toHaveCount(0)
  await expect(page.getByLabel('Message')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
})

test("This chat's notes opens the vault on the chat's shelf", async ({ page }) => {
  await signIn(page)
  await send(page, `${TOOLCALL}:notes_write:${harbour}`)
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  // A long shared shelf, so the chat's shelf starts below the fold.
  await page.evaluate(async () => {
    const url = '/orfe/src/lib/notes/store.ts'
    const { notes, YOU } = (await import(/* @vite-ignore */ url)) as typeof import('../src/lib/notes/store')
    for (let i = 0; i < 30; i++) {
      await notes.write(
        { path: `shared/filler-${i}`, conversationId: 'none' },
        { body: 'x', description: 'Filler', isNew: true },
        YOU,
      )
    }
  })
  const sheet = await chatSettings(page)
  await sheet.getByRole('button', { name: /This chat's notes/ }).click()
  const vault = page.getByRole('dialog', { name: 'Vault' })
  await expect(vault.getByRole('region', { name: /^This chat/ }).getByRole('button', { name: /Harbour/ })).toBeInViewport()
})
