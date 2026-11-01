# ORFE vault and abilities: design

Date: 2026-11-01. Owner: Mikael. This extends `2026-10-22-orfe-design.md` and replaces its "no tool calling" non-goal.
Evidence: `docs/research/agent-driven-memory-2026-11.md` (the report) and `docs/research/openrouter-api-2026-10.md`.
Approved look: `.superpowers/brainstorm/1757-1793541283/content/vault-and-tool-lines.html`.

Marks: **(Mikael)** is his decision. **(agreed)** is a proposal he approved in the playback. **(my call)** is the author's, and a builder may change it with a reason.

## 1. Intent

Mikael misses a place where the model can keep things: "a little persistent memory meets skill/database/vault/wiki flexible thing". Recipes, story beats, future plans, character progress, and lists like his favourite insects. The model writes and reads through visible tool lines. He reaches the notes "via some other tab". He also wants compaction, the model able to search older messages, and a clean base where abilities can be "clicked on".

The one design idea: **the model does the curating, and code sets the walls.** Mneme automates the decision on purpose. ORFE automates only the limits.

## 2. Goals, non-goals, anti-goals

**Goals**
- Model-written notes that survive across turns and chats, with a shared shelf and a chat shelf.
- The vault stays tidy with very little work from Mikael.
- Curated words stay exactly as they are.
- Long chats stay coherent after trims: compaction, plus search through old messages.
- A small base of abilities, switchable per chat.
- Any tool-capable model can use all of this mid-chat, and model switching still works.

**Non-goals for this design**
- Web access, MCP, user-made modules, embeddings. The registry must not block them.
- Memory that is pushed into the chat automatically, beyond the index and the summaries.
- Sync between devices.

**Anti-goals: it failed even if it works**
- A tidy run changes a poem, recipe or voice sample.
- Tool work makes the cache permanently cold.
- A reply can't be sent because a summary or a tidy run is late or failing.
- Original messages are lost or stop being searchable because a summary replaced them.
- Switching to a model without tools breaks the chat.
- The vault becomes a chore: daily review lists, or prompts to approve.

## 3. Constraints

- No backend. Everything runs on the phone in IndexedDB through `src/lib/storage.ts`.
- OpenRouter Chat Completions from the browser. Many providers, so no provider-only feature may be required.
- Default window is 32,000 tokens.
- The repo is public, and the app holds the key. Nothing here may send data to any host but openrouter.ai. The CSP in `vite.config.ts` enforces that.
- Design system: `DESIGN.md`. Tool lines and vault screens add no new colours and no new glass.

## 4. Data model

Shapes are a starting point. A builder may adjust names, not meanings. Dexie schema v3, with defaults on read as usual. `Note`, `NoteRevision` and `Summary` are new tables. (my call)

```ts
// A tool step lives inside the reply, in order, so a reply stays one message.
type ContentPart = /* existing */ | ToolPart

interface ToolPart {
  type: 'tool'
  callId: string
  round: number
  model: string           // who made the call; Continue may switch model mid-reply
  name: string
  args: unknown
  result: string          // always stored whole
  status: 'running' | 'done' | 'error' | 'stopped'
  undone?: boolean        // a write that was undone
}

interface Version { /* existing */ roundReasoning?: unknown[][] }  // reasoning_details per round, stored unchanged

interface Note {
  id: string
  shelf: string           // 'shared' or a conversation id
  path: string            // 'lists/insects', unique per shelf, ignoring case
  description: string     // one line, required, shown in the index
  tags: string[]
  body: string            // Markdown
  protected: boolean
  bodyHash: string
  version: number
  supersedes: string | null
  updatedAt: number
  deletedAt: number | null
}

interface NoteRevision {
  id: string
  noteId: string
  version: number
  before: Note | null     // null for a create
  after: Note | null      // null for a soft delete
  writer: string          // a model id, 'you' or 'tidy'
  messageId: string | null
  callId: string | null   // survives Edit and Continue, which copy ToolParts to a new version
  at: number
}

interface Summary {
  id: string
  conversationId: string
  level: number           // 0 is a chunk, 1 a chapter, 2 and up are stacked
  fromOrder: number
  toOrder: number
  sourceHash: string      // of the active text in the span
  text: string
  model: string
  stale: boolean
  editedByYou: boolean
}

interface Conversation { /* existing */
  abilities: Record<string, boolean> | null   // null = defaults
  notesIndex: string | null                   // frozen text, see §8
}
interface Prompt { /* existing */ abilities?: Record<string, boolean> }
interface Settings { /* existing */ summaryModel: string; tidyModel: string; tidying: boolean }
```

