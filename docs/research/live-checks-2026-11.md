# Live checks for the tool loop (2026-11-01)

These are the six tests from spec section 15 of the vault design. They ran with real, paid OpenRouter calls. The script is `scripts/live-check.mjs`. Total spend: about $0.14 (the key went from $0.00 to $0.136 of its $5 limit).

## How the tests ran

- Four models, all cheap, all with tool support:
  - `anthropic/claude-haiku-5.5` (Anthropic, reasoning effort low)
  - `deepseek/deepseek-v4-flash` (effort high). Check 2 also ran on `deepseek/deepseek-v3.2`.
  - `openai/gpt-5.6-luna` (effort low)
  - `google/gemini-3.1-flash-lite` (effort low)
- The system message was padded to 5,000-6,000 tokens. That is above every provider's cache minimum. A dummy `lookup` tool was in every request.
- Each model first made a real history: one tool turn (call, 800-word result, final text) and two plain turns. Reasoning was dropped for the plain turns (the ORFE rule).
- Anthropic got the same top-level `cache_control: {type: "ephemeral"}` that ORFE sends. The other three cache by themselves.
- Calls were not streamed. Usage numbers are the same.
- Every cache check has a control. The identical request goes out twice, a few seconds apart. The second call must show `cached_tokens` above zero. Only then is a drop trusted. All controls passed except where noted.
- All numbers below are `prompt_tokens` / `cached_tokens` from the response `usage`.

## Results

| # | Check | Model | Result | What it means for rendering |
|---|---|---|---|---|
| 1 | Strip soon (result two turns back shrinks to a pointer) | haiku-5.5 | Passed. Prefix before the change: 7,851 tokens. After the strip, cached 7,847. Control cached 9,661 of 9,665. | Only the tail after the change is paid again. Strip is safe. |
| 1 | | gpt-5.6-luna | Passed. Prefix before the change: 5,016. After the strip, cached 5,013. Control 6,217 of 6,220. | Same. |
| 1 | | gemini-3.1-flash-lite | Partly. Prefix 5,296. After the strip, cached 4,005 (4,005 again in a second run). Control 6,038 of 6,492. | Unclear. This provider caches in coarse steps. A normal repeat turn here only cached 4,025. The strip did no worse than that. |
| 1 | | deepseek-v4-flash | Depends on the provider. On Relace (run 1, with an older padding) cached 6,400 of a 6,441 prefix. On Venice, cached 0 in two runs, while the control cached 6,400. | Unclear. Some DeepSeek hosts keep nothing after a mid-history change. The cost is small (see below). |
| 2 | DeepSeek with tools: which field keeps reasoning valid | deepseek-v4-flash, deepseek-v3.2 | No variant failed. I tried: no reasoning, `reasoning`, `reasoning_details`, both, `reasoning_content`. Each was tried inside the tool turn and on the next user turn. All returned 200. | No field was needed on the hosts I reached. Send back `reasoning_details` unchanged during the tool turn, as the spec says. First-party DeepSeek was not reached, so this is not proven for it. See the caveat below. |
| 3 | Foreign reasoning (switch model, stored reasoning from another provider still attached) | all 12 pairs among the four models (reasoning kept on the steps) | All 200. All made a tool call when asked. | No error. Prompt sizes with and without the foreign reasoning were equal in 11 of 12 pairs (one differed by 4 tokens; numbers below). That suggests OpenRouter drops it, but this is a guess. |
| 4 | Tool messages after a switch: raw steps with foreign ids, plus `tools` | same 12 pairs | All 200. All made a tool call when asked. | Raw steps with foreign call ids work on all four. Flattening is a choice, not a need. |
| 4 | Same, steps flattened to plain text, plus `tools` | same 12 pairs | All 200. All made a tool call when asked. | Flattening works everywhere, as the spec expects. |
| 5 | One word changed in a tool description | haiku-5.5 | Cached 9,661 -> 0. | Tools are in the prefix. A changed description makes the whole prefix cold. |
| 5 | | gpt-5.6-luna | Cached 6,217 -> 0. | Same. |
| 5 | | gemini-3.1-flash-lite | Cached 4,025 -> 0. The first control hit 0, so I retried once. The retry hit. | Same. |
| 5 | | deepseek-v4-flash | Three runs: 7,680 -> 0 (Relace), 6,400 -> 4,864 (Venice), 6,400 -> 0 (Venice). | Same, with one odd partial hit. Treat tools as part of the prefix. |
| 6 | Dropped reasoning after a finished tool turn | haiku-5.5 | No error. The round had 226 reasoning tokens. Next turn without them: prompt 9,862, cached 9,695. Control repeat cached 9,858. | A small tail miss, as planned. Everything up to the end of the tool turn's first request stayed cached. About 167 tokens were paid again. |
| 6 | | gpt-5.6-luna | No error. Prompt 6,333, cached 6,250. Repeat cached 6,330. | Tail miss of about 80 tokens. |
| 6 | | gemini-3.1-flash-lite | No error. Prompt 6,576, cached 6,015, same as with reasoning kept (6,015). The repeat never hit higher. | No error. Not distinguishable from kept at this step size. |
| 6 | | deepseek-v4-flash | No error. Prompt 6,737, cached 6,144, same as with reasoning kept (6,144). The repeat never hit higher. | No error. Not distinguishable from kept at this step size. |

