# ORFE: design

*An OpenRouter chat app that lives on your phone.* Working name: ORFE.
Written 2026-10-22 from a brainstorm with Mikael. In the text below, **(Mikael)** marks his decisions and **(my call)** marks Claude's calls, which he can overturn. Unmarked text is a direct requirement from the conversation.

API facts come from [docs/research/openrouter-api-2026-10.md](../../research/openrouter-api-2026-10.md). That file is the reference for every OpenRouter field named here.

---

## 1. Intent

Mikael likes OpenRouter's playground chat, with one exception: you can't change models mid-conversation. When you switch, the assistant's earlier messages are lost and only the user's survive. He was writing something creative (a story, a poem, a recipe) where the context mattered. Partway through, he realised another model would do the next part better.

> "I just want one context but to be able to switch between models that provide the next assistant message."

So the heart of ORFE is **one shared transcript that no single model owns.** Any model can write the next reply. Around that heart he wants:

- full control over the transcript: edit, reroll, delete;
- saved system instructions you can swap mid-chat;
- a rolling context window that respects prompt caching;
- rich output, from decorated text to small interactive toys;
- everything stored **on his Android phone**, not on a server or on his PC.

What success looks like: he opens ORFE instead of the playground for creative and everyday chats. He switches models without a second thought. The app looks so calm and well-made that he never notices it, only what's in it.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Model per turn: every assistant message records which model wrote it (and with which provider, prompt and reasoning effort). The next turn can use any model.
2. Full transcript control: edit any message, reroll any assistant message (keeping the old versions), delete any message.
3. Prompt library with variants, swappable mid-conversation.
4. Rolling context with an easy limit (messages or tokens) that trims in a cache-friendly way.
5. Cache-stable requests, following OpenRouter's caching docs.
6. Rich output: full markdown, sanitised inline styling, live sandboxed frames, per-chat themes.
7. Visible thinking for models that stream it. Streaming on by default.
8. A model list that stays current, with favourites, auto "most used", newest-first by month or A–Z, and provider choice per model.
9. Media: image, PDF, audio and video in where the model supports it; images, speech and video out.
10. Local-only storage on the phone, with persistent storage and one-tap backups.

**Non-goals (v1)**
- Accounts, sync, servers, a database on the PC.
- Multi-user anything.
- Tool calling or agent loops. Exception: OpenRouter's web search plugin as a per-chat toggle, which needs no tool loop on our side.
- Branching conversation trees beyond per-message alternatives.
- A native Android app. It stays possible later: the storage layer is isolated so a Capacitor wrapper can be added (see §11).
- Embeddings, rerank and "decisions" models. These are not chat models, so they're hidden from the picker (my call).

**Anti-goals: it fails if…**
- it's forcibly warm or decorated. The app's own palette is neutral; colour comes from content and the model's own formatting (Mikael).
- glass, blur or effects appear everywhere. There is one glass object, the composer (Mikael: "doesn't throw glassmorphism interchangeably everywhere").
- it's busy. Mikael rejected direction C for having "too much non-essential random stuff going on."
- a model switch loses any part of the conversation.
- an edit or reroll destroys something without a way back.
- the API key can reach code the model wrote (live frames must be sealed).

## 3. Constraints

- **Platform: a PWA** (an installable web app) on Chrome for Android (Mikael). It must also work in a desktop browser, using a centred reading column with a max width of about 720 px (my call).
- **No backend for data.** Nothing is ever stored server-side. The browser calls `https://openrouter.ai/api/v1` directly (CORS is open, tested, research §1), **except** that streamed chat replies go through one small relay Mikael owns, so a reply survives locking the phone or switching apps (Mikael: "I'd prefer being able to lock phone and switch tabs"). See §9.1. If the relay is unreachable, the app falls back to direct calls.
- **Hosting:** static files on **GitHub Pages** from a public repo `mhuuh/orfe`, so the app lives at `https://mhuuh.github.io/orfe/` (Mikael). Deployed by a GitHub Action. The host never sees user data. **This address is permanent:** IndexedDB belongs to the origin, so moving the app strands the chats until a backup/restore. The OAuth callback and `HTTP-Referer` use this URL. The PWA `scope`/`start_url` is `/orfe/`. Note: storage is shared with every other Pages site under `mhuuh.github.io`, since they're all one origin. Those are all Mikael's own repos, so this is acceptable, but no third-party code should ever be hosted there. A custom subdomain would isolate it later, at the cost of a backup/restore move.
- **Storage:** IndexedDB on the device. It must survive normal use, and backups protect against Chrome data wipes (§9).
- **Cost awareness:** show token usage and cost per reply. Never send hidden extra requests without a setting that allows it (auto-titles, §8.9).

