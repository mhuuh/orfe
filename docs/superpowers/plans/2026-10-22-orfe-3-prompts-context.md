# ORFE Plan 3: Prompt Library, Rolling Context, Lens Glass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mikael can save system prompts with variants and swap them mid-chat. A rolling context window keeps requests within a limit and trims in cache-friendly chunks. The composer gets the real lens edge.

**Architecture:** Two new pure modules: `system.ts` builds the system message and `context.ts` plans the window and detects a cold cache. `send.ts` wires them into `generate`. The cold-cache check is exact: the app stores a fingerprint (hash) of the last request's messages, and the next request is warm only if its first part matches that fingerprint, the model and provider are unchanged, and the provider's cache time has not run out. The Dexie schema moves to version 2 with a `prompts` table. The UI adds a prompt sheet, a chat settings sheet, a prompt chip in the composer, a "context starts here" marker, pinning, and a lens filter on the composer.

**Tech Stack:** unchanged from Plan 1 (Vite, React 19, TS strict, Dexie 4, Vitest + fake-indexeddb, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-22-orfe-design.md` §5.1, §5.5, §6, §7.4, §8.3, §8.4, §10. API notes: `docs/research/openrouter-api-2026-10.md` §5. Code map: `CLAUDE.md`.

## Global Constraints

- Everything in Plan 1's Global Constraints still holds (`docs/superpowers/plans/2026-10-22-orfe-1-foundation.md`).
- Writes to a Message or Conversation that depend on its current value re-read inside a `db.transaction('rw', …)`.
- The system message is `[prompt text]` + `\n\n` + `[capability note]`. Either part may be absent. Nothing dynamic goes in it, such as dates or model names (spec §8.4).
- The capability note is fixed text. In Plan 3 it describes only what exists now: markdown and inline styling, used with restraint. Plans 5 and 7 extend it.
- Context defaults: mode `tokens`, limit `32000`, trim-to `0.7`, soft threshold `0.85` (spec §6).
- Cache time-to-live (TTL) defaults: 5 min. Anthropic with the 1 h setting: 60 min. `openai/gpt-5.6` and later: 30 min.
- Anthropic models (`anthropic/` prefix) get top-level `cache_control: { type: 'ephemeral' }`, plus `ttl: '1h'` when the setting is on.
- The design rule "no opacity for hierarchy" holds: dimmed messages use colour steps (`--mute`), not opacity.
- Old phone data must survive the schema upgrade untouched. Every new field has a default on read.

## Review Focus

1. **The prompt a chat uses gets deleted.** The chat falls back to "No prompt" and nothing crashes. → Task 2 test `missing prompt ref assembles as no prompt`.
2. **The message the window starts at gets deleted.** The window must not silently grow back to the whole transcript. → Task 3 test `missing window start snaps to the next message by order`.
3. **One message is bigger than the whole limit,** for example a huge paste. The last user message is never trimmed, and the request still goes out. → Task 3 test `never trims the last user turn even when it alone exceeds the limit`.
4. **Upgrading a phone that has Plan 1 data.** Conversations and messages are kept, and new fields get defaults. → Task 1 test `v1 database upgrades to v2 without losing rows`.
5. **A prompt is edited while a chat uses it.** The next request carries the new text, the cache counts as cold, and older replies show "made with an older version". → Task 4 test `editing the active prompt makes the next request cold` and Task 5 meta-line check.

---

## File Structure

```
src/lib/types.ts        + Prompt, ContextSetting, LastRequest; Conversation + Settings fields
src/lib/db.ts           version(2): prompts table; versionchange handling
src/lib/storage.ts      prompt CRUD; defaults for new fields on read
src/lib/hash.ts         hashText (FNV-1a, hex)
src/lib/system.ts       CAPABILITY_NOTE, assembleSystem
src/lib/context.ts      estimateTokens, ttlFor, isCold, planWindow
src/lib/send.ts         wire system + window + cache_control + lastRequest + tokenRatio
src/lib/openrouter.ts   ChatRequest.cacheControl → body.cache_control
src/ui/PromptSheet.tsx      pick / manage prompts (+ PromptEditor inside)
src/ui/ChatSettings.tsx     per-chat: title, context override, capability note, totals
src/ui/Composer.tsx         prompt chip; lens filter
src/ui/lens.ts              displacement-map generator (pure, testable)
src/ui/Transcript.tsx       "context starts here", dimmed out-of-window messages
src/ui/MessageActions.tsx   Pin / Unpin
src/ui/MetaLine.tsx         prompt name + "made with an older version"
src/ui/Header.tsx           ctx "12.1k / 32k" and cache state; title opens ChatSettings
src/ui/Settings.tsx         global context defaults; Anthropic 1 h cache toggle
e2e/prompts-context.spec.ts
```

---

### Task 1: Schema v2, prompt storage, version-change safety

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/db.ts`, `src/lib/storage.ts`
- Create: `src/lib/hash.ts`
- Test: `src/lib/storage.test.ts`, `src/lib/hash.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `interface Prompt { id: string; name: string; parentId: string | null; text: string; updatedAt: number; versionHash: string }`
  - `interface ContextSetting { mode: 'tokens' | 'messages'; limit: number; trimTo: number }`
  - `interface LastRequest { model: string; provider: string | null; prefixHash: string; prefixCount: number; at: number }`
  - `Conversation` gains `context: ContextSetting | null` (null = use global), `windowStartOrder: number | null`, `lastRequest: LastRequest | null`, `tokenRatio: number` (default 1).
  - `Settings` gains `context: ContextSetting` (default `{ mode: 'tokens', limit: 32000, trimTo: 0.7 }`), `anthropicCacheHour: boolean` (default false).
- Produces (`hash.ts`): `function hashText(s: string): string`, 32-bit FNV-1a as 8 lowercase hex chars.
- Produces (`storage.ts`, added to the `Storage` interface): `listPrompts(): Promise<Prompt[]>` (sorted by name, locale compare), `getPrompt(id): Promise<Prompt | undefined>`, `savePrompt(p: { id?: string; name: string; parentId: string | null; text: string }): Promise<Prompt>` (sets `updatedAt` and `versionHash = hashText(text)`, creates an id when absent), `deletePrompt(id): Promise<'deleted' | 'has-variants'>` (refuses when variants exist).
- `getConversation` and `listConversations` fill the new fields with defaults when missing. So does `getSettings`, which merges defaults deeply for `context`.
- `db.ts`: `this.version(2).stores({ prompts: 'id, parentId' })` with no upgrade function, because defaults are applied on read. `db.on('versionchange', () => { db.close(); window.dispatchEvent(new Event('orfe:db-outdated')) })`. `main.tsx` listens for that event and shows a toast "ORFE was updated in another tab · Reload".

- [ ] **Step 1: Write failing tests:**
  - `hash.test.ts`: `hashText is stable and 8 hex chars`; `different texts give different hashes` (for "a" vs "b").
  - `storage.test.ts`:
    - `v1 database upgrades to v2 without losing rows`: open a raw Dexie `orfe` at version 1 with the v1 stores, add a conversation and a message, close, then open via `db`. Both rows are still there, and `getConversation` returns `context === null`, `tokenRatio === 1`, `lastRequest === null`.
    - `savePrompt sets versionHash and updatedAt`.
    - `listPrompts sorts by name`.
    - `deletePrompt refuses while variants exist`.
    - `settings default context is tokens 32000 at 0.7`.
- [ ] **Step 2:** Run `npx vitest run src/lib/storage.test.ts src/lib/hash.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → pass. Run the full `npm test` → all pass.
- [ ] **Step 5:** Commit `feat: schema v2 with prompts, context fields and version-change safety`.

### Task 2: System message assembly

**Files:**
- Create: `src/lib/system.ts`
- Test: `src/lib/system.test.ts`

**Interfaces:**
- Consumes: `Prompt` (Task 1), `storage.getPrompt`.
- Produces:
  - `const CAPABILITY_NOTE: string`, fixed text, verbatim:
    `"Formatting: you can use Markdown (headings, lists, tables, code, footnotes) and inline HTML with style attributes — for example a coloured span, a tinted box around a recipe card, or a different font family for a poem. Use it with restraint, only where it helps the reader."`
  - `function assembleSystem(promptText: string | null, capabilityNote: boolean): string | null`. Returns the prompt text, plus `"\n\n"` and the note when the note is on. Returns null when both are empty. A whitespace-only prompt counts as empty.
  - `async function systemFor(conversation: Conversation): Promise<{ system: string | null; prompt: Prompt | null }>`. Resolves `systemPromptRef`, and treats a missing prompt as no prompt.

- [ ] **Step 1: Write failing tests:** `prompt only`, `note only`, `prompt then blank line then note`, `both empty returns null`, `missing prompt ref assembles as no prompt` (ref points to an unknown id → `prompt === null`, system is the note only).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → pass.
- [ ] **Step 5:** Commit `feat: system message assembly with capability note`.

### Task 3: Context window planning and cold-cache detection

**Files:**
- Create: `src/lib/context.ts`
- Test: `src/lib/context.test.ts`

**Interfaces:**
- Consumes: `Message`, `ContextSetting`, `LastRequest` (Task 1), `OutMessage` (openrouter.ts), `hashText`.
- Produces:
  - `function estimateTokens(messages: Message[], system: string | null, ratio: number): number`. Counts active-version text characters ÷ 4 (media parts count 0 in this plan), plus the system text, times `ratio`, rounded up.
  - `function ttlFor(modelId: string, anthropicCacheHour: boolean): number` (ms). `anthropic/` with the hour setting → 3_600_000. `openai/gpt-5.6` or later (match `/^openai\/gpt-(\d+)\.(\d+)/` and compare ≥ 5.6, including `gpt-6`) → 1_800_000. Otherwise 300_000.
  - `function fingerprint(outgoing: OutMessage[]): { prefixHash: string; prefixCount: number }`, a hash of `JSON.stringify(outgoing)` plus its length.
  - `function isCold(last: LastRequest | null, next: { model: string; provider: string | null; outgoing: OutMessage[]; now: number; ttlMs: number }): boolean`. Cold when: there is no last request; the model or provider differs; `now - last.at > ttlMs`; `next.outgoing.length < last.prefixCount`; or `hashText(JSON.stringify(next.outgoing.slice(0, last.prefixCount))) !== last.prefixHash`.
  - `function planWindow(input: { messages: Message[]; windowStartId: string | null; windowStartOrder: number | null; setting: ContextSetting; system: string | null; ratio: number; cold: boolean; soft: number }): { startId: string | null; startOrder: number | null; trimmed: boolean; size: number; limit: number }`
    - The messages are sorted by order. Dividers don't count.
    - Resolve the start. If the id is found, use it. If the id is missing but `windowStartOrder` is set, snap to the first message with `order >= windowStartOrder`. Otherwise start at the first message.
    - Size is `estimateTokens(window + pinned-before-window)` in tokens mode, or the count of non-divider messages in the window plus pins in messages mode.
    - **Hard trim** when size > limit. **Cold trim** when cold and size > soft × limit. Either trim moves the start forward one message at a time until size ≤ trimTo × limit.
    - It never moves past the **last user message**, so the newest turn is always sent. Pinned messages are always counted and never trimmed.
    - Returns `trimmed: true` only when the start moved.

- [ ] **Step 1: Write failing tests:**
  - `estimateTokens counts chars over four times ratio`
  - `ttlFor anthropic hour, gpt-5.6+, default`
  - `isCold when no last request`; `isCold on model change`; `isCold after ttl`; `isCold when an earlier message changed` (same length, one char edited inside the prefix); `warm when new request extends the old one` (old outgoing + assistant + user).
  - `no trim while under limit`
  - `hard trim to trimTo when over the limit`
  - `cold trim when over soft threshold`, and `no cold trim under soft threshold`
  - `messages mode counts messages`
  - `pinned messages before the window are counted and never trimmed`
  - `missing window start snaps to the next message by order`
  - `never trims the last user turn even when it alone exceeds the limit`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → pass.
- [ ] **Step 5:** Commit `feat: rolling context planner and exact cold-cache detection`.

### Task 4: Wire prompts, window and cache into generate

**Files:**
- Modify: `src/lib/send.ts`, `src/lib/openrouter.ts`, `src/lib/normalise.ts` (only if needed for pinned handling; it already includes pins)
- Test: `src/lib/send.test.ts`, `src/lib/openrouter.test.ts`

**Interfaces:**
- Consumes: `systemFor` (Task 2), `planWindow`, `isCold`, `fingerprint`, `ttlFor`, `estimateTokens` (Task 3).
- Produces:
  - `ChatRequest.cacheControl?: { type: 'ephemeral'; ttl?: '1h' }` → body `cache_control`.
  - `generateInner` steps:
    1. Resolve `systemFor(conversation)`.
    2. Effective setting is `conversation.context ?? settings.context`.
    3. Build a provisional outgoing with the stored window to compute `cold` via `isCold(conversation.lastRequest, …)`. Use `provider: null` until provider pinning (Plan 4).
    4. Call `planWindow` with `soft: 0.85`. If it trimmed, write `windowStartMessageId` and `windowStartOrder` to the conversation in a transaction, and rebuild outgoing with the new start.
    5. Send `cacheControl` for `anthropic/` models.
    6. Record the version's `promptRef` and `promptVersionHash`.
    7. After the request is sent, store `lastRequest = { model, provider: null, ...fingerprint(outgoing), at: Date.now() }`.
    8. On `usage`, set `conversation.tokenRatio = clamp(promptTokens / estimate, 0.5, 2)`, where `estimate` is `estimateTokens` of what was sent.
  - `async function setPrompt(conversationId: string, promptRef: string | null): Promise<void>`. Sets `systemPromptRef`. If the conversation already has messages and the ref changed, it appends a divider message: role `'divider'`, `dividerLabel: '→ ' + (prompt name ?? 'No prompt')`, one empty done version.

- [ ] **Step 1: Write failing tests** (stubbed fetch, fake-indexeddb):
  - `sends the active prompt plus capability note as the system message`
  - `editing the active prompt makes the next request cold`: two sends with a prompt edit in between. The second send's `isCold` is true. Observe it through a trim happening with a soft-threshold setup, or by exposing the computed `cold` through a test hook (implementer's choice, and the report says which).
  - `trims and stores the new window start when over the limit` (messages mode, limit 4)
  - `adds cache_control for anthropic models and ttl 1h when the setting is on`
  - `stores lastRequest fingerprint and updates tokenRatio from usage`
  - `setPrompt appends a divider only when the chat has messages and the ref changed`
  - `openrouter.test.ts`: `sends cache_control when given`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → pass, then the full suite.
