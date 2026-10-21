# ORFE Plan 1: Foundation and Core Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable PWA at `https://mhuuh.github.io/orfe/` where Mikael pastes his OpenRouter key and chats with streaming replies. Any model can write the next turn. Every message can be edited, rerolled into versions, or deleted. Everything is stored on the phone.

**Architecture:** Vite + React + TypeScript single-page app, with no backend. IndexedDB (via Dexie) is the single source of truth. UI components read it through `useLiveQuery`, so the transcript updates live as a stream writes to the DB. The pure logic (SSE parsing, the send-time normaliser, catalog sorting) is plain TypeScript with unit tests. The UI is thin.

**Tech Stack:** Vite 6, React 19, TypeScript 5 (strict), Dexie 4 + dexie-react-hooks, vite-plugin-pwa, markdown-it, DOMPurify, Vitest + fake-indexeddb, Playwright (mobile viewport), `@fontsource-variable/geist`, `@fontsource/geist-mono`, `@fontsource-variable/newsreader` (fonts bundled for offline use).

**Spec:** `docs/superpowers/specs/2026-10-22-orfe-design.md` (research reference: `docs/research/openrouter-api-2026-10.md`)

**Roadmap (later plans, written when their turn comes):**
- Plan 2: background relay (spike first, spec §9.1) with direct-mode fallback, wake lock, Continue/Retry on interruption.
- Plan 3: prompt library and swapping (§8.3–8.4), rolling context + cache logic + indicator (§6).
- Plan 4: picker polish (most used, favourites, filters, provider sheet §8.1–8.2), OAuth login, backup/restore/persist/nudge (§9), web search toggle, auto-titles, usage panel.
- Plan 5: rich output: full inline-style allowlist, KaTeX, code highlighting, live frames (§7.1–7.2, 7.4).
- Plan 6: media in and out (§8.5–8.6, normaliser rules 8–10).
- Plan 7: per-chat themes (§7.3).

## Global Constraints

- App URL `https://mhuuh.github.io/orfe/`; Vite `base: '/orfe/'`; PWA `scope` and `start_url` `/orfe/`.
- No server stores data. Calls go to `https://openrouter.ai/api/v1` from the browser. The key is sent only to openrouter.ai.
- Headers on every OpenRouter call: `Authorization: Bearer <key>` (when present), `HTTP-Referer: https://mhuuh.github.io/orfe/`, `X-OpenRouter-Title: ORFE`, `X-OpenRouter-App-Visibility: hidden`.
- Every chat request carries `session_id: conversation.sessionId`.
- Reasoning is stored but never sent back (spec §5.4).
- Editing never deletes later messages. Reroll and edit add versions; they never overwrite.
- Design tokens exactly as spec §10 (palette table, Geist 15/22 UI, Geist Mono 11/16 meta, Newsreader 17/26 prose, radius 14, pills, 4 pt spacing 4 8 12 16 24 32 48). Minimum text 11 px; all real text passes WCAG AA 4.5:1; placeholder passes at least 3:1.
- One glass object only: the composer.
- Phone first (360–430 px wide); desktop gets a centred column, max 720 px.
- TypeScript `strict: true`. No `any` in `src/lib/**`.

## Review Focus

1. **A stream chunk splits mid-line or mid-character** (Finnish ä/ö, emoji). The text must arrive intact. → Task 3 test `parses events split across chunk and UTF-8 boundaries`.
2. **The app reloads or is killed mid-stream.** A version left in `status: 'streaming'` must show as interrupted, not spin forever. → Task 6 test `marks stale streaming versions interrupted on startup`.
3. **Offline or OpenRouter down when opening the model list.** The cached catalog is used. With no cache, a clear error with retry appears, not an empty sheet. → Task 5 test `falls back to cached catalog when fetch fails`.
4. **A delete or edit leaves two user turns in a row, or an assistant turn first.** The request must still be valid. → Task 4 tests (rules 3 and 4).
5. **Bad key (401) or no credits (402).** The reply shows a readable inline error on the message with Retry, never an empty bubble. → Task 6 test `stores readable error for 401 and 402`.

---

## File Structure

