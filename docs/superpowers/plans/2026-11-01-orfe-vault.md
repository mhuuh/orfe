# ORFE vault and abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model a private notes vault, search through old messages and compaction, all as abilities switchable per chat, with visible tool lines.

**Architecture:** A static ability registry feeds a tool loop in `send.ts`. Tool steps live inside the reply as `ToolPart`s. `buildOutgoing` stays a pure function that renders them per model. Notes, revisions and summaries are new Dexie tables. The model curates, and code sets the walls.

**Tech Stack:** React 19, TypeScript strict, Dexie 4, Vitest + fake-indexeddb, Playwright (Pixel 7, mocked OpenRouter). One new dependency: a Snowball stemmer with Finnish and English.

**Spec:** `docs/superpowers/specs/2026-11-01-orfe-vault-design.md`. Read it first. Evidence: `docs/research/agent-driven-memory-2026-11.md`.

**Branch:** `feat/vault`. Merge to `main` at the end of each milestone (M1 to M7), so each one deploys and can be tried on the phone. On E:, prefer `git merge` over rebase.

## Global Constraints

- All tools run on the phone. Nothing is sent to any host but openrouter.ai.
- `src/lib/storage.ts` holds the Dexie seam. Writes to a Message or Note re-read inside `db.transaction('rw', …)`. Never write back a live-query copy.
- Every note write and its `NoteRevision` go in one transaction. Every revision records its writer.
- Tool errors are normal results the model can read. Refusals say what to do next. Tools never throw into the loop.
- `ToolPart.result` always stays whole in storage. Stripping happens at render time only.
- The tools JSON is one stored string, in fixed order, with no counts, dates or titles in it. `tool_choice` is always `'auto'`.
- A send must never wait on a summary or a tidy run, and neither may ever block a reply.
- Protected note bodies are never sent to a tidy model.
- Design system: `DESIGN.md`, tokens only, no new colours, the composer stays the one glass object. Minimum text 11 px. Mono meta is Geist Mono 11/16.
- `oddsandends.key` is the test key. Read it only from a script, never print it or the full `/key` response.
- Comments and UI copy in Simplified Technical English. Match the surrounding code's comment density.

## Review Focus

1. **A reply with only tool steps and no text.** The app shows the lines and ends the reply normally, and the next request is valid. Tests in Tasks 5 and 7.
2. **Malformed tool arguments or an unknown tool name**, which weak models produce. The model gets a readable error result and the loop goes on. Test in Task 7.
3. **The phone locks during a write.** On Continue the write is not done twice. Test in Task 7.
4. **Two chats write the same shared note.** The second gets a version refusal, and neither loses text. Test in Task 9.
5. **The frozen index names a note that has since been deleted or moved.** `notes_read` follows the alias, or says it is gone and suggests a search. Test in Task 10.

---

## Milestone 1: Backup

### Task 1: Backup, restore, persist

**Files:**
- Create: `src/lib/backup.ts`, `src/lib/backup.test.ts`
- Modify: `src/ui/Settings.tsx`, `src/ui/Drawer.tsx`, `src/lib/types.ts`, `src/lib/storage.ts`

**Interfaces:**
- Produces: `exportBackup(): Promise<Blob>`, `importBackup(file: Blob, mode: 'merge' | 'replace'): Promise<{ added: number }>`, `requestPersist(): Promise<boolean>`, `backupDue(s: Settings, lastChange: number, now: number): boolean`. `Settings.lastBackupAt: number | null`.

Follow spec §9 of the first design. The file is `orfe-backup-YYYY-MM-DD.json`. It walks `db.tables`, so later tables join by themselves. It skips `cache`, and later `searchDocs`, because both rebuild. **The key is never in the file** (my call: backups get shared and stored). Share through the Web Share API with files, otherwise download.

- [ ] **Step 1: Write failing tests** in `backup.test.ts`:

```ts
it('round-trips every table and leaves the key out')   // seed a chat, a prompt, settings.key; export; assert text has no key; clear; import; assert rows equal
it('merge keeps rows that are not in the file')
it('replace removes rows that are not in the file')
it('rejects a file that is not an ORFE backup')         // throws, and nothing changes
it('restores a backup from an older schema')            // rows missing new fields load with defaults
it('keeps the existing key after replace')
it('backupDue is true after 14 days with new content, false without')
```

