# Prompt caching, tools, retrieval and mixed-model tool loops on OpenRouter

Researched 2026-11-01. Builds on `docs/research/openrouter-api-2026-10.md` and does not repeat it.
"(probed)" means I checked it myself on 2026-11-01 with a free, unauthenticated request. I made no paid or keyed calls, so nothing here was tested with a real model run. Each section's Gaps list says what ORFE must test live.

## How does each provider family cache when tools are present?

### Takeaway
Treat the `tools` array as frozen, byte-identical content at the very top of the prefix for every provider. Anthropic, OpenAI, Qwen and Kimi document this directly. Gemini, DeepSeek, xAI and GLM do not say, but no doc gives a reason to expect otherwise. Serialise the tool list once, per chat, and never reorder or edit it mid-chat. On Anthropic, `tool_choice` changes also drop the message-level cache, so keep `tool_choice` constant too.

### Cited Findings

Per-family rules:

| Family | Tools in cached prefix? | What invalidates | Other rules that matter |
|---|---|---|---|
| Anthropic | Yes, first. Order is `tools`, `system`, `messages` | Any change to tool names, descriptions or parameters invalidates tools, system and messages. `tool_choice` change invalidates messages only. Adding or removing images anywhere invalidates messages. Web search or citations toggle invalidates system and messages. Thinking config change invalidates messages | Optional breakpoint on the last tool definition caches all tools |
| OpenAI | Yes. Tool definitions are part of the rendered context | Changes to "tool names, descriptions, schemas, ordering, or tool-specific instructions". `text.format` schema is also in the prefix | Keep `tools` stable and use `allowed_tools` or `tool_choice`. Docs say to set `tool_choice` to `none` instead of removing tools. They do not say if `tool_choice` itself is in the prefix |
| Gemini | Not stated | Prefix based. Google only says to put large common content first | Gemini 4 and newer: the full previous request is cached only if the new request adds at least 2,050 tokens. Smaller additions reprocess the last 2,050 tokens at the normal input price |
| DeepSeek | Not stated | Strict prefix-unit match. Units are saved at the end of each user input and model output, at common prefixes, and at fixed intervals | Best effort. Cache clears in "a few hours to a few days" |
| xAI | Definitions not stated. "The cacheable prefix includes all messages up to and including tool call results" | "Any edit, removal, or reorder breaks the cache" | Recommends `x-grok-conv-id` on every request |
| GLM (Z.AI) | Not stated | Docs do not even say it is prefix based: "identical or highly similar" content, and minor formatting differences can reduce hits | OpenRouter sends a session affinity key. Cache writes free for a limited time, reads about 0.2x |
| Kimi | Yes, list tool definitions as fixed content at the front. Also: "Top-level global tool declarations do not affect cache hits" | "When any part of a prefix changes, the content after that position cannot be reused." | TTL 5m or 1h, locked at first write. Works in blocks, and a part smaller than a block is a miss. Tools added late go at the end of `messages` |
| Qwen (Alibaba) | Yes. "Tool definitions count as part of the system prompt" | Any tool change. Docs say to keep order, field order and structure identical, and not to add or remove optional fields | `cache_control` only on array-form message content, never on string content or on tools. Up to 4 markers. Min 1,024 tokens. TTL 5 min, renewed on hit. Explicit and implicit are mutually exclusive |

