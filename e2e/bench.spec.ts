import { expect, test } from '@playwright/test'

test('?bench shows its own page and never opens the real database', async ({ page }) => {
  await page.goto('?bench')
  await expect(page.getByRole('heading', { name: 'Search index bench' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Copy' })).toBeDisabled()
  const names = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  expect(names).not.toContain('orfe')
})

test('?bench clears what a killed run left, and leaves the real database alone', async ({ page }) => {
  await page.goto('')
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('orfe-bench', 1)
        open.onupgradeneeded = () => open.result.createObjectStore('messages')
        open.onsuccess = () => {
          open.result.close()
          resolve()
        }
        open.onerror = () => reject(open.error)
      }),
  )
  await page.goto('?bench')
  await expect(page.getByRole('heading', { name: 'Search index bench' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)))
    .toEqual(['orfe'])
})

test('a bench that fails to load shows a line of text', async ({ page }) => {
  await page.route('**/src/bench/bench.tsx*', (r) => r.abort())
  await page.goto('?bench')
  await expect(page.getByText("Couldn't load the bench.")).toBeVisible()
})

test('a normal load does not fetch the bench', async ({ page }) => {
  const asked: string[] = []
  page.on('request', (r) => asked.push(r.url()))
  await page.goto('')
  await expect(page.locator('#root')).not.toBeEmpty()
  expect(asked.filter((u) => u.includes('/bench/'))).toEqual([])
})
