# How creative writing and roleplay tools keep long-running story memory, and how they protect curated material

Researched 2026-11-01. Evidence labels used below:
**[Docs]** = official tool docs or a repo README (says what the tool does, not whether it works).
**[Vendor]** = marketing or a company with something to sell.
**[Lore]** = community opinion with no measurement behind it.
**[Study]** = paper with measured results.
**[Old]** = dated material; check before relying on it.

## How do these tools structure memory, and what do users praise and complain about?

### Takeaway
Nearly every tool has converged on the same stack: fixed text that is always sent, keyword-triggered entries, a rolling summary or per-scene summaries, and optional embedding search. Lorebooks are trusted for exact facts because they are deterministic. Summaries are trusted least, because a summary that keeps getting re-summarised degrades. The 2026 trend is away from one running summary and toward small units that are attached to their source and can be reviewed.

### Cited Findings

**SillyTavern core**
- World Info entries have keys (keywords or regex), optional secondary filter keys, content, order, position and a strategy. Titles and keys are never sent to the model, so the content must stand alone. [Docs] — [ST World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- Activation modes are keyword, constant and vectorized (embedding similarity). A shared token budget caps the total. Constant entries go in first, then the others by order, and nothing further activates once the budget is used. [Docs] — [ST World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- Timed effects exist per entry: sticky (stays on for N messages), cooldown (cannot fire for N messages) and delay (cannot fire until the chat has N messages). Inclusion groups let entries compete so that only one is inserted. [Docs] — [ST World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- The built-in Summarize keeps one running summary. The docs warn that it can drop details or contain hallucinations, and say to monitor it and correct it by hand. It has an editable text box, Restore Previous and Pause. [Docs] — [ST Summarize](https://docs.sillytavern.app/extensions/summarize/)
- The built-in Summarize is criticised for "information loss over time" from re-summarising a single summary, described as a "jpeg compression artifact effect". [Lore] — [r/SillyTavernAI RFC thread, Feb 2026 mirror](https://reddit.sentinel-team.org/posts/1rbxdct/snapshots/2026-02-27T16%3A12%3A57.42274Z)
- Long-chat guidance: keep the prompt lean, do not rely on a larger context, keep about 5 to 8 recent messages visible, and put detail in keyword entries near the bottom of the prompt. The same guide says a summary may silently fail to appear in the prompt on some API and preset combinations, and that the old summary should be removed before generating a new one or errors compound. [Lore, with a worked example] — [RPWithAI](https://rpwithai.com/how-to-manage-long-chats-on-sillytavern/)
- Extras-based summarising (BART, about 1024 tokens of context) is the weak old path. [Old] — [ST Summarize](https://docs.sillytavern.app/extensions/summarize/). Smart Context is reported as deprecated in favour of native Vector Storage. [Old] — [TavernSprite, a vendor blog, Aug 2026](https://tavernsprite.com/blog/best-sillytavern-memory-extensions/)

**SillyTavern extensions**
- Qvink MessageSummarize stores one summary per message. Its author gives two main reasons: storage is not done by an LLM, so summaries do not degrade over time, and each summary belongs to its message, so editing or deleting a message affects only that memory. It uses no embeddings. Recent summaries rotate out by token limit. A user marks a message with a "brain" icon to keep it in long-term memory. [Docs] — [Qvink README](https://github.com/qvink/SillyTavern-MessageSummarize)
- Qvink's author advises a short summary prompt, temperature 0, and avoiding reasoning models because they are slow. It also has an option to freeze the injection threshold to preserve prompt caching. [Docs] — [Qvink README](https://github.com/qvink/SillyTavern-MessageSummarize)
- A user complains that MessageSummarize "can miss a lot of information and context" when the model writes long messages. [Lore] — [RFC thread](https://reddit.sentinel-team.org/posts/1rbxdct/snapshots/2026-02-27T16%3A12%3A57.42274Z)
- Memory Books turns marked scenes into editable lorebook entries. Types are scene memories, clips (one saved fact or line), topical clips, side prompts (trackers that overwrite their own entry) and consolidated tiers (Arc, Chapter, Book, Legend, Series, Epic). [Docs] — [Memory Books user guide](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md)
- Summaryception keeps the newest turns verbatim and promotes older snippets through compressed layers. Its defaults are 30 snippets per layer, 3 merged per promotion and 5 layers, and its claimed capacity is about 10,897 turns in about 15,500 tokens. The token figure assumes about 70 tokens per snippet. One fork says plainly that these are illustrative capacity estimates, not measured continuity, and that compression is lossy. [Docs; numbers are not evidence] — [Summaryception forks on GitHub](https://github.com/Lodactio/Extension-Summaryception), [Dogoo9 fork](https://github.com/Dogoo9/Extension-Summaryception)
- Summaryception was called "Easiest and works great" in one Reddit thread, reported second-hand. [Lore] — [RoboRhythms](https://www.roborhythms.com/sillytavern-memory/)
- Timeline-memory sends the full text of a stored chapter to a separate model with a specific question, so details lost in a summary can still be found. Its author says tool calling can be unreliable with thinking models and recommends a fill command for most users. One user called it "a lifesaver". [Docs and Lore] — [Reddit post mirror, Dec 2025](https://reddit.sentinel-team.org/posts/1pe5n6n/snapshots/2025-12-06T01%3A00%3A26.763531Z)
- CharMemory extracts memories every 20 messages into plain markdown files that the user can edit, and Vector Storage retrieves them. It warns that Consolidate, Replace All and Clear All "cannot always be undone". [Docs] — [CharMemory README](https://github.com/bal-spec/sillytavern-character-memory)
- Smart Memory has many tiers: long-term, session, rolling summary, scene history, story arcs, relationship history, profiles, per-character secrets, a state ledger, an entity registry and a canon document. [Docs] — [Smart Memory README](https://github.com/senjinthedragon/Smart-Memory)
- LoreVault, a hosted service, drew suspicion: "Seems a bit suss". One commenter still prefers periodic summaries with manual editing and has found nothing better. [Lore] — [Reddit mirror, Dec 2025](https://reddit.sentinel-team.org/posts/1pfah6d/snapshots/2025-12-06T01%3A00%3A26.763531Z)
- Roundups broadly agree on Qvink or Memory Books for most users, Summaryception for very long paid-API chats, and lorebooks for exact facts. These are SEO-style blogs, so treat this as a weak signal. [Lore] — [TavernSprite](https://tavernsprite.com/blog/best-sillytavern-memory-extensions/), [RoboRhythms](https://www.roborhythms.com/sillytavern-memory/)

**NovelAI, KoboldAI, RisuAI, Agnai, Kindroid**
- NovelAI Lorebook entries activate on keys or are Always On. Each entry has a search range, insertion order, position, token budget and reserved tokens. The title is not visible to the AI. [Docs] — [NovelAI Lorebook docs](https://docs.novelai.net/en/text/lorebook/)
- NovelAI docs say the Author's Note is inserted much closer to the recent text than Memory by default. [Docs] — [NovelAI Story Settings, Japanese](https://docs.novelai.net/ja/text/editor-jp/storysettings/)
- KoboldAI describes Memory as the summary on a book's dust jacket and the Author's Note as high-impact text close to the new prose. It suggests keeping the note under about 50 tokens. [Old] — [KoboldAI wiki](https://github.com/KoboldAI/KoboldAI-Client/wiki/Memory,-Author's-Note-and-World-Info)
- RisuAI lists HypaMemory V2/V3 and SupaMemory as compression systems. [Docs] — [RisuAI repo](https://github.com/kwaroran/Risuai). A Korean wiki describes Hypa as a helper AI that writes memory chunks, which embeddings then match to the current context. [Secondary] — [namu wiki](https://namu.moe/w/RisuAI)
- Kindroid splits memory into persistent (Backstory, Key Memories, examples, directives) and retrieved layers, including Cascaded Memory and trigger-phrase journals. A review gives limits of 2,500 characters for Backstory, 1,000 for Key Memories and 150 for the Response Directive. These details are from third-party guides and were not checked against Kindroid's docs. [Secondary] — [AI Companion Pick](https://aicompanionpick.com/ai-companion-memory-kindroid-nomi-replika-long-term-2026), [Messengerbot guide](https://messengerbot.app/kindroid-ai-in-2026-companion-app-guide-pricing-and-safety/)
- Kindroid users report characters forgetting key facts mid-conversation. The report is undated. [Lore] — [RoboRhythms](https://www.roborhythms.com/kindroid-memory-not-working/)

**Sudowrite and Novelcrafter (book-writing tools)**
- Sudowrite's Story Bible holds cards and traits. The Saliency Engine chooses what is relevant, with no user control beyond an eyeball toggle per card or trait. Everything is visible by default. [Docs] — [Sudowrite Saliency Engine](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/saliency-engine/4KL8gFeLZNvk8CEeXpfwB2)
- Sudowrite users report that the tool invents characters instead of using the Bible, gives traits that conflict with the story, and restates plot points. Most of this is older feedback; I found no 2026 reviews. [Lore, Old] — [feedback board](https://feedback.sudowrite.com/p/force-sudowrite-to-use-bible-characters-instead-of-inventing-new), [feedback item](https://feedback.sudowrite.com/feedback/34472), [ProWritingAid review](https://prowritingaid.com/sudowrite-review)
- Sudowrite's own advice is to keep sections consistent and delete outdated content, because conflicting information confuses the tool. [Docs] — [Sudowrite tips](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/tips--tricks/eBjBne7foMi8uYFxWEPCai)
- Novelcrafter's Codex splits each entry into fields the AI sees (description, aliases, details) and a Research tab for notes it does not use for prose. An AI Context setting chooses always, only when detected, or never. [Docs] — [Anatomy of a Codex entry](https://novelcrafter.com/help/docs/codex/anatomy-codex-entry)
- Novelcrafter advises small entries first, and warns that smaller models fixate on whatever details they are given. Vivid appearance details go in notes. [Docs] — [Guidelines for descriptions](https://www.novelcrafter.com/help/docs/codex/guidelines-for-descriptions)

### Inferences
- The consistent split is "deterministic text for facts" and "lossy text for gist". ORFE's notes should be read by the model as written, not regenerated, wherever a fact matters.
- The strongest design lesson is Qvink's: no LLM rewrite of a stored memory means no generational loss. Compression should work from originals each time, not from the previous compression.
- ORFE differs from these tools in one helpful way. Most of them have to guess when to fire (keywords, embeddings). A tool-using model can ask for a note by name. That removes keyword failure. It adds the failure that the model must know the note exists, so a short index in the prompt becomes the key part. This is my reasoning, not something the sources tested.
- Tool sprawl is a warning. Smart Memory's ten-odd tiers show how far the idea can go on a desktop. On a phone, with one person, a few note kinds will probably serve better.

### Gaps
- No independent test compares these extensions. Stars and "most recommended" claims are not evidence of quality.
- I found no reliable sources on how Agnai's memory book or chat tree work. Only passing third-party mentions came up.
- RisuAI's Hypa V3 exact behaviour was not documented in anything I could reach.
- NovelAI's Memory field is not described on its Lorebook page, and I found no official token guidance. The 2048-token figures I saw are likely dated.
- Reddit content came through mirrors and thin snapshots, so sentiment here is a small sample.

## What keeps character voice consistent over long chats?

### Takeaway
Verbatim samples beat descriptions in community opinion, and the one careful study supports a narrow version of that: a few samples beat none, while more samples add little. The bigger finding is that voice fades even when the persona text is still in context. So this is not only a storage problem, and samples probably need to stay near the current turn. No study measures fictional character voice directly.

### Cited Findings
- Study of 400+ real authors and 40,000+ generations per model: at 5 samples, GPT-4o's imitation passed authorship verification about 95 to 97% of the time on news and email, but 63.65% on Reddit and 19.37% on blogs. With zero samples, blog verification fell to about 8 to 10%. [Study] — [Catch Me If You Can? (EMNLP Findings 2025)](https://arxiv.org/html/2509.14543v1)
- The same paper tested 2, 4, 6, 8 and 10 samples and reports that adding more "affects the four metrics very little". This covers implicit style, with no style instructions. [Study] — [Catch Me If You Can?](https://arxiv.org/html/2509.14543v1)
- Long persona dialogues (100+ rounds, 7 models): the last round showed a 41.27% drop in persona-specific token patterns compared with baseline (95% CI 36.50 to 45.73%). Models drift back to default behaviour. The dialogues were 60k to 110k tokens and well inside each model's window, so overflow is not the cause. Larger models fade less, but significant gaps remain. [Study] — [Persistent Personas? (EACL 2026)](https://arxiv.org/html/2512.12775v2)
- That paper did not test restating the persona. It suggests, without testing, retrieving relevant dialogue history alongside the persona text. [Study] — [Persistent Personas?](https://arxiv.org/html/2512.12775v2)
- Fidelity fell faster in goal-oriented dialogue than in persona-directed dialogue. [Study] — [Persistent Personas?](https://arxiv.org/html/2512.12775v2)
- PersonaForge reports 6.3% drift against a 24.8% baseline over 50 turns. These are self-reported figures on the authors' own benchmark, seen only in a search snippet. [Study, unverified] — [ACL author page](https://aclanthology.org/people/sirui-zou/)
- MRPrompt, a prompt-only method, structures persona text into facets and adds an explicit protocol for long-term against short-term memory. Gains are real but small: Qwen3-4B went from 7.85 to 8.07 on a 10-point scale. The schema contributed more than the protocol. Smaller models gain most. [Study] — [MRBench (2026)](https://arxiv.org/html/2603.19313v1)
- SillyTavern example messages are "only kept until chat history fills up the context". Blocks are dropped one at a time as chat grows, unless the user forces them to stay. [Docs] — [ST Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)
- SillyTavern's Character's Note injects text at a fixed depth from the newest message and is often used to reinforce traits. [Docs] — [ST Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)
- Sudowrite has a 40-word Style field and a separate 1,000-word Style Examples allowance. Match My Style takes up to 2,000 words and compresses them to 40. Users call 40 words "very restrictive". Dates are unclear. [Vendor, Old] — [feedback post](https://feedback.sudowrite.com/p/better-style-controls-longer-instructions-multiple-labeled-style-examples), [changelog](https://feedback.sudowrite.com/changelog/22411). Sudowrite says more examples give a tighter match. [Vendor] — [Sudowrite blog](https://sudowrite.com/blog/ai-keeps-your-voice/)
- Novelcrafter says sample lines can help capture voice, but keep that detail only if it is prominent in the prose. [Docs] — [Guidelines for descriptions](https://www.novelcrafter.com/help/docs/codex/guidelines-for-descriptions)
- Ali:Chat, the classic community method, uses dialogue to express traits, and adds the character's name in actions every 2 to 3 sentences in long examples. The guide marks itself as outdated. [Lore, Old] — [Ali:Chat guide](https://docs.google.com/document/d/1qvcvZWhp24p14dsMlmj7vN4cM5RTDSj0gLaZSl1PPO8/mobilebasic)
- "One well-written dialogue example teaches a model more than a paragraph of adjectives" is widely repeated, with no evidence given. [Lore] — [Meganova](https://blog.meganova.ai/character-ai-voice-tone-writing-better-prompts/)

### Inferences
- Start with about 3 to 5 short verbatim samples per voice. The data says going from 5 to 10 buys little. The size estimate is my arithmetic: 5 samples of 60 to 100 words cost roughly 400 to 650 tokens each turn, at about 1.3 tokens per word. Per character, per turn, that is not small, so send samples only for those in the scene.
- Pick samples for range rather than count. Lore favours this (angry, tender, deflecting), but I found no test of it.
- The "voice fades inside the window" result suggests position may matter as much as presence. A sample at the top of a 100k-token prompt may fade. A short reminder near the end, like a Character's Note, is the common fix. It is lore-supported and untested. This also interacts with ORFE's prompt cache: text near the end costs less cache damage, as the RPWithAI guide also notes.
- Mikael wants voice samples to be a protected verbatim class. The evidence supports that: Sudowrite's compression to 40 words is exactly the description-based path that users dislike, though nobody measured it.
- Blogs scoring far below news suggests informal, personal voice is the hardest kind. Fiction voice may behave more like blogs than news, so expectations should stay modest. That mapping is my guess.

### Gaps
- No study tests verbatim samples against voice descriptions for fictional characters in long sessions.
- The per-count numbers in Catch Me If You Can are in figures, which I could not read. The "very little" statement is the authors' words.
- I found no measured token budgets for voice samples from any community source.
- Restating the persona during a long chat was not tested in anything I found.

## How do tools track plot state, keep plans from being treated as past events, and find contradictions?

### Takeaway
State tracking is well served and planned-event handling is poorly served. Almost no tool has a real "planned, not yet happened" concept. Tools prevent leaks mainly by hiding future material from the model altogether. Contradiction checkers exist but miss a lot, so they suit flagging, not automatic repair. The studies show that planning and fact errors are hard for current models even with memory added.

### Cited Findings

**Plot and state tracking**
- Novelcrafter progressions are additions to a Codex entry, seen by the AI only for scenes at or after the point where they were added. If you go back to an earlier scene, they are not in the context. The docs say to use them instead of overwriting the description. [Docs] — [Novelcrafter progression additions](https://docs.novelcrafter.com/en/articles/8675593-progression-additions), [Guidelines](https://www.novelcrafter.com/help/docs/codex/guidelines-for-descriptions)
- Smart Memory tracks story arcs (resolved arcs get a summary), a state ledger, and "Perspectives & Secrets": per-character knowledge, suspicions, false beliefs, unawareness and concealment, extracted at scene breaks. It has no dedicated planned-event feature. [Docs] — [Smart Memory README](https://github.com/senjinthedragon/Smart-Memory)
- zTracker, forked from WTracker, can run several modules in one chat, such as a scene tracker plus an agenda tracker. [Docs] — [zTracker](https://github.com/Zaakh/SillyTavern-zTracker)
- Doom's Enhancement Suite has scene fields the AI fills in with every response. [Docs] — [Doom's Enhancement Suite](https://github.com/DangerDaza/Dooms-Enhancement-Suite)
- Memory Books side prompts are trackers that overwrite their own entry rather than adding a new memory each run. [Docs] — [Memory Books user guide](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md)
- Timeline-memory gives each chapter an id, a message range and a summary, and presents them as a timeline. [Docs] — [Reddit post mirror](https://reddit.sentinel-team.org/posts/1pe5n6n/snapshots/2025-12-06T01%3A00%3A26.763531Z)

**Keeping plans and secrets from leaking**
- Sudowrite documents the exact failure: a murderer's Motive trait may be judged relevant to a scene and reveal the twist early. The fix is to hide that trait, and the AI then "will ignore it altogether". [Docs] — [Sudowrite Saliency Engine](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/saliency-engine/4KL8gFeLZNvk8CEeXpfwB2)
- Novelcrafter warns that the AI uses everything in an entry, so future plot points leak into prose. Its advice is to include only what you want used. [Docs] — [Guidelines for descriptions](https://www.novelcrafter.com/help/docs/codex/guidelines-for-descriptions)
- NCP-Bench names "triggering unknown facts" as a failure class: naming a villain before the story supplies the evidence. [Study] — [NCP-Bench (ICML 2026, arXiv Aug 2026)](https://arxiv.org/html/2608.08160)
- A paper on game NPCs found hidden background secrets can be drawn out of an NPC by prompt injection, with a "pretend this is a dream" framing as the example. [Study] — [arXiv 2508.19288](https://arxiv.org/pdf/2508.19288v1)
- A community technique injects short instructions from a lorebook, with one specific trigger word, to fire a beat at a chosen moment. Sticky then holds it for N messages. The guide has no mechanism for stopping an event firing early, and its claim that System-position entries cost no tokens is unverified. [Lore] — [sphiratrioth666 guide](https://huggingface.co/sphiratrioth666/Lorebooks_as_ACTIVE_scenario_and_character_guidance_tool)
- SillyTavern's delay setting blocks an entry until the chat has N messages. That is message-count gating, not story gating. [Docs] — [ST World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)

**What studies say about plans and memory**
- NCP-Bench uses 100 environments derived from movie synopses. It checks invariant, ordering and achievement commitments. The best model, GPT-5.2, reached 42% survival after 20 turns, and only 3.5% of all runs reached 100 turns. [Study] — [NCP-Bench](https://arxiv.org/html/2608.08160)
- Fact conflicts were the most frequent failure, in 40 to 68% of interactions across models. Commitment conflicts ranged from 24 to 54%. [Study] — [NCP-Bench](https://arxiv.org/html/2608.08160)
- Adding hierarchical memory (HiAgent) to GPT-4o-mini cut commitment conflicts from 26% to 4% and raised average turns from 22.16 to 30.05. But player-input conflicts rose from 13% to 38%, fact conflicts barely moved (60% to 59%), and runs satisfying everything went from 2 to 0. The authors suggest compression abstracts away concrete player actions. [Study] — [NCP-Bench](https://arxiv.org/html/2608.08160)
- A tendency to accommodate player claims over established facts was exploited by adversarial inputs. A human narrator pilot resolved all 19 interventions, reached all 13 trajectory nodes and met 7 of 12 commitments, including all achievement goals. [Study] — [NCP-Bench](https://arxiv.org/html/2608.08160)

**Finding contradictions**
- ConStory-Bench: 2,000 prompts, 8k to 10k words each, 21 systems, 5 categories and 19 subtypes. Errors per 10,000 words ranged from 0.113 (GPT-5-Reasoning) to 3.664. Gemini-2.5-Pro scored 0.305 and Claude-Sonnet-4.5 scored 0.520. [Study] — [Lost in Stories (ACL Findings 2026)](https://arxiv.org/html/2603.05890v1)
- Factual detail and timeline errors dominate. Facts cluster at 15 to 30% of a story, and their contradictions at 40 to 60%. Geographic and absolute-time contradictions have the longest gaps (about 30% of story length). Perspective confusions have the shortest (4.7%), which suggests local failure. Narrative-style errors barely correlate with other categories. [Study] — [Lost in Stories](https://arxiv.org/html/2603.05890v1)
- Errors rise roughly linearly with length, though the correlation varies widely by model (r = 0.478 to 0.973). [Study] — [Lost in Stories](https://arxiv.org/html/2603.05890v1)
- ConStory-Checker found injected errors with 0.884 precision and 55.0% recall (F1 0.678). Human annotators reached 17.1% recall (F1 0.281). The paper text and table disagree on one figure (GRR), which a reader should note. [Study] — [Lost in Stories](https://arxiv.org/html/2603.05890v1)
- FlawedFictions: on short stories (about 731 words) Claude 3.5 Sonnet matched humans at 0.76 accuracy. On about 2,703 words the best accuracy was 0.61, and the best full-score result (0.53) barely beat always answering "no error" (0.51). More reasoning effort did not reliably help. [Study] — [Finding Flawed Fictions (2025)](https://arxiv.org/html/2504.11900v1)
- Smart Memory's continuity checker compares the last reply against stored memories, the character card and the persona. It can queue a one-shot correction for the next reply, which the user can cancel. Conflicting memory pairs get a warning. [Docs] — [Smart Memory README](https://github.com/senjinthedragon/Smart-Memory)
- Smart Memory also retires a memory when a new one changes the fact, using a phrase check and then a model question. Retired items remain viewable but are not injected. [Docs] — [Smart Memory README](https://github.com/senjinthedragon/Smart-Memory)

### Inferences
- "Hide it" is the industry's answer to leaks, and the reason is plain: if the model can read a plan, it may use it. ORFE's private notes are a harder case, since the model must read the plan to steer toward it. So labels alone will not do the whole job. Keep planned beats in a separate note, loaded on request and marked with status (planned, seeded, happened, dropped), rather than mixed into story state.
- Writing plans as conditions, not events ("When X learns Y, Z may follow"), may reduce past-tense confusion. No source tested this. It is my suggestion.
- NCP-Bench's three commitment kinds are a neat ready-made vocabulary for notes: things that must stay true, things that must happen in order, and goals.
- The HiAgent result is the most useful single number here. Memory compression helped plans and hurt respect for what the user just did. So the user's concrete recent actions should stay verbatim, and notes should not stand in for them.
- Fact and timeline slips dominate, so a small state ledger (where people are, what day it is, who holds what) probably returns more than rich character prose. Location and absolute time deserve explicit fields, given the long gaps.
- Checker recall of about 55% at best, and weak scores on stories over 2,700 words, mean the model should raise a flag rather than fix on its own. Precision of 88% suggests flags would mostly be real. That figure comes from injected errors, so real-world precision may be lower.
- A user-triggered "check this chapter against the notes" fits better than a check every turn, for cost and for trust.
- Who-knows-what tracking exists, but only as an extraction feature. I could not find any evidence that it works.

### Gaps
- I found no tool with a true "planned, not yet happened" status, and no tested technique for stopping plans being narrated as past events. All of the advice here is hide-or-trigger.
- No study measures who-knows-what tracking in long fiction specifically.
- I could not determine how DOME and other memory-enhanced agents scored by category in ConStory. It was not in what I read.
- Sudowrite and Novelcrafter's contradiction-checking features were not found. I did not search them separately.

## How do tools separate protected verbatim content from notes the machine may rewrite?

### Takeaway
No tool has a clean, general "locked block inside an editable note" feature. Protection comes from three plainer patterns: keep protected text in a separate container the machine cannot write to, make every rewrite a preview the user accepts, and keep the original when a new summary is made. Memory Books is the best worked example.

### Cited Findings
- Memory Books consolidation never runs by itself. The user confirms it, and previews let the user edit, accept or regenerate before saving. [Docs] — [Memory Books user guide](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md)
- Memory Books compaction shows the original next to the draft. It "should never silently replace the original", and replacement needs a button press. [Docs] — [Memory Books user guide](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md)
- Source entries can optionally be disabled after a consolidation. The guide does not describe deleting them. A source cannot be regenerated while an active parent depends on it. [Docs] — [Memory Books user guide](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md)
- Before saving a regeneration, Memory Books rechecks the source and target, and will not overwrite if either changed during generation. [Docs] — [Memory Books user guide](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md)
- Clips hold single saved facts or lines, with a `[STMB Clip]` marker. Topical Clips exclude Clip and Side Prompt entries as sources. [Docs] — [Memory Books manual](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/userguides/1%20Memory_Books_AI_Reference_Manual.md)
- Memory Books added recoverable consolidation checkpoints in v9.3.0, and consolidation previews in v6.9.0. So these protections arrived over months, not at launch. The changelog does not state why. [Docs] — [Memory Books changelog](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/changelog.md)
- Memory Books' "lock" means something else: it ties a character to one book across chats. A locked book stays shared rather than being copied on branch. [Docs] — [Memory Books user guide](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md)
- Qvink keeps summary storage away from the LLM, so nothing degrades in storage. [Docs] — [Qvink README](https://github.com/qvink/SillyTavern-MessageSummarize)
- CharMemory's Consolidate has a preview and undo, but it warns that bulk operations cannot always be undone and advises backing up first. The README does not say whether hand edits survive later extraction. [Docs] — [CharMemory README](https://github.com/bal-spec/sillytavern-character-memory)
- Smart Memory states that consolidation merges near-identical entries, and does not state any exemption for manual entries. Canon can be edited by hand, but Canon is itself synthesised. [Docs] — [Smart Memory README](https://github.com/senjinthedragon/Smart-Memory)
- Novelcrafter's split between AI-facing Description and the Research tab is a visibility boundary, not a write lock. Its progressions are additive: they add to the entry instead of overwriting it. [Docs] — [Anatomy of a Codex entry](https://novelcrafter.com/help/docs/codex/anatomy-codex-entry), [Guidelines](https://www.novelcrafter.com/help/docs/codex/guidelines-for-descriptions)
- Sudowrite's Match My Style replaces a verbatim sample with a 40-word compressed version, which shows the risk of treating curated text as input to summarising. [Vendor] — [changelog](https://feedback.sudowrite.com/changelog/22411)
- Summaries cause measurable harm. In FlawedFictions, LLM summaries raised plot-hole detection from 0.31 to 0.45, and one example dropped an event so that the rest contradicted itself. [Study] — [Finding Flawed Fictions](https://arxiv.org/html/2504.11900v1)

### Inferences
- A rule that the model may not edit curated text is weak if it is only an instruction. It should be enforced in code: the tool layer refuses writes to protected items, and the tidy job never receives their text for rewriting.
- "Reorganising is welcome" fits neatly here. Protected text can be moved, tagged, grouped, indexed and linked without touching a byte. So tidying can act on metadata and pointers. A hash of each protected block would allow a mechanical check that nothing changed. No tool I found does exactly this. It is my suggestion.
- Two granularities seem to be needed. Whole items (a poem, a recipe) are simple. A quoted block inside an editable note is the harder case, and nobody has solved it visibly. The cleanest way out is to avoid it: keep the block as its own item, and let the editable note hold a reference to it. The model then edits the note and the reference survives.
- The shift from silent automatic rewrites to edits with a preview and undo looks like the community's hardest-won lesson. Even so, on a phone a user will not review every change. Previews fit well for rare big tidies. A cheap undo log fits small routine edits.
- Keeping old versions, as Memory Books does by disabling rather than deleting sources, makes tidying safe. An automatic tidy that deletes its input can never be undone.

### Gaps
- I found no tool with inline locks, canon-versus-draft states on spans of text, or quoted blocks that survive rewriting inside an editable note. It may exist in a tool I missed.
- I could not confirm how Memory Books consolidation treats hand-written entries or Clips. The part of the manual I read does not say.
- I found no user reports of curated content being destroyed by automatic tools, though the warnings suggest it happens. This is not evidence either way.

## How do branching tools handle memory when a reply is rerolled or a branch is abandoned?

### Takeaway
This is still poorly solved, and users are asking for it. Two patterns work: attach memory to the message that produced it, so it goes away when the message does, and copy the memory store when a branch is made. Global long-term memory does not roll back in most tools. The best rollback system so far arrived only in late 2026, and is opt-in, and needed fixes within weeks. That shows how hard it is to add afterwards.

### Cited Findings
- SillyTavern checkpoints are named branches, and branches are essentially separate chat files. [Docs] — [Timelines extension](https://github.com/city-unit/SillyTavern-Timelines)
- The Timelines extension displays chats as a tree, like Loom. It can branch from any chat or swipe and shows swipes on earlier messages. It handles navigation only, and I found nothing about memory in it. [Docs] — [Timelines extension](https://github.com/city-unit/SillyTavern-Timelines)
- World Info timed effects reset if the chat does not advance, such as after a swipe or deletion. [Docs] — [ST World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- Built-in Summarize stores the summary in metadata of the last message in context at generation time. Deleting or editing that message reverts to the last valid summary. Rerolls are not addressed specifically. [Docs] — [ST Summarize](https://docs.sillytavern.app/extensions/summarize/)
- Qvink attaches summaries to messages. Edited, swiped or continued messages can be re-summarised automatically. Its todo list still includes "Handle swiping, editing, and deleting summaries", so this area may be incomplete. [Docs] — [Qvink README](https://github.com/qvink/SillyTavern-MessageSummarize)
- Memory Books copies unlocked books on branching by default, so a branch has independent memory. If copying is off, the branch writes to the parent's books. [Docs] — [Memory Books user guide](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md)
- Memory Books added opt-in Memory Auto-Rollback in v9.0.0 (29 Aug 2026), covering checkpoints, memories, consolidations, linked copies and side prompts. It was marked breaking. Fixes followed in v9.3.0 ("Fix auto-rollback for branches and checkpoints"), v9.3.2 and v9.3.13 (1 Nov 2026). [Docs] — [Memory Books changelog](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/changelog.md)
- A version 2 side-prompt snapshot stores the prior entry content, whether the entry existed before the run, the source chat and message range, and a fingerprint of what was written. Version 1 snapshots cannot be rolled back. [Docs] — [Memory Books manual](https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/userguides/1%20Memory_Books_AI_Reference_Manual.md)
- Smart Memory long-term memories are shared across a character's chats and do not roll back on a checkpoint or branch. Its answer is a read-only mode, turned on before branching, with a commit-or-discard choice on exit. Editing or hiding a processed message does not update memories already extracted from it. [Docs] — [Smart Memory README](https://github.com/senjinthedragon/Smart-Memory)
- A user asked for memory that follows only the active branch, so that information from different storylines does not mix. Nobody answered in the captured thread. [Lore] — [Reddit post mirror](https://reddit.sentinel-team.org/posts/1pe5n6n/snapshots/2025-12-06T01%3A00%3A26.763531Z)
- Loom gives each completion its own node in a tree, with a pane for sibling nodes. It targets base-model text generation and treats the tree as the document. The Obsidian version is desktop-only. [Docs, older tool] — [Loom on Obsidian](https://community.obsidian.md/plugins/loom), [DeepWiki](https://deepwiki.com/cosmicoptima/loom)

### Inferences
- The clean model for ORFE is event sourcing: each tool write records which message caused it, and what the note was before. If a reply is rerolled, the app can undo that reply's writes. This is what Qvink's attachment and Memory Books' snapshots each do in part. Building it from day one is far easier than adding it later, as the Memory Books changelog shows.
- Reroll has two cases that should not be treated alike. A reroll of a reply that made no notes needs nothing. A reroll of a reply that made notes should undo them, or ask. Going back to an old branch needs the notes as they stood there, so the state of a note should be derivable per branch.
- Not all notes should roll back. A real-world list or a recipe added during a story should survive an abandoned branch. Story state should follow the branch. So scope belongs to the note kind: branch-scoped against global. This matches Memory Books' locked (shared) against unlocked (copied) books. In ORFE, curated content looks like global scope, and plot state looks like branch scope.
- Deferring writes helps. If notes are saved only after a reply is accepted (the user sends the next message), rerolls are harmless by default. The cost is that a reply's notes are not visible until then. Nobody documents this approach. It is my suggestion, and it deserves comparison with undo.

### Gaps
- The exact triggers and limits of Memory Books Auto-Rollback were in a part of the manual I could not read.
- I found no measured data on how often users reroll after notes were written, or what they expect.
- I found no description of how Loom-style tools handle external notes. They seem to keep everything in the tree. My sources on Loom were thin, and much of that work is base-model era.
- How Kindroid, NovelAI, RisuAI and Agnai treat memory on reroll was not found.

## What careful studies or writeups exist on LLM fiction memory and narrative consistency?

### Takeaway
There is now real work, mostly from 2025 and 2026. It agrees on four points: consistency errors are common and grow with length, facts and timelines fail most, fluent prose does not predict consistency, and memory architectures help less than their authors hope. Almost nothing measures the tools hobbyists actually use.

### Cited Findings
- Lost in Stories / ConStory-Bench (ACL Findings 2026): see the numbers in the plot section. Models differ a lot, by over 30 times on errors per 10k words. [Study] — [arXiv 2603.05890](https://arxiv.org/html/2603.05890v1)
- NCP-Bench (ICML 2026): "high linguistic quality does not guarantee commitment preservation". [Study] — [arXiv 2608.08160](https://arxiv.org/abs/2608.08160)
- Finding Flawed Fictions (2025): LLM rewrites introduce plot holes. Summaries rose about 50% for the best model, and contemporary adaptations about 100%, up to 278% for the worst. [Study] — [arXiv 2504.11900](https://arxiv.org/html/2504.11900v1)
- Persistent Personas? (EACL 2026): fidelity fades without context overflow. [Study] — [arXiv 2512.12775](https://arxiv.org/html/2512.12775v2)
- Catch Me If You Can? (EMNLP Findings 2025): sample counts past a few add little. [Study] — [arXiv 2509.14543](https://arxiv.org/html/2509.14543v1)
- MRBench (2026): role-play framed as memory use, with four abilities: anchoring, selecting, bounding and enacting. Upstream memory ability only moderately predicts enactment (r = 0.35). [Study] — [arXiv 2603.19313](https://arxiv.org/html/2603.19313v1)
- SCORE (2025) combines state tracking, summaries and TF-IDF retrieval. Its reported gains vary by version. The v6 table shows GPT-4 consistency rising from 83.21 to 85.61, while an export mirror claims 23.6% higher coherence. These conflict, so the smaller figure is the safer reading. [Study, conflicting] — [SCORE v6](https://arxiv.org/pdf/2503.23512v6), [export mirror](https://export.arxiv.org/pdf/2503.23512)
- DOME (NAACL 2025) pairs a dynamic hierarchical outline with a temporal knowledge graph memory. [Study] — [DOME paper](https://preview.aclanthology.org/moar-dois/2025.naacl-long.63.pdf)

### Inferences
- Model choice matters more than any memory trick in these figures. ConStory's spread between models dwarfs SCORE's gain. ORFE's per-turn model choice is therefore a memory feature in its own right, and a strong model may be worth using for note-writing or checks.
- Fancy structure buys little at measured level. A knowledge graph on a phone is hard to justify from this evidence. Plain notes plus a good index look like the sensible start.
- These benchmarks fall short of ORFE's case. ConStory stories are 8k to 10k words in one shot, and NCP-Bench uses adversarial players and strict pass-fail rules. With cooperative players, commitment conflicts fell from 26% to 9% and average turns doubled from 22.16 to 46.08, though player-input conflicts rose from 13% to 18% and most runs still ended in conflict ([NCP-Bench](https://arxiv.org/html/2608.08160)). Mikael is a cooperative co-writer, so results for him may be better than the headline numbers, but they will not be clean.

### Gaps
- I found no study of SillyTavern-style lorebooks, summaries or extensions under controlled conditions.
- I found no long-term study over months of real use, which is what ORFE faces.
- I found no study of model-maintained notes for fiction, tool-driven or otherwise. HiAgent inside NCP-Bench is the closest.
- Several figures reached me through a summarising fetch of long papers. The first 100k characters were read, and later sections were not. Verify any number before quoting it in a design decision.