- [ ] **Step 2: Run** `npx vitest run src/lib/backup.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `backup.ts`.** Add Backup rows to Settings (Back up, Restore with merge or replace, persist status) and the 14-day nudge row in the drawer. Call `requestPersist` on first run.
- [ ] **Step 4: Run** `npm test` and `npm run e2e`. Expected: PASS.
- [ ] **Step 5: Commit**, merge to `main`, push. This also brings the `*.key` ignore rule to `main`.

---

## Milestone 2: The tool base

### Task 2: Live checks

**Files:**
- Create: `scripts/live-check.mjs`, `docs/research/live-checks-2026-11.md`

**Interfaces:**
- Produces: a filled-in findings doc. Task 5 turns it into `MODEL_RULES`.

A plain Node script with hand-built requests, run before the app work so its findings shape the rendering. It reads `oddsandends.key`, prints only status, `usage` numbers and error messages, and stops when `/key` shows over $2 used.

- [ ] **Step 1: Write the six checks from spec §15** as functions, each with a dummy `lookup` tool: strip soon, DeepSeek with tools, foreign reasoning, tool messages after a switch, tool description change, dropped reasoning. Run on an Anthropic model, DeepSeek, an OpenAI model and a Gemini model. Pad the prefix above each provider's cache minimum.
- [ ] **Step 2: Run** `node scripts/live-check.mjs`. Expected: one line per check and model, with `cached_tokens`.
- [ ] **Step 3: Write `live-checks-2026-11.md`:** a table of check, model, result, and what it means for rendering, using spec §15's fallbacks.
- [ ] **Step 4: Commit** script and findings.

### Task 3: Types, schema, tool-aware parts

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/db.ts`, `src/lib/storage.ts`, `src/lib/versions.ts`, `src/lib/catalog.ts`, `src/lib/openrouter.ts`, `src/lib/normalise.ts`
- Test: `src/lib/versions.test.ts`, `src/lib/storage.test.ts`, `src/lib/catalog.test.ts`

**Interfaces:**
- Produces: spec §4 types (`ToolPart`, `Note`, `NoteRevision`, `Summary`, new `Conversation`, `Prompt`, `Settings`, `Version` fields). Also `Conversation.summaryBlock: string | null`, frozen like `notesIndex` (spec §11: the block changes only at a trim). `Settings.vaultUsage: Usage`. `Note.aliases: string[]`. `NoteRevision.runId: string | null` for tidy runs. `ModelInfo.tools: boolean`, from `supported_parameters` including `tools`; a stand-in model has `tools: false`.
- Dexie v3 tables: `notes: 'id, shelf, [shelf+path], deletedAt'`, `noteRevisions: 'id, noteId, callId, [noteId+version]'`, `summaries: 'id, conversationId, [conversationId+level]'`.

- [ ] **Step 1: Write failing tests:**

```ts
it('editedVersion keeps ToolParts and puts the one text part after them')
it('versionText ignores ToolParts')
it('old rows read with abilities null, notesIndex null, summaryBlock null')
it('new settings default: tidying true, summaryModel set, tidyModel set, vaultUsage zero')
it('toModelInfo sets tools from supported_parameters')
it('a catalog cached before this schema re-fetches')   // cache row without tools must not read as "no tools"
```

- [ ] **Step 2: Run** `npx vitest run src/lib`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `mapPart` in `normalise.ts` must skip `tool` parts for now, because it assumes every non-text part is media. Version the catalog cache row (a Plan 1 follow-up). Default `summaryModel` is a Gemini Flash id checked against the live catalog; default `tidyModel` is `anthropic/claude-sonnet-5.5`.
- [ ] **Step 4: Run** `npm test` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: Ability registry

**Files:**
- Create: `src/lib/abilities/registry.ts`, `src/lib/abilities/registry.test.ts`

**Interfaces:**
- Produces:

```ts
interface ToolDef { name: string; description: string; parameters: object }
interface AbilityCtx { conversationId: string; messageId: string; callId: string; model: string; key: string; signal: AbortSignal }
interface StepWords { running: string; done: string; past: string }  // "recalling Harbour…", "recalled Harbour", "(Read the note Harbour.)"
interface Ability {
  id: string; title: string; summary: string; tools: ToolDef[]; instructions?: string
  run(name: string, args: unknown, ctx: AbilityCtx): Promise<string>
  describe(part: ToolPart): StepWords
  hooks?: { beforeSend?(plan: SendPlan): Promise<void> }
  traits: { private?: true; untrusted?: true; outward?: true }
}
const ABILITIES: Ability[]                                     // fixed order
function enabledAbilities(c: Conversation, p: Prompt | null): Ability[]   // c.abilities ?? p?.abilities ?? all on
function toolsFor(c: Conversation, p: Prompt | null, model: ModelInfo): { json: string; hash: string; tools: ToolDef[] } | null  // null without tool support
function abilityInstructions(enabled: Ability[], model: ModelInfo): string | null
function runTool(name: string, rawArgs: string, ctx: AbilityCtx, enabled: Ability[]): Promise<string>
function describeStep(part: ToolPart): StepWords
```

`SendPlan` is `{ conversation: Conversation; messages: Message[]; startId: string | null; trimmed: boolean; cold: boolean; key: string | null }`. Hooks run after `planWindow`, and `generateInner` rebuilds `system` after them. `tools` are sorted by the ability order, then the order in `ability.tools`.

- [ ] **Step 1: Write failing tests** with a fake ability injected through a `setAbilitiesForTest` helper:

```ts
it('toolsFor gives byte-identical JSON on every call')
it('toolsFor is null for a model without tools')
it('a switched-off ability leaves the list')
it('c.abilities wins over the prompt, and the prompt over the defaults')
it('runTool returns a readable error for an unknown tool')
it('runTool returns a readable error for bad JSON, naming the tool')
it('runTool returns a readable error when run throws')
it('describeStep falls back to the tool name for an unknown tool')
```

- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS. Step 5: Commit.**

### Task 5: Rendering and cache rules

**Files:**
- Create: `src/lib/modelRules.ts`
- Modify: `src/lib/openrouter.ts`, `src/lib/normalise.ts`, `src/lib/context.ts`, `src/lib/system.ts`
- Test: `src/lib/normalise.test.ts`, `src/lib/context.test.ts`, `src/lib/system.test.ts`

**Interfaces:**
- Produces:

```ts
type OutMessage =
  | { role: 'system' | 'user'; content: string | OutPart[] }
  | { role: 'assistant'; content: string | OutPart[] | null; tool_calls?: OutToolCall[]; reasoning_details?: unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string }
// normalise.ts
BuildOptions + { modelId: string; toolsEnabled: boolean }
function renderRounds(content: ContentPart[], o: { modelId: string; toolsEnabled: boolean; reasoning?: unknown[][] }): OutMessage[]
// context.ts
function canonical(outgoing: OutMessage[]): OutMessage[]   // tool content → id, reasoning_details removed
LastRequest + { toolsHash: string | null }
isCold next + { toolsHash: string | null }
PlanInput + { overheadChars: number }                      // the tools JSON
// system.ts
assembleSystem(promptText, capabilityNote, extras: (string | null)[])
// modelRules.ts
interface ModelRule { keepReasoning?: true; noTools?: true; flattenAll?: true }
function ruleFor(modelId: string): ModelRule
```

`renderRounds` splits content at each run of consecutive `tool` parts: text before a run becomes the `assistant` message's content with `tool_calls`, then one `tool` message per call, and trailing text is a last `assistant` message. A part whose `model !== modelId`, or any part when tools are off, flattens to text through `describeStep(part).past`. A reply with tool steps renders outside the same-role merge. The same `renderRounds` serves stored turns and the turn in flight.

`reasoning` is passed only for the turn in flight. A finished reply sends none, unless `ruleFor(model).keepReasoning`. `modelRules.ts` carries Task 2's findings, one line per pattern with a comment naming the check.

`fingerprint` and `isCold` hash `canonical(outgoing)`. `messageChars` counts a `ToolPart` as `name + JSON args + result` length. `estimateTokens` and `planWindow` add `overheadChars`.

- [ ] **Step 1: Write failing tests:**

```ts
it('a tool step by the current model goes out as tool_calls then a tool message')
it('a step by another model flattens to one past-tense line')
it('a mixed reply keeps text order around the rounds')
it('tools off flattens everything')
it('a reply with only tool steps renders, and the turn after it is valid')
it('every tool_calls id has a tool message, in order')
it('finished replies send no reasoning_details; the turn in flight does')
it('keepReasoning keeps it for that model only')
it('a changed tool result does not change the canonical hash')
it('a different toolsHash reads cold')
it('a null toolsHash on an old lastRequest reads warm when tools are absent')
it('messageChars counts tool text, so planWindow trims on it')
it('overheadChars counts toward the limit')
it('assembleSystem joins prompt, note and extras, skipping nulls')
```

- [ ] **Step 2: Run, expect FAIL. Step 3: Implement.** Change the `system.ts` comment to "dynamic parts change only at a cold moment". **Step 4: Run** `npm test`, expect PASS. **Step 5: Commit.**

### Task 6: Streaming tool calls

**Files:**
- Modify: `src/lib/openrouter.ts`, `src/lib/send.ts`
- Test: `src/lib/openrouter.test.ts`, `src/lib/send.test.ts`

**Interfaces:**
- Produces: `ChatRequest + { tools?: ToolDef[]; toolChoice?: 'auto' }`. `StreamEvent + { type: 'tool_calls'; calls: { id: string; name: string; arguments: string }[] }`, yielded once just before `finish`. `mergeReasoning(list: unknown[], d: unknown[]): unknown[]`.

`streamChat` sends `tools` wrapped as `{ type: 'function', function }` plus `tool_choice`, and collects `delta.tool_calls` by `index`, because `arguments` arrive in pieces. `mergeReasoning` joins deltas with the same `index`: text, summary and signature strings concatenate, and it never merges across indexes. `Version.reasoning.details` uses it too.

- [ ] **Step 1: Write failing tests:**

```ts
it('joins tool call arguments split across chunks')
it('keeps two parallel calls apart by index')
it('a non-streamed reply yields tool_calls too')
it('sends tools and tool_choice, and neither when absent')
it('mergeReasoning joins by index and never across')
```

- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS. Step 5: Commit.**

### Task 7: The tool loop