- [ ] **Step 5:** Commit `feat: prompts, rolling window and cache control in generate`.

### Task 5: Prompt UI — sheet, editor, composer chip, meta line

**Files:**
- Create: `src/ui/PromptSheet.tsx`, `src/ui/PromptSheet.module.css`
- Modify: `src/ui/Composer.tsx`, `src/ui/Composer.module.css`, `src/ui/MetaLine.tsx`, `src/ui/Transcript.tsx` (pass prompt names to MetaLine), `src/ui/App.tsx` only if a sheet host is needed

**Interfaces:**
- Consumes: `storage.listPrompts/savePrompt/deletePrompt/getPrompt`, `setPrompt` (Task 4), `Sheet`, `useToast`.
- Produces: `<PromptSheet open onClose conversationId current={string | null} />`.
- Behaviour:
  - **List.** At the top, a "No prompt" row. Then parents sorted by name, each followed by its variants, indented 16 px, in mono-free Geist 15. The current prompt gets a check.
  - **Picking.** Tapping a row calls `setPrompt` and closes the sheet.
  - **Editing.** Each row has a quiet "Edit" pill. The editor is the same sheet in an edit state, with a name field, an auto-growing text area (Geist 15/22, up to 60% of the screen), and the actions Save · Duplicate as variant · Delete.
    - Delete is refused with the toast "Delete its variants first" when variants exist.
    - Deleting the prompt the current chat uses shows an undo toast and leaves the chat on "No prompt".
  - **New.** A "New prompt" row sits at the bottom.
  - **Composer chip.** A prompt chip sits between the model chip and the effort chip. It uses the same pill style and shows the prompt name, truncated to 16 characters with "…", or "No prompt". Tapping it opens the PromptSheet.
  - **MetaLine.** The expanded meta shows `prompt: <name>`. When the version's `promptVersionHash` differs from the prompt's current `versionHash`, it adds `· made with an older version`. When the prompt is gone, it shows `prompt: deleted`.

