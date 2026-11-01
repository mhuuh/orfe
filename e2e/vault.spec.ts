import { TOOLCALL, expect, send, signIn, test } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import type { Result, Writer } from '../src/lib/notes/store'

const harbour = JSON.stringify({ path: 'chat/harbour', description: 'The harbour', body: 'Boats at dawn.' })

/** The model writes the harbour note. */
async function modelWrites(page: Page): Promise<void> {
  await send(page, `${TOOLCALL}:notes_write:${harbour}`)
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
}

async function openVault(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('tab', { name: 'Vault' }).click()
  return page.getByRole('dialog', { name: 'Vault' })
}

async function openNote(page: Page, vault: Locator, name: RegExp | string): Promise<Locator> {
  await vault.getByRole('button', { name }).click()
  return page.getByRole('dialog', { name: 'Note' })
}

/** Whether a waiting app update may reload the page now. */
const idle = (page: Page): Promise<boolean> =>
  page.evaluate(async () => {
    const url = '/orfe/src/lib/appUpdate.ts'
    return ((await import(/* @vite-ignore */ url)) as typeof import('../src/lib/appUpdate')).isIdle()
  })

const thisChat = (vault: Locator) => vault.getByRole('region', { name: /^This chat/ })

/** As a model, on the only note: replaces its words, deletes it, or tries to clear its protection. Runs in the page, through the dev server. */
function asModel(page: Page, call: 'rewrite' | 'remove' | 'unprotect'): Promise<Result> {
  return page.evaluate(async (call) => {
    const url = '/orfe/src/lib/notes/store.ts'
    const { notes, refOf } = (await import(/* @vite-ignore */ url)) as typeof import('../src/lib/notes/store')
    const [note] = await notes.all()
    const model: Writer = { writer: 'openai/gpt-6', messageId: null, callId: null }
    if (call === 'unprotect') return notes.setProtected(note.id, false, model)
    if (call === 'remove') return notes.remove(refOf(note), model)
    return notes.write(refOf(note), { body: 'Boats at noon.', description: note.description, expectedVersion: note.version }, model)
  }, call)
}

test('a note written by a model shows in the vault under this chat', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const vault = await openVault(page)
  await expect(thisChat(vault).getByRole('button', { name: /^Harbour/ })).toBeVisible()
  await expect(thisChat(vault).getByText('The harbour')).toBeVisible()
  await expect(thisChat(vault).getByText('1 note', { exact: true })).toBeVisible()
  await expect(vault.getByRole('region', { name: 'Shared' }).getByRole('button')).toHaveCount(0)

  const note = await openNote(page, vault, /^Harbour/)
  await expect(note.getByRole('heading', { name: 'Harbour' })).toBeVisible()
  await expect(note.getByText('chat', { exact: true })).toBeVisible()
  await expect(note.getByText('claude-sonnet-5.5 · version 1')).toBeVisible()
  await expect(note.getByText('Boats at dawn.')).toHaveCSS('font-family', /Newsreader/)
})

test('editing a note adds a revision by you', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const note = await openNote(page, await openVault(page), /^Harbour/)

  await note.getByRole('button', { name: 'Edit' }).click()
  await note.getByLabel('Note text').fill('Boats at dusk.')
  await note.getByRole('button', { name: 'Save' }).click()
  await expect(note.getByText('Boats at dusk.')).toBeVisible()
  await expect(note.getByText('you · version 2')).toBeVisible()

  await note.getByRole('button', { name: 'History' }).click()
  await expect(note.getByRole('listitem').filter({ hasText: 'Version 2' })).toContainText('you · edited')
  await expect(note.getByRole('listitem').filter({ hasText: 'Version 1' })).toContainText('claude-sonnet-5.5 · created')
  await note.getByRole('button', { name: 'Restore version 1' }).click()
  await expect(note.getByText('Boats at dawn.')).toBeVisible()
  await expect(note.getByText('you · version 3')).toBeVisible()
})

