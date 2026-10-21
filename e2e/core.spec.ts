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