## 4. Data model

The entities below are a guide. The builder may rename fields.

```
Conversation
  id, title, createdAt, updatedAt
  sessionId              // sent as session_id for provider stickiness (cache)
  systemPromptRef        // current prompt variant id, or null
  capabilityNote: bool   // append the formatting/live/theme note (§7.4)
  context: { mode: 'messages'|'tokens'|'inherit', limit, trimTo }   // §6
  theme: Theme | null    // §7.3
  webSearch: bool
  totals: { cost, promptTokens, completionTokens, cachedTokens }

Message
  id, conversationId, order (sortable), role: 'user'|'assistant'|'system-divider'
  // user and assistant messages have versions; the active one is shown and sent
  versions: [ Version ]
  activeVersion: index
  pinned: bool           // never trimmed (§6)
  createdAt

Version
  content: ContentPart[] // text, image, file, audio, video (local blob refs)
  // assistant-only metadata:
  model, provider, promptRef + promptVersionHash, reasoningEffort
  reasoning: { text, details[], durationMs } | null   // shown, never resent (§5.4)
  usage: { promptTokens, completionTokens, cachedTokens, cacheWriteTokens, reasoningTokens, cost }
  generationId, finishReason, error | null
  createdAt, editedAt

Divider (role 'system-divider')
  kind: 'prompt-swap'|'context-start'   // transcript markers; never sent
  label

Prompt
  id, name, parentId|null (variants group under a parent), text, updatedAt, versionHash

Blob store: id → Blob (images, audio, video, files), referenced by ContentPart
ModelCache: the last /models response + fetchedAt
ModelPrefs: per model id → { pinned, provider: ProviderPref, reasoningEffort, uses: [timestamps] }
Settings: key (see §9), defaults (model, context, streaming, theme mode…), backup.lastAt
```

Model switches don't need their own divider entity. The transcript draws the "→ model · prompt" divider wherever the active assistant version's model or prompt differs from the previous assistant message's. Prompt-swap dividers *are* stored, because a swap can happen before the next reply exists.

## 5. The conversation

### 5.1 Turns and model switching
- The composer has a **model chip** and a **prompt chip**. A **reasoning-effort chip** appears only when the model's `reasoning.supported_efforts` exists. Changing a chip affects the *next* reply only.
- Each assistant message shows a small mono meta line above it with the model name. Tapping it shows the provider, prompt, effort, tokens, cached tokens, cost and latency.
- A quiet divider marks changes: a hairline with centred mono text, e.g. `claude-sonnet-5.5 · Co-writer, warm` (from mockup child 1).

### 5.2 Edit, reroll, delete
- **Edit** any message, user or assistant, in place. Editing never deletes later messages (my call). The edit is saved as a new version, so the original remains reachable.
- **Reroll** any assistant message. It regenerates using the context *up to that message*, with the currently selected model, prompt and effort. The result becomes a new version. Later messages stay (my call; useful for fixing one bad paragraph mid-story).
- **Versions:** a `‹ 2/3 ›` switcher on any message with more than one version. Only the active version is sent.
- **Delete** a message, or one version of it. Undo via a toast for about 6 s (my call).
- **Send without reply:** the send button can also add a user message without requesting a reply (long-press). A **"Reply"** action on the last message asks for an assistant turn without new user text. Together these let him shape the transcript freely.
- The normaliser (§5.5) quietly fixes the alternation problems that edits and deletes create.