Every note write and its revision row go in one transaction. Every revision records its writer from the first day, because no study covers several models sharing one store, and this data will be the evidence. (Mikael: "agent driven". Stamp: my call.)

Chat-shelf notes belong to the chat. `deleteChat` soft-deletes them and `restoreChat` brings them back. (my call)

## 5. The tool loop

Lives in `src/lib/send.ts`. All tools run on the phone.

1. Send with `tools` and a constant `tool_choice: 'auto'`.
2. Collect `delta.tool_calls` by index until `finish_reason: 'tool_calls'`. Accumulate `reasoning_details` by `index`, and never merge across indexes, because that gives "Invalid signature".
3. Run the calls in order, one at a time. Save each `ToolPart` as it starts and as it ends.
4. Send the next round. Stop at 8 rounds per reply: return a result that says so, and let the model answer. (my call)

A tool error is a normal result the model can read, never a thrown failure. Refusals say what to do next.

**Stop:** write a `stopped` result for every open call, or the next request fails.

**Locking the phone:** the reply ends `interrupted` as it does today. Continue finishes open calls, then runs the next round. Plan 2's relay covers one request at a time, so it can't run a tool step alone. A locked phone pauses the reply. Accepted. (agreed)

Usage from all rounds adds up on the Version. Small-model calls add to the chat's totals.

## 6. Rendering the outgoing history

`buildOutgoing` stays a pure function, now of stored history, current model and current turn. (agreed)

- **Steps by the current model** go out as real `tool_calls` and `tool` messages, with their stored ids.
- **Steps by other models** flatten into the assistant text, in plain past tense: `(Looked in notes for 'river': found 2 notes.)`. This avoids every id format problem.
- **A model without tool support:** everything flattens, no `tools` field, no index. Abilities are off for that model, and the app says so once beside the model chip. Compaction still applies, because it is not a tool. Read support from the catalog's `supported_parameters`. (agreed)
- **`tools` stay in every request** while the sent history holds tool messages.
- **Reasoning:** while a reply's tool rounds are running, send that reply's `reasoning_details` back unchanged, always. Once the reply is finished, stop sending them, for every model, and keep them stored. So a tool turn pays a small tail miss on the next turn, the same kind as stripping, and reasoning takes no window space. (my call, test 6 in §15) DeepSeek is the one known exception, so test it first.

Tool text counts in the window. `messageChars` and `planWindow` must count the rendered form of tool steps, the index, the ability instructions and the summary block.

## 7. Keeping the cache warm

- Send one stored JSON string for the tools of the current ability set, in a fixed order. Keep counts, dates and titles out of tool descriptions.
- Freeze the window start for a whole tool turn.
- `fingerprint()` and `isCold` must also cover the tools JSON, or a toggle reads warm.
- **Stripping (§9) must not read as cold.** Hash a canonical form where every tool result is reduced to its call id. Otherwise each strip would allow a cold trim.
- All other prefix changes land in one event: the trim. Trim, summary, index refresh.
- Retrieved text goes in the tool result. No breakpoint work is needed.
- An ability toggle costs one cold turn. Tools stay frozen between toggles. (agreed)

## 8. Notes ability

### The index (Mikael: always visible)
Note bodies are pulled. The map is pushed. A compact tree of paths and one-line descriptions sits in the system message, after the prompt and capability note. It covers the shared shelf and this chat's shelf. Cap: about 2,000 tokens. Over the cap, folders collapse to a name and a count.

The index is frozen in `conversation.notesIndex` and refreshed only at a cold moment. New notes stay reachable through `notes_search` until then. The comment in `system.ts` that says nothing dynamic goes in must change to match.