## Raw numbers

Format: `prompt / cached`. `through-u1` is the prompt size of the first request of the tool turn. That request ends at the first user message. The strip changes the message after it.

**Check 1** (run 3; the padding differs from run 1)

| Model | through-u1 | control-1 | control-2 | strip |
|---|---|---|---|---|
| haiku-5.5 | 7,851 | 9,665 / 9,640 | 9,665 / 9,661 | 8,035 / 7,847 |
| deepseek-v4-flash (Venice) | 5,341 | 6,488 / 0 | 6,488 / 6,400 | 5,403 / 0 |
| deepseek-v4-flash (Venice, run 4) | 5,342 | 6,484 / 0 | 6,484 / 6,400 | 5,399 / 0 |
| deepseek-v4-flash (Relace, run 1) | 6,441 | 7,865 / 6,400 | 7,865 / 7,680 | 6,581 / 6,400 |
| gpt-5.6-luna | 5,016 | 6,220 / 6,196 | 6,220 / 6,217 | 5,137 / 5,013 |
| gemini-3.1-flash-lite | 5,296 | 6,492 / 4,025 | 6,492 / 6,038 | 5,373 / 4,005 |
| gemini-3.1-flash-lite (run 4) | 5,298 | 6,496 / 4,025 | 6,496 / 6,038 | 5,377 / 4,005 |

**Check 3 prompt tokens** (reasoning kept / reasoning dropped; source -> target): haiku->deepseek 6,510/6,510; haiku->gpt 6,249/6,249; haiku->gemini 6,517/6,517; deepseek->haiku 9,672/9,672; deepseek->gpt 6,240/6,240; deepseek->gemini 6,508/6,508; gpt->haiku 9,661/9,661; gpt->deepseek 6,494/6,494; gpt->gemini 6,501/6,501; gemini->haiku 9,666/9,666; gemini->deepseek 6,499/6,495; gemini->gpt 6,237/6,237.

**Check 5** (control, then the changed description)

| Model | control | changed |
|---|---|---|
| haiku-5.5 | 9,665 / 9,661 | 9,671 / 0 (wrote 9,667) |
| deepseek-v4-flash (run 3) | 6,488 / 6,400 | 6,492 / 4,864 |
| deepseek-v4-flash (run 4) | 6,484 / 6,400 | 6,488 / 0 |
| gpt-5.6-luna | 6,220 / 6,217 | 6,224 / 0 (wrote 6,221) |
| gemini-3.1-flash-lite | 6,492 / 4,025 (retry) | 6,496 / 0 |

**Check 6** (run 5; the prompt asks the model to think first, and haiku ran at effort high)

| Model | round 1 | round 2 (reasoning kept) | next turn, dropped | dropped, repeat | next turn, kept |
|---|---|---|---|---|---|
| haiku-5.5 | 9,699 / 7,847 | 10,007 / 9,695 | 9,862 / 9,695 | 9,862 / 9,858 | 10,089 / 10,005 |
| deepseek-v4-flash (SiliconFlow) | 6,627 / 4,096 | 6,780 / 6,144 | 6,737 / 6,144 | 6,737 / 6,144 | 6,809 / 6,144 |
| gpt-5.6-luna | 6,253 / 6,197 | 6,317 / 6,250 | 6,333 / 6,250 | 6,333 / 6,330 | 6,349 / 6,314 |
| gemini-3.1-flash-lite | 6,521 / 4,026 | 6,644 / 6,021 | 6,576 / 6,015 | 6,576 / 6,015 | 6,576 / 6,015 |

