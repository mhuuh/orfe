import { expect, send, signIn, test } from './fixtures'
import type { Page } from '@playwright/test'

/** Sends a message and waits until its reply has finished (the composer is idle again). */
async function turn(page: Page, text: string, n: number): Promise<void> {
  await send(page, text)
  await expect(page.getByText(new RegExp(`^Reply ${n} `))).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
}

/** Opens this chat's settings from the header title. */
async function openSettings(page: Page) {
  await page.locator('header button[aria-haspopup="dialog"]').click()
  return page.getByRole('dialog', { name: 'Chat' })
}

test('prompt swap mid-chat changes the system message and shows a divider', async ({ page, api }) => {
  await signIn(page)

  // Make "Editor" and pick it.
  await page.getByRole('button', { name: /^Prompt:/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Prompt' })
  await sheet.getByRole('button', { name: 'New prompt' }).click()
  await page.getByLabel('Prompt name').fill('Editor')
  await page.getByLabel('Prompt text').fill('You are a copy editor.')
  await page.getByRole('button', { name: 'Save' }).click()
  await sheet.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Prompt: Editor. Change' })).toBeVisible()
  await turn(page, 'first', 1)

  // Make the variant "Editor, strict" with its own text, and swap to it.
  await page.getByRole('button', { name: /^Prompt:/ }).click()
  await sheet.getByRole('button', { name: 'Edit Editor' }).click()
  await page.getByRole('button', { name: 'Duplicate as variant' }).click()
  await expect(page.getByLabel('Prompt name')).toHaveValue('Editor, variant')
  await page.getByLabel('Prompt name').fill('Editor, strict')
  await page.getByLabel('Prompt text').fill('You are a STRICT copy editor.')
  await page.getByRole('button', { name: 'Save' }).click()
  await sheet.getByRole('button', { name: 'Editor, strict', exact: true }).click()
  await turn(page, 'second', 2)

  expect(api.chats).toHaveLength(2)
  expect(api.chats[0].messages[0]).toMatchObject({ role: 'system' })
  expect(JSON.stringify(api.chats[0].messages[0].content)).toContain('You are a copy editor.')
  expect(api.chats[1].messages[0].role).toBe('system')
  const content = api.chats[1].messages[0].content
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  expect(text).toContain('You are a STRICT copy editor.')
  expect(text.indexOf('You are a STRICT')).toBeLessThan(40)
  await expect(page.getByRole('separator', { name: '→ Editor, strict' })).toBeVisible()
})

test('trimming keeps requests inside the limit and marks the window', async ({ page, api }) => {
  await signIn(page)
  await turn(page, 'turn 1', 1)

  const settings = await openSettings(page)
  await settings.getByRole('switch', { name: /Use default/ }).click()
  await settings.getByRole('radio', { name: 'Messages' }).click()
  await settings.getByRole('textbox', { name: 'Limit' }).fill('4')
  await settings.getByRole('textbox', { name: 'Limit' }).blur()
  const trim = settings.getByRole('group', { name: 'Trim to' })
  while (parseInt(await trim.locator('output').innerText(), 10) !== 70) {
    const pct = parseInt(await trim.locator('output').innerText(), 10)
    await trim.getByRole('button', { name: pct > 70 ? 'Less' : 'More' }).click()
  }
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  for (let n = 2; n <= 5; n++) await turn(page, `turn ${n}`, n)

  const last = api.chats[api.chats.length - 1]
  expect(last.messages.filter((m) => m.role !== 'system').length).toBeLessThanOrEqual(4)
  const marker = page.getByRole('separator', { name: /context starts here/ })
  await expect(marker).toBeVisible()
  // Dimming is a colour step, not opacity: the oldest text is muted, the newest is not.
  const colour = (text: string) =>
    page.getByText(text, { exact: true }).evaluate((el) => getComputedStyle(el).color)
  const [old, recent] = [await colour('turn 1'), await colour('turn 5')]
  expect(old).not.toBe(recent)
})

test('pinned message stays in context', async ({ page, api }) => {
  await signIn(page)
  await turn(page, 'PINNED-FIRST', 1)

  const first = page.getByRole('article', { name: 'You' }).first()
  await first.click()
  await first.getByRole('button', { name: 'Pin', exact: true }).click()

  const settings = await openSettings(page)
  await settings.getByRole('switch', { name: /Use default/ }).click()
  await settings.getByRole('radio', { name: 'Messages' }).click()
  await settings.getByRole('textbox', { name: 'Limit' }).fill('4')
  await settings.getByRole('textbox', { name: 'Limit' }).blur()
  const trim = settings.getByRole('group', { name: 'Trim to' })
  while (parseInt(await trim.locator('output').innerText(), 10) !== 70) {
    const pct = parseInt(await trim.locator('output').innerText(), 10)
    await trim.getByRole('button', { name: pct > 70 ? 'Less' : 'More' }).click()
  }
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  for (let n = 2; n <= 5; n++) await turn(page, `filler ${n}`, n)

  await expect(page.getByRole('separator', { name: /context starts here/ })).toBeVisible()
  const last = api.chats[api.chats.length - 1]
  expect(JSON.stringify(last.messages)).toContain('PINNED-FIRST')
  // Older filler really was dropped, so the pin is what kept the first message.
  expect(JSON.stringify(last.messages)).not.toContain('filler 2')
})