test('protecting a note blocks a model edit, and only you can unprotect', async ({ page, api }) => {
  await signIn(page)
  await modelWrites(page)
  const vault = await openVault(page)
  let note = await openNote(page, vault, /^Harbour/)

  await note.getByRole('button', { name: 'Protect' }).click()
  await expect(note.getByText('Models can read, move and tag this note. Only you can change the words.')).toBeVisible()
  await note.getByRole('button', { name: 'Back' }).click()
  await expect(thisChat(vault).getByRole('img', { name: 'Protected' })).toBeVisible()
  await vault.getByRole('button', { name: 'Close' }).click()

  const edit = JSON.stringify({ path: 'chat/harbour', expected_version: 2, old_text: 'dawn', new_text: 'dusk' })
  await send(page, `${TOOLCALL}:notes_edit:${edit}`)
  await expect(page.getByText(/^Reply 4 /)).toBeVisible()
  expect(JSON.stringify(api.chats.at(-1)?.messages.at(-1))).toContain('This note is protected.')

  expect(await asModel(page, 'unprotect')).toMatchObject({ refused: expect.stringContaining('Only Mikael can clear protection') })

  await page.getByRole('button', { name: 'Open menu' }).click()
  note = await openNote(page, page.getByRole('dialog', { name: 'Vault' }), /^Harbour/)
  await expect(note.getByText('Boats at dawn.')).toBeVisible()

  // Mikael can still change the words.
  await note.getByRole('button', { name: 'Edit' }).click()
  await note.getByLabel('Note text').fill('Boats at dusk.')
  await note.getByRole('button', { name: 'Save' }).click()
  await expect(note.getByText('Boats at dusk.')).toBeVisible()

  // Clearing asks once. Keep leaves it on.
  const chip = note.getByRole('button', { name: 'Protected' })
  await chip.click()
  await note.getByRole('button', { name: 'Keep' }).click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await chip.click()
  await note.getByRole('button', { name: 'Clear' }).click()
  await expect(note.getByRole('button', { name: 'Protect', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(note.getByText('Models can read, move and tag this note.')).toHaveCount(0)
})

test('Back with unsaved edits asks first', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const vault = await openVault(page)
  const note = await openNote(page, vault, /^Harbour/)
  await note.getByRole('button', { name: 'Edit' }).click()

  // No edits yet: Back goes to the note and asks nothing.
  await page.goBack()
  await expect(note.getByLabel('Note text')).toHaveCount(0)
  await note.getByRole('button', { name: 'Edit' }).click()

  const text = note.getByLabel('Note text')
  await text.fill('Half a thought')
  await page.goBack()
  await expect(note.getByText('Unsaved changes')).toBeVisible()
  await note.getByRole('button', { name: 'Keep editing' }).click()
  await expect(text).toHaveValue('Half a thought')

  // The next Back asks again, and so do Escape and the back arrow.
  await page.goBack()
  await expect(note.getByText('Unsaved changes')).toBeVisible()
  await note.getByRole('button', { name: 'Keep editing' }).click()
  await page.keyboard.press('Escape')
  await expect(note.getByText('Unsaved changes')).toBeVisible()
  await note.getByRole('button', { name: 'Keep editing' }).click()
  await note.getByRole('button', { name: 'Back' }).click()
  await note.getByRole('button', { name: 'Discard' }).click()
  await expect(note.getByText('Boats at dawn.')).toBeVisible()

  await page.goBack()
  await expect(page.getByRole('dialog', { name: 'Note' })).toHaveCount(0)
  await expect(vault).toBeVisible()
})

test('a model write during an edit keeps your text and asks', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const note = await openNote(page, await openVault(page), /^Harbour/)
  await note.getByRole('button', { name: 'Edit' }).click()
  await note.getByLabel('Note text').fill('My long thought')

  await asModel(page, 'rewrite')
  await note.getByRole('button', { name: 'Save' }).click()
  await expect(note.getByRole('alert')).toContainText('This note changed while you edited. Your text is still here.')
  await expect(note.getByLabel('Note text')).toHaveValue('My long thought')

  await note.getByRole('button', { name: 'Save mine' }).click()
  await expect(note.getByText('My long thought')).toBeVisible()
  await expect(note.getByText('you · version 3')).toBeVisible()
  await note.getByRole('button', { name: 'History' }).click()
  await expect(note.getByRole('listitem').filter({ hasText: 'Version 2' })).toContainText('gpt-6')
})

test('a note deleted during an edit keeps your text and can come back with it', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const note = await openNote(page, await openVault(page), /^Harbour/)
  await note.getByRole('button', { name: 'Edit' }).click()
  await note.getByLabel('Note text').fill('My long thought')

  await asModel(page, 'remove')
  await note.getByRole('button', { name: 'Save' }).click()
  await expect(note.getByRole('alert')).toContainText('This note went to Trash while you edited. Your text is still here.')
  await expect(note.getByLabel('Note text')).toHaveValue('My long thought')

  await note.getByRole('button', { name: 'Save mine' }).click()
  await expect(note.getByText('My long thought')).toBeVisible()
  await expect(note.getByText('This note is in Trash.')).toHaveCount(0)
  await expect(note.getByRole('button', { name: 'Edit' })).toBeVisible()
})