An earlier check 6 run (run 3) used a plainer prompt and haiku produced no reasoning in the tool round. That run proved nothing for haiku, so run 5 replaced it. The other three models agreed in both runs.

**Check 2 prompt sizes** show that reasoning sent back is counted. On deepseek-v4-flash the in-turn request was 6,425 tokens with no reasoning and 6,453 with `reasoning`, `reasoning_details` or `reasoning_content`.

## Things the tests showed that the spec did not ask about

1. **A refusal comes back as HTTP 200 with nothing in it.** Anthropic returned `finish_reason: content_filter`, `native_finish_reason: refusal`, empty content, and `usage` all zero. It happened when the system message was random word salad. The tool loop must treat `content_filter` with no content as an error the user can see. It must not treat it as an empty finished reply.
2. **The cache lives on one provider.** DeepSeek moved between Relace, Venice, Azure, SiliconFlow and DeepInfra inside one run, even with the same `session_id`. Every move starts cold. The same applies to any model with many hosts.
3. **Cache steps differ by provider.** Anthropic matched down to a few tokens. OpenAI matched in 128-token steps. DeepSeek matched in 64-token steps. Gemini matched in coarse steps of about 2,000 tokens (4,025, then 6,038).
4. **Anthropic only reuses a cache that an earlier request wrote at its end.** After the strip, haiku kept exactly the prefix that ended at the first user message (7,847 of 7,851). That is the end of the first request of the tool turn. Everything after the changed message was paid again. This is the normal, expected behaviour.
5. **`deepseek-v3.2` has no endpoints when the call is pinned to `deepseek` itself**, and DeepSeek's own host returned "Insufficient Balance" for `deepseek-v4-flash` on a pinned call. That is a limit on the host's side. So the first-party DeepSeek API was not tested.

## What is unclear

- **DeepSeek first-party.** DeepSeek's own API is said to require `reasoning_content` back after a tool turn. I could not reach it. The five hosts I did reach accepted every variant, including none. If a user pins a model to a host that is stricter, the fallback in spec section 15 applies: keep reasoning on that model until the next trim.
- **Whether the model uses the reasoning it gets back.** The tests show only that there is no error, and what the cache does. They do not show answer quality.
- **Gemini and DeepSeek strip results** vary by host and by moment. Three runs on Gemini agreed (4,005). Three runs on DeepSeek disagreed (6,400, 0, 0).
- **Check 3 and rule 4** rest on "no error". The "OpenRouter drops it" reading comes from equal prompt sizes only. The response does not say so.

## Rules for modelRules.ts

The interface is `ModelRule { keepReasoning?: true; noTools?: true; flattenAll?: true }`.

1. **No `keepReasoning` entry is proven needed on the tested hosts.** Five DeepSeek hosts accepted a next turn with no reasoning. First-party DeepSeek was never reached, so it is untested. `keepReasoning` stays in the `ModelRule` interface, and the mechanism must ship, so an entry can be added in one line.
2. **No model needs `noTools`.** All four models call the tool and handle tool results.
3. **No model needs `flattenAll`.** Raw steps with foreign call ids work on all four, and flattened steps work on all four. Keep the spec's design: flatten steps made by other models. It is safe and it is not required.
4. **Foreign reasoning can always be left out.** It was never an error. That alone supports sending nothing.
5. **Keep tools frozen.** A one-word change in a tool description made the cache go cold on every provider. This confirms spec section 7: one stored tools string, changed only at a toggle.
6. **Strip soon stays on.** It passed on Anthropic and OpenAI. It did no worse than a normal turn on Gemini. On some DeepSeek hosts a strip costs the whole prompt, about 6,000 tokens. At deepseek-v4-flash prices ($0.091 per million input tokens uncached, $0.0182 cached), 6,400 missed tokens cost 6,400 x ($0.091 - $0.0182) / 1,000,000 = about $0.0005 extra per strip. Spec section 15 says to strip only at trims "if not". I judge the cost too small to add a rule for it. If Mikael disagrees, the rule needs a new field, because `ModelRule` has none for this.
7. **Dropping reasoning after a finished tool turn is safe on all four.** The cost is a tail miss of roughly 80 to 170 tokens on Anthropic and OpenAI, and not distinguishable from keeping reasoning on Gemini and DeepSeek at their coarse cache step size (no error on any). In the app's live smoke test on Haiku 5.5, it cost about 11% of the Anthropic prefix once (1,964 of 2,214 tokens cached on the next send). Spec section 6 accepts this as a tail miss.
8. **Treat HTTP 200 with `finish_reason: content_filter` and no content as a failure.** (Not a `ModelRule`; it belongs in the send loop.)

