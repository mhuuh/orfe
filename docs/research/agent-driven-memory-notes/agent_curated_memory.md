# Agent-curated memory: what works, what fails, and what it means for ORFE's vault

Evidence labels used below:
- **[LONG-USE]**: shipped at scale for a long time, but no controlled comparison.
- **[MEASURED]**: numbers exist. Read the stated caveats.
- **[PROMISING]**: a design or small study with thin evidence.
- **[CLAIM]**: vendor or anecdotal statement, not independently checked.

Source limits: OpenAI's help pages and its dreaming post returned HTTP 403, so OpenAI facts come from search excerpts and press coverage. Vendor benchmark numbers are self-reported. arXiv papers from 2026 are preprints unless stated. Sources from 2024 are marked as older.

## What does agent-curated memory look like in production today?

### Takeaway
The field has converged on one shape: a small always-visible index, plain Markdown files read on demand, and version history. Background tidying is the newest layer and the least proven. Almost nobody has published a controlled result showing that any of it improves real outcomes.

### Cited Findings

**Anthropic memory tool (stable API feature)**
- It is client-side. The model requests `view`, `create`, `str_replace`, `insert`, `delete` and `rename` under `/memories`, and the app runs them against its own storage — [Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- The API auto-injects a system instruction: "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE", plus an "ASSUME INTERRUPTION" rule — [Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- The docs tell builders to cap file size, cap what `view` returns, validate every path, and periodically delete files not accessed for a long time — [Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- The tool description says `create` "creates or overwrites". The reference behaviour returns an error if the file exists, and overwriting is allowed as an implementation choice. So models will try `create` on existing paths — [Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- If memory gets cluttered, the docs suggest this prompt: "Do not create new files unless necessary" and rename or delete what is no longer relevant — [Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- Context engineering guidance recommends just-in-time retrieval by lightweight identifiers, and calls hybrid designs good: some context up front, the rest fetched by tools. Trade-off: runtime exploration is slower and can waste context on dead ends — [Anthropic, 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

**Anthropic Managed Agents memory stores and dreams (beta and research preview)**
- Each memory is capped at 100 kB, with up to 10,000 per store. Guidance: "many small focused files, not a few large ones" — [Anthropic docs](https://platform.claude.com/docs/managed-agents/memory).
- Stores can be `read_only`, enforced at the filesystem level. Writes use a `content_sha256` precondition to avoid overwriting a concurrent write. Every change makes an immutable version, attributed to the session — [Anthropic docs](https://platform.claude.com/docs/managed-agents/memory).
- A dream reads a store and 1 to 100 past transcripts. It writes a new store with duplicates merged and stale entries replaced. The input store is never changed, so you can review and discard the output — [Anthropic docs](https://platform.claude.com/docs/managed-agents/dreams).
- The optional `instructions` field can name "content to preserve unchanged". The docs call the pipeline "a synthesis pass", not an editor — [Anthropic docs](https://platform.claude.com/docs/managed-agents/dreams).

**Claude Code memory**
- Auto memory is a `MEMORY.md` index with one line per memory, plus topic files read on demand. The first 200 lines or 25KB load every session. Each file carries a `type`: `user`, `feedback`, `project` or `reference` — [Claude Code docs](https://code.claude.com/docs/en/memory).
- It skips anything derivable from the code, and anything CLAUDE.md already says — [Claude Code docs](https://code.claude.com/docs/en/memory).
- After a write to `MEMORY.md`, the tool measures the file. Near the limit it reminds Claude to shorten it. Over the limit the write succeeds but returns an error telling Claude to rewrite the index — [Claude Code docs](https://code.claude.com/docs/en/memory). An older third-party post says the write path has no such check, so that point has likely changed — [search summary](https://vectorize.io/articles/claude-code-memory).
- Auto Dream is described only by third parties: a background pass after about 24 hours and 5 sessions, in gradual rollout as of March 2026 — [claudefa.st](https://claudefa.st/blog/guide/mechanics/auto-dream). The official memory page I fetched does not mention it. Treat the details as unverified.

**Letta (formerly MemGPT)**
- Letta now keeps memory as a git-backed Markdown filesystem. Root or `system/` files stay in the prompt, and other files show up as a tree with frontmatter descriptions and load when needed — [Letta docs](https://docs.letta.com/letta-code/memfs); [Letta, Feb 2026](https://www.letta.com/blog/context-repositories).
- Defrag backs up memory, then reorganises it into "15–25 focused files". The post reports no measured results — [Letta, Feb 2026](https://www.letta.com/blog/context-repositories).
- Sleep-time agents split duties: the primary agent cannot edit core memory, and a background agent does. Letta's post gives no latency, cost or accuracy figures for its own product. The only cited gains are math benchmarks in the research paper — [Letta, Apr 2025](https://www.letta.com/blog/sleep-time-compute).
- Dreaming can run after a set step count or on compaction. An optional "Agent reviews before applying" adds a second model review, but it does not ask the human — [Letta docs](https://docs.letta.com/configuration/memory).

**ChatGPT**
- OpenAI says saved memories tended to go stale and depended on users to update them. Chat-history reference arrived in April 2025 as the first version of "dreaming" — [OpenAI, via search excerpt](https://openai.com/index/chatgpt-memory-dreaming/).
- Dreaming V3 rolled out from June 4, 2026. It rewrites entries as time passes, and memory is injected at conversation start, not pulled by the model. OpenAI's internal figures, reported second-hand: 82.8% factual recall, 71.3% preference adherence, 75.1% time-sensitive accuracy **[CLAIM]** — [Tech Times](https://www.techtimes.com/articles/317840/20260605/chatgpt-memory-dreaming-update-openai-rewrites-personalization-engine-limits-audit-trail.htm).
- The same report says the summary page may not show everything remembered, and that deleting a chat does not delete memories derived from it — [Tech Times](https://www.techtimes.com/articles/317840/20260605/chatgpt-memory-dreaming-update-openai-rewrites-personalization-engine-limits-audit-trail.htm).
- Sources disagree on whether V3 replaces saved memories or supplements them. A legacy option reportedly remains — [search summary of OpenAI and press](https://www.digitalapplied.com/blog/chatgpt-memory-dreaming-v3-openai-2026-guide).

**Mem0**
- In April 2026 Mem0 dropped its reconcile step. It went from two LLM passes with ADD, UPDATE and DELETE to a single ADD-only pass, and it now resolves conflicts at retrieval time. Nothing is overwritten — [Mem0](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm); [Mem0 research](https://mem0.ai/research-3).

**Zep / Graphiti**
- A knowledge graph where each edge has four timestamps: `t_valid` and `t_invalid` (true in the world), and `t'_created` and `t'_expired` (known to the system). An LLM compares new edges with related old ones. On contradiction it sets the old edge's `t_invalid` — [Zep paper, Jan 2025](https://arxiv.org/html/2501.13956).

**Cursor**
- Cursor removed Memories in version 2.1.x in November 2025. Staff called it intentional and gave no reason. The route offered was to export memories into Rules files — [Cursor forum](https://forum.cursor.com/t/are-my-memories-gone/144057).

**Manus**
- The file system is treated as the "ultimate context". Compression must be restorable: drop page content but keep the URL, drop document content but keep the path — [Manus, Jul 2025](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- Cache hit rate is called the single most important production metric, so the prompt prefix must stay stable — [Manus, Jul 2025](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- A secondary source says Manus later found about a third of actions went on updating `todo.md`, and replaced it with a planner agent. I could not confirm this in Manus's own text **[CLAIM]** — [AgentMarketCap](https://agentmarketcap.ai/blog/2026/04/08/manus-ai-context-engineering-production-agent-lessons).

**OpenAI agent memory guidance**
- The Agents SDK cookbook takes the opposite side: state-based and injected, not retrieved. A `save_memory_note` tool writes candidates to a session staging area, an async job consolidates them at session end, and the top six global notes are injected — [OpenAI cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization).
- It forbids storing speculation, assistant inferences, and "instructions or rules for the agent". Consolidation has a "no invention" rule. The current user message overrides all memory — [OpenAI cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization).

**LLM wiki pattern (Karpathy, April 2026)**
- Three layers: immutable raw sources, an LLM-owned wiki, and a schema file. `index.md` is read first, `log.md` is append-only, and lint checks for contradictions, stale claims, orphans and gaps — [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
- Karpathy says the index approach "works surprisingly well at moderate scale (~100 sources, ~hundreds of pages)" with no embeddings — [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

**Hermes Agent (Nous Research)**
- A hard-capped design: `MEMORY.md` at 2,200 characters and `USER.md` at 1,375. A write that would overflow returns an error, and the agent must trim and retry. Exact duplicates are rejected. Entries are scanned for injection patterns and invisible Unicode. The snapshot is frozen per session to protect the prompt cache. Session search covers everything else — [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

### Inferences
- ORFE's design fits the mainstream shape: Markdown files, tools, two scopes. The closest matches are the Anthropic memory tool, Claude Code auto memory and the LLM wiki.
- ORFE should not reuse the Anthropic server tool, because several non-Claude models write to the vault. It should offer ordinary function tools with the same semantics, and it must supply the protocol text itself. Anthropic's auto-injected prompt reaches Claude only.
- Two reversals deserve weight. Cursor dropped its memory feature for rules. Mem0 dropped write-time reconcile. Both suggest that automatic reconcile logic was costing more than it returned. The stated reasons are missing, so this is a reading, not a fact.
- The LLM wiki's "immutable raw layer" is the best existing model for ORFE's curated shelf content. The model may index and link it, but it never edits it.

### Gaps
- I found no outcome study for Claude Code auto memory, Cursor Memories or Letta's dreaming.
- I could not confirm why Cursor removed Memories, or how its original sidecar and approval flow worked.
- The live Letta Leaderboard scores did not render, so no per-model memory scores are available here.

## What failure modes are documented, how often, and how bad?

### Takeaway
Junk and hallucination rates are severe for automatic extraction. Stale facts and contradictions are severe everywhere and remain unsolved at scale. There is no published base rate for tool-driven, agent-curated memory, so ORFE's case is extrapolated.

### Cited Findings

**Junk and duplicates**
- **[MEASURED, one setup]** One user audited 10,134 Mem0 entries after 32 days and kept 224, so 97.8% was junk by the author's own labels. By category: 52.7% restated the system prompt, 11.5% was system noise, 7.4% was transient task state, 5.2% was hallucinated user profiles, 2.1% was security or privacy leaks — [Mem0 issue #4573](https://github.com/mem0ai/mem0/issues/4573).
- A single hallucinated "User prefers Vim" grew to 808 entries, because recalled memories were re-extracted as new facts. The author lists no write-time gate, and no REJECT action in the update step, among the root causes — [Mem0 issue #4573](https://github.com/mem0ai/mem0/issues/4573).
- A better model did not fix it. The junk rate was about 95–98% with gemma2:2b and 89.6% with Sonnet, and the author blames a permissive prompt. Caveats: one setup, subjective labels, changes confounded, and internal totals that do not fully reconcile — [Mem0 issue #4573](https://github.com/mem0ai/mem0/issues/4573).
- A competitor argues that a weak model drove the number. It has a commercial interest — [socket.dev listing](https://socket.dev/npm/package/jamgate/diff/0.11.2).
- Anthropic states the default outcome plainly: over many sessions a store "accumulates duplicates, contradictions, and stale entries" — [Anthropic docs](https://platform.claude.com/docs/managed-agents/dreams).
- In LLM wiki comments, a podcast-wiki builder calls near-duplicate pages the default failure. Fixes: check the index before creating, never silently overwrite, run periodic merges. Anecdotal — [gist comments](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

**Hallucinated or missed updates**
- HaluMem finds that systems "tend to generate and accumulate hallucinations during the extraction and updating stages", and these carry into answers — [HaluMem, Nov 2025](https://arxiv.org/abs/2511.03506).
- A secondary summary reports update omission of about 98.5% for Mem0. I did not verify this against the paper — [BestHub summary](https://www.besthub.dev/articles/halumem-evaluating-hallucinations-in-ai-agent-memory-systems-29392bd5f14e).

**Stale facts**
- **[MEASURED, preprint]** Across 16 models, agents checked a memory's provenance in about one episode in five. When the constraint had been withdrawn, 74.7% to 77.3% of decisions still followed it — [Nakayashiki, Aug 2026](https://arxiv.org/abs/2608.25553).
- In that study a content-free freshness cue did not help. A one-sentence rule preferring memories that state a limit recovered +89.3 points on decisions where the constraint limits the tempting action. The selection rate rose from 17.0% at two slots to 88.7% at four of six. Synthetic setup, single author — [Nakayashiki, Aug 2026](https://arxiv.org/abs/2608.25553).

**Contradictions**
- **[MEASURED]** MemoryAgentBench, single-hop conflict resolution: GPT-4o 60, BM25 56, MemGPT 28, Mem0 18. Multi-hop: no method above 6. The authors blame lossy storage among other causes — [MemoryAgentBench, Jul 2025](https://arxiv.org/html/2507.05257v1).
- A later preprint reached 82–93% single-hop and 27–41% multi-hop by splitting evidence extraction from the answer policy. Its freshness operator alone added +2.0 points on average, and it showed no significant gain on LongMemEval (26/45 vs 29/45, p=0.45) — [Reddy and Challaram, 2026](https://arxiv.org/abs/2606.01435).
- MemConflict finds that correct answers often diverge from good retrieval, and that longer histories, distractors and implicit queries make things worse — [MemConflict, May 2026](https://arxiv.org/abs/2605.20926).
- Claude Code's docs warn that with two contradicting instructions Claude "may pick one arbitrarily" — [Claude Code docs](https://code.claude.com/docs/en/memory).

**Index and store bloat**
- In Claude Code, content past 200 lines or 25KB in `MEMORY.md` does not load. The docs say larger files "reduce adherence" — [Claude Code docs](https://code.claude.com/docs/en/memory).
- ChatGPT users report a hard cap of roughly 100 entries, with nothing added until they delete. Anecdotal — [Unmarkdown](https://unmarkdown.com/blog/chatgpt-memory-full).
- Commenters claim the wiki pattern breaks past about 1,000 files. Unverified — [search summary](https://denser.ai/blog/llm-wiki-karpathy-knowledge-base/).

**Poisoned memory**
- **[MEASURED, idealised]** MINJA reached 98.2% injection success and 76.8% attack success through queries alone — [Dong et al., 2025](https://arxiv.org/html/2503.03704v2). A follow-up notes that these tests assumed idealised memory conditions — [arXiv 2601.05504](https://arxiv.org/html/2601.05504v1).
- SpAIware (older, Sep 2024): hidden text in a document or site made ChatGPT store attacker instructions. They ran in all later chats. OpenAI fixed the exfiltration path, not the memory injection — [Rehberger](https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/).
- Anthropic warns that a prompt injection can write to a read-write store, and later sessions then read it as trusted memory — [Anthropic docs](https://platform.claude.com/docs/managed-agents/memory).

**Models that do not use or follow the system**
- **[MEASURED]** In Vercel's evals an available skill was never invoked in 56% of cases. It added no gain over baseline until explicit instructions raised the trigger rate above 95% — [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals).
- Models can also overuse memory. Claude Haiku 3.5 lost points on Letta's leaderboard for unneeded memory calls — [Letta, May 2025, via search excerpt](https://www.letta.com/blog/letta-leaderboard).
- Claude Code docs say memory is "context, not enforced configuration", and to use a hook to block an action regardless — [Claude Code docs](https://code.claude.com/docs/en/memory).
- Over-personalisation is reported in a blog: memories can make an agent agree with the user against the evidence. Its studies are cited second-hand — [Vaughan](https://codex.danielvaughan.com/2026/06/12/codex-cli-memory-over-personalisation-sycophancy-risk-configuration-defence/).

**Consolidation errors**
- A critic notes that dreaming consolidates but does not verify, so coherent memory is not necessarily correct — [search summary](https://levelup.gitconnected.com/claude-dreaming-anthropic-memory-explained-a038f17f7d13).

### Inferences
- The worst numbers come from automatic extraction, which ORFE has rejected on purpose. The audit's top categories (system-prompt restating, noise, transient state) mostly need a pipeline that reads every message. A model choosing to call a save tool should avoid much of this. That is a reasoned guess, not a measured result.
- The feedback loop still applies to ORFE. A model that reads a note and then saves its paraphrase creates the same 808-style amplification, more slowly. The save tool should show near matches and make the writer choose update over create.
- Staleness is ORFE's biggest real risk. Models rarely check, and a date or "may be stale" label alone is unlikely to help.
- ORFE is a single-user app, so MINJA's multi-user setting does not map across directly. SpAIware does. Any pasted document, fetched page or file a model reads can reach the vault. The risk rises if ORFE ever injects notes into the system prompt.

### Gaps
- No published audit exists of junk rate in tool-driven, agent-curated memory.
- No source measures harm from memory on a small personal store. Most figures are from benchmarks or one-off setups.
- I found nothing on several different models writing to one store, including tone drift or format drift. This is the biggest gap for ORFE.
- I found no evidence about memory of creative content such as poems or voice samples.

## Which maintenance methods have evidence?

### Takeaway
Cheap, deterministic controls at write time have the best support: size caps that return an error, an index, version history, read-only scopes, and a reject path. Background consolidation is widely shipped but thinly proven. Decay is the weakest of all, and it is unsafe for curated content.

### Cited Findings

**Write-time checks: [MEASURED, weak]**
- After four changes at once (NONE by default, a stricter prompt with negative examples, cosine dedup lowered to 0.90, search threshold 0.6), one audit saw junk fall from 97.8% to 46.6%. That is 73 entries over 48 hours, so no single change can be credited — [Mem0 issue #4573](https://github.com/mem0ai/mem0/issues/4573).
- Hermes rejects exact duplicates and scans content before accepting a write. No measured result is given — [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
- The OpenAI cookbook requires checks at capture, consolidation and injection. It names metrics to log but gives no results — [OpenAI cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization).

**Version history: [LONG-USE]**
- Git-backed history for every edit, with a boundary between saved and unsaved changes — [Letta docs](https://docs.letta.com/letta-code/memfs).
- Immutable versions with restore and redact. Older versions may go after 30 days, so export to keep them — [Anthropic docs](https://platform.claude.com/docs/managed-agents/memory).
- Git is widely used here for rollback, not for proven quality. I found no study measuring its effect on memory quality.

**Size caps: [LONG-USE]**
- Claude Code: 200 lines or 25KB, with an error returned to the model — [Claude Code docs](https://code.claude.com/docs/en/memory).
- Hermes: strict character limits, with the agent forced to trim in the same turn — [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
- Vercel cut an index from about 40KB to 8KB with no loss in pass rate — [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals).
- A vendor warns that consolidation under pressure can lose detail **[CLAIM]** — [Vectorize](https://vectorize.io/articles/hermes-agent-memory-not-working).

**Supersession and invalidation: [MEASURED, mixed]**
- Zep scored 71.2% on LongMemEval against 60.2% for full context with gpt-4o, using 1.6k rather than 115k context tokens. This tests the whole system, not supersession alone — [Zep paper, Jan 2025](https://arxiv.org/html/2501.13956).
- On a conflict-focused test, a summary reports Zep/Graphiti at 7% single-hop, far under BM25. That summary's BM25 figure (48) also differs from the original paper's (56), so treat it with care — [search summary of arXiv 2606.01435](https://arxiv.org/abs/2606.01435); [MemoryAgentBench](https://arxiv.org/html/2507.05257v1).
- Mem0 claims temporal metadata raised LoCoMo from 86.1% to 92.5% **[CLAIM]** — [Mem0 issue #4573 closing comment](https://github.com/mem0ai/mem0/issues/4573).

**Background consolidation by a separate agent: [PROMISING]**
- Harvey reported about 6x task completion with dreams in internal testing. One report ties this to an outcomes rubric used at the same time. No independent check **[CLAIM]** — [press coverage](https://www.beri.net/article/anthropics-dreaming-6x-agent-memory-bet-cio-2026).
- Giving a curator read-only tools to check memories before saving raised pass rate from 39% to 73% on CLBench, and halved task-agent cost ($3.38 to $1.68). Verification alone was not isolated — [Suresh et al., Sep 2026](https://arxiv.org/abs/2609.11060).
- Anthropic's design choice is notable: dreams never change the input, and a human approves the output — [Anthropic docs](https://platform.claude.com/docs/managed-agents/dreams).
- Letta's defrag runs when the user asks, and backs up first — [Letta search summary](https://docs.letta.com/letta-code/memory).
- A compiled-wiki commenter reports that agents fall back to raw sources because summaries drop the details needed. Anecdotal — [gist comments](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

**Decay and archiving: [CLAIM]**
- Anthropic suggests deleting files not accessed for a long time — [Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- OpenAI lists TTLs as optional and calls forgetting "essential" — [OpenAI cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization).
- Mem0 ships decay as a ranking change. Vendor-reported — [Mem0 issue #4573 closing comment](https://github.com/mem0ai/mem0/issues/4573).

**Reflection and reliability engineering: [PROMISING]**
- Letta's reflection subagent reviews recent history and writes to memory on a step or compaction trigger. No results are given — [Letta docs](https://docs.letta.com/letta-code/memory).
- A months-long, one-person project logged 85 memory-subsystem failures, 84 of them in the first three weeks, using a session-start health gate and telemetry. N=1, no control, self-reported — [Helwig, Aug 2026](https://arxiv.org/abs/2609.05510).
- Claude Code's `/doctor prompt-audit` reports problems and changes nothing until told. This is a human-approved lint — [Claude Code docs](https://code.claude.com/docs/en/memory).

### Inferences
Recommended stack for ORFE, in order of evidence and cost. All of it is local and suits a phone:
1. Enforce curated protection in the tool handler, not in a prompt. Prompts are advisory, as Claude Code's docs say. A `kind: curated` note should reject `str_replace`, `insert`, `create` over it and `delete`, while still allowing rename, move and tag edits. Only the user should be able to clear the flag. A body hash can prove that reorganising changed no content.
2. Make every write a version, with date and writer model. Keep versions for a long time, because the store is small. This is ORFE's main protection against bad models.
3. Hard-cap the index and each working note. Return an actionable error, as Hermes and Claude Code do. Do not cap curated notes.
4. Have save return near matches from the index, so a model must decide. Add an explicit "nothing to save" path in the instructions. Mem0's lack of a reject option is a named root cause.
5. Use a simple form of supersession: `supersedes` and `superseded_by` links plus a date. Keep the old note. The four-timestamp model is overkill for a few hundred notes, and it needs an LLM to find contradictions anyway.
6. Make tidying a proposal, in the Anthropic dream shape: copy, propose, show a diff, let the user accept. ORFE has no backend, so "background" can only mean a session the user starts or a run while the app is open. That is a fair trade, because no evidence shows unattended tidying is safe.
7. Skip automatic decay. Offer archiving by the user or by a proposal. Decay could silently bury a recipe that is rarely read but still wanted. Lower rank is acceptable. Deletion is not.

A deterministic lint is a good cheap first step: orphan notes, broken links, index entries with no file, notes past a size limit, and near-duplicate titles. It needs no model, and it cannot damage content.

### Gaps
- No controlled trial shows that version history or size caps improve memory quality. Support is design logic plus production adoption.
- No independent evaluation of dreams, Letta's defrag or ChatGPT's dreaming exists.
- No evidence separates the value of each write-time check. All such results are confounded.

## Files, structured records, or a graph for a few hundred notes? What do the benchmarks say?

### Takeaway
For a few hundred personal notes, plain files with keyword search have the strongest case. Graphs solve problems ORFE does not have, at an ingest cost it should not pay. Published benchmark scores are too disputed to choose by. Use them only to reject bold claims.

### Cited Findings

**Files**
- **[MEASURED, flawed benchmark]** A Letta agent with `grep`, semantic file search, `open` and `close` scored 74.0% on LoCoMo using gpt-4o-mini, against Mem0's reported best of 68.5%. Letta argues agents use simple tools more reliably, and that memory quality depends more on how the agent manages context and calls tools than on the retrieval mechanism — [Letta, Aug 2025](https://www.letta.com/blog/benchmarking-ai-agent-memory).
- That same result is partly a benchmark artefact: a full-context baseline also scored 72.9% — [Zep, May 2025](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/).
- MemoryAgentBench found Mem0 and MemGPT trailing simple baselines on most tasks. The authors cite lossy storage, since fact extraction throws content away — [MemoryAgentBench](https://arxiv.org/html/2507.05257v1).
- Vendors have moved toward files. Letta, Anthropic and Claude Code all ship Markdown-based memory — [Letta docs](https://docs.letta.com/letta-code/memfs); [Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool); [Claude Code docs](https://code.claude.com/docs/en/memory).

**Keyword vs embeddings at small scale**
- A 2026 paper found grep and BM25 about tied in agentic document QA, with dense retrieval about 43 points behind. Not personal-notes data — [Beyond Top-K, search summary](https://arxiv.org/pdf/2608.06305).
- On 240 synthetic notes and 20 queries, BM25 was strong for exact terms, and adding vectors raised recall@10 by about 8 points, mainly on conceptual queries. Self-run by the project author — [agentmemory](https://cdn.jsdelivr.net/gh/rohitg00/agentmemory@main/benchmark/REAL-EMBEDDINGS.md).
- A practitioner reports that the agent's own query rewriting does much of the work embeddings normally do. Blog-level evidence — [HackerNoon](https://hackernoon.com/lite/why-your-rag-system-doesnt-need-embeddings).

**Graphs**
- Zep's paper supports graphs on LongMemEval and on context savings — [Zep paper](https://arxiv.org/html/2501.13956). Contradiction detection still relies on LLM calls at ingest.
- In LLM wiki comments, one builder argues that Markdown suits general knowledge and a graph suits relational code structure. Opinion — [gist comments](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

**Structured records**
- OpenAI's cookbook pairs typed profile fields with free-form notes, and promotes stable, repeatedly confirmed preferences into structured fields — [OpenAI cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization).
- Claude Code adds a light typed layer: a frontmatter `type` on each note — [Claude Code docs](https://code.claude.com/docs/en/memory).
- Letta requires `name` and `description` frontmatter on each memory — [Letta docs](https://docs.letta.com/letta-code/memfs).

**Benchmark criticism**
- LoCoMo conversations average 16,000 to 26,000 tokens, fit in a modern context window, and test no knowledge updates. Zep made these points, as an interested party — [Zep, May 2025](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/).
- A self-published audit found 99 score-corrupting errors in 1,540 LoCoMo questions (6.4%), which caps a perfect system near 93.6%. The judge accepted 62.81% of deliberately wrong but topical answers — [Penfield Labs](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg). I could not open the audit repo itself.
- That audit calls LongMemEval-S a context-window test, not a memory test, at about 115K tokens per question. BEAM goes up to 10M tokens but brings its own problems — [Penfield Labs](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg).
- One analysis shows Zep's product scoring from 58.44 to 94.7 on LoCoMo, depending on who ran it and with which models — [BrainDetox](https://braindetox.kr/en/posts/memory_benchmark_scores_reliability_2026.html). Zep's own corrected 2025 figure was 75.14 — [Zep](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/).
- Mem0 lists LoCoMo at 92.5 and LongMemEval at 94.4 on one page, and 91.6 and 93.4 on another — [Mem0 research](https://mem0.ai/research-3); [Mem0 blog](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm).
- Multiple practitioners report being unable to reproduce published LoCoMo numbers, and one paper describes a refusal-matching bug in Mem0's reference runner — [ATANT v1.1](https://arxiv.org/pdf/2604.10981).
- Full context does not always win. On LongMemEval it scored 60.2%, under Zep's 71.2%, because very long context degrades the model too — [Zep paper](https://arxiv.org/html/2501.13956).

### Inferences
- Use a file-shaped store, kept in IndexedDB through the existing `storage.ts` seam. "File" here means a path, a body and frontmatter. It does not need a real filesystem.
- Add a small required frontmatter set: `description`, `kind`, `updated`, `writer`. This gives most of the benefit of structured records without a schema migration each time. It also feeds the index.
- Keyword search is the right first search tool on a phone. MiniSearch-style BM25 in the browser is cheap, offline and private. Semantic search can wait. If it is needed, OpenRouter embeddings are an option, but they would send note text out for embedding. This needs a privacy decision.
- A claimed LoCoMo score above the estimated 93.6% ceiling suggests judge leniency or a different question set. Treat any such figure as marketing until shown otherwise.
- ORFE needs no public benchmark. A 20-case eval built from Mikael's real usage across his main models would tell him more than any number in this section.

### Gaps
- No benchmark tests a personal store of a few hundred curated notes.
- No benchmark measures curation quality over time: drift, sprawl, or index health.
- No benchmark tests several models writing to one store.
- I did not get a direct comparison of files vs graph on the same small corpus.

## Do agent-driven memories beat automatic retrieval, and what makes models use memory tools well?

### Takeaway
Pure pull loses when the model has to decide to look something up without knowing what exists. The evidence favours a hybrid: a small map that is always visible, with bodies pulled on demand. Agent-driven retrieval beats single-pass search when the model can iterate. Tool design, explicit triggers and small evals matter more than the retrieval engine.

### Cited Findings

**Push vs pull**
- **[MEASURED, vendor, coding domain]** Baseline 53%, skill 53%, skill with explicit instructions 79%, always-visible 8KB docs index 100%. Vercel credits the absence of a decision point, availability on every turn, and no sequencing issues. Bodies were still read on demand, and the index only maps paths. Skills remain better for user-triggered workflows — [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals).
- **[MEASURED]** The ETH study found that context files gave no general gain in success and raised cost by over 20%. Repository overviews were not helpful. Agents did follow the instructions. Files were useful for non-standard practices — [Gloaguen et al., Feb 2026](https://arxiv.org/abs/2602.11988).
- These two conflict on the surface. Vercel's test covered APIs outside model training data, and ETH's covered repositories the agent could explore — [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals); [ETH](https://arxiv.org/abs/2602.11988).
- A December 2025 reverse-engineering post says ChatGPT pre-computes and injects summaries, while Claude calls search tools when context seems relevant. It frames the choice as continuity vs depth. One person's analysis, and may be dated — [Gupta, via scour](https://scour.ing/@emschwartz/p/https://manthanguptaa.in/posts/claude_memory).
- Hermes and Claude Code both run small injected memory plus on-demand search. Hermes puts the fixed cost at about 1,300 tokens per prompt — [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

**Agent-driven vs single-pass retrieval**
- Letta argues that agents can rewrite queries and keep searching, which beats single-hop retrieval. Whether an agent "remembers" depends mainly on knowing when and how to use its retrieval tool — [Letta, Aug 2025](https://www.letta.com/blog/benchmarking-ai-agent-memory).
- MemoryAgentBench shows the reverse risk: MemGPT, an agentic system, trailed simple RAG on many tasks. No architecture wins everywhere — [MemoryAgentBench](https://arxiv.org/html/2507.05257v1).

**What makes tool use work**
- Wording changes outcomes. "You MUST invoke the skill" made agents read docs first and anchor on them. "Explore project first, then invoke skill" did better — [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals).
- Anthropic advises few, consolidated tools rather than one per operation, description text written as for a new hire, unambiguous parameter names, natural-language identifiers rather than opaque IDs, and actionable errors. Natural-language names reduced hallucinations. Prefix vs suffix naming changed eval results, and the effect varied by LLM — [Anthropic, Sep 2025](https://www.anthropic.com/engineering/writing-tools-for-agents).
- Improving a tool description fixed a concrete bad habit (appending "2025" to searches) — [Anthropic, Sep 2025](https://www.anthropic.com/engineering/writing-tools-for-agents).
- Index shape: a compressed path map beat full text, and folder and file names act as signposts. Letta shows the tree plus frontmatter descriptions — [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals); [Letta, Feb 2026](https://www.letta.com/blog/context-repositories).
- A concrete rule of the "prefer the note that limits you" kind worked where a generic freshness cue did not — [Nakayashiki, Aug 2026](https://arxiv.org/abs/2608.25553).
- Read budget matters. In the same study selection of the critical path rose from 17.0% to 88.7% when more slots were available — [Nakayashiki, Aug 2026](https://arxiv.org/abs/2608.25553).
- The save criteria that recur: durable, actionable, stated or confirmed by the user, not derivable from elsewhere. Do not store speculation — [OpenAI cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization); [Claude Code docs](https://code.claude.com/docs/en/memory); [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
- Prompt stability counts. Hermes freezes the snapshot per session, and Manus warns against changing the prefix — [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory); [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).

### Inferences
- The likely resolution of Vercel vs ETH: passive context helps when it holds what the model cannot get elsewhere. Vault notes are exactly that. A summary of things the model could find by itself does not help. So the index should map, not summarise.
- This touches ORFE's "pulled, not pushed" rule, and it needs an explicit decision. A compact generated index in the system message is still model-driven retrieval, since no automation picks which body enters context. Only the map is pushed. Without it, the evidence suggests many relevant notes will never be read. The alternative is to rely on a first-turn `vault_list` call, which may fall short. Anthropic's forced protocol does this for Claude, and it is untested for other models.
- Freeze the index per chat, or per context window, so it does not disturb the prompt cache. It should sit near ORFE's existing system message work in `system.ts`, and be checked against the cold-cache fingerprint logic in `context.ts`.
- Keep the tool set small, perhaps four or five: `vault_list` or index, `vault_read`, `vault_search`, `vault_write` (create or update), `vault_move`. Use readable paths, not IDs.
- Each error should tell the model the next step, such as "this note is curated; move or tag it, or write a new note and link it".
- Instruction text should state when to read as well as when to write. It should describe when not to save, and how to handle a read note that looks out of date: re-check with the user or mark it, instead of silently relying on it.
- Because results vary by model, run the same small eval on each model Mikael uses. Test whether it reads when it should, whether it skips saving when it should, and whether it respects curated notes. The evidence supports evals over intuition on this.

### Gaps
- I found no study of push vs pull on personal memory. The best data is from coding.
- No evidence covers how OpenRouter's non-Claude models handle memory tools, beyond the general finding that behaviour varies by LLM.
- Whether a pushed index improves real ORFE outcomes is unknown until tested.