```
index.html
package.json  tsconfig.json  vite.config.ts  vitest.config.ts  playwright.config.ts
DESIGN.md                           design system (copied from spec §10)
.github/workflows/deploy.yml        build + deploy to GitHub Pages
public/icon.svg, icon-192.png, icon-512.png
src/
  main.tsx                          mounts <App/>, imports fonts + styles
  App.tsx                           layout: Header, Transcript, Composer, sheets
  styles/tokens.css                 CSS variables, light + dark
  styles/base.css                   reset, type, layout primitives
  lib/types.ts                      domain types (spec §4)
  lib/db.ts                         Dexie schema
  lib/storage.ts                    Storage interface + Dexie implementation (the seam, spec §9)
  lib/sse.ts                        SSE line parser
  lib/openrouter.ts                 API client: streamChat, fetchModels, fetchKeyInfo
  lib/normalise.ts                  send-time normaliser (spec §5.5)
  lib/catalog.ts                    model filtering, sorting, month groups, search
  lib/send.ts                       turn orchestration: send, reroll, continue, stop
  lib/markdown.ts                   markdown-it + DOMPurify (basic allowlist; full one in Plan 5)
  lib/*.test.ts                     unit tests beside each module
  ui/Header.tsx  ui/Drawer.tsx  ui/Settings.tsx  ui/KeySetup.tsx
  ui/Transcript.tsx  ui/UserMessage.tsx  ui/AssistantMessage.tsx
  ui/MetaLine.tsx  ui/Divider.tsx  ui/Thinking.tsx  ui/Versions.tsx  ui/MessageActions.tsx
  ui/Composer.tsx  ui/ModelSheet.tsx  ui/Sheet.tsx  ui/Toast.tsx
  ui/*.module.css                   one CSS module per component
e2e/core.spec.ts                    mobile smoke with mocked OpenRouter
```

---

### Task 1: Scaffold, design tokens, deploy pipeline

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles/tokens.css`, `src/styles/base.css`, `DESIGN.md`, `public/icon.svg`, `public/icon-192.png`, `public/icon-512.png`, `.github/workflows/deploy.yml`
- Test: `src/lib/smoke.test.ts`

**Interfaces:**
- Produces: CSS variables used by every later task: `--bg --surface --line --ink --prose --mute --faint --radius (14px) --font-ui --font-mono --font-prose --s1..--s7 (4 8 12 16 24 32 48px)`. Light/dark via `prefers-color-scheme`, overridden by `<html data-theme="light|dark">`.

- [ ] **Step 1:** `npm create vite@latest . -- --template react-ts`, then add the dependencies from the Tech Stack line. Set `"type": "module"` and scripts `dev`, `build` (`tsc -b && vite build`), `test` (`vitest run`), `e2e` (`playwright test`).
- [ ] **Step 2:** `vite.config.ts`: `base: '/orfe/'`, `VitePWA({ registerType: 'autoUpdate', manifest: { name: 'ORFE', short_name: 'ORFE', start_url: '/orfe/', scope: '/orfe/', display: 'standalone', background_color: '#0e0e0f', theme_color: '#0e0e0f', icons: [192, 512 png + svg] }, workbox: { navigateFallback: '/orfe/index.html' } })`.
- [ ] **Step 3:** Write `tokens.css` with the spec §10 palette for both themes. Faint: choose values that pass 3:1 on `bg` and `surface` (dark ≈ `#75746f`, light ≈ `#8d8c86`; verify with a contrast checker). Write `base.css`: body uses `--font-ui` 15px/22px, `background: var(--bg)`, `color: var(--ink)`, `text-wrap: pretty` on `p`. Copy the spec §10 six lines + palette into `DESIGN.md`.
- [ ] **Step 4:** Icons: a simple mark on `#0e0e0f` (a small off-white circle split by a hairline: "one transcript, two voices"). Export the svg and both pngs.
- [ ] **Step 5:** Write the smoke test `smoke.test.ts`: `expect(1 + 1).toBe(2)`, to prove Vitest runs with `environment: 'jsdom'` and `setupFiles: ['fake-indexeddb/auto']`.
- [ ] **Step 6:** Run `npm test` → 1 passed. Run `npm run build` → `dist/` contains `manifest.webmanifest` and `sw.js`.
- [ ] **Step 7:** `deploy.yml`: on push to `main`: checkout, setup-node 22, `npm ci`, `npm test`, `npm run build`, `actions/upload-pages-artifact` (path `dist`), `actions/deploy-pages`. Permissions `pages: write`, `id-token: write`.
- [ ] **Step 8:** Commit `chore: scaffold ORFE PWA with design tokens and Pages deploy`.

### Task 2: Domain types and storage