## Term index bench (2026-11-02): desktop with throttling, not a phone

Task 16's `?bench` page, run on a production build under `vite preview`, in full Chromium, with the CPU throttled 6x through CDP. The machine is a 12-core desktop with 16 GB RAM. Mikael's phone run is still to come, and that run is the gate. The section has three rounds: the first build, kept here with its failed runs, the design after review under "Second round", and two last changes under "Third round". The third round is what ships.

**What the numbers do not show.** The throttle slows page JavaScript. It does not slow the browser's IndexedDB process or the disk, so a phone can be slower than this on index writes and on reads from flash. The text is made up: a few hundred Finnish and English words, with some rare ones. The first noun in each list (`kissa`, `memory`) is far more common than any real word, on purpose.

**Result of the first build: no query over 500 ms, but the queries were too easy.** Min 34 ms, median 140 ms, max 300 ms over 20 queries. Review found that the spec's multi-form queries were not in the set, and that those failed (786 and 925 ms). See "Second round".

| Measure | First build |
|---|---|
| Messages | 100,000 in 100 chats. Queries run in the longest chat, 20,000 messages |
| Seed | 56.6 s |
| Index (a full backfill) | 653 s |
| Repair pass with nothing to do | 84.1 s |
| Index size | 657.7 MB (messages: 85.1 MB) |
| Terms per message | about 77 |
| One `index` write | min 13 ms, median 20 ms, max 45 ms |
| Queries | min 34 ms, median 140 ms, max 300 ms. Slowest: `kissoille` |
| Longest stall of the page during the run | 489 ms (timer tick check) |
| CSP violations | 0, with a `securitypolicyviolation` listener on |
| Hosts contacted | localhost only |
| Databases after the run | none: `orfe-bench` is gone and `orfe` was never opened |
| Normal load | 0 requests for the bench chunk, with the service worker active |

All 20 queries, in ms: the 153, and 115, ja 122, memory 223, project 97, window 93, kissa 223, koira 96, zebra 122, kissoille 300, talossa 140, kirjastossa 34, järvellä 98, ystävälle 82, metsästä 120, kirja 186, "kissa koira" 257, "memory project" 246, "talo järvi" 289, "kirja window" 285.

**Runs of the first build.** The first two failed the 500 ms line:

| Run | Index design | Shape | Queries (min / median / max) | Over 500 ms |
|---|---|---|---|---|
| 1 | Plain terms, plus a read of all the chat's ids | all 100k in one chat | 1,535 / 3,639 / 12,524 ms | 20 of 20 |
| 2 | Terms filed under the chat | 100 chats, longest 20k | 49 / 596 / 2,782 ms | 10 of 20 |
| 3 | Run 2, plus at most 4,000 rows read per token | 100 chats, longest 20k | 34 / 140 / 300 ms | 0 of 20 |

Runs 1 and 2 differ in the chat shape as well as the design, so the gap between them is not all from the design. Run 1 is the harsher shape. Filing terms under the chat also cut the index time from 1,268 s to 650 s.

**What the 4,000 row limit cost in this build.** With message ids as keys, the rows a capped word kept were a random sample, the same one on each search, and ties went by random id. Review measured this. The second round replaces it with the newest rows.

**Keys in one read, not `startsWithAnyOf`.** Each token gets one `startsWith(...).primaryKeys()` read, and Dexie serves that with `getAllKeys`. `startsWithAnyOf` walks a cursor row by row. Raw IndexedDB under the same throttle, 80,000 rows: `getAllKeys` 1,383 ms, key cursor 6,945 ms. That is 5 times slower.

