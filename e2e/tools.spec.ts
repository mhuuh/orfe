import { TOOLCALL, expect, send, signIn, test } from './fixtures'
import type { Page } from '@playwright/test'
import type { Ability } from '../src/lib/abilities/registry'

/** No ability ships yet, so this adds one to the app's own registry through the dev server. */
async function addEcho(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = '/orfe/src/lib/abilities/registry.ts'
    const registry = (await import(/* @vite-ignore */ url)) as { setAbilitiesForTest(list: Ability[]): void }
    registry.setAbilitiesForTest([
      {
        id: 'echo',
        title: 'Echo',
        summary: '',
        tools: [{ name: 'echo', description: 'Say it back.', parameters: { type: 'object', properties: {} } }],
        run: async (_name, args) => `echoed ${JSON.stringify(args)}`,
        describe: () => ({ running: 'echoing', done: 'echoed', past: '(Echoed.)' }),
        traits: {},
      },
    ])
  })
}

test('a tool call round trips and the reply appears', async ({ page, api }) => {
  await signIn(page)
  await addEcho(page)
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

test('no ability means no tools field, even on a model that can take tools', async ({ page, api }) => {
  await signIn(page)
  await send(page, 'hi')
  await expect(page.getByText(/^Reply 1 /)).toBeVisible()
  expect(api.chats[0]).not.toHaveProperty('tools')
  expect(api.chats[0]).not.toHaveProperty('tool_choice')
})
