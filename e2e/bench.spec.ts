import { expect, test } from '@playwright/test'

test('?bench shows its own page and never opens the real database', async ({ page }) => {
  await page.goto('?bench')
  await expect(page.getByRole('heading', { name: 'Search index bench' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Copy' })).toBeDisabled()
  const names = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  expect(names).not.toContain('orfe')
})

test('a normal load does not fetch the bench', async ({ page }) => {
  const asked: string[] = []
  page.on('request', (r) => asked.push(r.url()))
  await page.goto('')
  await expect(page.locator('#root')).not.toBeEmpty()
  expect(asked.filter((u) => u.includes('/bench/'))).toEqual([])
})