### 5.3 Streaming
- On by default, with a switch in Settings.
- SSE parsing per research §3: skip `:` comment lines, handle the mid-stream `error` event, and read `usage` from the final chunk.
- A **Stop** button replaces Send while streaming. It aborts the fetch, and the partial text is kept as the version with a "stopped" mark.
- Errors show inline on the message with **Retry**. The partial text is kept.

### 5.4 Thinking
- When `delta.reasoning` / `reasoning_details` arrive, a **Thinking** block streams open above the reply. Once content starts, it folds to one line ("Thought for 12 s"). Tap to open.
- Reasoning is stored with the version and **never sent back** (my call). This is safe when switching models, saves tokens, and keeps the prefix stable. Every request strips `reasoning` / `reasoning_details` from assistant messages.
- Effort is set with `reasoning: { effort }`. The default effort is the model's own `reasoning.default_effort`.

### 5.5 Send-time normaliser
The transcript stays as the user left it. Only the outgoing `messages` array is shaped (my call):
1. Take the active versions of messages inside the context window (§6), plus pinned messages, in order.
2. Drop dividers and empty messages.
3. Merge consecutive same-role messages into one, joining text with a blank line and concatenating media parts in order.
4. If the first non-system message is an assistant message, put a minimal user turn before it (`"…"`).
5. Strip reasoning fields.
6. Prepend the system message (§7.4 / §8.4).
7. Ending on an assistant message (prefill) is allowed. A "Continue" action on the last assistant message uses it.
8. **Media the next model can't read** (my call). For each media part in the window whose type isn't in the next model's `input_modalities`, send a text stand-in instead, e.g. `[image not shown to this model: "sunset.jpg"]`. The composer shows a quiet note before sending: "2 images won't be seen by this model." Nothing is blocked. The transcript keeps the media.
9. **Media the models made** (my call). Assistant messages can't reliably carry media parts. So generated images go out as a user-side image part placed right after that assistant message, labelled `(image from the previous reply)`, when the next model accepts images. Otherwise they become a stand-in as in rule 8. Merging (rule 3) then folds it into the next user turn. Generated audio and video become text stand-ins (the audio sends its transcript).
10. Large media in the window (audio, video) is re-sent on every turn while it stays in the window. The composer shows the attached size when it's over 5 MB, so the cost is visible (my call).

This needs unit tests. It's pure logic and easy to get subtly wrong.

## 6. Rolling context and cache

**Settings:** a global default and a per-chat override.
- **Limit mode:** messages (count) or tokens (estimate). Default: tokens, 32k (my call).
- **Trim-to:** the share kept after a trim. Default 70% (Mikael agreed to chunked trimming).

