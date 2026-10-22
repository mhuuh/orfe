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

/** Gives this chat its own context (mode, limit, trim-to %) and closes the sheet. */
async function setChatContext(page: Page, mode: 'Tokens' | 'Messages', limit: number, trimPct = 70): Promise<void> {
  const settings = await openSettings(page)
  await settings.getByRole('switch', { name: /Use default/ }).click()
  await settings.getByRole('radio', { name: mode }).click()
  await settings.getByRole('textbox', { name: 'Limit' }).fill(String(limit))
  await settings.getByRole('textbox', { name: 'Limit' }).blur()
  const trim = settings.getByRole('group', { name: 'Trim to' })
  // The stepper moves 5 % a tap within 50–90 %: 20 taps reach any value; more means it is stuck.
  for (let i = 0; ; i++) {
    const pct = parseInt(await trim.locator('output').innerText(), 10)
    if (pct === trimPct) break
    expect(i, `trim-to stuck at ${pct}%`).toBeLessThan(20)
    await trim.getByRole('button', { name: pct > trimPct ? 'Less' : 'More' }).click()
  }
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
}

/** The text of a request's system message (sent as a plain string). */
function systemText(body: { messages: { role: string; content: unknown }[] }): string {
  const first = body.messages[0]
  expect(first.role).toBe('system')
  expect(typeof first.content).toBe('string')
  return first.content as string
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
  // The prompt text leads the system message; the capability note follows it.
  expect(systemText(api.chats[0]).startsWith('You are a copy editor.')).toBe(true)
  expect(systemText(api.chats[1]).startsWith('You are a STRICT copy editor.')).toBe(true)
  await expect(page.getByRole('separator', { name: '→ Editor, strict', exact: true })).toBeVisible()
})

test('trimming keeps requests inside the limit and marks the window', async ({ page, api }) => {
  await signIn(page)
  await turn(page, 'turn 1', 1)
  await setChatContext(page, 'Messages', 4)

  for (let n = 2; n <= 5; n++) await turn(page, `turn ${n}`, n)

  const last = api.chats[api.chats.length - 1]
  expect(last.messages.filter((m) => m.role !== 'system').length).toBeLessThanOrEqual(4)
  // The oldest turn really was dropped from the request.
  expect(JSON.stringify(last.messages)).not.toContain('"turn 1"')
  const marker = page.getByRole('separator', { name: /context starts here/ })
  await expect(marker).toBeVisible()
  // Dimming is a colour step, not opacity: the oldest text is muted, the newest is not.
  const colour = (text: string) =>
    page.getByText(text, { exact: true }).evaluate((el) => getComputedStyle(el).color)
  const [old, recent] = [await colour('turn 1'), await colour('turn 5')]
  expect(old).not.toBe(recent)
})

test('raising the limit or Reset lets a trimmed window grow back', async ({ page, api }) => {
  await signIn(page)
  await turn(page, 'turn 1', 1)
  await setChatContext(page, 'Messages', 4)
  for (let n = 2; n <= 4; n++) await turn(page, `turn ${n}`, n)
  const marker = page.getByRole('separator', { name: /context starts here/ })
  await expect(marker).toBeVisible()

  // Raise the limit: the stored start is cleared at once, so the marker and the Reset row go.
  let settings = await openSettings(page)
  const reset = settings.getByRole('button', { name: 'Reset', exact: true })
  await expect(reset).toBeVisible()
  await settings.getByRole('textbox', { name: 'Limit' }).fill('40')
  await settings.getByRole('textbox', { name: 'Limit' }).blur()
  await expect(reset).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(marker).toHaveCount(0)
  await turn(page, 'turn 5', 5)
  expect(JSON.stringify(api.chats[api.chats.length - 1].messages)).toContain('"turn 1"')

  // Lowering never clears; the next send trims again. Reset then sends from the beginning.
  settings = await openSettings(page)
  await settings.getByRole('textbox', { name: 'Limit' }).fill('4')
  await settings.getByRole('textbox', { name: 'Limit' }).blur()
  await page.keyboard.press('Escape')
  await turn(page, 'turn 6', 6)
  await expect(marker).toBeVisible()
  expect(JSON.stringify(api.chats[api.chats.length - 1].messages)).not.toContain('"turn 1"')
  settings = await openSettings(page)
  await expect(settings.getByText('Sends from the beginning again; trims to the limit if needed.')).toBeVisible()
  await settings.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Reset', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(marker).toHaveCount(0)
})

test('pinned message stays in context', async ({ page, api }) => {
  await signIn(page)
  await turn(page, 'PINNED-FIRST', 1)

  const first = page.getByRole('article', { name: 'You' }).first()
  await first.click()
  await first.getByRole('button', { name: 'Pin', exact: true }).click()

  await setChatContext(page, 'Messages', 4)

  for (let n = 2; n <= 5; n++) await turn(page, `filler ${n}`, n)

  await expect(page.getByRole('separator', { name: /context starts here/ })).toBeVisible()
  const last = api.chats[api.chats.length - 1]
  expect(JSON.stringify(last.messages)).toContain('PINNED-FIRST')
  // Older filler really was dropped, so the pin is what kept the first message.
  expect(JSON.stringify(last.messages)).not.toContain('filler 2')
})