test('a note in Trash opens to read, and Restore brings it back', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  await send(page, `${TOOLCALL}:notes_delete:{"path":"chat/harbour"}`)
  await expect(page.getByText(/^Reply 4 /)).toBeVisible()

  const vault = await openVault(page)
  await vault.getByRole('button', { name: /^Trash/ }).click()
  const note = await openNote(page, vault, /^Harbour/)
  await expect(note.getByText('This note is in Trash.')).toBeVisible()
  await expect(note.getByText('Boats at dawn.')).toBeVisible()
  await expect(note.getByRole('button', { name: 'Edit' })).toHaveCount(0)

  await note.getByRole('button', { name: 'History' }).click()
  await expect(note.getByRole('listitem').filter({ hasText: 'Version 2' })).toContainText('deleted')
  await expect(note.getByRole('button', { name: /^Restore version/ })).toHaveCount(0)
  await note.getByRole('button', { name: 'Back' }).click()

  await note.getByRole('button', { name: 'Restore' }).click()
  await expect(note.getByText('This note is in Trash.')).toHaveCount(0)
  await expect(note.getByRole('button', { name: 'Edit' })).toBeVisible()
})

test('search finds a note by its body', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const vault = await openVault(page)
  const search = vault.getByLabel('Search notes')

  await search.fill('dawn')
  await expect(vault.getByRole('button', { name: /^Harbour/ })).toContainText('Boats at dawn.')
  await expect(thisChat(vault)).toHaveCount(0)

  await search.fill('winter')
  await expect(vault.getByText('No notes found')).toBeVisible()

  await search.fill('')
  await expect(thisChat(vault)).toBeVisible()
})

test('Trash restores a deleted note', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  await send(page, `${TOOLCALL}:notes_delete:{"path":"chat/harbour"}`)
  await expect(page.getByText(/^Reply 4 /)).toBeVisible()

  const vault = await openVault(page)
  await expect(thisChat(vault).getByRole('button', { name: /^Harbour/ })).toHaveCount(0)

  const trash = vault.getByRole('region', { name: 'Trash' })
  await trash.getByRole('button', { name: /^Trash/ }).click()
  await trash.getByRole('button', { name: 'Restore Harbour' }).click()
  await expect(thisChat(vault).getByRole('button', { name: /^Harbour/ })).toBeVisible()
  await expect(trash.getByRole('button', { name: /^Harbour/ })).toHaveCount(0)
})