**Files:**
- Modify: `src/lib/send.ts`, `e2e/fixtures.ts`
- Test: `src/lib/send.test.ts`
- Create: `e2e/tools.spec.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 6.
- Produces: `MAX_ROUNDS = 8`. In `run`: a loop over rounds. Base `outgoing` stays frozen, and each round sends `[...base, ...renderRounds(content, { reasoning: roundReasoning })]`. `RunArgs + { tools, enabled, ctx basics }`.

Rules:
- Save each `ToolPart` as `running` before the call and `done` or `error` after. Run calls in order, one at a time.
- Idempotence: before running, look for a revision with this `callId` (Task 9 adds the lookup; here a pluggable `alreadyDone(callId)` returning a stored result).
- On `finish_reason: 'tool_calls'`, run the calls and go on. In round 8, each call gets the result "Round limit reached. Answer now." If the next response still asks for tools, store those calls as `error` and end the reply `done`.
- Usage adds across rounds. `lastRequest` updates each round with `toolsHash`.
- Stop writes `stopped` on every open part, with the result "Stopped by the user."
- Continue on a version with `running` parts: finish them through `alreadyDone` or by running them, then send the next round. A continue of a version that ended in a text reply stays as today.

- [ ] **Step 1: Extend `e2e/fixtures.ts`:** a user message holding `TOOLCALL:<name>:<json>` makes the mock answer with that tool call first, then text on the next request.
- [ ] **Step 2: Write failing tests:**

```ts
it('runs a tool and sends the result in the next round')
it('a reply with only tool steps ends done')                                     // Review Focus 1
it('saves running then done on the ToolPart')
it('base outgoing is byte-identical across rounds')
it('stops at 8 rounds and lets the model answer')
it('sends reasoning_details inside the loop')
it('Stop writes a stopped result for every open call, and the next request is valid')
it('adds usage across rounds without double counting')
it('malformed arguments give the model an error result and the loop goes on')   // Review Focus 2
it('an unknown tool gives the model an error result and the loop goes on')       // Review Focus 2
it('Continue after a lock does not run a finished write twice')                  // Review Focus 3
it('a network drop mid-loop ends interrupted, with Continue')
it('a model without tools sends no tools field')
```

e2e `tools.spec.ts`: `a tool call round trips and the reply appears`.

- [ ] **Step 3: Run, expect FAIL. Step 4: Implement. Step 5: Run** `npm test`, `npm run e2e`, expect PASS. **Step 6: Commit, then merge M2 to `main`.** No ability ships yet, so the app must behave exactly as before: check that no `tools` field is sent while `ABILITIES` is empty.

---

## Milestone 3: Notes

### Task 8: Note rules

**Files:**
- Create: `src/lib/notes/rules.ts`, `src/lib/notes/rules.test.ts`

**Interfaces:**
- Produces: pure functions. `MAX_BODY = 8000`, `SHRINK_LIMIT = 0.5`. `normalisePath(p): string`, `shelfOf(path, conversationId): { shelf: string; path: string } | null`, `nearMatch(path, existing: string[]): string | null`, `checkWrite(prev: Note | null, next: { body: string; description: string; expectedVersion?: number; isNew?: boolean; shrink?: boolean }, writer): string | null`, returning the refusal text or null. `bodyHash` from `hash.ts`.

- [ ] **Step 1: Write failing tests:**

```ts
it('shared/ and chat/ map to shelves; anything else is refused')
it('nearMatch finds case, plural and small typo differences, and not unrelated paths')
it('refuses a model body over 8000 characters, and allows it for "you"')
it('refuses a replace that removes over half, unless shrink is true')
it('refuses a stale expectedVersion')
it('refuses a missing description')
it('refuses a protected note, and the text names move, tag and a linking note')
it('allows Finnish characters in paths')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**

### Task 9: Note store and undo

**Files:**
- Create: `src/lib/notes/store.ts`, `src/lib/notes/store.test.ts`
- Modify: `src/lib/send.ts` (`deleteChat`, `restoreChat`, `alreadyDone`)

**Interfaces:**
- Produces:

```ts
const notes: {
  read(ref: NoteRef): Promise<Note | undefined>      // follows aliases, skips deleted
  list(shelf: string): Promise<Note[]>
  search(shelves: string[], q: string, limit: number): Promise<{ note: Note; snippet: string }[]>  // a linear scan is fine at this scale
  write(ref: NoteRef, input: WriteInput, by: Writer): Promise<Result>
  edit(ref: NoteRef, change: { oldText?: string; newText?: string; tags?: string[]; description?: string; expectedVersion: number }, by: Writer): Promise<Result>
  remove(ref: NoteRef, by: Writer): Promise<Result>
  move(ref: NoteRef, newPath: string, by: Writer): Promise<Result>
  setProtected(id: string, on: boolean, by: Writer): Promise<Result>   // off is refused unless by.writer === 'you'
  revisions(noteId): Promise<NoteRevision[]>
  revert(revisionId, by): Promise<'done' | 'changed-later'>
  undoCalls(messageId, callIds: string[], shelves: 'chat'): Promise<UndoReport>
  redoCalls(callIds): Promise<void>
  byCall(callId): Promise<NoteRevision | undefined>
}
interface NoteRef { path: string; conversationId: string }   // path starts with shared/ or chat/
interface WriteInput { body: string; description: string; tags?: string[]; expectedVersion?: number; isNew?: boolean; shrink?: boolean; protected?: boolean; supersedes?: string }
type Result = { ok: Note } | { refused: string }
interface UndoReport { undone: string[]; kept: string[] }    // call ids
interface Writer { writer: string; messageId: string | null; callId: string | null; runId?: string }
```

