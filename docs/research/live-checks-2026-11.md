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
7. **Dropping reasoning after a finished tool turn is safe on all four.** The cost is a tail miss of roughly 80 to 170 tokens on Anthropic and OpenAI, and not distinguishable from keeping reasoning on Gemini and DeepSeek at their coarse cache step size (no error on any).
8. **Treat HTTP 200 with `finish_reason: content_filter` and no content as a failure.** (Not a `ModelRule`; it belongs in the send loop.)