**Files:**
- Create: `src/lib/types.ts`, `src/lib/db.ts`, `src/lib/storage.ts`
- Test: `src/lib/storage.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `type Role = 'user' | 'assistant' | 'divider'`
  - `type ContentPart = { type: 'text'; text: string } | { type: 'media'; blobId: string; mime: string; name?: string }`
  - `type VersionStatus = 'streaming' | 'done' | 'stopped' | 'interrupted' | 'error'`
  - `interface Reasoning { text: string; details: unknown[]; durationMs: number }`
  - `interface Usage { promptTokens: number; completionTokens: number; cachedTokens: number; cacheWriteTokens: number; reasoningTokens: number; cost: number }`
  - `interface Version { id: string; content: ContentPart[]; status: VersionStatus; model?: string; provider?: string; promptRef?: string | null; promptVersionHash?: string; reasoningEffort?: string; reasoning?: Reasoning | null; usage?: Usage; generationId?: string; finishReason?: string; error?: string | null; createdAt: number; editedAt?: number }`
  - `interface Message { id: string; conversationId: string; order: number; role: Role; versions: Version[]; activeVersion: number; pinned: boolean; dividerLabel?: string; createdAt: number }`
  - `interface Conversation { id: string; title: string; createdAt: number; updatedAt: number; sessionId: string; systemPromptRef: string | null; capabilityNote: boolean; windowStartMessageId: string | null; nextModel: string; nextEffort: string | null; totals: Usage }`
  - `interface Settings { key: string | null; streaming: boolean; themeMode: 'system' | 'light' | 'dark'; defaultModel: string }`
- Produces (`storage.ts`), the single seam all code uses:
  - `interface Storage { listConversations(): Promise<Conversation[]>; getConversation(id): Promise<Conversation | undefined>; createConversation(init?: Partial<Conversation>): Promise<Conversation>; updateConversation(id, patch: Partial<Conversation>): Promise<void>; deleteConversation(id): Promise<void>; listMessages(conversationId): Promise<Message[]>; putMessage(m: Message): Promise<void>; deleteMessage(id): Promise<Message | undefined>; restoreMessage(m: Message): Promise<void>; appendMessage(conversationId, role: Role, first: Version): Promise<Message>; getSettings(): Promise<Settings>; setSettings(patch: Partial<Settings>): Promise<void>; getCache<T>(key: string): Promise<{ value: T; at: number } | undefined>; setCache<T>(key: string, value: T): Promise<void> }`
  - `export const storage: Storage` (Dexie-backed); `export const db` (for `useLiveQuery` in UI only).
  - `newId(): string` (crypto.randomUUID).
- `appendMessage` sets `order = (max order in conversation) + 1` and bumps `conversation.updatedAt`. `Settings.defaultModel` defaults to `'anthropic/claude-sonnet-5.5'`, `streaming: true`, `themeMode: 'system'`.

- [ ] **Step 1: Write failing tests** in `storage.test.ts`:
  - `creates a conversation with a fresh sessionId and zero totals`
  - `appendMessage assigns increasing order and bumps updatedAt`
  - `listMessages returns messages sorted by order`
  - `deleteMessage returns the removed message and restoreMessage puts it back in place` (order preserved)
  - `deleteConversation removes its messages`
  - `settings have defaults: streaming true, themeMode system, key null`
- [ ] **Step 2:** Run `npx vitest run src/lib/storage.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `types.ts`, `db.ts` (Dexie tables: `conversations: 'id, updatedAt'`, `messages: 'id, conversationId, [conversationId+order]'`, `settings: 'k'`, `cache: 'k'`), and `storage.ts`.
- [ ] **Step 4:** Run the tests → 6 passed.
- [ ] **Step 5:** Commit `feat: domain types and Dexie storage behind a Storage seam`.

### Task 3: SSE parser and OpenRouter client

**Files:**
- Create: `src/lib/sse.ts`, `src/lib/openrouter.ts`
- Test: `src/lib/sse.test.ts`, `src/lib/openrouter.test.ts`