- [ ] **Step 1: Write failing tests:**

```ts
it('every write adds a revision in the same transaction, with the writer')
it('edit must match exactly once; zero or two matches refuse, and say which')
it('a moved note keeps its old path as an alias; read follows it')
it('delete is soft; restore brings it back')
it('protected refuses edit, replace and delete, and allows move and tags')
it('only "you" can clear protected')
it('revert restores before; a create becomes a soft delete')
it('revert says changed-later when a newer revision exists')
it('undoCalls touches chat-shelf writes only')
it('deleteChat soft-deletes chat-shelf notes and restoreChat brings them back')
it('two writers on one shared note: the second is refused, and no text is lost')  // Review Focus 4
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**

### Task 10: Notes ability and index

**Files:**
- Create: `src/lib/abilities/notes.ts`, `src/lib/abilities/notes.test.ts`, `src/lib/notes/index.ts`
- Modify: `src/lib/abilities/registry.ts`, `src/lib/send.ts`

**Interfaces:**
- Produces: `notesAbility: Ability` with the five tools of spec §8 (`notes_search`, `notes_read`, `notes_write`, `notes_edit`, `notes_delete`). `INDEX_MAX_CHARS = 8000`. `buildIndex(shared: Note[], chat: Note[]): string`.

`notes_read` returns numbered lines and pages at 8,000 characters. With no path it returns the tree. `notes_write` takes `protected` and `supersedes`, so any model can protect a note. `notes_edit` can change `tags` and `description` alone, which is how a protected note gets tagged. Both return the new version number. Instructions carry all six points of spec §8 Instructions.

`buildIndex` is a tree of `path — description`. Over the cap, the largest folders collapse first to `folder/ (12 notes)`.

In `generateInner`: build `system` from the stored `notesIndex`, compute `cold`, and if cold or the index is null, rebuild the index, store it, and rebuild `system` before planning.

- [ ] **Step 1: Write failing tests:**

```ts
it('each tool returns text, and a refusal reads as a next step')
it('notes_read pages long notes and numbers lines')
it('a new note starts where its path says; a bare path is refused')
it('buildIndex stays under the cap and collapses the largest folder first')
it('the index is unchanged while warm and refreshed when cold')
it('a chat with tools off gets no index and no instructions')
it('a read of a deleted note says it is gone and suggests notes_search')   // Review Focus 5
it('a read through a moved path returns the note and names the new path')  // Review Focus 5
it('the tool JSON has no counts, dates or titles')
it('a model can set protected, and notes_edit can still tag that note')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**

### Task 11: Tool lines in the chat

**Files:**
- Create: `src/ui/ToolLine.tsx`, `src/ui/ToolLine.module.css`, `src/ui/ToolLine.test.ts`
- Modify: `src/ui/AssistantMessage.tsx`, `src/lib/versions.ts`, `e2e/tools.spec.ts`

**Interfaces:**
- Produces: `segments(content: ContentPart[]): ({ kind: 'text'; text: string } | { kind: 'tool'; part: ToolPart })[]` in `versions.ts`. `<ToolLine part messageId />`.

Style A in the approved mockup. Mono 11/16. A 4 px dot. Running shows `describeStep(part).running` in `--ink`. Done shows `.done` in `--mute`. Tap toggles a detail block with a 1 px `--line` left rule: the result's first lines, and for a write, Undo. An undone line shows "undone" and Redo. `withCaret` applies only to the last text segment. The whole message stays tappable; `tapHandlers` already skips buttons.

- [ ] **Step 1: Write failing tests:**

```ts
it('segments keeps text and tools in order')
it('adjacent text parts merge into one segment')
it('a running part shows the running words')
it('a write shows Undo; a read does not')
it('an undone write shows Redo')
```

e2e: `tool line shows, opens, and Undo restores the note`.

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS.** Look at it at 412 px in dark and light before moving on. **Step 5: Commit.**

### Task 12: Rerolls, deletes and edits

**Files:**
- Modify: `src/lib/send.ts`, `src/ui/MessageActions.tsx`
- Test: `src/lib/send.test.ts`, `e2e/tools.spec.ts`

**Interfaces:**
- Consumes: `notes.undoCalls`, `notes.redoCalls`.
- Produces: `undoReplyWrites(messageId: string, versions: Version[]): Promise<UndoReport>`.

Follow spec §8 "Rerolls and undo" exactly. A reroll undoes at the start of `generateInner`, before messages are read. If the reroll ends with no output, redo. A message or version delete calls `undoReplyWrites`, and its toast Undo redoes. Mark `ToolPart.undone` through `mutateMessage`.

- [ ] **Step 1: Write failing tests:**