- [ ] **Step 1:** Build. Verify at 390×844 in dark and light with seeded prompts (a parent "Co-writer" with a variant "Co-writer, tighter prose", plus "Editor"). Check the composer with the prompt chip, the sheet list, the editor, a prompt-swap divider in the transcript, and the older-version meta. Compare against the child-1 look and fix what's off. Save shots under `.superpowers/sdd/<plan>/shots/task5-*.png`.
- [ ] **Step 2:** `npm test` and `npm run build` pass.
- [ ] **Step 3:** Commit `feat: prompt library sheet, editor and composer chip`.

### Task 6: Context UI — chat settings, header, window marker, pinning

**Files:**
- Create: `src/ui/ChatSettings.tsx`, `src/ui/ChatSettings.module.css`
- Modify: `src/ui/Header.tsx`, `src/ui/Header.module.css`, `src/ui/Transcript.tsx`, `src/ui/Transcript.module.css`, `src/ui/MessageActions.tsx`, `src/ui/UserMessage.module.css`, `src/ui/AssistantMessage.module.css`, `src/ui/Settings.tsx`
- Test: `src/ui/Header.test.ts` (pure meta formatter)

**Interfaces:**
- Consumes: `planWindow`, `estimateTokens` (Task 3), the conversation fields (Task 1), `storage.mutateMessage`.
- Produces:
  - `function headerMeta(input: { turns: number; size: number; limit: number; mode: 'tokens' | 'messages'; cache: 'warm' | 'cold' | 'none' }): string`. Gives `"5 turns · 12.1k / 32k ctx · warm cache"`, or in messages mode `"5 turns · 14 / 40 msgs · cold"`. `none` (no reply yet) gives `"… · –"`.
  - **Header.** Tapping the title opens `ChatSettings`. The size comes from `planWindow` with `cold: false`, which is display only and changes nothing.
  - **ChatSettings** (sheet):
    - title (rename);
    - context: "Use default (32k tokens)" or a custom choice of mode segment, limit number field and trim-to (50–90%, step 5);
    - capability note switch;
    - totals (tokens in/out, cached, cost to 4 decimals);
    - Done.
  - **Settings.** A "Context" section (mode, limit, trim-to) and a "Cache: keep Anthropic cache for 1 hour (costs 2× to write)" switch.
  - **Transcript.**
    - Messages before the window start, except pinned ones, render in `--mute` colour instead of `--prose`/`--ink`. User bubbles keep their surface but use `--mute` text.
    - A hairline divider labelled `context starts here` sits above the first in-window message. It reuses the Divider component's style.
    - Nothing shows when the window starts at the first message.
  - **MessageActions.** Pin / Unpin. A pinned message shows a small mono `pinned` in its meta row (user messages: under the bubble, right-aligned, mono 11 mute).