**When to trim** (Mikael's idea combined with chunking):
- **Hard trim:** the window goes over the limit, so drop the oldest messages until it's at trim-to.
- **Cold-cache trim:** the cache is lost anyway, so trimming is free. If the window is over a soft threshold (default 85% of the limit), trim to trim-to. "Cold" means any of:
  - the model or provider changed since the last request;
  - the system prompt changed (swap or edit);
  - an edit or delete changed the prefix;
  - more time passed since the last request than the provider's cache TTL. Defaults: 5 min, Anthropic with 1 h TTL → 60 min, OpenAI GPT-5.6+ → 30 min. The builder keeps a small per-provider table from research §5.
- Otherwise the window only grows. The start of the request stays byte-identical between turns.

**The window start is stored, not recomputed:** `conversation.windowStartMessageId` moves only on a trim (my call). This makes stability easy to reason about and to test.

**Token estimate:** characters ÷ 4, corrected by the ratio of the real `usage.prompt_tokens` to the estimate from the last reply (my call).

**Transcript display:** messages outside the window stay visible, dimmed, above a "context starts here" divider. Pinned messages are always sent, in their original position (my call).

**Cache mechanics** (research §5):
- `session_id` = `conversation.sessionId` on every request, which keeps the provider sticky.
- Anthropic models: add top-level `cache_control: { type: "ephemeral" }` (automatic breakpoint mode). An optional setting allows the 1 h TTL.
- The system prompt goes first and stays unchanged. Variable content goes last. Model chips and per-turn settings never go into the messages.
- Effort changes for the same model use `configuration_update` on the system message, if it proves to keep the cache warm. Otherwise they count as cold. The builder tests this.
- **Cache indicator** in the header: `warm cache` when the last reply had `cached_tokens > 0`, `cold` otherwise, and `n/a` for models that don't cache. Per-message meta shows cached/total tokens.

## 7. Rich output

### 7.1 Markdown and inline styling
- GFM: tables, task lists, strikethrough, footnotes, autolinks. Plus math (KaTeX) and syntax-highlighted code with a copy button.
- **Sanitised inline HTML** with an allowlist (my call):
  - Tags: `span div p br b i u s em strong mark small sub sup kbd abbr details summary blockquote hr figure figcaption ul ol li table…`
  - `style` attribute, limited to these properties: `color background(-color) font-family font-size font-weight font-style letter-spacing line-height text-align text-decoration text-transform border border-radius padding margin opacity display(inline-block|block) width max-width`
  - `font-family` is limited to the curated font list (§7.3), and sizes are clamped. No `position`, no `url()`, no event handlers, no `<script>`, `<style>`, `<iframe>` or `<img src=remote>`.
- This is how the model decorates a recipe card, colours a line of a poem, or puts a tinted box around ingredients (mockup child 1, the "For the pot" card).

### 7.2 Live frames
- These fenced code blocks render in a **sandboxed iframe**:
  - ` ```html-live ` for HTML/CSS/JS toys, sliders and layouts;
  - ` ```svg ` for drawings;
  - ` ```ascii ` for monospace art in a frame that keeps its spacing.
- Sandbox: `sandbox="allow-scripts"` only. No same-origin, so the frame can't read IndexedDB or the key. `srcdoc` carries a CSP of `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:`.
  - A setting "allow libraries in live frames" adds `https://cdn.jsdelivr.net` and `https://cdnjs.cloudflare.com` to script-src. Default off (my call).
- Auto-height via `postMessage` from a tiny injected script, capped at about 70% of the screen height, then the frame scrolls.
- Frame toolbar (mono, quiet): label · expand to full screen · view source · copy · reload.
- Frames run automatically by default. A setting can make them run on tap instead (my call).
- Frames get the chat's theme tokens as CSS variables, so toys match the chat.

### 7.3 Per-chat themes
- The model (or Mikael, by hand) sets a theme with a ` ```theme ` block containing JSON. Only this schema is accepted:
  ```json
  { "mode": "dark|light|auto",
    "background": "#hex | {gradient: [#hex, #hex], angle}",
    "ambient": "none|grain|drift|stars|aurora",
    "text": "#hex", "accent": "#hex",
    "proseFont": "<from curated list>", "uiFont": "<from curated list, optional>" }
  ```
- The curated font list is about 12 Google Fonts covering serif, sans, mono and a few display faces. The builder picks them; Newsreader and Geist must be included.
- **Contrast check:** if text on the background falls under 4.5:1, the theme is rejected with a small note, and the chat keeps its old theme.
- Ambient presets are subtle, slow CSS/canvas effects that respect `prefers-reduced-motion`.
- The theme block shows in the transcript as a small chip ("theme · Warm paper ↺"), and tapping it reverts. A theme editor sits in the chat settings. Built last; it must never block the core.

### 7.4 Capability note
- A short system addendum explains to the model that it can use inline HTML styling, the live/svg/ascii blocks, and the theme block, and that it should use them with restraint.
- It's toggled per chat (default on) and appended **after** the user's prompt, as a separate part of the same system message, so his prompts stay pure. Its text is fixed, which keeps the prefix stable.

## 8. Features around the chat

### 8.1 Model picker (bottom sheet)
Order from the top:
1. **Most used:** the 6 models with the highest recency-weighted use, a 30-day half-life (my call). Updated automatically.
2. **Pinned favourites:** pinned with a star.
3. **All models**, with a toggle:
   - **Newest:** sorted by `created`, grouped under sticky **month headers** ("October 2026"), like OpenRouter's own list (Mikael).
   - **A–Z:** alphabetical.
- Search box, plus filter chips for capabilities: thinking, sees images, makes images, audio, video, free.
- Each row: the model name, plus quiet mono price (in/out per 1M tokens) and context size.
- The list comes from `GET /api/v1/models?output_modalities=all` with no key, fetched on app open and when the sheet opens (if older than 1 h). It's cached locally for offline use. Embeddings, rerank and decisions models are filtered out.

### 8.2 Provider choice (Mikael)
- Tap "›" on a model row (or long-press it) to open its **provider sheet**, built from `GET /api/v1/models/{author}/{slug}/endpoints`.
- Options: **Auto** (default) · **Cheapest** · **Fastest** · **Lowest latency**, which map to OpenRouter's `provider.sort`. Or **pin one provider** from the list, which shows each provider's price, uptime and quantization, plus throughput and latency when a key is present.
- A pinned provider is sent as `provider: { order: [name], allow_fallbacks: <setting, default true> }`.
- The choice is remembered per model. Note: `provider.order` turns off OpenRouter's sticky routing, which doesn't matter when one provider is pinned.

### 8.3 Prompt library
- A list of named prompts. Variants group under a parent ("Co-writer" → "Co-writer, tighter prose"). Duplicating as a variant is one tap.
- A **prompt chip** in the composer swaps the prompt for the next reply and stores a prompt-swap divider (`→ Editor (strict)`).
- Prompts are live references: editing a prompt changes it for every chat that uses it. Each assistant version stores the prompt's `versionHash`, and the meta shows "made with an older version" when it differs (my call).
- A chat can also have "no prompt".

### 8.4 System message assembly
`[prompt text]` + `\n\n` + `[capability note if on]`. Nothing dynamic goes in it, such as dates or model names (my call: keeps the prefix stable).

### 8.5 Media in
- An attachment button offers camera, gallery, files (PDF), audio recording and video. Only the types the next model's `input_modalities` support are enabled. Unsupported ones are greyed out with a reason.
- Images are downscaled to a max of 2048 px on the long edge before sending (my call).
- PDFs use the `file` part. The engine setting defaults to the model's native support, then `cloudflare-ai`, which is free.
- Audio uses `input_audio` (base64). Video uses `video_url` (data URL).
- Blobs are stored locally in the blob store. Messages reference them.

### 8.6 Media out
- **Images in chat:** if the model outputs images, send `modalities: ["image","text"]`. Images from `message.images` are saved as blobs and shown inline; tap for full screen and save/share. The streaming shape is undocumented, so the builder tests it. Fallback: a non-streamed request for image models.
- **Read aloud:** each assistant message has a speaker action using `POST /audio/speech`, with the speech model and voice chosen in Settings. Off until a speech model is chosen (my call).
- **Audio-out chat models:** `modalities: ["text","audio"]`. Audio plays inline, with the transcript as the text.
- **Video generation:** when a video model is selected, the composer sends to `POST /videos`. The reply becomes a job card that polls, then downloads the result as a blob. Polling continues when the app reopens.

### 8.7 Web search
A per-chat toggle that adds `plugins: [{ id: "web" }]`. Citations from `message.annotations` render as small numbered links under the reply.

### 8.8 Conversations
- A drawer (the header's ≡ button) lists chats by last activity, with search across titles and content.
- New chat, rename, delete (with undo), duplicate.

### 8.9 Auto-titles
- After the first reply, a cheap model chosen in Settings writes a title. If no title model is set, the first words are used (my call: off by default, because it's an extra paid request).

### 8.10 Usage
- Per message: tokens, cached, cost (from `usage`).
- Per chat: running total in the chat settings.
- Key panel: `GET /api/v1/key`, showing limit, remaining and usage today/week/month.

## 9. Storage, key, backup

- **IndexedDB** behind a small storage interface, e.g. `Storage.getConversation`, `putMessage`, `putBlob`… All app code goes through it. This is the seam for a future Capacitor/native file backend (Mikael: "1+2 now, door open").
- `navigator.storage.persist()` is requested on first run. The result shows in Settings.
- **Backup:** one tap exports a single file (`orfe-backup-YYYY-MM-DD.json`; blobs base64-encoded, or a zip if that turns out simpler). It goes through the Web Share API with files when available, otherwise as a download. **Restore** imports the file and merges by id, with a choice between "replace" and "merge".
- A **backup nudge** appears in the drawer when the last backup is older than 14 days and there's new content.
- **Folder mirror (only if available):** if `window.showDirectoryPicker` exists, offer "Mirror to a folder", which writes each conversation as a JSON file on change. Chrome for Android support is unclear, so detect at runtime and hide when absent.
- **Key:**
  - "Log in with OpenRouter" via OAuth PKCE (research §1), with `key_label: "ORFE"`, callback to the app's own URL.
  - The builder must test that `POST /api/v1/auth/keys` allows CORS. If it doesn't, fall back to pasting a key.
  - The key is stored in IndexedDB settings and sent as `Authorization: Bearer` only to openrouter.ai.
  - The key panel suggests setting a credit limit (OpenRouter's advice).
### 9.1 Background relay (Mikael)

**Why:** Android Chrome pauses or kills a page's network requests when the app goes to the background. Without help, a long reply dies when the phone locks.

**What:** a Cloudflare Worker with one Durable Object per reply (Cloudflare's free plan), deployed from `relay/` in this repo with `wrangler`. Mikael logs in to Cloudflare once with `wrangler login`. A Durable Object is a tiny server-side object that keeps running while it waits on network I/O.

**Flow:**
1. The app sends `POST /start` with the OpenRouter request body and the key in a header. The relay creates a job, starts the upstream streaming fetch to OpenRouter, and returns `{jobId}` right away.
2. The Durable Object appends every SSE chunk to a buffer (in memory, and to its storage in batches).
3. The app reads `GET /stream/{jobId}?from={offset}`, which replays buffered chunks from the offset and then follows live.
4. When the app comes back (on `visibilitychange`, a network reconnect, or reopening the app), it resumes from the last offset it saved in IndexedDB. The app also writes partial text to IndexedDB as it arrives, as in direct mode.
5. When the stream is done and the app has read to the end, it sends `DELETE /job/{jobId}`. Unclaimed jobs self-delete after 1 h (alarm).
6. `POST /cancel/{jobId}` aborts the upstream fetch (the Stop button).

**Rules:**
- The relay **never stores the key**. It holds it in memory only for the life of the upstream fetch. It never logs bodies.
- Buffered reply text exists only until it is claimed, or for 1 h at most.
- Access needs a shared secret the app generates on setup (a `X-Relay-Token` header checked by the Worker), so strangers can't use it as an open proxy. Set as a Worker secret.
- CORS allows only `https://mhuuh.github.io`.
- Non-streamed calls (models list, key info, images endpoint, TTS, video jobs) go direct. Video jobs already run in the background at OpenRouter.

**Fallback:** Settings has a "Background replies" toggle and a relay URL field. If the relay is off, unreachable, or `/start` fails, the app streams direct, with a screen wake lock and the interrupted → **Continue / Retry** handling (Continue = prefill from the partial text).

**Must be proven first (spike, build step 2):** that a Durable Object keeps the upstream fetch running for several minutes with no client connected. If it doesn't, the alternative is the Durable Object holding a WebSocket to itself or using `ctx.waitUntil` patterns. If no free-plan pattern works, report back to Mikael before building further.

- Attribution headers: `HTTP-Referer: <app url>`, `X-OpenRouter-Title: ORFE`, and `X-OpenRouter-App-Visibility: hidden` (my call: it's a private app).

## 10. Look and feel

Direction **child 1 of A × B** (Mikael). Reference render: `.superpowers/brainstorm/1630-1792615550/content/children.html`, first phone (local file, not committed).

```
Format    Phone first, 360–430 wide; margins 20; height open. Desktop: centred column, max 720.
Type      UI: Geist 15/22 (sans), meta in Geist Mono 11/16. Model prose: Newsreader 17/26 (default; a chat theme can swap it).
Scale     1.2 · 11 · 13 · 15 · 18 · 22 (17 for prose is the serif's optical match to 15 sans, named exception).
Space     4 pt unit · 4 8 12 16 24 32 48.
Radius    14 for surfaces (bubble, cards, frames), pills for chips and round buttons. Nothing else.
Reasons   A daily tool for dense use: quiet ratio, one UI face. The model gets a book voice; you and the app speak sans.
```

**Palette** (neutral, no colour in the chrome; Mikael: "no background colours, off-blacks/dark greys and off-whites"):

| token | dark | light |
|---|---|---|
| bg | `#0e0e0f` | `#f5f5f3` |
| surface (user bubble, chips) | `#18181a` | `#e9e9e6` |
| line | `#27272a` | `#dcdcd8` |
| ink | `#e9e7e2` | `#1a1a19` |
| prose | `#dcdad5` | `#262624` |
| mute (meta) | `#8b8a86` | `#6b6a66` |
| faint (placeholder) | raise to pass 4.5:1 for real text; ≥3:1 for placeholder | same |

- **User messages:** a grey bubble (`surface`), right-aligned, max 84% width, radius 14.
- **Assistant messages:** no bubble, full width, with a mono meta line above.
- **Composer:** the one glass object. Floating 12 px from the edges, radius 22, `backdrop-filter: blur(22px) saturate(1.4)`, a 1 px gradient edge that catches light at top-left and bottom-right, and an inset top highlight. The chips sit inside, with a round ink-filled send button.
- **Theme:** follows the system light/dark, with a manual override in Settings.
- **Motion:** short and quiet, 150–220 ms ease-out on sheets and folds, none on text. Respects reduced motion. The builder may use the `animate` / `motion-design` skills.
- **Minimum text size:** 11 px, and contrast must pass AA, including mono meta (the design checker flagged the mockups).
- Write this system to `DESIGN.md` at the repo root once the build starts.

## 11. Tech choices (my call, builder may adjust with a reason)

- Vite + TypeScript + React. A PWA via `vite-plugin-pwa`, with offline app shell and installable manifest.
- Dexie for IndexedDB.
- markdown-it (+ footnote, task-list plugins), DOMPurify with the §7.1 allowlist, KaTeX, and a light highlighter (Shiki with a small language set, or highlight.js).
- Vitest for pure logic: SSE parser, normaliser, window/trim logic, cache-cold detection, theme validation, backup round-trip. Playwright for a mobile-viewport smoke test with a mocked OpenRouter.
- GitHub Pages deploy via an Action.
- Relay: a Cloudflare Worker + Durable Object in TypeScript, under `relay/`, deployed with `wrangler`.
- Future native wrapper: Capacitor, with the Filesystem plugin behind the §9 storage interface. Not in v1.

## 12. Build order

Each step should be usable on the phone before the next:
1. Shell: PWA install, key (paste first, then OAuth), the models list, a plain streaming chat with markdown. The design system lands here.
2. The background relay spike (§9.1), then the relay itself with direct-mode fallback. Then model per turn, chips, dividers, meta, thinking, stop/retry/continue.
3. Edit / versions / reroll / delete / send-without-reply / normaliser.
4. Prompt library and swapping.
5. Rolling context and cache logic, plus the indicator.
6. Picker polish: most used, favourites, month groups, filters, provider sheet.
7. Backup / restore / persist / nudge.
8. Rich output: inline styling, live frames.
9. Media in, then media out (images, speech, video).
10. Per-chat themes and the capability note's theme part.

## 13. Left to the builder

- Exact component structure, routing, and state management.
- The curated font list (must include Newsreader and Geist).
- The ambient preset implementations.
- The backup file format details (JSON vs zip).
- The exact capability-note wording (short; it must ask for restraint).
- Icons (a thin-stroke set that matches Geist; Lucide is fine).

## 14. Known unknowns (test early)

- Whether a Cloudflare Durable Object keeps a long upstream fetch alive with no client connected (§9.1). This decides the relay design.
- CORS on `POST /api/v1/auth/keys` (OAuth exchange).
- How images arrive in a *streamed* chat response.
- Whether `configuration_update` keeps the cache warm across effort changes.
- `showDirectoryPicker` on Chrome for Android.
- The exact `file` content-part JSON for PDFs (check the OpenAPI spec).