```ts
it('a reroll undoes chat-shelf writes before the request goes out')
it('a reroll keeps shared-shelf writes')
it('a failed reroll puts the writes back')
it('a note changed later stays, and the part says so')
it('deleting a message undoes its writes; toast Undo restores them')
it('deleting one version undoes only that version')
it('Edit leaves ToolParts and revisions alone')
it('flipping to an old version shows its writes as undone')
it('a Continue that changes model keeps each part\'s own model')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**

### Task 13: Vault screens

**Files:**
- Create: `src/ui/Vault.tsx`, `src/ui/Vault.module.css`, `src/ui/NoteSheet.tsx`, `src/ui/NoteSheet.module.css`, `e2e/vault.spec.ts`
- Modify: `src/ui/Drawer.tsx`, `src/ui/Sheet.tsx` if needed

**Interfaces:**
- Consumes: `notes`.
- Produces: `<Vault conversationId onOpen={(id) => void} />`, `<NoteSheet noteId open onClose />`. Other tasks mount To review here in Task 22.

The mockup's first two vault phones, as approved. Chats / Vault segment at the top of the drawer. Search, then the current chat's shelf and shared shelf, a small lock on protected notes, then other chats' shelves in a row, then Trash. A note shows path, title, last writer and version; Edit, History, Move, Protected; prose in Newsreader. Edits write a revision with writer `you`. History lists revisions with writer and a Restore action. Clearing Protected asks once. Use the same unsaved-changes guard as `PromptSheet`.

- [ ] **Step 1: Write failing e2e tests:**

```ts
test('a note written by a model shows in the vault under this chat')
test('editing a note adds a revision by you')
test('protecting a note blocks a model edit, and only you can unprotect')
test('Back with unsaved edits asks first')
test('search finds a note by its body')
test('Trash restores a deleted note')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS.** Screenshot at 412 px in full Chromium, dark and light, against the mockup. **Step 5: Commit.**

### Task 14: Abilities in settings

**Files:**
- Modify: `src/ui/ChatSettings.tsx`, `src/ui/PromptSheet.tsx`, `src/ui/Composer.tsx`, `src/lib/send.ts`
- Test: `src/ui/ChatSettings.test.ts`, `e2e/tools.spec.ts`

**Interfaces:**
- Produces: `setAbility(conversationId, id, on): Promise<void>` in `send.ts`. Rows per the mockup's fourth phone.

A prompt's editor gains an Abilities row. Beside the model chip, one line once per model: "This model can't use notes." This is the no-tools notice of spec §6. Trust gate: in `run`, after any `untrusted` result in the reply, `outward` and note-writing tools wait for a visible OK. No shipped ability has the trait, so test it with a fake.

- [ ] **Step 1: Write failing tests:**

```ts
it('a switch changes the tool list and the next request reads cold')
it('a chat with a prompt default follows it until the chat sets its own')
it('after untrusted content a note write waits for OK')
```

e2e: `switching notes off removes the tools from the request`, `a no-tools model shows the notice and still replies`.

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit, merge M3 to `main`.** Mikael tries real notes on the phone here, with two different models.

---

## Milestone 4: Keeping results small

### Task 15: Strip soon and repeat reads

**Files:**
- Create: `src/lib/retention.ts`, `src/lib/retention.test.ts`
- Modify: `src/lib/normalise.ts`, `src/lib/context.ts`, `src/lib/abilities/notes.ts`

**Interfaces:**
- Produces: `STRIP_MIN_CHARS = 1200`, `STRIP_AFTER_TURNS = 2`. `keptWhole(messages: Message[]): Set<string>` (call ids that still render whole). `pointerFor(part: ToolPart): string`, for example `(Read shared/lists/insects, version 7. Stripped. notes_read reopens it.)`. `wholeInWindow(messages, startId, path, version): boolean`.

Count user messages after the step's message, by active versions. A rerolled reply counts from its message. Task 2's check 1 decides whether this ships: if it failed, `keptWhole` returns every call until a trim, and record why in the file header. `notes_read` returns "unchanged since your last read, see above" when `wholeInWindow`. Render time only: `result` never changes.

- [ ] **Step 1: Write failing tests:**

```ts
it('a big result stays whole for two user turns, then becomes a pointer')
it('a small result is never stripped')
it('a stripped pair keeps its call and its tool message')
it('stripping does not read as cold')
it('messageChars counts the pointer once stripped')
it('a repeat read says unchanged while the copy is whole, and returns the note after')
it('a changed note returns in full')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit, merge M4 to `main`.**

---

## Milestone 5: History search

### Task 16: Term index

**Files:**
- Create: `src/lib/search/tokens.ts`, `src/lib/search/termIndex.ts`, and tests
- Modify: `src/lib/db.ts` (v4: `searchDocs: 'messageId, conversationId, *terms'`), `src/lib/send.ts`, `src/ui/MessageActions.tsx`, `package.json`

**Interfaces:**
- Produces:

```ts
interface SearchIndex {
  index(m: Message): Promise<void>
  remove(messageId: string): Promise<void>
  search(conversationId: string, query: string, limit: number): Promise<{ messageId: string; score: number }[]>
  backfill(budgetMs: number): Promise<boolean>       // true when done
}
function tokens(text: string): string[]              // raw + fi stem + en stem, deduped, lower-cased, ä ö kept
```

`index` runs when a message settles (a user send, the end of a reply, an edit, a version flip), not on each 200 ms stream write. This is a small change from the spec's "same transaction": re-tokenising a stream every 200 ms would slow the phone, and a backfill pass repairs any gap. Prefix search with `startsWithAnyOf`. Backfill keeps its place in `db.cache`, so a killed run resumes.

- [ ] **Step 1: Write failing tests:**

```ts
it('keeps ä and ö')
it('finds a Finnish inflection through the stem')                 // kissa, kissan, kissoille
it('prefix search finds a compound start')                        // kirja → kirjasto
it('an edit replaces the old terms')
it('a deleted message leaves the index')
it('search scores more matching terms higher')
it('backfill resumes where it stopped')
it('backfill yields within its budget')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**
- [ ] **Step 6: Phone test.** Build a page behind `?bench` in dev only that seeds 100k messages and logs index size, write and query time. Mikael opens it once on the phone. Record the numbers in `docs/research/live-checks-2026-11.md`. If a search takes over 500 ms, stop and raise it: FTS5 replaces this behind `SearchIndex`.