**Other things to know.**
- The index was 7.7 times the messages in this run, about 6.7 KB per message. It is never backed up. The second round's numbers replace these.
- A pass ran at each app start in this build. It no longer does.
- A plain Playwright context keeps IndexedDB in memory and hit `QuotaExceededError` at about 70k messages. A persistent profile had no such limit, so the runs above use one. The page reports that error and still deletes its data. The phone stores on flash, so this should not happen there unless it is nearly full.
- The full run took about 14 minutes here, not "a few minutes", so the page's warning says 20 minutes or more. In the second round it took 16 to 18 minutes.
- The Finnish stemmer has limits. `kissoille` stems to `kiso`, and `kissa` to `kis`. A search for `kissa` finds `kissoille` through the prefix, but a search for `kissoille` does not find `kissa`. Words that change inside (`vesi`, `veden`) share no stem. The tool description should ask for several forms, as spec §10 says.

### Second round: the design after review (still desktop with 6x throttle, not a phone)

**Result of this round: 3 of 24 queries are over 500 ms in the usual shape, and all three are multi-form queries.** The third round brings these under. Single words and two-word queries stay under 260 ms. Chat length does not matter: one chat of 100k messages gives about the same times as a 20k chat.

The queries over 500 ms:

| Query | 100 chats, longest 20k | One chat of 100k |
|---|---|---|
| `memory cache token model stream message search index` | 881 ms | 721 ms |
| `the and of to in is that it` | 571 ms | 465 ms |
| `kissa kissan kissoille kissoja kissat` | 526 ms | 469 ms |

These are the worst case on purpose: `memory` and `kissa` are far more common here than any real word, and an 8-word query can read up to 24 tokens. A query of eight rare words reads almost nothing.

| Measure | 100 chats, longest 20k | One chat of 100k | 20k messages at 1,600 characters |
|---|---|---|---|
| Seed | 59.0 s | 56.4 s | 19.0 s |
| Index (full backfill) | 843 s | 952 s | 365 s |
| Repair pass with nothing to do | 55.0 s | 53.0 s | 14.0 s |
| Index size | 291.3 MB | 330.4 MB | 137.6 MB |
| Size per message | 3.0 KB | 3.4 KB | 7.0 KB |
| Message size | 74.2 MB | 71.1 MB | 53.9 MB |
| Terms per message | 77 | 77 | 229 |
| One `index` write, median / max | 18 / 28 ms | 23 / 31 ms | 27 / 35 ms |
| Backfill slice at 30 ms budget, median / p90 / max | 27 / 33 / 108 ms | 31 / 42 / 103 ms | 26 / 36 / 113 ms |
| One 500 KB message | 167 ms | 218 ms | 197 ms |
| Queries, min / median / p90 / max | 52 / 181 / 526 / 881 ms | 84 / 167 / 465 / 721 ms | 31 / 155 / 344 / 742 ms |
| Over 500 ms | 3 of 24 | 1 of 24 | 1 of 24 |
| Longest page stall | 461 ms | 448 ms | 846 ms |
| CSP violations | 0 | 0 | 0 |
| Page was hidden | no | no | no |
| Databases after the run | none | none | none |

All 24 queries, 100 chats, in ms: the 119, and 96, ja 102, memory 182, project 108, window 106, kissa 185, koira 93, zebra 85, kissoille 247, talossa 134, kirjastossa 52, järvellä 105, ystävälle 95, metsästä 114, kirja 181, "kissa koira" 236, "memory project" 233, "talo järvi" 251, "kirja window" 245, then the four multi-form queries: `kissa`-forms 526, `talo`-forms 237, `the`-words 571, `memory`-words 881.

**How big.** About 3 KB per message at 400 characters, 7 KB at 1,600. So 10,000 messages take about 30 MB at 400 characters and about 70 MB at 1,600. The first build's "66 MB" held only at 400 characters, and would be about 225 MB at 1,600. Review measured 2.64 KB in a smaller test. The numbers here come from `storage.estimate()`, which counts files before the database has compacted them.

