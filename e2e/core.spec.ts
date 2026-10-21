import { MODEL_A, MODEL_B, MODEL_B_NAME, PARTIAL, SLOW, expect, send, signIn, test } from './fixtures'

test('switches model mid-conversation and keeps both voices', async ({ page, api }) => {
  await signIn(page)
  await send(page, 'hi')
  await expect(page.getByText(`from ${MODEL_A}`)).toBeVisible()

  await page.getByRole('button', { name: /^Model:/ }).click()
  await page.getByRole('button', { name: new RegExp(MODEL_B_NAME) }).click()
  await send(page, 'more')
  await expect(page.getByText(`from ${MODEL_B}`)).toBeVisible()

  expect(api.chats).toHaveLength(2)
  expect(api.chats[0].model).toBe(MODEL_A)
  expect(api.chats[1].model).toBe(MODEL_B)
  // The second request carries A's reply as history.
  expect(JSON.stringify(api.chats[1].messages)).toContain(`Reply 1 from ${MODEL_A}`)
  await expect(page.getByRole('separator', { name: 'gpt-6' })).toBeVisible()
})

test('edit keeps later messages', async ({ page }) => {
  await signIn(page)
  await send(page, 'first question')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  await send(page, 'second question')
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()

  const first = page.getByRole('article', { name: 'You' }).first()
  await first.click()
  await first.getByRole('button', { name: 'Edit' }).click()
  await first.getByLabel('Edit message').fill('first question, reworded')
  await first.getByRole('button', { name: 'Save' }).click()

  await expect(first.getByText('first question, reworded')).toBeVisible()
  await expect(first.getByText('2/2')).toBeVisible()
  await expect(page.getByText('second question')).toBeVisible()
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
})

test('reroll creates a version and stop keeps partial text', async ({ page }) => {
  await signIn(page)
  await send(page, 'hello')
  const reply = page.getByRole('article', { name: /^Reply from/ }).first()
  await expect(reply.getByText(/^Reply 1 /)).toBeVisible()

  await reply.click()
  await reply.getByRole('button', { name: 'Reroll' }).click()
  await expect(reply.getByText('2/2')).toBeVisible()
  await expect(reply.getByText(/^Reply 2 /)).toBeVisible()
  await reply.getByRole('button', { name: 'Previous version' }).click()
  await expect(reply.getByText('1/2')).toBeVisible()
  await expect(reply.getByText(/^Reply 1 /)).toBeVisible()

  // Slow stream: one chunk arrives, then the connection hangs until Stop.
  await send(page, `${SLOW} please`)
  await expect(page.getByText(PARTIAL)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Send/ })).toBeDisabled() // empty field again, idle
  await expect(page.getByText(PARTIAL)).toBeVisible()

  // Reload: the partial text and the note must come from storage (status 'stopped'), not from live state.
  await page.reload()
  await expect(page.getByText(PARTIAL)).toBeVisible()
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible()
  await expect(page.getByText('Interrupted', { exact: true })).toHaveCount(0)
})

test('survives reload', async ({ page }) => {
  await signIn(page)
  await send(page, 'remember me')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()

  await page.reload()
  await expect(page.getByText('remember me')).toBeVisible()
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  await expect(page.getByLabel('Message')).toBeVisible()
})

test('back closes the open sheet and stays on the chat', async ({ page }) => {
  await signIn(page)
  await send(page, 'hello')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  const chat = page.url()
  await page.getByLabel('Message').fill('unsent draft')

  // Drawer: back closes it; same chat, draft kept.
  await page.getByRole('button', { name: 'Open menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Chats' })
  await expect(drawer).toBeVisible()
  await page.goBack()
  await expect(drawer).toHaveCount(0)
  expect(page.url()).toBe(chat)
  await expect(page.getByText('hello')).toBeVisible()
  await expect(page.getByLabel('Message')).toHaveValue('unsent draft')

  // Model sheet over Settings: back closes only the top one, then Settings.
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await expect(drawer).toHaveCount(0)
  await settings.getByRole('button', { name: 'Change' }).last().click() // the default model's Change
  const models = page.getByRole('dialog', { name: 'Default model' })
  await expect(models).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(2)
  await page.goBack()
  await expect(models).toHaveCount(0)
  await expect(settings).toBeVisible()
  await page.goBack()
  await expect(settings).toHaveCount(0)
  expect(page.url()).toBe(chat)

  // Closing by other means steps back off the sheet's entry, so no dead Back press is left behind.
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(drawer).toBeVisible()
  await expect.poll(() => page.evaluate(() => history.state as unknown)).toEqual({ orfeSheet: true })
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => history.state as unknown)).toBeNull()
  expect(page.url()).toBe(chat)

  // Hash routing still works: a new chat from the drawer, then back returns to the first chat.
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect.poll(() => page.url()).not.toBe(chat)
  await page.goBack()
  await expect.poll(() => page.url()).toBe(chat)
  await expect(page.getByText('hello')).toBeVisible()
})