### Task 17: History ability and digest

**Files:**
- Create: `src/lib/abilities/history.ts`, `src/lib/abilities/history.test.ts`, `src/lib/smallModel.ts`, `src/lib/smallModel.test.ts`

**Interfaces:**
- Produces: `historyAbility: Ability` with `history_search` (`query`, optional `digest`) and `history_read` (`ids` or `fromOrder`, `toOrder`). `MAX_SEARCHES_PER_TURN = 4`. `completeOnce(req: { model: string; system: string; prompt: string; key: string; signal: AbortSignal }): Promise<{ text: string; usage: Usage } | { error: string }>`, built on `streamChat` with `stream: false`, with usage added by the caller.

Results cover active messages outside the window, plus the neighbour on each side, with ids and capped at 6,000 characters. The tool descriptions must make the two search tools easy to tell apart from `notes_search`. A failed digest returns plain hits.

- [ ] **Step 1: Write failing tests:**

```ts
it('searches only outside the window')
it('returns the hit with one neighbour each side, and ids')
it('never searches summaries')
it('the fifth search in a turn is refused with a next step')
it('digest returns the small model\'s text with ids, and counts its usage')
it('a failed digest returns plain hits')
it('completeOnce reports an error instead of throwing')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit, merge M5 to `main`.**

---

## Milestone 6: Compaction

### Task 18: Summary engine

**Files:**
- Create: `src/lib/compact/plan.ts`, `src/lib/compact/plan.test.ts`, `src/lib/compact/template.ts`

**Interfaces:**
- Produces: pure.

```ts
const CHUNK_CHARS = 16000, CHUNKS_PER_CHAPTER = 8, SUMMARY_SHARE = 0.15, BLOCK_SHARE = 0.15, BLOCK_MAX_TOKENS = 4800
function chunkSpans(messages: Message[], summaries: Summary[], beforeOrder: number): { fromOrder: number; toOrder: number }[]
function spanHash(messages: Message[], fromOrder: number, toOrder: number): string
function staleSummaries(messages: Message[], summaries: Summary[]): string[]
function nextRollup(summaries: Summary[], limitTokens: number): { level: number; ids: string[]; fromOriginals: boolean } | null
function renderBlock(summaries: Summary[]): string | null
const SUMMARY_PROMPT: string, CHAPTER_PROMPT: string, STACK_PROMPT: string
```

`nextRollup` rules: `CHUNKS_PER_CHAPTER` chunks make a chapter, from originals (`fromOriginals: true`). Over the block cap, the oldest same-level summaries stack one level up (`fromOriginals: false`). `renderBlock` lists highest level first and names each message range. Prompts use the story template of spec §11; `STACK_PROMPT` carries "exact phrases" forward word for word.

Message-mode windows use `BLOCK_MAX_TOKENS`, since their limit isn't in tokens.

- [ ] **Step 1: Write failing tests:**

```ts
it('chunks fall on message edges near 16000 characters')
it('a message longer than a chunk stays whole')
it('dividers and pinned messages stay out of the text')
it('an edit makes only its chunk stale')
it('a summary edited by you is flagged, not rewritten')
it('8 chunks roll into a chapter from originals')
it('over the cap, the oldest chapters stack one level up')
it('the block stays under the cap in a very long chat')
it('cost per trim stays flat as the chat grows')        // nextRollup input size is bounded
it('an edited chunk feeds its edited text to the chapter')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**

### Task 19: Compaction ability

**Files:**
- Create: `src/lib/abilities/compaction.ts`, `src/lib/abilities/compaction.test.ts`
- Modify: `src/lib/send.ts`, `src/ui/ChatSettings.tsx`, `src/ui/Settings.tsx`

**Interfaces:**
- Produces: `compactionAbility: Ability` with no tools and `hooks.beforeSend`. `prepareSummaries(conversationId: string): Promise<void>`, fire-and-forget, one run per chat at a time. `PREPARE_AT = 0.6`.

After a reply ends, if the window is over `PREPARE_AT` of the limit, summarise what the next trim would drop. `beforeSend` updates `conversation.summaryBlock` only when the plan trimmed or the cache is cold, and only with summaries that are ready. Errors in `prepareSummaries` are logged and retried at the next reply. Usage adds to the chat's totals.