Sources for the table:
- Anthropic prefix order, invalidation table, thinking row — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- OpenAI tools in prefix, `allowed_tools`, `tool_choice: none` advice — [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- Gemini 2,050-token rule, minimums — [Gemini caching](https://ai.google.dev/gemini-api/docs/caching)
- DeepSeek prefix units — [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache)
- xAI prefix and `x-grok-conv-id` — [xAI caching best practices](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices)
- GLM behaviour — [Z.AI cache docs](https://docs.z.ai/guides/capabilities/cache); pricing and affinity key — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Kimi prefix and TTL — [Kimi context caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api); top-level tools sentence and late tools — [Kimi dynamic tool loading](https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading)
- Qwen rules — [Alibaba explicit cache guide](https://www.alibabacloud.com/help/en/model-studio/explicit-cache-guide)

OpenRouter layer:
- OpenRouter's caching page has no section on tool definitions. The only mention is a placeholder `<SHARED_INSTRUCTIONS_AND_TOOLS>` in an OpenAI example. The page gives no full invalidation list. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Qwen needs an explicit block marker on OpenRouter, so ORFE's top-level `cache_control` (sent to anthropic/ only) gives Qwen no cache today. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Stickiness is remembered per model. It only activates when the provider's cache read is cheaper than its prompt price, except that `session_id` starts it on any successful request. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Many hosts serve the same open-weight model. `deepseek/deepseek-v4.1-flash` lists about 39 endpoints, nearly all with `supports_implicit_caching: true`, and prices differ a lot between them. (probed) — [endpoints feed](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)

Doc conflicts:
- Gemini 2.5 minimums. OpenRouter says 1,024 (Flash) and 4,096 (Pro). Google says 2,048 for both, and 4,096 for Gemini 3.1 Pro Preview, 3.6 Flash, 3.8 Flash and 4 Argon. — [OpenRouter](https://openrouter.ai/docs/guides/best-practices/prompt-caching); contradicted by [Google](https://ai.google.dev/gemini-api/docs/caching)
- Gemini explicit caching. OpenRouter documents `cache_control` for Gemini. Google says explicit caching is not available for Gemini 4 Argon and later. — [OpenRouter](https://openrouter.ai/docs/guides/best-practices/prompt-caching); contradicted by [Google](https://ai.google.dev/gemini-api/docs/caching)
- Kimi "top-level tools do not affect cache hits" sits oddly beside "put tool definitions at the front". The same page says keeping them unchanged still helps. — [Kimi dynamic tool loading](https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading)

### Inferences
- Rules for ORFE, all inferred from the docs above:
  1. Build one tool list per app version. Store the exact JSON string. Send that same string every time. Never build it from an object whose key order can change.
  2. Do not vary tools by model, by turn or by note count. If a tool is unavailable on some turn, keep it in the list and refuse the call in the tool result, or use `tool_choice`.
  3. Do not put live data in tool descriptions (note counts, today's date, vault titles). That data is in the prefix and breaks every chat at once.
  4. Keep `tool_choice` at one value across a chat. A one-off `tool_choice: "none"` to end a loop costs one message-level miss on Anthropic. Forced values are not an option on Opus 5.5 or Sonnet 5.5 at all (next sections).
  5. For the open-weight families, the table describes the first-party API only. When OpenRouter routes to a third-party host, the host's cache rules apply, and these are mostly undocumented. `session_id` keeps the host stable, so it matters more for these models.
- Adding tools to ORFE will cause one cold request per chat for every chat, because the prefix top changes. Same when the tool list changes in an app update. That is fine, but it should be expected in the cost display.
- For Gemini 4 and newer, short chat turns will never fully cache. A "hi" turn reprocesses 2,050 tokens at full price. ORFE's cold-cache detection should not flag this as a miss.

### Gaps
- Gemini, DeepSeek, xAI and GLM do not document tools in the prefix. Nothing suggests they are excluded. Test by changing one tool description and watching `cached_tokens`.
- No doc says how OpenRouter serialises `tools` before sending upstream, or whether it reorders keys. It matters only if it is not deterministic.
- `x-grok-conv-id` is not in OpenRouter's CORS allow list (probed on `/api/alpha/decisions`, and it is also absent from the list in the October notes). I found no doc saying OpenRouter maps `session_id` to it for xAI.
- The stated OpenAI 1,024-token rule does not say what share of that a tool list provides. I did not find this.

## Where should retrieved content go relative to the cache breakpoint?

### Takeaway
The simplest safe answer is: retrieved text goes in the tool result and stays there. A tool result is append-only history, so it never breaks the cache on any provider. Below-the-breakpoint retrieval, where text appears for one turn and then vanishes, needs an explicit breakpoint on Anthropic and Qwen. With ORFE's top-level automatic `cache_control` it silently destroys the cache, because the automatic breakpoint lands on the last block, which is the retrieved text itself.

### Cited Findings

The rule behind everything:
- A hit needs an exact prefix match. "Changes at each level invalidate that level and all subsequent levels." — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Automatic mode "automatically applies the cache breakpoint to the last cacheable block and moves it forward as conversations grow." — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Lookback only finds "entries that earlier requests already wrote". — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

The pattern is documented as a principle, under no shared name:
- "Place it on the last block that stays identical across requests... If a later block varies with each request (a timestamp, the incoming message), keep the breakpoint before it, on the last stable block." — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Placing a breakpoint on a block that changes every request "writes a fresh entry each time and never hits." — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Anthropic reserves explicit breakpoints for large text such as RAG data. OpenRouter repeats this. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- OpenRouter: keep the start of the array the same and put variable content at the end. For Gemini, put dynamic content in a later `user` message, not after a cached block in the first system message. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Kimi: per-turn content "like user questions and tool results should go last". — [Kimi context caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api)

Anthropic's turn-scoped option:
- A mid-conversation `role: "system"` message with `clear_at: "next_user_message"` renders only while no later user message exists. After that it "stays in the array but renders nothing and costs no input tokens". It needs the beta header `mid-conversation-system-clear-at-2026-08-21`. It is text only, and `cache_control` on it returns 400. A cleared message is never part of a cache key, so the breakpoint belongs on the preceding user turn. Resend cleared messages verbatim. — [Anthropic mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
- It must follow a user turn (a `tool_result` message counts) and must end the array or be followed by an assistant turn. Between `tool_use` and `tool_result` it returns 400. — [same page](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
- Not available on Sonnet 5. On Sonnet 5.5 and Haiku 5.5 the docs recommend a `text` block after the last `tool_result` in the same user message instead, because these models may treat a system message after a tool result as untrusted. — [same page](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
- OpenRouter's Claude 5.5 guide also recommends this pattern for per-turn reminders. — [OpenRouter Claude 5.5 migration](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)

Tool results:
- Tool use and tool result blocks are cacheable, and "Cache remains valid when only tool results are provided as user messages." — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Anthropic says to keep untrusted content inside `tool_result` blocks, not in `system` or plain user text. — [Anthropic handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- "Clearing or shortening an earlier `tool_result`" counts as an invalidating edit of the prefix. — [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- xAI: never modify earlier messages, only append. — [xAI caching best practices](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices)

Real failure:
- OpenCode with an OpenAI-compatible gateway put `cache_control` in the tool message's `content` array. The gateway ignored it, so nothing cached when the last message was a tool result, and every step re-billed the whole chat. This was a gateway, not OpenRouter. — [opencode #57199](https://github.com/anomalyco/opencode/issues/57199)

Multiple breakpoints:
- Up to 4. The automatic breakpoint uses one of the 4 slots. If 4 explicit ones exist, automatic returns 400. If the last block has an explicit marker with a different TTL, that is a 400. — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

### Inferences

Does injecting something before the newest message break the next turn? It depends on one thing only: whether the injected text is still there, in the same place, next turn.
- If it stays, it is an ordinary append. Nothing breaks. Position does not matter, as long as it lands after everything the last request cached.
- If it goes, the prefix diverges at that point. Everything after it is a miss.

Worked through for ORFE's current automatic mode with disappearing retrieval. Turn N sends `..., A(n-1), U(n), R(n)`. The automatic breakpoint lands on `R(n)`, so the cache entry ends with `R(n)`. Turn N+1 removes `R(n)`. The new prefix now has `A(n)` where the old one had `R(n)`, so that entry cannot match. The entry from turn N-1 ended with `R(n-1)`, also gone. So every entry written in the chat ends in text that no longer exists. The result: every turn pays a full 1.25x write for the whole chat, and reads nothing. This is worse than no caching. This is my reasoning from the documented rules, not a documented case, so it should be confirmed with one test.

Options compared (inferred from the findings above):

| Option | Cache safe? | Portable? | Cost and limits |
|---|---|---|---|
| Tool result, kept in history | Yes, everywhere | Yes. Non-tool models see it flattened | Text stays in context and is re-read each turn at the cache read rate. Never edit it in place. Drop it only at a window reset |
| Text in the last user message, kept for good | Yes, if stored and resent byte for byte | Yes | Same cost. ORFE must store what was sent, separate from what the user typed |
| Separate late message, removed next turn, on OpenAI / DeepSeek / xAI / Kimi / GLM | Yes, up to the message before it | Mostly | Billed at full price each turn. Use a separate message, not concatenated text, because DeepSeek saves prefix units at message ends |
| Same, on Anthropic / Qwen with an explicit breakpoint on the message before it | Yes | Needs per-family code | One marker per request, and the marker moves each turn |
| Same, with ORFE's top-level automatic `cache_control` and nothing else | No. Total loss | - | Do not ship this |
| Anthropic `clear_at` system message | Yes, by design | Anthropic only. OpenRouter passthrough on Chat Completions not confirmed | Sonnet 5.5 and Haiku 5.5 may distrust it after a tool result |

Recommendation for ORFE:
- Model-driven retrieval (the model calls `search_notes`): use the tool result and keep it. No breakpoint work at all. Top-level automatic `cache_control` just works.
- App-driven recall (ORFE fetches before the model sees the turn, like Mneme): this is the only case that needs "below the breakpoint". The simple form is to store the recall block as a kept part of the turn. Only build the disappearing form if kept recall costs too much.
- If the disappearing form is built on Anthropic: send an explicit breakpoint on the user message before the recall block, and keep the top-level one too. The top-level one still covers the tool rounds inside the turn. Two slots out of four.

Limits of below-the-breakpoint retrieval:
- The text is billed at full input price on every turn it appears.
- The model answers from text that is gone next turn. Its own reply may refer to something it can no longer see, and a follow-up question loses the source.
- During a tool loop the block must stay in place for the whole loop, because a loop is one turn. It only leaves at the next user message, and then every tool step after it is rewritten once.
- On models with the prefix check, removing text before a thinking block invalidates that block. OpenRouter does not enforce this (see the reasoning section), but the cache restarts there anyway.
- Automatic and explicit markers must agree on TTL. Mixed TTLs must run long to short.
- ORFE's rolling window: moving the window start changes the prefix too. Freeze the window start for a whole tool turn.

### Gaps
- Whether OpenRouter accepts `cache_control` on a `role: "tool"` message on Chat Completions is undocumented. OpenCode's failure above shows this can silently fail. Top-level automatic mode avoids the question, so prefer it inside tool loops. Test by reading `cache_write_tokens`.
- Whether `clear_at` and the beta header pass through OpenRouter on Chat Completions is not confirmed. The Claude 5.5 guide names the pattern, but gives no Chat Completions example.
- How OpenRouter renders a `tool` message followed by a `user` message for Anthropic is undocumented. It presumably becomes one user message with `tool_result` blocks first, then text.
- What a `role: "system"` message in mid-array does on non-Anthropic models through OpenRouter is undocumented. Do not rely on it.
- I found no case study measuring below-the-breakpoint retrieval. The Mneme context files have no note on it.

## How does the automatic breakpoint move across tool rounds, and what about TTL and minimums?

### Takeaway
With top-level `cache_control`, each tool round moves the breakpoint to the newest tool result. Each round reads everything before and writes only the new tail. This needs no code, as long as messages stay append-only. A 1 hour TTL is worth it for a phone chat, but OpenRouter's 10-minute stickiness can undo it unless the provider is held in place.

### Cited Findings
- On OpenRouter, top-level `cache_control` works on Anthropic, Vertex, Azure, Bedrock and Claude Platform on AWS. On Bedrock, OpenRouter converts it to a trailing breakpoint. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Each breakpoint checks at most 20 positions, counting itself. "On the Claude API, a run of consecutive `tool_use` blocks counts as one position, and so does a run of consecutive `tool_result` blocks." If a chat pushes the breakpoint 20 or more blocks past the last write, the lookback misses. — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Qwen also uses a 20-block backward search, per search results from Alibaba's own docs. The fetched guide page did not mention it. — [Alibaba context cache](https://www.alibabacloud.com/help/en/model-studio/user-guide/context-cache)
- Preserved thinking blocks allow cache hits during tool use, "cached incrementally across the assistant turn". — [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- "A tool-use loop is one assistant turn, so change the configuration only between turns." — [Anthropic thinking tool workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows)
- Changing top-level effort "restarts the prompt cache". OpenRouter says effort changes sent as a system message do not. — [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking); [OpenRouter Claude 5.5 migration](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)

TTL:
- Top-level `"ttl": "1h"` is supported on Anthropic, Bedrock and Vertex through OpenRouter. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- 1h writes cost 2x, 5m writes cost 1.25x. Anthropic recommends 1h for prompts used "less frequently than every 5 minutes, but more frequently than every hour". — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Longer TTLs must come before shorter ones in the same request. — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Sticky sessions expire after 10 minutes of inactivity. If the sticky provider errors, the next request may be rerouted. Sticky routing is disabled when `provider.order` is set. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Live prices per million tokens (probed 2026-11-01): Opus 5.5 $4 input, $5 write, $0.20 read. Sonnet 5.5 $2 input, $2.50 write, $0.10 read. Haiku 5.5 $0.10 input, $0.125 write, $0.01 read. So Opus 5.5 and Sonnet 5.5 reads are 0.05x, not the 0.1x general rule. — [models feed](https://openrouter.ai/api/v1/models)

Minimums:
- 512 tokens: Fable 5.1, Opus 5.5, Opus 5, Sonnet 5.5, Fable 5, Haiku 5.5. 1,024: Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, Opus 4.1, Opus 4, Sonnet 4. 2,048: Opus 4.7, Haiku 3.5. 4,096: Opus 4.6, Opus 4.5, Haiku 4.5. — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Below the minimum, the request runs without caching and no error is returned. — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Haiku 5.5's tokenizer gives about 30% more tokens for the same text, so re-measure. — [OpenRouter Claude 5.5 migration](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)

### Inferences
- A loop round is at most about 3 or 4 positions (thinking, text, tool calls, tool results). Each round writes, so the 20-position window will not be a problem in a normal loop. It can be a problem after a skipped write: an aborted request, or a stream that failed. A long loop after an abort could fall out of the window.
- On Bedrock and Vertex the "consecutive runs count as one" rule is stated for the Claude API only. Do not assume it elsewhere.
- Cost of a loop: the first round writes the new turn. Each later round reads the prefix and writes one tool step. So big tool results are paid once at 1.25x, then at the read rate.
- 1h versus 5m, in rough numbers. Extra cost of 1h: 0.75x on each newly written token. Cost of one 5m expiry: rewrite the whole prefix at 1.25x, against 0.1x to read it, so about 1.15x of the prefix. With a 50k prefix and 1k of new tokens per turn, one pause longer than 5 minutes pays for about 75 turns of the 1h premium. A phone chat pauses all the time, so 1h should win once a chat has any size. In very short chats it does not.
- The trap: a 1h entry lives at one provider, but stickiness ends after 10 idle minutes. After a 30-minute pause OpenRouter may send the request to Vertex or Bedrock, where the entry does not exist. That is a miss plus a 2x write. To get the benefit of 1h, pin with `provider.order` for Claude. This turns sticky routing off, but the pin does the same job. This also loses failover unless the order lists fallbacks.
- `session_id` does not obviously extend past 10 minutes. The docs give no separate lifetime for it. See Gaps.
- Keep the reasoning effort fixed through a tool loop. If the user changes effort, apply it at the next user message, via `configuration_update`.

### Gaps
- Whether `session_id` stickiness has the same 10-minute expiry is not stated separately. The doc's sentence is general, so assume yes until tested.
- Whether 1h entries work across Anthropic and "Claude Platform on AWS", which share an account group for thinking, is undocumented.

## What does a mixed-model tool history need?

### Takeaway
Render the history per request as a pure function of (stored history, current model). Tool steps made by the current model go out as real `tool_calls` and `tool` messages, with native IDs. Steps from any other model go out as remapped or flattened. Always send `tools` when structured tool messages are present. Models without tool support get everything flattened and no `tools` field. Every tool call must have a result, even after Stop.

### Cited Findings

`tools` presence:
- "The `tools` parameter must be included in every request (Steps 1 and 3)". — [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- LiteLLM refuses Bedrock requests that carry tool history without `tools`. Its workaround adds a dummy tool. The usual trigger is a summary, compaction or plain "continue" turn that replays history but leaves `tools` out. — [litellm #40735](https://github.com/BerriAI/litellm/issues/40735), [litellm #24158](https://github.com/BerriAI/litellm/issues/24158)
- Docs for Kimi show `tools` on each request in the loop, without stating a rule. — [Kimi tool calls](https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls)

Models without tool support:
- Filter with `supported_parameters=tools`. — [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- The default model list has 452 entries, and 66 of them do not list `tools`. The `supported_parameters=tools` query returns 362. These two counts do not add up, so read the per-model field and do not rely on the count. (probed 2026-11-01) — [models feed](https://openrouter.ai/api/v1/models?supported_parameters=tools)
- Sending `tools` to a model with no tool-capable endpoint gives "No endpoints found that support tool use". One report shows this for a model whose page lists tools, so it depends on the endpoints. — [opencode #1002](https://github.com/anomalyco/opencode/issues/1002), [claude-code-router #409](https://github.com/musistudio/claude-code-router/issues/409)
- `tool_choice` in `supported_parameters` only means the parameter is accepted, not that every value works. — [OpenRouter SDK docs](https://openrouter.ai/docs/client-sdks/go/models/components/toolchoicesupport.md)

Tool call IDs:
- Gemini through Vertex, and gateways that embed a signature in the ID, can produce IDs over 1,000 characters. OpenAI-compatible providers limit IDs (reported as 40 for OpenAI, 64 for others). Replaying such an ID gave a 400 `string_above_max_length` on every later request and bricked the session. — [opencode #54146](https://github.com/anomalyco/opencode/issues/54146)
- Anthropic-style tool IDs: pattern `^[a-zA-Z0-9_-]+$`, length 1 to 64, per Bedrock's reference. — [AWS ToolUseBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlockStart.html)
- Kimi's doc example ID is `search:0`, with a colon. It would fail the pattern above. — [Kimi tool calls](https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls)
- Mistral error: "Tool call id was i-nKGDr5g but must be a-z, A-Z, 0-9, with a length of 9." Found through a third-party report, with no official Mistral page. — [Vercel AI issue #11802](https://github.com/vercel/ai/issues/11802)
- Truncating IDs to 9 characters caused collisions: GLM IDs like `chatcmpl-tool-...` all became `chatcmplt`, and Mistral then returned 400 "Duplicate tool call id in assistant message". — [opencode #58323](https://github.com/anomalyco/opencode/issues/58323)
- Kimi: an ID that cannot be matched to `tool_calls` gives an error. — [Kimi tool calls](https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls)

Ordering and pairing:
- "Tool result blocks must immediately follow their corresponding tool use blocks". `tool_result` blocks come first in the user content, text after. Violations give "tool_use ids were found without tool_result blocks immediately after". — [Anthropic handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- Return one `tool_result` for each `tool_use`, all in the next user message. If a call is skipped, still return a result with `is_error: true`. — [Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)
- Gemini parallel calls: the order FC1, FC2, FR1, FR2 is required. Interleaving gives 400. — [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- Mistral rejects a `user` message directly after a `tool` message. Zed's fix inserts an empty assistant message. Third-party evidence, no official page found. — [Zed commit](https://git.secluded.site/zed/commit/b8c1b54f9eaf78d3bcf073f6495cfaeb8b3bf2b4)
- Anthropic accepts a user text after tool results, in the same user message. But if the assistant turn also called a server tool with no result yet, text after results ends the turn early and can return 400. — [Anthropic handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- Gemini through OpenRouter returned 400 "Requests ending with a model turn are not supported" after a tool result carrying images. — [opencode #55694](https://github.com/anomalyco/opencode/issues/55694)

Assistant `content` on tool-call messages:
- OpenRouter's docs show `content: null` when an assistant message has only tool calls. — [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- Some backends reject null. — [opencode #51661](https://github.com/anomalyco/opencode/issues/51661), [opencode #55936](https://github.com/anomalyco/opencode/issues/55936)

Flattening:
- OpenRouter's compaction recipe renders old messages as plain text, because ScaleDown Summarize returns 400 on tool calls and results. It moves the cut so "the kept turns never start with an orphaned tool result". — [OpenRouter compaction cookbook](https://openrouter.ai/docs/cookbook/building-agents/compact-agent-sessions-with-scaledown)
- OpenCode drops provider metadata on a model switch, and has a bug class where it did not. — [opencode #35827](https://github.com/anomalyco/opencode/issues/35827)

### Inferences

The render rules ORFE needs:
1. Store each tool step with: native ID, tool name, arguments string, result text, model slug, provider, and raw `reasoning_details`.
2. Same model as the current request: send native IDs and real tool messages.
3. Different model, tool-capable: two choices. Flatten, or keep structure with new IDs. Flatten is simpler and also avoids every ID, signature and `reasoning_content` trap. I recommend flatten. If structure is kept, use deterministic 9-character alphanumeric IDs, unique per message. Nine alphanumeric characters satisfy every rule found above (Mistral 9, Anthropic pattern, OpenAI length). Do not truncate. Derive them from a hash or counter, so collisions are impossible and the output is stable.
4. Model without tools: flatten all steps, and send no `tools` and no `tool_choice`.
5. Rendering must be deterministic. A model switch is cold anyway, so a different rendering per model costs nothing. But if the user switches back within the TTL, an identical rendering gets the old cache back.

Safe flattening, by my reasoning:
- Merge one whole loop (assistant text, tool calls, results, final answer) into one assistant message, so no two assistant messages sit side by side and no `tool` role remains.
- Never leave half a pair. Cut only at turn boundaries.
- Use a plain past-tense note, such as `(Looked in notes for "river": found 2 notes.)`. Avoid JSON or anything that looks like a tool call. A model reading tool-shaped text may imitate it as text instead of making a real call. This is a known worry, but I found no source measuring it, so test it.
- Keep result text short in the flattened form. Consider a title and a line, not the full note. If the model needs it again, it can call the tool.

Stop and abort:
- If the user presses Stop after tool calls arrive, or tools fail, write a `tool` message for every call ID ("Cancelled by the user.") before any later user message. Otherwise the next request fails on Anthropic and Kimi.

User message right after a tool:
- Normal flow ends with an assistant answer, so this only happens after Stop or a cap. To cover Mistral, add a short assistant message ("Stopped.") after the last tool result in that case. This is valid everywhere, and it also keeps Anthropic safe.

Turns that should not call tools: if the model supports tools but this turn should not use them, keep `tools` in the request and set `tool_choice: "none"`. Do not drop `tools`, because the history still holds tool messages. A summary request is the exception: flatten its input and send no `tools`.

### Gaps
- What OpenRouter does when `role: "tool"` messages reach a model with no tool support, with or without `tools`, is undocumented. Flatten avoids it.
- Whether OpenRouter rewrites IDs between providers is undocumented. I found no report either way for Kimi IDs reaching Anthropic. Test `search:0`-style IDs.
- Empty assistant `content` on tool messages through OpenRouter: both null and "" may behave differently per upstream. Follow OpenRouter's doc (`null`) and test the families ORFE uses.
- Mistral's ID and ordering rules come from client reports, not Mistral's docs. They may have relaxed. #58323 confirms 9 random characters is still Mistral's own format.

## How must `reasoning_details` be handled?

### Takeaway
Inside a tool loop, echo the assistant message whole: `content`, `tool_calls`, and `reasoning_details` unchanged. After the turn ends, the rule differs by family. DeepSeek needs it on all later requests when `tools` are present. Anthropic allows dropping. Gemini is safest dropped. On a model switch, strip it, and the provider's own rules then make the history valid, except DeepSeek, which needs a value on every assistant message.

### Cited Findings

OpenRouter's rules:
- "Preserving reasoning blocks is useful specifically for tool calling." — [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- "The entire sequence of consecutive reasoning blocks must match the outputs generated by the model during the original request", and you "cannot rearrange or modify the sequence". — [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- Pass back `message.reasoning` (plain string) or `message.reasoning_details` (full array). Use `reasoning_details` for encrypted or summarized types. `reasoning_content` is an alias of `reasoning`. — [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- `format` values include `anthropic-claude-v1`, `openai-responses-v1`, `google-gemini-v1`, `unknown`. — [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- The docs say you can switch OpenAI and Anthropic reasoning models "without changing your code structure". They do not say one family's blocks are accepted by another. — [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

Claude 5.5 through OpenRouter:
- "Thinking blocks are bound to the transcript prefix that produced them." Editing the prefix and replaying a block can return 400 on enforced upstream accounts, but "Requests through OpenRouter are not subject to this enforcement." — [OpenRouter Claude 5.5 migration](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)
- Sonnet 5.5 blocks are readable only by the producing account or a linked one. Anthropic, Claude Platform on AWS and Azure share a group. OpenRouter does not send these replays to Bedrock or Vertex. — [same](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)
- Haiku 5.5 blocks are readable only by the producing provider account, so OpenRouter keeps the replay on that provider and does not fall back. — [same](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)
- If `provider.only` or `provider.ignore` leaves no eligible provider, OpenRouter returns 400. The fix is to allow a provider, or start a new conversation without the blocks. — [same](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)
- Opus 5.5 and Sonnet 5.5 reject forced tool choice (`any`, a named tool, `required`). `auto` and `none` work. Haiku 5.5 accepts forced use but skips thinking. — [same](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)
- Sonnet 5.5 returns longer notes between tool calls as thinking blocks, so that text arrives as reasoning. — [same](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)
- Prefill is rejected on Opus 5.5, Sonnet 5.5 and Haiku 5.5, so a request must not end with an assistant message. — [same](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)
- The two 5.5 pages name neither `reasoning_details` nor `signature`. The mapping to `thinking` blocks is my reading. — [same](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5)

Anthropic's own rules:
- "Required: within a tool-use turn, pass thinking blocks back. Recommended: across turns, pass everything back. Allowed: outside tool use, omit prior turns' thinking." — [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- Modified blocks return 400. Rebuilding the message or filtering `redacted_thinking` returns 400. — [Anthropic thinking tool workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows)
- Soft side of the same rule: removing thinking blocks "from the start, end, or all of them" is "Valid (the model loses that reasoning)". Removing from the middle while keeping later ones is invalid. — [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- A block from a model that cannot read it is dropped "without an error", is not billed, and stays in your array. — [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- "The reasoning is permanently lost only if your client removes the blocks itself, for example a harness that strips thinking on a model switch". — [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- "A serializer that skips empty blocks removes thinking": on these models the `thinking` field is empty by default and `signature` carries the reasoning. — [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- Most edits that invalidate thinking also restart the cache. — [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- Keep-all models keep prior thinking in context and bill it as input. Last-turn-only models strip it at the next non-tool-result user message. Pass all, and the API filters. — [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)

DeepSeek:
- With `tools`, previous `reasoning_content` "must be fully passed back to the API in all subsequent requests", even for turns with no tool call. Otherwise, "the API will return a 400 error". Without `tools`, it is ignored. — [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)
- A user reports that OpenRouter's `reasoning` and `reasoning_details` fields did not satisfy DeepSeek V4 and that the message needs `reasoning_content`, using `msg.reasoning ?? ""`. This is open, and it conflicts with OpenRouter's "alias" statement. — [ai-sdk-provider #501](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/501)

Gemini:
- Only the current turn is validated. A turn starts at the latest user message with normal text. Each step's first `functionCall` must carry its signature, otherwise a 400 says it "is missing a `thought_signature`". — [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- Dummy values exist for injected or transferred calls. — [same](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- Through OpenRouter, one user reports `skip_thought_signature_validator` did not work, and the signature was not visible on the tool call. Another user pointed to `reasoning_details`. The thread did not confirm the fix. — [Google forum](https://discuss.ai.google.dev/t/gemini-3-thought-signature-is-not-valid-cant-do-multi-turn-tool-calling/119360)
- Zed found that placing the signature on the tool call through OpenRouter's format still gave 400. — [Zed notes](https://git.secluded.site/zed/blob/v0.214.7/crates/language_models/THOUGHT_SIGNATURES.md?raw=1)
- Replaying old `reasoning.encrypted` for Gemini caused 400 on later turns. — [ai-sdk-provider #491](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/491)

Streaming assembly bugs (directly relevant, since ORFE assembles its own stream):
- Two signed `reasoning.text` blocks in one answer arrive with `index: 0` and `index: 1`, each with a signature-only delta and no `id`. Merging them gives 400 "Invalid signature in thinking block". Two separate details were accepted, and the merged one was refused. — [ai-sdk-provider #582](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/582)
- Signature lost in streaming gave the same 400. — [ai-sdk-provider #423](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/423)
- Unmerged `reasoning.summary` deltas fragment the array and break round trips. — [ai-sdk-provider #519](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/519)
- Assigning `signature: undefined` broke later validation. — [ai-sdk-provider #540](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/540)

### Inferences

Rule table for ORFE (inferred from the above):

| Situation | Anthropic | DeepSeek | Gemini | Others (OpenAI, GLM, Kimi, xAI, Qwen) |
|---|---|---|---|---|
| Tool loop, same model | Send, unchanged | Send, unchanged | Send, unchanged | Send, unchanged |
| Later turn, same model, no tool steps | May drop | With `tools`: must send | Drop | No hard rule found. Sending is the doc's default |
| Later turn, same model, tool steps | May drop whole turns from the start or end. Dropping costs that turn's cache and its reasoning | With `tools`: must send | Drop. Only the current turn is validated, and stale encrypted blobs caused 400 | Same as above |
| After a model switch | Strip | Other models' messages have nothing to send, so send `reasoning_content: ""` if testing requires it | Strip | Strip |

Why stripping on a switch is the right call, even though Anthropic warns against it: the warning is about losing Claude's own reasoning between Claude models. It is true but cheap. ORFE's history can mix families, and a foreign `reasoning.encrypted` blob has no documented behaviour. A middle way: strip at send time only, keep the raw data stored, and resend it if the chat returns to the same model slug. This matches "the API never edits your messages array". The rendering stays a pure function of history and model.

Simple ORFE policy:
- Store raw `reasoning_details` per assistant round, with model slug.
- Send them for messages made by the current model slug, back to the last switch.
- Exception for Gemini: only the current turn.
- Do not "fix" or filter blocks. Never skip empty-looking ones.
- This changes today's "never sent back". Sending them from turn one is better than sending only in loops, because a stable policy gives a stable prefix. Dropping a finished turn's thinking at the next user message rewrites that turn's tail once per turn, and on keep-all models also loses the reasoning.

Stream assembler rules for `send.ts`:
- Accumulate `reasoning_details` by `index`, not by type. Never merge across indexes.
- Keep signature-only deltas, and do not write `signature: undefined`.
- Keep `reasoning.summary` and `reasoning.encrypted` entries.
- Save the array exactly as assembled. Do not rebuild it from the display string.

Provider routing:
- If ORFE adds `provider.only` or `provider.ignore` for any reason, a replay on Sonnet 5.5 or Haiku 5.5 can fail with 400. The way out is to resend without the blocks. A retry path that strips reasoning on this one 400 is worth having.
- Do not offer a provider picker that changes mid-chat without stripping.

`reasoning.exclude: true` hides the text but should keep signatures. Do not assume. If ORFE ever sets it, check that `reasoning_details` still arrive.

### Gaps
- Whether a missing thinking block inside a tool loop gives 400 or a silent quality loss through OpenRouter on Claude 5.x. The Thinking page says required. The preserved-thinking table says removal is valid. Both can be true.
- How OpenRouter handles foreign-format `reasoning_details` is undocumented: forwards, drops, or errors. The `model_binding_mismatch` note suggests Anthropic drops other Claude models' blocks. I found nothing for cross-family.
- DeepSeek through OpenRouter: which field satisfies it (`reasoning`, `reasoning_details`, or `reasoning_content`), and whether a plain assistant message with no reasoning gives 400 when `tools` are present. Mixed history depends on this. Test on the DeepSeek provider specifically. Third-party hosts of DeepSeek weights may not enforce it at all.
- Whether OpenAI, Kimi, GLM, xAI or Qwen give an error for a missing reasoning field. Kimi's fetched page does not cover `reasoning_content`.
- OpenRouter's Gemini signature transport: the `reasoning.encrypted` path is implied by #491 but not stated in OpenRouter's docs.

## Which OpenRouter features help, and which to avoid?

### Takeaway
Use: `supported_parameters=tools`, parallel tool calls (handled, not relied on), top-level `cache_control`, `session_id`. Avoid for the main chat: tool search and deferred tools, server tools for notes, response caching, and context compression. They either conflict with mixed-model replay or duplicate what ORFE already does.

### Cited Findings

Use:
- `supported_parameters` filter. — [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- `parallel_tool_calls` defaults to true for most models. `false` limits to one call at a time. — [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- The "Tool Call Error Rate" on each model drives Auto Exacto provider ordering for tool-calling requests. — [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)

Tool search and deferred tools:
- `openrouter:tool_search` returns 400 on Chat Completions. The `deferred_tools` protocol is the Chat Completions route. — [OpenRouter tool search](https://openrouter.ai/docs/guides/features/server-tools/tool-search)
- Requires unaltered assistant messages including encrypted reasoning, and a fixed tool catalog across turns. — [OpenRouter tool search](https://openrouter.ai/docs/guides/features/server-tools/tool-search)
- Client-side deferral rolls out per account. Until admitted, deferred tools are sent in full. — [OpenRouter tool search](https://openrouter.ai/docs/guides/features/server-tools/tool-search)
- Compression is off for deferred requests. Forcing or forbidding calls returns 400. — [OpenRouter tool search](https://openrouter.ai/docs/guides/features/server-tools/tool-search)
- Suggested only above about 10 tools or 10k tokens of definitions. — [OpenRouter tool search](https://openrouter.ai/docs/guides/features/server-tools/tool-search)
- Continuation state lives in a `reasoning_details` entry on Chat Completions, and editing earlier history breaks the chain. Seen in search summaries of OpenRouter's docs. I did not read the protocol page directly. — [OpenRouter chat API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)

Server tools:
- Beta. Run by OpenRouter, up to `max_tool_calls` of 30. — [OpenRouter server tools](https://openrouter.ai/docs/guides/features/server-tools)
- The page shows `input`-style examples and does not explain Chat Completions behaviour, how steps return, or their place in history. — [OpenRouter server tools](https://openrouter.ai/docs/guides/features/server-tools)
- Anthropic docs: on client plus server tool mixes, tool results and text have tighter rules. — [Anthropic handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)

Response caching:
- Off by default. `X-OpenRouter-Cache: true` per request, or a preset. Exact request hash per key. Hits are free. Responses with tool calls are cached like any other. Ignores `temperature`. TTL 300 s by default. — [OpenRouter response caching](https://openrouter.ai/docs/guides/features/response-caching)
- `X-OpenRouter-Cache` is not in the CORS allow list. (probed on `/api/alpha/decisions`, 2026-11-01. The October notes' list for chat also lacks it.) — [OpenRouter response caching](https://openrouter.ai/docs/guides/features/response-caching)

Context compression:
- "Removing or truncating messages from the middle of the prompt". For message-count limits it keeps half from the start and half from the end. Default on for endpoints of 8,192 tokens or less. Disable with `plugins: [{"id": "context-compression", "enabled": false}]`. The page does not mention tool messages. — [OpenRouter message transforms](https://openrouter.ai/docs/guides/features/message-transforms)

### Inferences
- Parallel calls: leave the default, and write the code to handle any number of calls per message. Keep results in call order, one `tool` message per call, with nothing between them. All notes tools are read-only or close to it, so running them in parallel is safe. A write tool should run one at a time. Keep the `parallel_tool_calls` value constant. Its cache effect is undocumented.
- Tool search: skip. ORFE has few tools, and the feature needs unaltered history, which ORFE breaks on purpose at each model switch.
- Server tools: skip for notes, since notes live on the phone and only ORFE can reach them. Web search as a server tool stays usable later, but it makes steps ORFE cannot replay across models. Test it before mixing.
- Response caching: skip in chat. Reroll would return the same answer. In a tool loop a cached response could repeat a stale call. It cannot be enabled from the browser by header, only by preset.
- Compression: send it disabled explicitly when the endpoint is 8k or smaller. Otherwise it may cut through a tool pair and it always breaks the prefix. ORFE's own rolling window already covers this, and it knows about pairs.
- Set `provider.require_parameters: true` on tool requests so a host that would ignore `tools` is skipped. This comes from a third-party guide, so verify on OpenRouter's routing page. See Gaps.

### Gaps
- Whether `provider.require_parameters` is needed for tools at all. OpenRouter appears to filter `tools` to capable endpoints already, given the 404. I did not read the provider routing page.
- Whether middle-out keeps tool pairs together is undocumented.
- Whether a preset with `cache_enabled` is usable from a browser client with ORFE's key was not checked.

## What are the best cheap small models for summaries and yes/no decisions?

### Takeaway
"Jev" is TypeSafe's Jev, `typesafe/jev-1.13` in Mai, now `typesafe/jev-1.14`, at $0.042 per million input tokens and $0 output. For yes/no, use a decision model through the Decisions API, and the endpoint is open to browsers. For summaries, the best first tries are `scaledown/summarize` (made for it, but needs plain text), `qwen/qwen3.7-flash`, `inception/mercury-2.5`, and Haiku 5.5 as the quality reference. No source ranks these on Finnish notes, so run one of Mikael's blind A/B pages.

### Cited Findings

Identity of Jev:
- Mai's status file records "live Jev 1.13" and a "Typed Decisions API". — `E:/Mai-h/IMPLEMENTATION_STATUS.md`
- `E:/Claude/Context/mai.md`: "Jev judges what deserves attention"; the log says at most 20 Jev calls cost about $0.0005, so about $0.000025 per call. — `E:/Claude/Context/mai.log.md`
- Jev is "TypeSafe's structured decision model", `typesafe/jev-1.14` is the latest, and `~typesafe/jev-latest` is the alias. (probed) — [models feed](https://openrouter.ai/api/v1/models?output_modalities=all)
- Endpoint `https://openrouter.ai/api/alpha/decisions`. The request has `model`, `state` and `questions`. Question types are Choice, Score, Noul (yes/no with a probability) and Box. Several questions fit in one request, and there is no reasoning trace. From search summaries of the tutorial. — [Jev tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial)
- The endpoint's preflight from `https://mhuuh.github.io` returns 204 with `Access-Control-Allow-Origin: *`, and allows `Authorization` and `Content-Type`. (probed)
- The path says alpha, so expect change.

Decision models, USD per million, from the feed on 2026-11-01 (all $0 output) (probed) — [models feed](https://openrouter.ai/api/v1/models?output_modalities=all):

| Model | Input | Context | Note |
|---|---|---|---|
| `perplexity/pplx-decider-flash-v1.2` | $0.01 | 262k | 4B, smaller sibling |
| `baseten/joey-1` | $0.01 | 16k | 2B, Qwen3.5-2B base |
| `respan/span-02` | $0.01 | 131k | Open weights |
| `perplexity/pplx-decider-v1.2` | $0.02 | 262k | 27B |
| `liquid/d1.1` | $0.02 | 65k | Successor to d1 |
| `inception/mercury-decide` | $0.02 | 65k | A `:free` tier page also exists |
| `typesafe/jev-1.14` | $0.042 | 262k | Mikael's known one (Jev 1.13 same price) |
| `upstage/solar-decide-flash` | $0.05 | 524k | Text only |
| `openai/gpt-6-luna-decisions` | $0.10 | 1.05M | Full model behind it |

Text models for summaries, USD per million, from the feed on 2026-11-01 (probed) — [models feed](https://openrouter.ai/api/v1/models):

| Model | In | Out | Cache read | Context | Tools | Note |
|---|---|---|---|---|---|---|
| `scaledown/summarize` | $0.04 | $0 | - | 1M | No | Dedicated. Rejects tool messages. Uses `/responses` |
| `inclusionai/ling-3.0-flash` | $0.021 | $0.063 | $0.0042 | 262k | Yes | No structured output |
| `mistralai/mistral-nemo` | $0.029 | $0.03 | - | 131k | Yes | Older, very cheap output |
| `z-ai/glm-5.3-flash` | $0.0285 | $0.0923 | $0.0285 | 1M | Yes | Mai's model. Reasoning mandatory, so output tokens run higher |
| `qwen/qwen3.7-flash` | $0.03 | $0.13 | $0.006 | 1M | Yes | Reasoning optional |
| `inception/mercury-2.5` | $0.04 | $0.15 | $0.004 | 260k | Yes | Reasoning optional |
| `deepseek/deepseek-v4.1-flash` | $0.045 | $0.50 | $0.006 | 1M | Yes | Price varies a lot by endpoint |
| `openai/gpt-5-nano` | $0.05 | $0.40 | $0.005 | 400k | Yes | Reasoning mandatory |
| `anthropic/claude-haiku-5.5` | $0.10 | $0.50 | $0.01 | 1M | Yes | Quality reference. Tokenizer about 30% heavier. No prefill, no sampling params |
| `openai/gpt-6-luna` | $0.10 | $0.50 | $0.01 | 1.05M | Yes | |

- ScaleDown example run: 82k characters, six calls, $0.00087. Chunks about 16k characters, because one long call loses facts. — [OpenRouter compaction cookbook](https://openrouter.ai/docs/cookbook/building-agents/compact-agent-sessions-with-scaledown)

### Inferences
- Use decision models for: "Does this turn need memory?", "Is this note worth saving?", "Did the topic change?". These are yes/no with probabilities, and one call is a tiny fraction of a cent. Several questions in one request saves calls.
- Decision models are not chat models. They have a different endpoint, return no text, and take no tools. They cannot share the chat loop. They also have no reason to share a cache.
- Jev is a safe default: it worked on Finnish in Mai (FI 10/12 equal to EN). The cheaper ones are untested on Finnish, and a $0.01 versus $0.042 difference is meaningless at ORFE's volumes. Stay on `~typesafe/jev-latest` or pin `typesafe/jev-1.14`. Pinning is safer for evals.
- For summaries, Finnish quality and fact-keeping matter more than price. All of these are well under a cent per summary. A blind comparison of 3 or 4 of them is cheap and fits how Mikael likes to choose.
- A model with mandatory reasoning (GLM 5.3 Flash, GPT-5 Nano) costs more than its price line suggests, and is slower for one-shot tasks.
- `scaledown/summarize` goes through `/responses`, so its CORS behaviour needs a check before relying on it.

### Gaps
- No independent benchmark found for summary quality in Finnish or for these decision models.
- Feed prices are model-level. Endpoint prices vary, and the cheapest endpoint may be a host with weaker privacy or caching.
- Latency was not measured. Mai's log has Jev timing that could seed this.
- Details of the `state` and answer format for the Decisions API come from search summaries, and from Mai's working code, which is the better reference. `E:/Mai-h/src/mai/` has a real client.
