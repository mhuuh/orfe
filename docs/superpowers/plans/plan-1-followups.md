# Plan 1 — open follow-ups

Left open after Plan 1's reviews. None blocks daily use. Fold them into the plan that touches the same code.

## Check on the real phone (can't be tested headless)
- Android keyboard: the composer and send row stay above the keyboard (`interactive-widget=resizes-content`).
- Auto-scroll: dragging up during a long streaming reply should let go and stay put.
- Back gesture: drawer → Settings → Change model → Back → Back. Chrome may skip a history entry that was pushed without a tap.
- Lock the phone mid-reply: the reply should end as "interrupted" with Continue. Plan 2's relay is the real fix.

## Behaviour
- Deleting the open chat from the drawer leaves one Back press that does nothing.
- Tapping Retry on the model list during the short cache read can be ignored.
- The effort chip is hidden for an unknown model while the catalog loads.
- A single toast replaces the previous one, so the first Undo is lost.
- Stop pressed after `finish` but before `usage` marks a complete reply as "stopped".
- A streaming reply re-renders fully every 200 ms, so text selection is lost and open `<details>` close.
- There is no trailing write when a stream pauses, so the screen can lag up to 200 ms.
- New chat creates another empty chat instead of reusing an empty current one.
- Rename is reached only by long-press or context menu, and Escape in rename can save.
- If IndexedDB fails permanently, the app shows a blank page.
- A conversation deleted while it still holds a draft blocks app updates until reload.

## Hardening
- `setCache` failure throws away freshly fetched models. Cache rows are not versioned; add versioning before the `ModelInfo` shape changes.
- A non-numeric `created` would throw in `Intl` month formatting.
- `setSettings` reads, merges and writes outside a transaction.
- `appendMessage` and `restoreMessage` don't check that the conversation exists.
- The DOMPurify hook sits on the global instance.
- `versions.ts` imports `newId` from storage, which pulls in Dexie.
- Drawer undo and the Header query bypass the storage seam.
- Copy has no fallback when the clipboard API is missing.
- Handle `db.on('versionchange')` before the first Dexie schema change.

## Accessibility and design polish
- Sheet: add focus trap, focus restore and `inert`; give Done and the toast action visible focus.
- Add arrow-key handling to the toolbar and radiogroup; the message article needs `aria-expanded`.
- Add a `--scrim` token; remove duplicated palette selectors in `tokens.css`.
- Composer has off-scale spacing (14/10/6 px from the mockup): rule on it or tokenise it.
- Send, Reply and the empty state look identical.
- There is no keyboard way to add a message without a reply.

## Tests
- Wire `typecheck:e2e` into CI. The stop e2e test is coupled to the 200 ms throttle.
- Add catalog tests for an expired cache, the success path, the `sortNewest` tie-break and mixed outputs.
- Add an abort-during-fetch e2e case.