test('you can delete a note, and Undo brings it back', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const vault = await openVault(page)
  const note = await openNote(page, vault, /^Harbour/)
  await note.getByRole('button', { name: 'More' }).click()
  await note.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('dialog', { name: 'Note' })).toHaveCount(0)
  await expect(thisChat(vault).getByRole('button', { name: /^Harbour/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(thisChat(vault).getByRole('button', { name: /^Harbour/ })).toBeVisible()
})

test('Move takes a shared note to this chat, and a taken path says why', async ({ page }) => {
  await signIn(page)
  const shared = JSON.stringify({ path: 'shared/lists/insects', description: 'Bugs', body: 'Moths.' })
  await send(page, `${TOOLCALL}:notes_write:${shared}`)
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  await send(page, `${TOOLCALL}:notes_write:${harbour}`)
  await expect(page.getByText(/^Reply 4 /)).toBeVisible()

  const vault = await openVault(page)
  const note = await openNote(page, vault, /^Lists, insects/)
  await expect(note.getByText('shared / lists')).toBeVisible()
  await note.getByRole('button', { name: 'Move' }).click()
  const field = note.getByLabel('New path')
  await expect(field).toHaveValue('shared/lists/insects')

  await field.fill('chat/harbour')
  await note.getByRole('button', { name: 'Move note' }).click()
  await expect(note.getByRole('alert')).toContainText('That path belongs to chat/harbour.')

  await field.fill('chat/insects')
  await note.getByRole('button', { name: 'Move note' }).click()
  await expect(note.getByText('chat', { exact: true })).toBeVisible()
  await expect(field).toHaveCount(0)
  await note.getByRole('button', { name: 'Back' }).click()
  await expect(thisChat(vault).getByRole('button', { name: /^Insects/ })).toBeVisible()
})

test('other chats sit in a row, and notes of a deleted chat stay reachable', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()

  const vault = await openVault(page)
  await expect(thisChat(vault).getByRole('button')).toHaveCount(0)
  const others = vault.getByRole('region', { name: 'Other chats' })
  await others.getByRole('button', { name: /1 note/ }).click()
  await expect(others.getByRole('button', { name: /^Harbour/ })).toBeVisible()

  // The chat goes. Its note waits in Trash, and a restore puts it on a shelf with no chat.
  await page.getByRole('tab', { name: 'Chats' }).click()
  // The new chat sits first, so the chat that holds the note is second.
  const chat = page.getByRole('dialog', { name: 'Chats' }).getByRole('button', { name: /^New chat \d/ }).nth(1)
  await chat.click({ button: 'right' })
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('tab', { name: 'Vault' }).click()

  const trash = vault.getByRole('region', { name: 'Trash' })
  await trash.getByRole('button', { name: /^Trash/ }).click()
  await expect(trash.getByRole('button', { name: /^Harbour/ })).toContainText('From a deleted chat')
  await trash.getByRole('button', { name: 'Restore Harbour' }).click()
  await others.getByRole('button', { name: /^No chat/ }).click()
  await expect(others.getByRole('button', { name: /^Harbour/ })).toBeVisible()
})

test('a link in a note opens that note', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const linking = JSON.stringify({ path: 'shared/plot-threads', description: 'Threads', body: 'See [[chat/harbour]] and [[chat/nowhere]].' })
  await send(page, `${TOOLCALL}:notes_write:${linking}`)
  await expect(page.getByText(/^Reply 4 /)).toBeVisible()

  const note = await openNote(page, await openVault(page), /^Plot threads/)
  await note.getByRole('button', { name: 'Nowhere' }).click()
  await expect(page.getByText('There is no note at that path.')).toBeVisible()
  await note.getByRole('button', { name: 'Harbour' }).click()
  await expect(note.getByRole('heading', { name: 'Harbour' })).toBeVisible()
  await expect(note.getByText('Boats at dawn.')).toBeVisible()
})

test('a note body is sanitised', async ({ page }) => {
  await signIn(page)
  const bad = JSON.stringify({ path: 'chat/bad', description: 'Bad', body: 'Hi <img src=x onerror="window.pwned=1"><script>window.pwned=1</script>' })
  await send(page, `${TOOLCALL}:notes_write:${bad}`)
  await expect(page.getByText(/^Reply 2 /)).toBeVisible()
  const note = await openNote(page, await openVault(page), /^Bad/)
  await expect(note.getByText('Hi', { exact: true })).toBeVisible()
  await expect(note.locator('img, script')).toHaveCount(0)
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false)
})

test('an unsaved note edit holds back an app update', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const note = await openNote(page, await openVault(page), /^Harbour/)
  await note.getByRole('button', { name: 'Edit' }).click()
  expect(await idle(page)).toBe(true)

  const text = note.getByLabel('Note text')
  await text.fill('Half a thought')
  await expect.poll(() => idle(page)).toBe(false)
  // Back on the old words: nothing to lose.
  await text.fill('Boats at dawn.')
  await expect.poll(() => idle(page)).toBe(true)

  // An emptied body or a new description is an edit too.
  await text.fill('')
  await expect.poll(() => idle(page)).toBe(false)
  await text.fill('Boats at dawn.')
  await note.getByLabel('Note description').fill('A new line')
  await expect.poll(() => idle(page)).toBe(false)

  await page.goBack()
  await note.getByRole('button', { name: 'Discard' }).click()
  await expect.poll(() => idle(page)).toBe(true)

  await note.getByRole('button', { name: 'Edit' }).click()
  await text.fill('Saved words')
  await expect.poll(() => idle(page)).toBe(false)
  await note.getByRole('button', { name: 'Save' }).click()
  await expect(note.getByText('Saved words')).toBeVisible()
  await expect.poll(() => idle(page)).toBe(true)
})