**Interfaces:**
- Produces:
  - `sse.ts`: `async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string>`. Yields each `data:` payload string, skips `:` comment lines, stops at `[DONE]`. Uses `TextDecoder` with `{ stream: true }` and line buffering.
  - `openrouter.ts`:
    - `type StreamEvent = { type: 'content'; text: string } | { type: 'reasoning'; text: string; details?: unknown[] } | { type: 'usage'; usage: Usage } | { type: 'meta'; generationId?: string; provider?: string } | { type: 'finish'; reason: string } | { type: 'error'; message: string; code?: number }`
    - `interface ChatRequest { model: string; messages: OutMessage[]; sessionId: string; stream: boolean; reasoning?: { effort: string }; provider?: unknown }`
    - `type OutMessage = { role: 'system' | 'user' | 'assistant'; content: string | OutPart[] }`, `type OutPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }`
    - `async function* streamChat(req: ChatRequest, key: string, signal: AbortSignal): AsyncGenerator<StreamEvent>`. Handles non-ok HTTP (yields one `error` with the status code and the message from the body's `error.message`), the mid-stream `error` object, `delta.content`, `delta.reasoning`, `delta.reasoning_details`, the final `usage` (mapping `prompt_tokens_details.cached_tokens`, `cache_write_tokens`, `completion_tokens_details.reasoning_tokens`, `cost`), `finish_reason`, and the `X-Generation-Id` / `X-Provider-Name` headers (as `meta`). With `stream: false`, it yields the same events from the JSON response.
    - `function headers(key?: string | null): Record<string, string>` with the Global Constraints headers.
    - `interface RawModel { id: string; name: string; created: number; context_length: number; pricing: { prompt: string; completion: string }; architecture: { input_modalities: string[]; output_modalities: string[] }; reasoning?: { supported_efforts?: string[]; default_effort?: string } }` (a subset of the API shape; extra fields are ignored).
    - `async function fetchModels(): Promise<RawModel[]>`: `GET /models?output_modalities=all`, no key.
    - `async function fetchKeyInfo(key: string): Promise<{ limit: number | null; limitRemaining: number | null; usage: number }>`.
    - `const API = 'https://openrouter.ai/api/v1'`.

- [ ] **Step 1: Write failing tests** in `sse.test.ts` (build streams from string arrays with a helper `streamOf(...chunks: (string | Uint8Array)[])`):
  - `yields data payloads and stops at [DONE]`
  - `skips comment lines like ": OPENROUTER PROCESSING"`
  - `parses events split across chunk and UTF-8 boundaries`: split `data: {"t":"Hyvää päivää 🌙"}\n\n` into byte chunks that cut inside `ä` and inside the emoji; expect the payload to equal the original JSON string.
  - `handles \r\n line endings`
- [ ] **Step 2: Write failing tests** in `openrouter.test.ts` (mock `fetch` with `vi.stubGlobal`):
  - `maps content, reasoning, usage and finish events in order`: fixture stream with 2 reasoning deltas, 2 content deltas, a finish chunk, a usage chunk; assert the event sequence and `usage.cachedTokens === 900`, `usage.cost === 0.0123`.
  - `yields a single error event for HTTP 401 with the body message`: `{ type: 'error', code: 401, message: 'No auth credentials found' }`.
  - `yields error for mid-stream error object`
  - `sends session_id, stream, reasoning and attribution headers`: inspect the fetch call's body JSON and headers.
  - `non-streaming mode yields content, reasoning, usage, finish from JSON`
- [ ] **Step 3:** Run both files → FAIL.
- [ ] **Step 4:** Implement `sse.ts` and `openrouter.ts`. The body sent is `{ model, messages, stream, session_id: sessionId, reasoning?, provider? }`.
- [ ] **Step 5:** Run → all pass.
- [ ] **Step 6:** Commit `feat: SSE parser and OpenRouter streaming client`.

### Task 4: Send-time normaliser

**Files:**
- Create: `src/lib/normalise.ts`
- Test: `src/lib/normalise.test.ts`

**Interfaces:**
- Consumes: `Message`, `Version`, `ContentPart` (Task 2); `OutMessage` (Task 3).
- Produces: `function buildOutgoing(messages: Message[], opts: { system: string | null; windowStartId: string | null; upToId?: string; inputModalities: string[]; blobUrl: (blobId: string) => string | undefined }): OutMessage[]`
  - `upToId` excludes that message and everything after it (used by reroll; spec §5.2 "context up to that message").
  - Media parts: if `inputModalities` includes `image` and the mime is `image/*` and `blobUrl` returns a data URL, emit `image_url`. Otherwise emit the text stand-in `[image not shown to this model: "<name>"]` (spec §5.5 rule 8). Other media types become stand-ins in this plan; Plan 6 extends them.

- [ ] **Step 1: Write failing tests**, one per spec §5.5 rule:
  - `rule 1: uses active versions and only messages from windowStart on, plus pinned messages before it in original order`
  - `rule 2: drops dividers and empty messages` (whitespace-only text counts as empty)
  - `rule 3: merges consecutive same-role messages with a blank line`, e.g. user "a", user "b" → one user `"a\n\nb"`
  - `rule 4: inserts "…" user turn when first non-system message is assistant`
  - `rule 5: never includes reasoning` (the output JSON contains no `reasoning` key)
  - `rule 6: prepends system message when system is non-empty; omits it when null or empty`
  - `rule 7: allows ending on assistant (prefill)`
  - `upToId excludes the target and everything after it`
  - `image becomes image_url for image-capable model and a stand-in otherwise`
  - `text-only messages are sent as plain string content, mixed ones as part arrays`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `buildOutgoing` as a pipeline: select → drop → map parts → merge → fix start → prepend system.
- [ ] **Step 4:** Run → 10 passed.
- [ ] **Step 5:** Commit `feat: send-time normaliser for alternation, windows and media stand-ins`.

### Task 5: Model catalog

**Files:**
- Create: `src/lib/catalog.ts`
- Test: `src/lib/catalog.test.ts`, fixture `src/lib/__fixtures__/models.json` (about 8 trimmed real-shaped entries across text, image, embeddings, rerank, decisions outputs; two with `reasoning.supported_efforts`; varying `created` across three months)

**Interfaces:**
- Consumes: `fetchModels` (Task 3), `storage.getCache/setCache` (Task 2).
- Produces:
  - `interface ModelInfo { id: string; name: string; created: number; contextLength: number; priceIn: number; priceOut: number; inputModalities: string[]; outputModalities: string[]; efforts: string[] | null; defaultEffort: string | null; free: boolean }`. Prices are USD per 1M tokens, converted from the per-token strings.
  - `function toModelInfo(raw: RawModel): ModelInfo`
  - `function chatModels(models: ModelInfo[]): ModelInfo[]` drops models whose outputs are only within `embeddings | rerank | decisions | transcription`.
  - `function sortNewest(models): ModelInfo[]`, `function sortAZ(models): ModelInfo[]` (by `name`, locale compare).
  - `function groupByMonth(models: ModelInfo[], locale = 'en-GB'): { label: string; models: ModelInfo[] }[]` with labels like `"October 2026"`, newest group first (spec §8.1, Mikael).
  - `function search(models, q: string): ModelInfo[]`: case-insensitive match on id and name, all whitespace-separated terms must match.
  - `async function loadCatalog(opts?: { force?: boolean }): Promise<{ models: ModelInfo[]; fetchedAt: number; stale: boolean; error?: string }>`. Uses the cache if younger than 1 h, unless forced. On fetch failure it returns the cache with `error` set. With no cache, it returns `models: []` and `error`.

- [ ] **Step 1: Write failing tests:**
  - `toModelInfo converts per-token price strings to per-million numbers` (`"0.000003"` → `3`)
  - `chatModels removes embeddings, rerank and decisions models`
  - `groupByMonth groups by created month, newest first, with "October 2026" labels`
  - `sortAZ is alphabetical by name`
  - `search matches all terms across id and name`
  - `loadCatalog uses fresh cache without fetching`
  - `falls back to cached catalog when fetch fails` (fetch rejects; the result has the cached models and `error`)
  - `returns empty list with error when fetch fails and no cache`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → 8 passed.
- [ ] **Step 5:** Commit `feat: model catalog with month groups, search and offline cache`.

### Task 6: Turn orchestration (send, reroll, continue, stop)

**Files:**
- Create: `src/lib/send.ts`
- Test: `src/lib/send.test.ts`

**Interfaces:**
- Consumes: `storage` (Task 2), `streamChat` (Task 3), `buildOutgoing` (Task 4), `ModelInfo` (Task 5).
- Produces:
  - `async function sendUserMessage(conversationId: string, text: string, opts: { reply: boolean }): Promise<void>` appends a user message. If `reply`, it calls `generate`.
  - `async function generate(conversationId: string, target: { kind: 'new' } | { kind: 'reroll'; messageId: string } | { kind: 'continue'; messageId: string }, model: ModelInfo): Promise<void>`:
    - `new` appends an assistant message with one `streaming` version.
    - `reroll` pushes a new `streaming` version onto the target and makes it active. Its context is `upToId: messageId`.
    - `continue` sends context including the target (prefill) and appends streamed text onto a **new version** whose content starts with the old text.
    - Model, effort and session come from `conversation.nextModel` / `nextEffort` / `sessionId`. `stream` comes from `settings.streaming`. The system prompt is `null` in this plan (Plan 3 adds prompts). `inputModalities` comes from `model`. `blobUrl` is `() => undefined` until Plan 6 adds the blob store.
    - Content and reasoning are written to storage at most every 200 ms and once at the end.
    - On `finish`, the status becomes `done`. On `usage`, it is stored on the version and added to `conversation.totals`. On `error`, the status becomes `error` with a readable message. Reasoning `durationMs` = time from the first reasoning event to the first content event.
  - `function stop(conversationId: string): void` aborts the active stream. The version ends `status: 'stopped'`, with its partial text kept.
  - `function isGenerating(conversationId: string): boolean`
  - `async function recoverInterrupted(): Promise<number>` marks every version still `streaming` as `interrupted` (call on app start). Returns the count.
  - `function errorText(code: number | undefined, message: string): string` maps 401 → `"Your OpenRouter key was rejected. Check it in Settings."`, 402 → `"Out of credits on OpenRouter."`, 429 → `"Rate limited. Try again in a moment."`. Anything else → the message.

- [ ] **Step 1: Write failing tests** (fake-indexeddb + stubbed `fetch` with fixture streams):
  - `new: appends assistant message with model, content, usage and status done`
  - `new: second turn with a different model sends both previous assistant texts` (the core promise: send with model A, switch `nextModel` to B, send again; assert the second request body has `model: B` and contains A's reply text)
  - `reroll: adds a version, keeps the old one, and sends context only up to the target`
  - `continue: new version starts with old text and request ends with assistant prefill`
  - `stop: aborts and leaves status stopped with partial text`
  - `stores readable error for 401 and 402` (version status `error`, `error` equals the `errorText` strings)
  - `marks stale streaming versions interrupted on startup`
  - `adds usage to conversation totals`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Keep one `AbortController` per conversation in a module-level `Map`.
- [ ] **Step 4:** Run → 8 passed.
- [ ] **Step 5:** Commit `feat: turn orchestration with reroll, continue, stop and recovery`.

### Task 7: App shell — header, drawer, settings, key setup

**Files:**
- Create: `src/ui/Header.tsx`, `src/ui/Drawer.tsx`, `src/ui/Settings.tsx`, `src/ui/KeySetup.tsx`, `src/ui/Sheet.tsx`, `src/ui/Toast.tsx`, matching `*.module.css`
- Modify: `src/App.tsx`, `src/main.tsx`

**Interfaces:**
- Consumes: `storage`, `db` (Task 2), `fetchKeyInfo` (Task 3), `recoverInterrupted` (Task 6).
- Produces:
  - `<Sheet open onClose title children/>`: a bottom sheet (radius 14 on the top corners, `surface` background, no blur, 180 ms ease-out slide, respects reduced motion). Reused by the model sheet.
  - `useToast(): { show(text: string, action?: { label: string; run: () => void }, ms = 6000): void }`
  - The current conversation id lives in the URL hash `#/c/<id>`, so back works and reloads keep the place.

- [ ] **Step 1:** `main.tsx` calls `recoverInterrupted()` before rendering. It applies `settings.themeMode` to `<html data-theme>` (it removes the attribute for `system`).
- [ ] **Step 2:** `KeySetup`: shown when `settings.key` is null. Text: "Paste your OpenRouter key. It stays on this phone." A password input, Save validates with `fetchKeyInfo` and shows the error text from `errorText` on failure. Below, in mute: "Tip: give this key a credit limit on openrouter.ai/settings/keys."
- [ ] **Step 3:** `Header` (spec mockup child 1): title (Geist 15/22 medium) and, under it, mono 11/16 meta `"<n> turns · <x>k ctx · <cache>"`. In this plan, ctx = the last reply's `promptTokens` and cache = `warm cache` if the last reply's `cachedTokens > 0`, else `cold`. Right side: the ≡ button opens the Drawer. Padding: top = safe-area + 12, sides 20.
- [ ] **Step 4:** `Drawer`: a sheet from the left listing conversations by `updatedAt` desc. A "New chat" row at the top. Long-press a row → rename / delete (delete shows an undo toast). The Settings link sits at the bottom.
- [ ] **Step 5:** `Settings`: key (masked, change, remove), key info (limit / remaining / usage from `fetchKeyInfo`), streaming toggle, theme mode (system / light / dark), default model (picked through the ModelSheet from Task 9).
- [ ] **Step 6:** Verify: `npm run dev`, open at a 390×844 viewport. Paste an invalid key → a readable error. A new chat appears in the drawer. Rename, delete, undo all work. Switch themes and check both look right against spec §10.
- [ ] **Step 7:** Commit `feat: app shell with key setup, drawer, settings and toasts`.

### Task 8: Transcript

**Files:**
- Create: `src/lib/markdown.ts`, `src/lib/markdown.test.ts`, `src/ui/Divider.test.ts`, `src/ui/Transcript.tsx`, `src/ui/UserMessage.tsx`, `src/ui/AssistantMessage.tsx`, `src/ui/MetaLine.tsx`, `src/ui/Divider.tsx`, `src/ui/Thinking.tsx`, `src/ui/Versions.tsx`, `src/ui/MessageActions.tsx`, matching `*.module.css`

**Interfaces:**
- Consumes: `db` + `useLiveQuery` (Task 2), `generate`, `stop`, `isGenerating` (Task 6), `useToast` (Task 7).
- Produces:
  - `function renderMarkdown(src: string): string`: markdown-it (`html: true`, `linkify: true`, `typographer: true`, with footnote and task-list plugins), sanitised by DOMPurify with tags `p br b i u s em strong mark small sub sup kbd code pre blockquote hr ul ol li table thead tbody tr th td a h1-h6 span div details summary` and attributes `href title class style`. `style` passes through unchanged here; Plan 5 replaces it with the property allowlist. Links get `target="_blank" rel="noopener noreferrer"`.
  - `function dividerLabel(prev: Version | undefined, curr: Version): string | null` returns `"<model id without author> · <prompt name or ''>"` when the model or prompt changed, else null. Exported from `Divider.tsx` and unit-tested in `src/ui/Divider.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - `markdown.test.ts`: `renders GFM tables and task lists`; `strips script tags and on* handlers`; `adds target _blank and rel to links`; `keeps inline span style for now`.
  - `src/ui/Divider.test.ts`: `labels a model change`; `returns null when model and prompt are unchanged`; `returns null for the first assistant message`.
- [ ] **Step 2:** Run → FAIL. Implement `markdown.ts` and `dividerLabel`. Run → pass.
- [ ] **Step 3:** `UserMessage`: grey bubble (`--surface`), right-aligned, max-width 84%, radius 14, padding 10/14, Geist 15/22, `white-space: pre-wrap`.
- [ ] **Step 4:** `AssistantMessage`: `MetaLine` (mono 11/16 mute: model id without author; tap expands to provider · effort · tokens in/out · cached · `$cost` with 4 decimals). Then `Thinking` (when reasoning exists: open while `streaming` and content is empty; when content starts it folds to `"Thought for <s> s"`; tap toggles), then prose (`--font-prose` 17/26, `--prose` colour, `dangerouslySetInnerHTML={renderMarkdown(text)}`). A caret blinks while streaming. Interrupted, stopped and error states show a one-line mono note in mute plus the relevant actions.
- [ ] **Step 5:** `Versions`: `‹ 2/3 ›` in mono 11 when `versions.length > 1`. Tapping sets `activeVersion`.
- [ ] **Step 6:** `MessageActions`: a long-press or tap on a message reveals a quiet action row: Edit · Reroll (assistant) · Continue (last assistant) · Copy · Delete. **Edit** turns the message into a textarea in place. Save pushes a new version with `editedAt`; it never removes later messages. **Delete** removes the message with an undo toast (`restoreMessage`). When the message has more than one version, the row offers "Delete this version" too (it removes the active version and activates its neighbour, with undo). **Reroll** calls `generate({kind:'reroll'})`. **Continue** calls `generate({kind:'continue'})`. Retry on an error or interrupted reply = Reroll.
- [ ] **Step 7:** `Transcript`: renders messages in order. It inserts a `Divider` (hairline, centred mono 11 mute label, margins 32 top / 16 bottom) before an assistant message where `dividerLabel` is non-null. It auto-scrolls to the bottom while streaming unless the user has scrolled up more than 80 px. Bottom padding = composer height + 24. The top edge has the 24 px fade mask from the mockup.
- [ ] **Step 8:** Verify in dev at 390×844 against the mockup's first phone (`.superpowers/brainstorm/1630-1792615550/content/children.html`). Check: bubble, meta, divider, serif prose, spacing. Run `npm test` → all pass.
- [ ] **Step 9:** Commit `feat: transcript with versions, edit, reroll, continue, delete and thinking`.

### Task 9: Composer and model sheet

**Files:**
- Create: `src/ui/Composer.tsx`, `src/ui/Composer.module.css`, `src/ui/ModelSheet.tsx`, `src/ui/ModelSheet.module.css`

**Interfaces:**
- Consumes: `sendUserMessage`, `generate`, `stop`, `isGenerating` (Task 6), `loadCatalog`, `chatModels`, `sortNewest`, `sortAZ`, `groupByMonth`, `search` (Task 5), `Sheet` (Task 7).
- Produces: `<ModelSheet open onClose onPick={(m: ModelInfo) => void} current={string}/>`, reused by Settings (default model) and Plan 4.

- [ ] **Step 1:** `Composer` (spec §10 glass): absolutely positioned 12 px from the left, right and bottom (plus safe-area), radius 22, `background: color-mix(in oklab, var(--bg) 62%, transparent)`, `backdrop-filter: blur(22px) saturate(1.4)`, inset top highlight, and the 1 px gradient edge done with the mask-composite technique from the mockup. An auto-growing textarea (1–8 lines, Geist 15/22, placeholder "Reply…" in `--faint`). The tools row holds a model chip (mono 11, pill, `surface` tint, model id without author + ▾) and an effort chip (only when `model.efforts`, cycling through `efforts`, shown as `effort: high`). Send is a 32 px round `--ink` button with an up arrow. While generating it becomes Stop (a square glyph) calling `stop`.
- [ ] **Step 2:** Send behaviour: tap = `sendUserMessage(text, { reply: true })`. Long-press (500 ms) = `{ reply: false }`, with toast "Added without reply". With an empty text field and the last message from the user, tap = `generate({kind:'new'})` (the spec §5.2 "Reply" action). Enter inserts a newline. Ctrl/Cmd+Enter sends.
- [ ] **Step 3:** Picking a model or effort writes `conversation.nextModel` / `nextEffort`. A new chat starts with `settings.defaultModel`.
- [ ] **Step 4:** `ModelSheet`: a search field on top, then a segmented toggle `Newest · A–Z`. Newest renders `groupByMonth` with **sticky month headers** (mono 11, normal case, mute, `bg` background). Each row: name (Geist 15), and under it mono 11 mute `$<in> / $<out> · <ctx>k` (or `free`). The current model gets a check. On a load error with no models: "Couldn't load models." + Retry. With an error and cached models: a mute line "Offline — showing saved list". (Most used, favourites, filters and providers come in Plan 4.)
- [ ] **Step 5:** Verify at 390×844: type a long message (the composer grows, text scrolls under the glass and visibly blurs). Long-press to send without reply. Switch the model mid-chat → the divider appears on the next reply. The effort chip appears only for reasoning models.
- [ ] **Step 6:** Commit `feat: glass composer and model sheet with month groups`.

### Task 10: End-to-end smoke and first deploy

**Files:**
- Create: `playwright.config.ts`, `e2e/core.spec.ts`, `e2e/fixtures.ts`

**Interfaces:**
- Consumes: the whole app. OpenRouter is mocked with `page.route('https://openrouter.ai/api/v1/**', …)`, serving fixture SSE bodies per model.

- [ ] **Step 1:** `playwright.config.ts`: `webServer: npm run dev`, project `Pixel 7` device, `baseURL: http://localhost:5173/orfe/`.
- [ ] **Step 2: Write tests** in `core.spec.ts`:
  - `switches model mid-conversation and keeps both voices`: paste key → send "hi" with model A → pick model B → send "more" → the second intercepted request body contains A's reply. The transcript shows a divider labelled with B.
  - `edit keeps later messages`: edit the first user message → the later messages are still visible → `‹ 2/2 ›` shows on the edited one.
  - `reroll creates a version and stop keeps partial text`: reroll → `‹ 2/2 ›` → switch to `1/2` shows the old text. A slow fixture stream + Stop → a "stopped" note, with partial text kept.
  - `survives reload`: reload → the conversation and messages are still there.
- [ ] **Step 3:** Run `npx playwright install chromium && npm run e2e` → 4 passed.
- [ ] **Step 4:** Commit `test: mobile e2e smoke with mocked OpenRouter`.
- [ ] **Step 5:** Create the public GitHub repo and push: `gh repo create mhuuh/orfe --public --source . --remote origin --push`. Enable Pages with source "GitHub Actions" (`gh api -X POST repos/mhuuh/orfe/pages -f build_type=workflow`). Wait for the deploy workflow → green.
- [ ] **Step 6:** Verify the live site: `https://mhuuh.github.io/orfe/` loads, the manifest is served under `/orfe/`, and Lighthouse's PWA "installable" check passes (or Chrome DevTools Application → Manifest shows no errors).
- [ ] **Step 7:** Hand the URL to Mikael to install on his phone, paste the key, and try a model switch for real.