### Tools (five, about 7 with history)
| Tool | Job | Guards |
|---|---|---|
| `notes_search` | Find notes. Returns path, snippet, version | Capped results |
| `notes_read` | Read a note with line numbers. No path lists the tree | 8,000 characters a page, with paging |
| `notes_write` | Create, or replace a whole note | Near-match check, `expected_version` on replace, shrink guard |
| `notes_edit` | Replace exact text, or insert | Must match once, exactly. `expected_version`. No fuzzy matching |
| `notes_delete` | Soft delete, or move with `new_path` | Goes to Trash |

Paths start with `shared/` or `chat/`. A new note starts on the chat shelf unless the model has a reason or Mikael asks. (agreed)

### Rules at the door
- **Near match:** `notes_write` compares the new path against existing ones. A close match is refused and names the note: update it, or resend with `new: true`.
- **Stale edit:** a wrong `expected_version` is refused and asks for a fresh read.
- **Size cap:** a model-written body over 8,000 characters is refused, with a request to shorten or split it. Mikael's own edits have no cap. (my call on the number)
- **Shrink guard:** a replace that removes over half a note is refused unless `shrink: true`. (my call on the number)
- **Required header:** a write needs a one-line description.
- **State, not diary:** notes say what is true now. The revision history keeps the past.

### Protection (Mikael: tidying never rewrites curated content)
`protected` is enforced in the tool handler, not in a prompt. A protected note refuses `notes_edit`, whole-note replace and delete. Move and tag still work. The refusal gives the next step: "This note is protected. Move or tag it, or write a new note that links to it."

Any model may set the flag. Only Mikael can clear it, in the UI. (agreed) Keep protected blocks as their own notes, linked from editable ones. There are no locked blocks inside a note.

### Instructions
Ability instructions go in the system message and don't change between toggles. The text is left to the builder, but it must say:
- Search before you say you don't remember.
- Saving nothing is a normal outcome. Save what is durable, useful, and stated or confirmed by Mikael.
- Don't save your own paraphrase of a note you just read.
- A concrete staleness rule, not a "may be stale" label: prefer the newest note, and when one states a limit, follow it. Use `supersedes` when a note replaces another.
- Keep planned events in a "Planned" section, apart from what has happened.
- What Mikael just did outranks any note.

### Links between notes
A link is `[[path]]`. A moved note keeps its old paths as aliases, so links in protected notes never break and tidy never has to rewrite them. (my call)

### Rerolls and undo (agreed)
Each write links to its message and `callId`.
- A reroll undoes the chat-shelf writes of the reply's active version and keeps its shared-shelf writes. Deleting a message or one version does the same for what it removes.
- Undo means a new revision restoring `before`. A create becomes a soft delete.
- Undo applies only when that write is still the note's latest revision. If Mikael or a later reply changed the note, it stays, and the line says so.
- Tapping a write line undoes that one write, on either shelf.

The rest are my calls:
- A reroll undoes at the start, so the new reply can't read the old writes. If the reroll fails with no output, the writes are put back.
- The Undo on a delete toast puts the writes back too.
- Flipping back to an old reroll version does not redo its writes. Its lines show as undone, with a tap to redo.
- Edit changes text parts only. `ToolPart`s stay in place, so a reply's steps survive an edit.
- Continue copies `ToolPart`s unchanged, and each keeps its own `model`.

## 9. Keeping tool results small (Mikael: strip soon)

Context bloat matters more than money here. Keeping a 2k note costs about $0.0002 a turn on Sonnet 5.5, but five such reads take a third of the window.

1. **Caps at the door.** Reads are paged, and searches return snippets with ids.
2. **Repeat reads.** If the same note at the same version is still whole in the sent history, return "unchanged, see above". Otherwise return it in full. (my call)
3. **Strip soon.** A result over about 300 tokens becomes a one-line pointer once two user turns have passed since it ran. The pointer names the path or message ids. Stripping only re-pays what came after the result, so it is cheap near the end of the chat. This happens at render time, from the stored turn, so `result` always stays whole. Reasoned, not tested: see §15.
4. **Tool text counts** toward the limit, so trims stay on time.

A kept call and result pair stays a pair: only the result text shrinks.

## 10. History search ability