test('a long shelf stops at the cap, and Show all shows the rest', async ({ page }) => {
  await signIn(page)
  await page.evaluate(async () => {
    const url = '/orfe/src/lib/notes/store.ts'
    const { notes, YOU } = (await import(/* @vite-ignore */ url)) as typeof import('../src/lib/notes/store')
    for (let i = 0; i < 105; i++) {
      await notes.write({ path: `shared/n${i}x`, conversationId: 'shared' }, { body: 'x', description: 'x', isNew: true }, YOU)
    }
  })
  const vault = await openVault(page)
  const shelf = vault.getByRole('region', { name: 'Shared' })
  await expect(shelf.getByText('105 notes')).toBeVisible()
  await expect(shelf.getByRole('button', { name: /^N\d+x/ })).toHaveCount(100)
  await shelf.getByRole('button', { name: /^Show all/ }).click()
  await expect(shelf.getByRole('button', { name: /^N\d+x/ })).toHaveCount(105)
  await expect(shelf.getByRole('button', { name: /^Show all/ })).toHaveCount(0)
})

test('a protected note asks once before it is deleted', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const vault = await openVault(page)
  const note = await openNote(page, vault, /^Harbour/)
  await note.getByRole('button', { name: 'Protect' }).click()
  await note.getByRole('button', { name: 'More' }).click()

  await note.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(note.getByText('Delete this protected note? It goes to Trash.')).toBeVisible()
  await note.getByRole('button', { name: 'Keep' }).click()
  await expect(note.getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(note.getByText('Delete this protected note?')).toHaveCount(0)

  await note.getByRole('button', { name: 'Delete', exact: true }).click()
  await note.getByRole('button', { name: 'Delete note' }).click()
  await expect(page.getByRole('dialog', { name: 'Note' })).toHaveCount(0)
  await expect(thisChat(vault).getByRole('button', { name: /^Harbour/ })).toHaveCount(0)
})

test('an open panel closes when the note goes to Trash', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const note = await openNote(page, await openVault(page), /^Harbour/)
  await note.getByRole('button', { name: 'Move' }).click()
  await expect(note.getByLabel('New path')).toBeVisible()
  await asModel(page, 'remove')
  await expect(note.getByText('This note is in Trash.')).toBeVisible()
  await expect(note.getByLabel('New path')).toHaveCount(0)
})

test('the small marks in the note head have 44 px hit areas', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const note = await openNote(page, await openVault(page), /^Harbour/)
  for (const name of ['Back', 'More']) {
    const [width, height] = await note.getByRole('button', { name }).evaluate((el) => {
      const after = getComputedStyle(el, '::after')
      return [parseFloat(after.width), parseFloat(after.height)]
    })
    expect(width).toBeGreaterThanOrEqual(44)
    expect(height).toBeGreaterThanOrEqual(44)
  }
})

test('search waits for a pause, and a query scans the notes once', async ({ page }) => {
  await signIn(page)
  await modelWrites(page)
  const vault = await openVault(page)
  await page.evaluate(async () => {
    const url = '/orfe/src/lib/notes/store.ts'
    const { notes } = (await import(/* @vite-ignore */ url)) as typeof import('../src/lib/notes/store')
    const calls = { all: 0, search: 0 }
    const { all, search } = notes
    notes.all = () => (calls.all++, all())
    notes.search = (...args) => (calls.search++, search(...args))
    Object.assign(window, { calls })
  })
  const search = vault.getByLabel('Search notes')
  await search.pressSequentially('dawn', { delay: 30 })
  await expect(vault.getByRole('button', { name: /^Harbour/ })).toContainText('Boats at dawn.')
  const calls = await page.evaluate(() => (window as unknown as { calls: { all: number; search: number } }).calls)
  expect(calls).toEqual({ all: 0, search: 1 })
})