- [ ] **Step 1:** Write the failing `Header.test.ts` for `headerMeta` (tokens, messages and none cases). Implement. Pass.
- [ ] **Step 2:** Build the UI. Verify at 390×844 in dark and light, with a seeded long chat where the window starts partway: the dimmed messages, the marker, a pinned message above the marker, the header meta, ChatSettings and the Settings context section. Shots go in `task6-*.png`.
- [ ] **Step 3:** `npm test` and `npm run build` pass.
- [ ] **Step 4:** Commit `feat: context marker, pinning, chat settings and header context meta`.

### Task 7: Lens edge on the composer

**Files:**
- Create: `src/ui/lens.ts`, `src/ui/lens.test.ts`
- Modify: `src/ui/Composer.tsx`, `src/ui/Composer.module.css`

**Interfaces:**
- Produces:
  - `function lensMap(w: number, h: number, radius: number, rim: number): Uint8ClampedArray`. RGBA displacement data for a rounded rectangle. Inside the rim, each pixel samples inward along the inward normal, with strength `(1 - d/rim)²`. R and G encode x and y as `128 + 127 * component`. Everywhere else it is neutral 128/128. Port this from the mockup `.superpowers/brainstorm/1630-1792615550/content/children.html` (the `lens` script) and keep its maths.
  - `function supportsBackdropUrl(): boolean`: `CSS.supports('backdrop-filter', 'url(#x)')`, true only in Chromium.
  - **Composer.**
    - When supported, render a hidden `<svg>` with `<filter id="orfe-lens">` holding `feImage` (the map as a data URL from a canvas) and `feDisplacementMap` with scale 36.
    - Set `backdrop-filter: url(#orfe-lens) blur(5px) saturate(1.5) brightness(1.04)`, and lower the glass tint so the bend shows.
    - Regenerate the map only when the composer's size changes, via the existing ResizeObserver, debounced 100 ms.
    - Otherwise keep today's blur glass. With `prefers-reduced-transparency: reduce`, keep the plain blur.
  - Rim width 16 px, radius 22, matching the composer.