Two tools: `history_search` and `history_read`. They search verbatim active messages outside the window, never the summaries. A hit returns the message plus one neighbour on each side, with ids. Cap the search rounds per turn.

**Index:** a Dexie multiEntry term index inside `storage.ts`, written in the same transaction as the message, behind a `SearchIndex` interface so FTS5 can replace it. Keep `ä` and `ö`. Index the raw token plus Snowball Finnish and English stems. Use prefix search, and let the tool description ask for several inflected forms. Backfill existing chats in small batches while idle. (my call, from the report)

**Digest:** `history_search` takes an optional `digest` question for wide looks, like "what happened with Mira across this chat?". The summary model reads the hits and returns a short digest with message ids. This happens before anything enters the context, so it costs no cache. If it fails, return plain hits. (agreed)

## 11. Compaction ability

A hook on the send plan, not a tool. It runs only at the existing trim. (agreed)

- Trimmed messages fall into fixed chunks of about 16,000 characters. Each gets one `Summary`, from the original text.
- Prepare summaries in the background as the chat nears the limit, so a send never waits. If one is late, trim anyway and fill it in next time.
- The summary block goes in the system message, after the index. It changes only at a trim.
- **Story template:** characters and state, relationships, events in order, open threads, world facts, exact phrases. Ask only for what is on the page.
- **Budget:** about 15% of each span, with the whole block capped near 15% of the window, or about 4,800 tokens. (my call on the numbers)
- **Chapters:** when about 8 chunks have built up, the oldest ones become one chapter (level 1), written from the original text in one pass. A chunk Mikael edited goes in as his text, so his edit carries over. (my call)
- **Stacking (Mikael):** when the block is full, the oldest summaries merge into one summary a level up. This is the only place summaries are written from summaries, so the cost per trim stays fixed however long the chat gets. The originals stay searchable through `history_search`, and every summary names its message range, so the model can check a detail in the real text. The research warns that stacking can lose detail and invent some. So a stacked pass carries "exact phrases" forward word for word and asks only for what is on the page.
- Recent messages and pinned messages stay word for word.
- An edit, delete or reroll inside a span changes `sourceHash`, marks the chunk stale, and redoes it at the next cold moment. Mikael's own edit of a summary sets `editedByYou`, and that chunk is then flagged, not rewritten.
- Compaction off means trims work as they do today.
- **Existing chats:** compaction starts from the next trim. Chat settings offers "Summarise earlier messages", one tap, for the part already trimmed. (my call)

**Summary model:** a setting. The default is Gemini Flash, from Mikael's experience, with the exact id checked at build time. A blind A/B can change it later, and the A/B is not part of this build. Haiku 5.5 and Gemma are the first to compare. Avoid models with mandatory reasoning, and check `context_length` covers a chapter pass, about 64,000 characters.

The base spec says no hidden extra requests without a setting. The per-chat Compaction switch and the Settings switch for tidying are those settings. Every extra call counts in the usage figures. (my call)

## 12. Tidying

Runs only while the app is open and idle. It never blocks a send. (agreed)

**A switch in Settings**, on by default. Tidy calls count in a vault line in the usage panel, since they belong to no chat. (my call)

**A free check runs first.** It finds broken links, oversized notes and near-identical paths, with no model call. A model runs only if the check finds something, at most once a day. A run sees only the flagged notes and their closest neighbours, at most 30 notes or 24,000 characters. That is about a cent on a Sonnet-class model. (my call on the numbers)

**Two tiers (agreed):**
- Moves, tags and description edits apply at once. One quiet "Tidied 3 notes" line with Undo.
- Merges and deletes wait in To review, each as a diff with one tap. Mikael can ignore the list forever.

**Protection, mechanically:** the tidy model receives only the path, description and tags of a protected note, never the body. After each run, compare every protected `bodyHash`. A mismatch rolls the run back.

Nothing fades or archives by age. A rarely opened recipe is still a recipe. (agreed)

`tidyModel` is a setting and should be a strong model, since models differ widely on this work. (my call)

## 13. Abilities

A static TypeScript registry, not a plugin system.

