# Compaction, older-message search and tool result retention for ORFE

Researched 2026-11-01. Sources from before 2025 are marked "(older)". Vendor numbers are marked as self-reported where they are.

Evidence quality in one view:
- Strong: what production systems do (official docs).
- Medium: Factory's compaction evaluation (large, but vendor-run, coding only). FABLES on fiction summaries (peer-reviewed, 2024, old models).
- Weak: anything about voice in fiction. I found only practitioner reports. No controlled study exists that I could find.

ORFE facts used below come from `E:/ORFE/src/lib/context.ts` and `E:/ORFE/docs/research/openrouter-api-2026-10.md`:
- The window start only moves forward. Default limit is 32,000 tokens, trim target 0.7, soft limit 0.85.
- Pinned messages always stay in the window.
- `isCold` already detects a dead cache.

## How do production agents compact today?

### Takeaway
Nearly every system uses the same three-step order: clear old tool results by rule (no LLM), summarise the older middle, keep the recent tail word for word. Several also archive the originals and give the model a search tool. Provider compaction features are not usable for ORFE, because they are tied to one provider and OpenRouter's own plugin only cuts messages.

### Cited Findings

**Anthropic API**
- Compaction replaces older turns with a summary Claude writes. It offers on-demand, threshold and your-own-summariser modes. Recent turns can stay word for word — [Anthropic compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)
- Threshold compaction defaults to 150,000 input tokens, with a minimum of 50,000 — [Anthropic threshold compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)
- The on-demand summary is readable text plus a signature, and it must be sent back exactly as it came — [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- The summary call uses the request's own model, system prompt and tools. It is billed like any request. Sending the block back later costs nothing extra — [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- Compacting again summarises the old summary plus everything after it, so it regenerates rather than merges — [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- Images, documents and fetched URLs inside the summarised range are gone afterwards. System messages in that range stop applying — [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- One default prompt asks for "the state, next steps, learnings etc." — it is written for tasks, not stories. Custom instructions replace it entirely — [Anthropic threshold compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)
- When no summary comes back, the response is still a 200 with empty content, the call is still billed, and you can continue and compact later — [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- Anthropic's docs call server-side compaction the main strategy and context editing the finer tool — [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)

**Claude Code**
- It summarises the conversation near the limit. Project CLAUDE.md, memory and plans are re-read from disk. Up to five recently modified files are re-read; a file over 5,000 tokens comes back as a path only — [Claude Code context window](https://code.claude.com/docs/en/context-window)
- The summary keeps requests and key code, but early detailed instructions may be lost. Users can steer with `/compact focus on...` — [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- It stops auto-compacting after a few attempts if context refills at once, rather than looping — [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- Third-party sources conflict on the trigger: ~95% of 200K, or window minus 13,000, or 75–80% — [Morph](https://www.morphllm.com/claude-code-auto-compact); [claudefa.st](https://claudefa.st/blog/guide/mechanics/context-buffer-management). Official docs say it varies by model and point to a page I did not read — [Claude Code context window](https://code.claude.com/docs/en/context-window)
- "Microcompact", which clears raw tool outputs before full compaction, is described only by third parties — [ClaudeLog](https://claudelog.com/faqs/what-is-micro-compact/)

**OpenAI**
- Two forms: server-side via `compact_threshold`, and a stateless `/responses/compact` endpoint. The result is encrypted and "opaque and not intended to be human-interpretable" — [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction.md)
- Items before the newest compaction item can be dropped when chaining by input array — [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction.md)
- Gateway docs say the output is the original user messages plus one encrypted item. OpenAI's own guide does not confirm this — [Bifrost](https://docs.getbifrost.ai/api-reference/compaction/compact-context.md)

**Manus**
- Compaction (reversible) comes first. Each tool call has a full form and a compact form; a file write keeps only its path. The oldest 50% of tool calls are compacted — [ZenML summary of a Manus webinar](https://www.zenml.io/llmops-database/context-engineering-for-production-ai-agents-at-scale) (secondary)
- Summarisation (irreversible) is used only when compaction stops saving. Summaries follow a schema. The full pre-summary context may be saved to a searchable log. Degradation starts around 128K–200K tokens, even with a 1M limit — [ZenML summary](https://www.zenml.io/llmops-database/context-engineering-for-production-ai-agents-at-scale) (secondary)

**Factory**
- Summarises only the newly dropped span and merges it into a persistent summary ("anchored iterative summarisation") — [Factory](https://factory.com/news/evaluating-compression)

**Hermes (open source, and Mikael's own stack)**
- Step 1: tool outputs over 200 characters outside the tail become a placeholder, with no LLM call. Step 2: protect the first 3 messages. Step 3: summarise the middle with an auxiliary model. Step 4: update the old summary rather than rewrite it — [Hermes docs](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Trigger is 0.50 of the window. Summary budget is content × 0.20, minimum 2,000 tokens, maximum min(window × 0.05, 12,000). Tail minimum is 20 messages — [Hermes docs](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Summary sections: Goal, Constraints & Preferences, Progress, Key Decisions, Relevant Files, Next Steps, Critical Context — [Hermes docs](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Archived messages stay reachable through a `session_search` tool — [Hermes docs, via search result](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching?full=true)

**LangChain Deep Agents**
- Tool results over about 20,000 tokens go to a file, leaving a path and a preview. Summarisation runs at 85% of the window. Summarised messages are saved to `/conversation_history/{session_id}.md`, which the agent can read — [LangChain, Oct 2026](https://www.langchain.com/blog/context-engineering-deep-agents-remember); [LangChain](https://www.langchain.com/blog/context-management-for-deepagents)

**OpenCode**
- V2 has `compaction` config with `auto`, `prune`, `keep.tokens`, `buffer`. In V2, `prune` does nothing: old tool outputs are not pruned in place — [OpenCode V2 docs, via search result](https://v2.opencode.ai/compaction.md)
- Community plugins fill that gap by removing repeated or stale tool outputs — [opencode-dynamic-context-pruning](https://github.com/Tarquinen/opencode-dynamic-context-pruning)

**Letta**
- A sleep-time agent edits in-context memory blocks apart from the main agent. Letta later moved towards bash and git-backed context — [Latent Space wiki](https://latent.space/wiki/letta-ai-558a42a5/) (secondary)

**Cline**
- Auto-Compact summarises only on listed models. Others fall back to rule-based truncation — [Cline docs](https://docs.cline.bot/features/auto-compact)

**OpenRouter**
- The `context-compression` plugin has one engine, `middle-out`. It trims or removes messages from the middle. It does not summarise — [OpenRouter SDK reference](https://openrouter.ai/docs/agent-sdk/typescript/api-reference/models/contextcompressionplugin.md); [OpenRouter transforms](https://openrouter.ai/docs/transforms)

### Inferences
- **Three separate systems (Manus, Hermes, Deep Agents) arrive at: summary + full archive + a way to search the archive.** ORFE gets the archive for free, because all messages already stay on the phone.
- ORFE must write its own summariser. Anthropic's block is signed and OpenAI's is encrypted, so neither can move between models. ORFE's premise is that any model writes the next turn.
- `middle-out` is not useful. It removes text silently, and it could undo ORFE's own window planning.
- The coding-agent defaults do not fit. Factory's systems removed 98.6–99.3% of tokens. For fiction, Hermes's budget rule (20% of content) is a more sensible starting point, but it is untested on fiction.
- Default summary prompts ask for state and next steps. A story has no "next steps". ORFE needs its own prompt.

### Gaps
- I did not find the exact trigger for Claude Code. The official model-config page was not read.
- I found no public OpenRouter pass-through for Anthropic compaction or OpenAI `/responses/compact`. I did not probe this live.
- I could not fetch the OpenCode doc page directly (404 after redirect), so those facts rest on the search result text.

## What is measurably lost in summarisation, and which formats preserve the most?

### Takeaway
The best evaluation shows incremental, structured summaries beat regenerated ones, but only by a small margin, and all methods lose specifics badly. Fiction summaries fail mostly on character states, relationships and events, which is exactly what ORFE cares about. Nothing measures voice.

### Cited Findings

**Factory evaluation (Dec 2025, coding only, self-run)**
- Method: 36,611 messages from production coding sessions, hundreds of compression points, four probes per point (recall, artifact, continuation, decision), graded 0–5 by GPT-5.2, blind to method — [Factory](https://factory.com/news/evaluating-compression)
- Overall: Factory 3.70, Anthropic 3.44, OpenAI 3.35 — [Factory](https://factory.com/news/evaluating-compression)

| Dimension | Factory | Anthropic | OpenAI |
|---|---|---|---|
| Accuracy | 4.04 | 3.74 | 3.43 |
| Context | 4.01 | 3.56 | 3.64 |
| Artifact | 2.45 | 2.33 | 2.19 |
| Completeness | 4.44 | 4.37 | 4.37 |
| Continuity | 3.80 | 3.67 | 3.77 |
| Instruction | 4.99 | 4.95 | 4.92 |

- Tokens removed: OpenAI 99.3%, Anthropic 98.7%, Factory 98.6% — [Factory](https://factory.com/news/evaluating-compression)
- "Artifact tracking remains an unsolved problem" at 2.19–2.45 for all. They suggest a separate artifact index instead of general summarising — [Factory](https://factory.com/news/evaluating-compression)
- Limits: Factory evaluated its own method, reports no significance tests, gives no cost data, and no human check of the judge — [Factory](https://factory.com/news/evaluating-compression)

**Fiction: FABLES (2024, older, peer-reviewed; old models)**
- 3,158 claims from 130 summaries of 26 books, annotated by 14 human readers at $5.2K in total — [FABLES](https://arxiv.org/html/2404.01261v2)
- Unfaithful claims: Claude-3-Opus 2.1%, GPT-4 4.55%, GPT-4-Turbo 7.64%, GPT-3.5-Turbo 11.26%, Mixtral 11.47% — [FABLES](https://arxiv.org/html/2404.01261v2)
- Types of unfaithful claim: state of a character or relationship 38.6%, specific event 31.5%, cause/effect 11.2%, high-level 11.2%, introspection 7.5% — [FABLES](https://arxiv.org/html/2404.01261v2)
- 50.2% needed indirect reasoning to refute, so these errors are hard to spot — [FABLES](https://arxiv.org/html/2404.01261v2)
- Omissions were flagged in 52.0–84.6% of summaries. Missing key events in 33.3–65.4%. Crucial characters missing in 23.1% for two models — [FABLES](https://arxiv.org/html/2404.01261v2)
- Chronology errors in 33.3–61.5% of summaries. Claude-3-Opus overweighted the ending in at least 20% of its summaries — [FABLES](https://arxiv.org/html/2404.01261v2)
- FABLES used hierarchical merging, so it measures recursive summarising directly — [FABLES](https://arxiv.org/html/2404.01261v2)

**Recursive summaries**
- Recursive merging can amplify hallucinations. Feeding source context back into each merge beat plain merging on legal and narrative datasets. Refinement worked best when paired with extractive selection of relevant input — [Ou & Lapata, ACL Findings 2025](https://arxiv.org/html/2502.00977v2)
- A book-length evaluation found that about 95% of faithfulness errors were extrinsic, meaning unsupported by the source, and sentence-level contradictions were rare — [arXiv 2508.19578](https://arxiv.org/pdf/2508.19578) (search excerpt only, not read in full)

**Roleplay community (practitioner reports)**
- SillyTavern's docs say to treat summaries "with a grain of salt", since they can lose details or hallucinate — [SillyTavern docs, as quoted](https://www.roborhythms.com/sillytavern-memory/)
- The Qvink author's list of faults in a rolling summary: it degrades over time, one bad generation can ruin it, chat edits do not update it reliably, and the LLM decides what matters instead of the user — [Qvink MessageSummarize](https://github.com/qvink/SillyTavern-MessageSummarize)
- Qvink's alternative: one summary per message, each attached to its message, with user-marked messages kept for long-term memory. It recommends temperature 0 and a simple prompt, since long prompts tend to reduce accuracy — [Qvink MessageSummarize](https://github.com/qvink/SillyTavern-MessageSummarize)
- A community pattern: summarise 12–20 messages at a time and nest those into "chapter" summaries. "You'll get better summaries out of smaller chunks" — [Reddit snapshot, via search](https://reddit.sentinel-team.org/posts/1rain9n/snapshots/2026-02-27T16%3A12%3A57.42274Z)
- Summaryception automates layered summaries with recent turns kept word for word. It is said to hold thousands of turns in under 20k tokens. I could not verify this against its own page — [RoboRhythms](https://www.roborhythms.com/sillytavern-memory/)
- Voice drift is reported as a return to a generic voice within 20–30 messages, but this source is a low-rigour guide with no measurement — [RoboRhythms](https://www.roborhythms.com/ai-companion-persona-drift-fix/)

**Other formats**
- Anthropic's advice: tune the compaction prompt for recall first, then cut for precision — [Anthropic, Sep 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Manus keeps recent tool calls in full so the model has fresh examples of correct use — [ZenML summary](https://www.zenml.io/llmops-database/context-engineering-for-production-ai-agents-at-scale) (secondary)

### Inferences
- **Summarise in small fixed chunks, never rewrite the whole.** Factory, the Hermes update step, Qvink and Ou & Lapata all point this way. Each chunk stays tied to its source messages, so a bad result damages one chunk and can be redone. This also answers the edit problem (see the caching question).
- **A story needs a story template, not a task template.** FABLES says the failures sit in character state, relationships and events. Suggested sections: characters and their current state; relationships; events in order; open threads and promises; world facts; exact phrases that matter. Writing events in order targets the chronology errors directly.
- **Treat exact wording like Factory's "artifacts".** Factory found general summaries do not preserve specifics and suggests a separate index. The fiction equivalent is a verbatim store: quotes, names, vows, recurring phrases. ORFE's pinned messages already do this, and the user chooses, which removes Qvink's "LLM decides what matters" fault.
- **Voice likely depends on the verbatim tail, not the summary.** By Manus's logic, the model learns from recent examples. That argues for a generous word-for-word tail. This is reasoning from analogy, not a finding.
- The Factory gap (3.70 vs 3.44) is small and self-reported. Anchored summaries are likely better, but "proven" is too strong.
- Summaries should not contain the model's own guesses at theme. Extrinsic error is the main failure, so the prompt should ask only for what is on the page.

### Gaps
- **No study measures voice, style or prose quality after compaction.** A search for "summary makes the model write like the summary" found nothing that tests it. This is the biggest gap, and ORFE could fill it with Mikael's blind A/B page: same chat, summary vs full context, vote on the next reply.
- No probe-style evaluation like Factory's exists for fiction chats.
- Nothing compares verbatim excerpts against summaries for fiction memory.
- The running-summary score in the August 2026 preprint is not given in its abstract, and the full text returned 403.

## Should tool results be kept, trimmed, summarised, cleared or moved to storage?

### Takeaway
The proven default is rule-based: keep recent results whole, replace old ones with a pointer, and keep the source restorable. ORFE's position is unusually good, because a search result is a copy of messages that already exist on the phone, so a pointer loses nothing.

### Cited Findings
- Manus: "Our compression strategies are always designed to be restorable." Content can go if a reference stays, such as a URL or file path — [Manus, Jul 2025](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Manus warns against irreversible compression, because the agent cannot reliably predict which observation will matter ten steps later — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Anthropic calls tool result clearing "one of the safest lightest touch forms of compaction" — [Anthropic, Sep 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic's `clear_tool_uses_20250919` defaults: trigger at 100,000 input tokens, keep the 3 most recent tool uses, clear oldest first, leave placeholder text. Options include `exclude_tools` and `clear_at_least` — [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- Self-reported Anthropic results: context editing alone +29% and with the memory tool +39% on an internal search evaluation; 84% fewer tokens in a separate 100-turn test. These come from different tests and should not be combined — [Anthropic, Sep 2025](https://www.anthropic.com/news/context-management)
- Hermes replaces old tool outputs over 200 characters with a placeholder and no LLM call — [Hermes docs](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Deep Agents moves results over about 20,000 tokens to a file with a path and a 10-line preview. Later it truncates older tool calls to pointers, and summarises only if that is not enough — [LangChain](https://www.langchain.com/blog/context-management-for-deepagents)
- Claude Code brings back a file over 5,000 tokens as a path reference, not its content — [Claude Code context window](https://code.claude.com/docs/en/context-window)
- Anthropic's sub-agents return 1,000–2,000 tokens from tens of thousands of tokens of exploration — [Anthropic, Sep 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

### Inferences
- For ORFE's search tool the order should be:
  1. Keep whole for the turn that used it, and for the next few turns.
  2. Then replace with a pointer: message ids and a one-line preview.
  3. The model can reopen by id with a `read_messages` style tool.
- Summarising a search result is usually the wrong move for ORFE. The result is exact story text, which is the very thing summaries lose. It is only worth it for bulky, non-story results such as web pages.
- A short "what I found" line written by the main model in its own reply survives any clearing, because it lives in an assistant message. That is a free summary with no extra call. Untested idea.
- Clear in batches, tied to the moments the cache is dead anyway. See the caching question.
- User-attached web pages or PDF text may need the Deep Agents rule (oversize results go to storage with a preview).

### Gaps
- All the evidence comes from coding or research agents. I found no data on tool result retention in fiction chats.
- No evaluation directly compares clear vs summarise vs pointer on the same task with reported numbers.

## Is a small model summariser or a cheap keep-or-drop classifier proven?

### Takeaway
A small model as a summariser is a real production pattern, with moderate evidence. Cheap models do degrade below some tier, so choose mid-tier rather than cheapest. A cheap per-result keep-or-drop classifier is not proven: I found no production system using one, everyone uses plain rules instead, and Manus argues the decision cannot be made well in advance.

### Cited Findings

**Summariser**
- Cognition describes a dedicated model that compresses history and says fine-tuning a smaller model is an option they have used, adding "This is hard to get right" — [Cognition, Jun 2025](https://cognition.com/blog/dont-build-multi-agents)
- Hermes uses a configurable auxiliary model. It defaults to the main model when unset — [Hermes docs, via search result](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching?full=true)
- Qvink suggests a separate connection profile for summaries, temperature 0, and avoiding reasoning models because they are slow — [Qvink MessageSummarize](https://github.com/qvink/SillyTavern-MessageSummarize)
- ACON shrinks observations and history using prompts refined from failure analysis. It cuts peak tokens by 26–54%. Distilling the compressor into smaller models keeps over 95% of the teacher's accuracy — [ACON, ICML 2026 listing](https://icml.cc/virtual/2026/poster/66270); [arXiv abstract](https://arxiv.org/abs/2510.00615)
- A review of ACON notes that history compression can raise cost by breaking the KV cache — [Moonlight review](https://www.themoonlight.io/en/review/acon-optimizing-context-compression-for-long-horizon-llm-agents) (secondary)
- ConvoMem: Pro beat Flash by only 2.3 points at 3.7× the cost, while Flash Lite did much worse. This measures answering, not summarising — [ConvoMem](https://arxiv.org/html/2511.10523v1)
- Non-peer-reviewed preprint: cheap 8B extractor fact slots were the weakest method (37.5% vs 73.6% for retrieval on knowledge updates). A 70B extractor gained 29.2 points but cost 1.8× full context — [Preprints.org, Aug 2026](https://prereview.org/preprints/doi-10.20944-preprints202608.1369.v1)
- FABLES unfaithfulness ranged from 2.1% to 11.47% by model. Model tier matters, though these are old models and chunk sizes differed — [FABLES (2024, older)](https://arxiv.org/html/2404.01261v2)
- A third-party page quotes Anthropic's launch text placing Haiku 5.5 at narrow tasks such as compaction and summarisation. I could not verify it — [laozhang.ai](https://blog.laozhang.ai/en/posts/claude-haiku-5-5-vs-sonnet-5-5)

**Failure modes**
- If the summary model's context window is smaller than the main model's, the call fails and the middle turns are dropped with no summary. Hermes docs call this the most common cause of degraded compaction — [Hermes docs, via search result](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching?full=true)
- A failed summary arms a cooldown of 60s, 300s, then 900s. Repeated stalls end in a deterministic fallback summary, or with `abort_on_summary_failure` nothing is dropped — [Hermes docs](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Non-JSON output from the auxiliary model can silently drop the summary. Two compressions in a row saving under 10% lock further compression — [Mem0 blog](https://mem0.ai/blog/how-hermes-and-claude-handle-context-compression-in-real-production-agents-(and-what-you-should-extract))
- The model reading a summary cannot tell if the summary is wrong: 50.2% of FABLES errors needed indirect reasoning to refute — [FABLES](https://arxiv.org/html/2404.01261v2)

**Keep-or-drop classifier**
- Every production tool-result rule I found is deterministic: keep the last N (Anthropic), over 200 characters outside the tail (Hermes), over 20k tokens (Deep Agents), oldest 50% (Manus) — [Anthropic](https://platform.claude.com/docs/en/build-with-claude/context-editing); [Hermes](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching); [LangChain](https://www.langchain.com/blog/context-management-for-deepagents); [ZenML](https://www.zenml.io/llmops-database/context-engineering-for-production-ai-agents-at-scale)
- Manus's stated reason for restorable compression is that the agent cannot predict which observation will matter later — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Qvink rejects an LLM deciding what to keep long-term, because it may not match the user's choices — [Qvink MessageSummarize](https://github.com/qvink/SillyTavern-MessageSummarize)

### Inferences
- **Mikael's three ideas, ranked:**
  1. Small model for compaction summaries: yes. Use a mid-tier model, not the cheapest, and let the user choose it.
  2. Small model summarising tool or retrieval results: only for bulky non-story results. Pointers are cheaper and lose nothing.
  3. Per-result keep-or-drop classifier: skip it. When dropping is reversible a wrong "keep" only costs tokens and a wrong "drop" can be reversed by reopening, so the classifier saves little. When dropping is not reversible, a cheap model is the wrong judge. Plain rules do the job at zero cost and zero latency.
- A keep-or-drop call also adds a network round trip per result, and a mobile PWA feels that. Latency numbers for this were not found.
- A hybrid worth testing: the main model marks what mattered, as a side effect of its own search use. Messages it actually quotes get kept. That needs no extra call, and is similar to ACON's second phase, which looks at which compressed information was used.
- Illustrative cost, using ORFE's defaults and quoted prices ($1/M cheap input, $3/M mid input, $0.30/M cached) and ignoring output:
  - Summarising only the trimmed span of 9,600 tokens on the cheap model: about $0.0096.
  - Whole window of 32,000 on the mid model, cold: about $0.096.
  - Whole window of 32,000 on the mid model, cache warm: about $0.0096.
  - So span-only summarising is about ten times cheaper than a cold whole-window summary. It matches a warm same-model call on input cost.
  - Prices come from [fast.io](https://fast.io/resources/claude-haiku-vs-sonnet-comparison/) and [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus). Check real prices from the model list before relying on this.
- A cheap model cannot read the main model's cache, because each model has its own. So the warm same-model route has a real advantage only when a hard trim fires while the cache is alive.
- Check that the summariser's context window covers the span being sent, using `context_length` from the OpenRouter model list. Span-only summarising largely removes the Hermes failure.

### Gaps
- **I found no direct measurement of summariser model tier vs summary quality for conversation compaction.** Searches returned pricing pages only. Mikael's blind A/B method could settle it for his own chats.
- ACON's compressor models and token cost could not be read: the PDF text came through unreadable.
- No latency figures found for a summary or classifier call on a phone.
- No production system or evaluation found for a cheap per-result keep-or-drop classifier. Absence of evidence only; a private system could exist.

## When should compaction run, and how do reroll, edit and delete work with a summary?

### Takeaway
Run compaction only at the moments ORFE already trims. A summary changes the prefix, so doing it when the cache is dead costs nothing extra. Prepare it in the background so a send never waits. For edits, tie each summary chunk to its source messages so that only the affected chunk goes stale.

### Cited Findings

**Caching**
- Compaction invalidates the conversation layer by design, while the system prompt can stay cached. The turn after rebuilds the cache only for the much shorter summary, so that turn is not the slow part — [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)
- While the cache is warm the summary call reads the prefix from cache, so it costs a fraction of the context size. After a break it reprocesses history uncached, which is when compaction costs most — [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)
- `/rewind` truncates back to a prefix that is already cached, rather than building a new one — [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)
- Claude Code advises compacting at natural breaks, not mid-task — [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)
- Claude Code can also compact a long conversation left idle on the one-hour TTL — [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)
- Tool result clearing invalidates cached prefixes. `clear_at_least` exists so that a clear is large enough to be worth it — [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- Anthropic recommends a cache breakpoint at the end of the system prompt, so that after compaction only the new summary is written — [Anthropic threshold compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)
- Anthropic offers background compaction: the request runs while work continues, and the block is swapped in when it arrives — [Anthropic compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)
- Manus: "even a single-token difference can invalidate the cache from that token onward"; avoid modifying previous actions. Cached input cost $0.30/M against $3/M uncached in their example — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Hermes: after compression the rolling cache rebuilds within one or two turns — [Hermes docs](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Trigger points vary widely: Hermes 50%, Deep Agents 85%, Anthropic 150k default, Manus near 128–200K — [Hermes](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching); [LangChain](https://www.langchain.com/blog/context-engineering-deep-agents-remember); [Anthropic](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold); [ZenML](https://www.zenml.io/llmops-database/context-engineering-for-production-ai-agents-at-scale)

**Reroll, edit, delete**
- Qvink attaches each summary to its message, so "editing/deleting a message only affects the associated memory". Users choose whether edits, swipes and continues re-summarise. Its todo list still has handling of swipes, edits and deletes open — [Qvink MessageSummarize](https://github.com/qvink/SillyTavern-MessageSummarize)
- Qvink's complaint about rolling summaries: editing the chat does not reliably update them — [Qvink MessageSummarize](https://github.com/qvink/SillyTavern-MessageSummarize)
- Anthropic: the summary block takes the place of the messages it summarises, and compacting again summarises the old summary. The page I read gives no method for updating a block after an edit — [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- Claude Code has "Summarize from here" and "Summarize up to here" from `/rewind`, so a partial summary from a chosen message is an accepted user action — [Claude Code context window](https://code.claude.com/docs/en/context-window)
- Ways to fail safely when no summary arrives: continue and compact later (Anthropic), cooldown (Hermes) — [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand); [Hermes](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)

### Inferences
- **ORFE's existing trim logic is already the right trigger.** `planWindow` trims only on a hard limit or a cold cache. Compaction should run on the same event, not on its own threshold. No new cache break is added, because the trim already broke the prefix.
- **Batch all prefix changes into that one event:** trim, new summary chunk, clearing old search results to pointers.
- **Where the summary sits:** after the system prompt and before the window, as one stable block. It changes only at trim events. Everything after it stays append-only.
- **Prepare early so a send never waits.** When a chunk nears the window edge, summarise it in the background and store it. At trim time the result is ready and the send is not delayed. If it is not ready, trim anyway and fill in the next time. Messages are safe on the phone, so failure costs one trim with no summary, and it can be shown in the UI.
- **Do not repeat a summary of content still in the window.** If the block covers only what has left the window, the two never overlap. Overlap costs tokens, but a small overlap may help continuity. This is untested.
- **Data shape for a chunk:** covers `fromOrder` to `toOrder`, a hash of the source text, the summary text, and the model used. Same idea as `fingerprint` in `context.ts`.
- **Rerolls never touch summaries.** The window never starts after the last user message, and a chunk is only made from messages well behind the tail. Keep the tail long enough and a reroll stays in the verbatim part.
- **Edit or delete inside a summarised chunk:** the hash no longer matches, so mark that chunk stale. Options, cheapest first:
  1. Show "this summary is out of date", and let the user decide.
  2. Redo that one chunk at the next cold moment.
  3. Redo it now, accepting the cache break.
  Since the user chose to edit old history, the cache is broken at that point in any case if the message is in the window. If it is outside the window, only the summary block changes.
- **Rolling up:** when chunks pile up, merge the oldest into a chapter summary, and keep the original chunks stored. Do this from the chunks, or better from the original text, as Ou & Lapata suggest, to limit error build-up.
- **Reversible:** keep a way to undo a summary, as the raw messages still exist. Raising the context limit should bring messages back, as `raisesLimit` already does.
- **Model switch:** a switch is a cold moment already, so it is a good time for any pending compaction.

### Gaps
- I found no source that measures the best tail size for fiction, or how much overlap helps.
- I found no published design for invalidating summaries after edits beyond Qvink's per-message link, and that remains on its todo list.
- The TTL behaviour of OpenRouter's non-Anthropic providers is taken from ORFE's own research notes, not checked again here.

## How should the model search older messages?

### Takeaway
Use hybrid search if it is cheap to add, and start with BM25 because it costs nothing and runs on the phone. "Grep beats vectors" is overstated: the best-known claim comes from coding, where exact tokens dominate, and the best data (Cursor) shows both together win. In fiction, people recall scenes by meaning, so embeddings likely matter more than in code.

### Cited Findings

**Grep vs vector**
- Boris Cherny said early Claude Code tried RAG with a local vector database and agentic search worked better. Reasons reported include index security and upkeep. The wording is second-hand — [talk summary](https://www.ai.engineer/talks/UM6sFg_jdlE-rag-is-dead-right-kuba-rogut); [BestHub](https://www.besthub.dev/articles/why-claude-code-and-cursor-abandoned-vector-databases-for-agentic-retrieval-9dad68e8f191)
- Cursor measured the opposite effect: adding semantic search to grep gave 12.5% higher answer accuracy (6.5–23.5% by model), +0.3% code retention (+2.6% on codebases over 1,000 files), and 2.2% more dissatisfied follow-ups when semantic search was missing. Using both together gave the best outcomes. Cursor trained custom embeddings and sells this feature — [Cursor, Nov 2025](https://cursor.com/blog/semsearch)
- Letta scored 74.0% on LoCoMo with GPT-4o mini and basic file tools, above Mem0's reported 68.5%. Those tools included `search_files`, which is semantic search, along with grep. So this is not a pure grep result. Letta's conclusion: the agent's ability to search iteratively matters more than the mechanism — [Letta, Aug 2025](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- Weak models needed tool rules forcing them to search first and keep searching until they answer — [Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- A later article says Mem0 now reports 92.5%, and Letta has not rerun — [Towards AI](https://pub.towardsai.net/mem0-vs-zep-vs-letta-a-folder-of-text-files-shouldnt-beat-the-61k-star-memory-layer-9d7e65c5799c) (secondary)
- Anthropic describes just-in-time retrieval as slower and dependent on good tools, and suggests hybrids — [Anthropic, Sep 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**BM25 vs embeddings on conversation memory**
- LongMemEval (2024, older) found dense embeddings significantly better than BM25 — [LongMemEval](https://arxiv.org/pdf/2410.10813)
- Newer project results disagree. One reports BM25 recall@10 of 0.982 against 0.933 for bge-m3, and suspects high keyword overlap in the benchmark's questions — [memini bench](https://pkg.go.dev/github.com/eleboucher/memini/bench). Another reports 95.2% recall@5 for hybrid against 86.2% for BM25 alone — [agentmemory](https://cdn.jsdelivr.net/gh/rohitg00/agentmemory@main/benchmark/LONGMEMEVAL.md)
- A hybrid added +7.7 F1 over cosine-only (36.5% → 44.2%), mostly on knowledge updates with shared terms like names — [arXiv 2603.23013](https://arxiv.org/pdf/2603.23013)
- A preprint found BM25 cut input tokens by 98% and cost to 4.8% of full context on LoCoMo, with retention 39.4% vs 30.6%. That trend is not significant (p=0.09, n=160) — [Preprints.org, Aug 2026](https://prereview.org/preprints/doi-10.20944-preprints202608.1369.v1)
- The same preprint shows sparse retrieval recovered only about 13% of gold evidence turns on multi-hop questions. Full context beat BM25 by 10.2 points on temporal, multi-session and abstention questions (p=0.004) — [Preprints.org](https://prereview.org/preprints/doi-10.20944-preprints202608.1369.v1)
- A March 2026 paper reports that BM25 does not hold up on distilled memories while vector search does — [arXiv 2603.13017](https://arxiv.org/pdf/2603.13017) (search excerpt only)

**Small histories**
- ConvoMem: memory search spaces are small, so exhaustive search and full context are practical. Full context stays viable to about 150 conversations and scored 15–25 points above Mem0 on user facts. The benchmark is synthetic and enterprise-focused, and the paper is not fully consistent on the crossover point — [ConvoMem](https://arxiv.org/html/2511.10523v1)

**Practical for a PWA**
- OpenRouter lists `openai/text-embedding-3-small` at $0.02/M input, with an 8,192 token limit per input — [OpenRouter](https://openrouter.ai/openai/text-embedding-3-small/pricing). The route is `POST /api/v1/embeddings` — [CodeWords](https://www.codewords.ai/blog/openrouter-embedding-models) (secondary)
- Transformers.js runs models in the browser, with models fetched on first use and cached. Its default is WASM + q8, and v4 uses WebGPU when present. One demo downloaded about 67MB — [Jimmy Song](https://jimmysong.io/ai/transformersjs); [indepth.dev](https://indepth.dev/posts/2004/en/ml-in-the-browser-transformers-js-tensorflow-js/)
- Heavy on-device models work best as an informed opt-in. A cross-browser memory check was reported missing at the time of one podcast — [Callstack](https://callstack.com/podcasts/running-ai-in-the-browser-with-transformers-js)

### Inferences
- **Stage 1: BM25 on the phone.** No network, no cost, no extra provider, instant index update. It works for names, places, objects and exact phrases. A library such as MiniSearch would do; I did not evaluate libraries, so that is an unverified starting point.
- **Stage 2: add embeddings as an option.** Fiction queries are often about meaning ("the scene where she finally forgave him") and share few words with the text. That is the case where BM25 fails. At $0.02/M, embedding a 1M-token chat costs about 2 cents. That is well worth trying.
- Brute-force cosine over stored vectors in IndexedDB should be fine at this size, following ConvoMem's point that the search space is small. No ANN index needed.
- Merge the two lists by rank (reciprocal rank fusion is the usual method, not sourced here).
- **Search the verbatim messages, not summaries.** Summaries are where detail is already lost, and arXiv 2603.13017 suggests lexical search does poorly on distilled text.
- **Search returns a small window:** the matching message plus a neighbour on each side, with message ids. A scene is rarely one message.
- **Let the model loop.** Letta's main point: rewriting the query and searching again matters more than the engine. Give it `search_messages(query)` and `read_messages(ids or range)`, and cap rounds per turn to control cost.
- **Models without tools:** `supported_parameters` in the OpenRouter model list shows tool support. Without tools, ORFE could run the search itself before sending, and inject the results. That is the classic RAG path, and it is weaker since the model cannot refine its query.
- **Weak models may need a nudge** in the system text to search before claiming not to remember, in the style of Letta's tool rules.
- **Search covers the active branch only:** reroll versions that were discarded should not appear. Also exclude messages still in the window, so results are not duplicates.
- Full context beat retrieval on temporal and multi-session questions, so the summary keeps its job: the overall timeline and shape. Search retrieves exact detail. They are complementary, not rivals.
- On-device embeddings are the weakest option for now: a large download and unknown Android performance, for a saving of cents. Privacy is the only argument, and the text goes to OpenRouter anyway.

### Gaps
- CORS on OpenRouter's `/embeddings` endpoint is unknown. No source mentions it. ORFE's research notes cover other routes only. **This needs a live probe before designing around it.**
- I found no retrieval evaluation on fiction or roleplay chats. All numbers come from personal-fact benchmarks or code.
- Benchmark numbers use different k values and embedders, so they cannot be compared across sources.
- Android browser speed for BM25 indexing or Transformers.js was not found.
- Cherny's exact words were not checked at the original podcast.
- Whether an embedding model switch is worth supporting is open. A switch needs a full re-embed, but the cost is low.