- [ ] **Step 1:** Write failing `lens.test.ts`: `centre pixel is neutral`; `rim pixel near the left edge samples rightwards (R > 128)`; `rim pixel near the top edge samples downwards (G > 128)`; `corner pixel samples diagonally inward`. Implement. Pass.
- [ ] **Step 2:** Wire it into the Composer. Verify in **full Chromium**, not the headless shell, which can't render `backdrop-filter`. Use a device-scale-2 crop of the composer over scrolled text in dark and light. The text under the rim should visibly bend while the middle stays clear. Shots go in `task7-*.png`. Also confirm that typing and scrolling stay smooth: no map regeneration while typing on one line.
- [ ] **Step 3:** `npm test` and `npm run build` pass.
- [ ] **Step 4:** Commit `feat: lens edge on the composer glass`.

### Task 8: End-to-end checks

**Files:**
- Create: `e2e/prompts-context.spec.ts`
- Modify: `e2e/fixtures.ts` (reuse its OpenRouter mock and record request bodies)

- [ ] **Step 1: Write tests** (Pixel 7, mocked OpenRouter):
  - `prompt swap mid-chat changes the system message and shows a divider`:
    - Create the prompt "Editor" through the sheet, send, swap to the variant "Editor, strict", send again.
    - The second request's `messages[0].content` starts with the variant text.
    - The transcript shows a divider `→ Editor, strict`.
  - `trimming keeps requests inside the limit and marks the window`:
    - Set this chat's context in ChatSettings to messages mode with limit 4 and trim-to 70%.
    - Send 5 turns.
    - The last request has at most 4 non-system messages.
    - The transcript shows `context starts here`, and the messages above it are dimmed.
  - `pinned message stays in context`: pin the first user message, then trim. The last request still contains it.
- [ ] **Step 2:** Run `npm run e2e` → all pass (5 old + 3 new). Run `npm run typecheck:e2e` → clean.
- [ ] **Step 3:** Commit `test: e2e for prompt swaps, trimming and pins`.