```ts
interface Ability {
  id: string; title: string; summary: string
  tools: ToolDef[]                          // plain data, fixed order
  instructions?: string
  run(call, ctx): Promise<string>           // ctx is narrow, never the Dexie handle
  hooks?: { beforeSend?(plan, ctx): plan }  // compaction lives here
  traits: { private?: true; untrusted?: true; outward?: true }
}
```

One function, `toolsFor(chat, model)`, decides what reaches the model, so a dispatcher can replace direct tools later without touching abilities. Stay at or below about 12 tools per request.

Notes, History search and Compaction are on by default, in all chats. Each can be switched off per chat, and a prompt can carry its own default set. (agreed; applying to existing chats: my call)

**Trust:** a chat that holds private data, reads untrusted content and has an outward channel at once must warn or refuse. After a model reads anything `untrusted`, its note writes wait for a visible OK. Nothing in this design is `untrusted`, so the gate exists but stays closed until such an ability ships. (agreed)

## 14. UI

The approved mockup is the reference. Tool lines are style A. (Mikael)

- **Tool lines:** mono 11 px lines in reply order, where each step happened. Running: `recalling Harbour…` in ink. Done: `recalled Mira, voice` in mute. Tap to open: shows what was read or changed. A write has Undo. Flattened old steps still show as lines, because the stored `ToolPart` is the same.
- **Vault:** a Chats / Vault segment at the top of the drawer. Search, the To review row, then the two shelves, with a small lock on protected notes. Other chats' shelves sit in a row at the end, and Trash after them.
- **Note:** path, title, last writer and version, Edit, History, Move, Protected. Prose in Newsreader. Only Mikael can clear Protected.
- **To review:** one card per merge or delete. Ignorable forever.
- **Chat settings:** Abilities with switches, a note that a change makes the next reply cold once, Summaries (readable and editable), Summary model, This chat's notes.

Mikael's edits are revisions with writer `you`.

## 15. Live tests before trusting the design

Each needs a real OpenRouter call, so the unit and e2e suites can't cover them. Run them at the start of the tool loop work, with cheap models.

1. **Strip soon:** strip a result two turns back and read `cached_tokens`. Confirm it costs only the tail on Anthropic and one automatic-cache provider. If not, strip only at trims.
2. **DeepSeek with tools:** which field keeps `reasoning_content` valid across requests.
3. **Foreign reasoning:** a model switch mid-chat with stored reasoning from another provider.
4. **Tool messages after a switch:** a history with flattened steps, plus `tools`, on three providers.
5. **Provider minimums:** whether changing nothing but one tool description drops `cached_tokens`, which confirms tools sit in the prefix.
6. **Dropped reasoning:** after a finished tool turn, send the next turn without its reasoning. Confirm no error and only a tail miss.

**If a test fails, the build goes on.** A failure gives one model or provider a narrower path, not a stop:
- Test 1 fails: strip only at trims.
- Tests 2 or 6 fail for a model: keep reasoning on that model until the next trim, and count it in the window. If it still errors, treat that model as having no tools, with the usual notice.
- Tests 3 or 4 fail for a provider: flatten more, up to everything. Flattened history always works, because it is plain text.

A per-model rule table in `buildOutgoing` carries these. (my call)

The phone test of the term index at around 100k messages runs before step 5 ships. A 20-case tool eval across Mikael's main models comes after step 3 ships, and blocks nothing. (my call)

**Who runs them (Mikael):** Claude runs them from a script, with an OpenRouter key Mikael creates for this. The key lives in a git-ignored local file, never in chat, code or a commit, and the script never prints it. A spend limit of about $2 on the key is the guard. (limit: my call)

## 16. Build order

Each step is usable alone. (from the report; order: my call)

1. Backup from Plan 4 (spec §9), including notes, revisions and summaries. Notes make the phone's data worth more.
2. Ability registry, tool loop, history rendering, cache rules, and the live tests.
3. Notes ability, tool lines, the vault UI, revisions, undo.
4. Keeping results small (§9).
5. History search.
6. Compaction.
7. Tidying.

## 17. Left to the builder

Exact tool schemas and descriptions, ability instruction text, the near-match method, the Snowball package, how the index tree collapses, batch sizes for backfill, how the two-turn count treats rerolls, and the digest's output format.