UI per the mockup's fourth phone: Summaries (a sheet with readable, editable chunks), Summary model (reuses `ModelSheet`), and "Summarise earlier messages" for trimmed history in existing chats.

- [ ] **Step 1: Write failing tests:**

```ts
it('the block changes at a trim and stays byte-identical otherwise')
it('a late summary never delays a send')
it('a failed summary leaves the send untouched and retries later')
it('switching compaction off keeps trims as they were')
it('a stale chunk is redone at the next cold moment')
it('a reroll inside the window touches no summary')
it('the summary model\'s usage counts in the chat totals')
it('originals stay searchable after a summary covers them')
it('compaction still runs on a model without tools')
```

e2e: `a long chat trims, shows a summary, and the next request carries the block`.

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit, merge M6 to `main`.**

---

## Milestone 7: Tidying

### Task 20: The free check

**Files:**
- Create: `src/lib/tidy/lint.ts`, `src/lib/tidy/lint.test.ts`

**Interfaces:**
- Produces: `lintNotes(notes: Note[]): Finding[]`, with `Finding = { kind: 'broken-link' | 'oversize' | 'near-duplicate'; noteIds: string[] }`. `MAX_RUN_NOTES = 30`, `MAX_RUN_CHARS = 24000`. `selectForRun(findings, notes): Note[]`, the flagged notes plus closest neighbours by folder.

- [ ] **Step 1: Write failing tests:**

```ts
it('finds a [[path]] with no note, and an alias counts as found')
it('finds near-identical paths on one shelf, and not across shelves')
it('an oversized note is a finding; a protected one is not')
it('a healthy vault gives no findings')
it('a note nothing links to is not a finding')
it('selectForRun stays inside both limits')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**

### Task 21: The tidy run

**Files:**
- Create: `src/lib/tidy/run.ts`, `src/lib/tidy/run.test.ts`
- Modify: `src/lib/db.ts` (v5: `proposals: 'id, createdAt'`), `src/main.tsx`

**Interfaces:**
- Produces: `maybeTidy(now: number): Promise<void>`, called when idle, on the same idle signal `appUpdate.ts` uses. `Proposal = { id: string; kind: 'merge' | 'delete'; noteIds: string[]; mergedBody?: string; path?: string; reason: string; createdAt: number }`. `Settings.lastTidyAt: number | null`.

Flow: skip if `!settings.tidying`, no key, a reply is running, or under 24 h since the last run. Run `lintNotes`, and stop if empty. Send `selectForRun` to `tidyModel` with `completeOnce`: unprotected notes in full, protected as path, description and tags only. Ask for JSON actions. Validate each action: moves, tags and descriptions apply at once under one `runId`, and merges and deletes become `Proposal`s. A proposal may not name a protected note. After the run, compare every protected `bodyHash`, and on any mismatch revert the whole `runId`. Usage adds to `Settings.vaultUsage`.

- [ ] **Step 1: Write failing tests:**

```ts
it('no findings means no model call')
it('runs at most once a day')
it('the switch off means no call')
it('a protected body is never in the request')                  // assert on the request text
it('moves and tags apply; merges and deletes become proposals')
it('a merge naming a protected note is dropped')
it('bad JSON from the model changes nothing')
it('a protected hash mismatch reverts the whole run')           // force it by editing mid-run in the test
it('a run never starts while a reply streams')
it('usage goes to vaultUsage')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**

### Task 22: To review

**Files:**
- Create: `src/ui/ReviewSheet.tsx`, `src/ui/ReviewSheet.module.css`
- Modify: `src/ui/Vault.tsx`, `src/ui/Settings.tsx`, `e2e/vault.spec.ts`, `CLAUDE.md`, `DESIGN.md`

**Interfaces:**
- Consumes: `Proposal`, `notes`.
- Produces: `<ReviewSheet open onClose />`, `applyProposal(id)`, `dismissProposal(id)`.

The mockup's third phone. The row "2 to review" shows only when proposals exist. Merge, See diff, Keep both. Delete, Keep. A "Tidied 3 notes" toast with Undo, which reverts the `runId`. Settings gets the Tidying switch, Tidy model, and a vault usage line.

Update repo `CLAUDE.md` with the new files, and add `tool lines` to `DESIGN.md`. Write `docs/superpowers/plans/vault-followups.md` with the 20-case tool eval and the blind A/B for the summary model. Neither blocks anything.

- [ ] **Step 1: Write failing e2e tests:**

```ts
test('a merge proposal applies, and History holds both originals')
test('Keep both removes the proposal and changes nothing')
test('the tidied toast undoes the whole run')
test('the review row hides when the list is empty')
test('the tidying switch stops runs')
```

- [ ] **Step 2 to 4: Run FAIL, implement, run PASS. Step 5: Commit.**
- [ ] **Step 6: Run** `npm test`, `npm run e2e`, `npm run typecheck:e2e`, `npm run build`, and one pass of the e2e suite against `vite preview` with a listener for `securitypolicyviolation`, because the CSP exists only in builds. Expected: no violations. **Step 7: Merge M7 to `main`, push, confirm the deploy is live.**
