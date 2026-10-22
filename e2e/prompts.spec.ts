import { expect, signIn, test } from './fixtures'

test('Back with edits shows the unsaved row and keeps the sheet open', async ({ page }) => {
  await signIn(page)
  const chat = page.url()

  // Make a prompt through the sheet.
  await page.getByRole('button', { name: /^Prompt:/ }).click()
  await page.getByRole('button', { name: 'New prompt' }).click()
  await page.getByLabel('Prompt name').fill('Editor')
  await page.getByLabel('Prompt text').fill('You are a strict copy editor.')
  await page.getByRole('button', { name: 'Save' }).click()
  const list = page.getByRole('dialog', { name: 'Prompt' })
  await expect(list.getByRole('button', { name: 'Edit Editor' })).toBeVisible()

  // Edit it, then press Back: the sheet stays, and asks.
  await list.getByRole('button', { name: 'Edit Editor' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit prompt' })
  await page.getByLabel('Prompt text').fill('You are a gentle copy editor.')
  await page.goBack()
  await expect(editor).toBeVisible()
  await expect(editor.getByText('Unsaved changes')).toBeVisible()
  await expect(page.getByLabel('Prompt text')).toHaveValue('You are a gentle copy editor.')

  // The refused Back put its step back: the next Back asks again instead of leaving.
  await editor.getByRole('button', { name: 'Keep editing' }).click()
  await expect(editor.getByText('Unsaved changes')).toHaveCount(0)
  // Keep editing puts the caret back in the text, so the phone keyboard comes back.
  await expect(page.getByLabel('Prompt text')).toBeFocused()
  await page.goBack()
  await expect(editor.getByText('Unsaved changes')).toBeVisible()
  expect(page.url()).toBe(chat)

  // Done and Escape ask too; Discard goes back to the list with the old text kept.
  await editor.getByRole('button', { name: 'Keep editing' }).click()
  await page.keyboard.press('Escape')
  await expect(editor.getByText('Unsaved changes')).toBeVisible()
  await editor.getByRole('button', { name: 'Keep editing' }).click()
  await editor.getByRole('button', { name: 'Close' }).click()
  await expect(editor.getByText('Unsaved changes')).toBeVisible()
  await editor.getByRole('button', { name: 'Discard' }).click()
  await expect(list).toBeVisible()
  await list.getByRole('button', { name: 'Edit Editor' }).click()
  await expect(page.getByLabel('Prompt text')).toHaveValue('You are a strict copy editor.')

  // Without edits, Back goes to the list, then closes the sheet, and the chat stays.
  await page.goBack()
  await expect(list).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(page.url()).toBe(chat)
})