**The design, as built.**
- `searchDocs: 'n, &messageId, conversationId, *terms'`. `n` is a number key from the message's time, newest lowest: `-createdAt * 1024`. A clash moves up by one, inside a rw transaction, so two writers can't pick the same number. A re-index keeps its `n`. Each index entry repeats the primary key, so a number in place of a 36-character id is what cut the size by more than half.
- Terms stay filed under the chat, as `chatId:term`.
- Each distinct token is read once. A query holds at most 8 words, and a form of a word counts as a word.
- The cap of 4,000 rows per token now keeps the newest rows of a term, and ties go to the newest. The cost: past the cap, a very common word reaches only the newest 4,000 rows that hold it. A prefix spans several terms in term order, so there the exact word comes first and the rest follow by spelling, not by time.
- Each token weighs `1 / (1 + log2(rows))`, and a token at the cap weighs the least. So a name beats the plain words beside it.
- The stored hash holds a format tag. A change to `filed` or `tokens` bumps it, and a pass then rebuilds every row.
- A slice charges 0.1 ms per term it writes, up front. Before, the budget saw only tokenising, and a real slice took a median of 209 ms. Now the median is 27 ms and the p90 33 ms. The maximum is still about 105 ms, and a send can wait that long.
- A message stops at 2,000 tokens, which is about 12 KB of varied text. A 500 KB message then takes about 170 to 220 ms.
- A chat delete is one collection delete by `conversationId`.
- The pass at app start runs only if no pass ever finished, one stopped half way, a reply was cut off, the last pass is over a week old, or it was of an older format.

### Third round: a key limit per search, and the clock after the read (still desktop with 6x throttle, not a phone)

**Result: no query over 500 ms, 0 of 24.** Min 42 ms, median 187 ms, p90 408 ms, max 432 ms. Slowest: `the and of to in is that it`. One run: 100k messages in 100 chats, queries in the longest chat, 20k messages.

| Query | Second round | Third round |
|---|---|---|
| `memory cache token model stream message search index` | 881 ms | 408 ms |
| `the and of to in is that it` | 571 ms | 432 ms |
| `kissa kissan kissoille kissoja kissat` | 526 ms | 425 ms |
| `talo talon talossa taloon talot taloja` | 237 ms | 232 ms |

| Measure | Third round |
|---|---|
| Seed | 57.8 s |
| Index (full backfill) | 824.5 s |
| Repair pass with nothing to do, at 100 ms slices | 54.4 s |
| Index size | 311.3 MB (messages: 78.4 MB) |
| One `index` write, median / max | 19 / 25 ms |
| Backfill slice while writing, at 30 ms budget, median / p90 / max | 31 / 37 / 118 ms |
| Clean pass at 30 ms | 985 messages, 14 slices, 70 per slice, median 40 ms, max 49 ms a slice |
| One 500 KB message | 184 ms |
| Longest page stall | 2,544 ms, cause not found |
| CSP violations | 0 |
| Hosts contacted | localhost only |
| Databases after the run | none |
| Page was hidden | no |

All 24 queries, in ms: the 128, and 117, ja 117, memory 202, project 118, window 106, kissa 207, koira 105, zebra 107, kissoille 265, talossa 135, kirjastossa 42, järvellä 105, ystävälle 91, metsästä 109, kirja 187, "kissa koira" 237, "memory project" 238, "talo järvi" 253, "kirja window" 256, then the four multi-form queries in the table above.

**The key limit.** A search reads at most 24,000 keys, shared between its tokens, and never over 4,000 for one token. The time of a search is almost all key reads, at about 16 microseconds per key under this throttle. The cost: in a query with many tokens, a capped word reaches only its newest 2,000 to 3,000 rows. The re-review measured what that does to the top 25 at this limit: `memory cache ...` kept 17 of 25, `kissa kissan ...` 14 of 25, and `the and of ...` and `talo talon ...` 25 of 25. Queries of one or two words read under 24,000 keys, so they do not change.

**The clock after the read.** A slice is now the batch read plus at most the budget. Before, a read that used up the 30 ms left the slice one message, so a clean pass read the same 25 messages again and again. With a controlled clock, a 31 ms read took 60 slices for 60 messages, and now takes 3 or fewer. The clean pass line above is on the bench so that the phone run shows this.

**Two more rules.** A stored place holds its format, and a place of another format is ignored. A message with no usable `createdAt` gets `n` from time 0, so a hand-edited backup can't stop a pass.

**Known and left as it is.** In a very long chat, reads of `messages` can queue behind a chat delete: `index` holds `messages` while it waits for `removeChat`, 5.5 s for a 20k chat here, about 0.5 s at 2,000 messages. So a reply sent right after such a delete can start late.
