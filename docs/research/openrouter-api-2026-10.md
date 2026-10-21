# OpenRouter API notes for a browser-only PWA (researched 2026-10-21)

Source: a research pass over openrouter.ai/docs plus live probes. **(tested)** = confirmed by a live request, not just docs.

## 1. Browser calls
- CORS open (tested): preflight from any origin → 204, `Access-Control-Allow-Origin: *` on `/chat/completions`, `/models`, `/models/{a}/{s}/endpoints`, `/key`. Allowed headers include `Authorization`, `Content-Type`, `HTTP-Referer`, `X-Title`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`, `X-OpenRouter-App-Visibility`, `X-Session-Id`. Exposed: `X-Generation-Id`, `X-Provider-Name`, `request-id`.
- Attribution (docs/app-attribution): `HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-App-Visibility: hidden` keeps it out of rankings.
- Keys in the browser: docs advise a credit limit on any key used client-side.
- OAuth PKCE (docs/use-cases/oauth-pkce): redirect to `https://openrouter.ai/auth?callback_url=<URL>&code_challenge=<C>&code_challenge_method=S256` → callback `?code=` (single use, 10 min) → `POST /api/v1/auth/keys {code, code_verifier, code_challenge_method}` → `{key}`. Optional `key_label`, `state`. CORS on `/auth/keys` not documented: probe it.

## 2. Models
- `GET /api/v1/models` works without auth (tested), `Cache-Control: public, max-age=120`. Filters: `output_modalities` (default `text`, `all` allowed), `category`, `supported_parameters`.
- Output modalities seen: text, image, embeddings, speech, video, transcription, rerank, decisions, audio. `all` → 691 models.
- Fields: `id`, `canonical_slug`, `name`, `created`, `description`, `context_length`, `architecture{input_modalities, output_modalities, tokenizer}`, `pricing{prompt, completion, image, request, …}` (USD/token strings; cache rates can appear), `top_provider{context_length, max_completion_tokens}`, `supported_parameters[]`, `default_parameters`, `supported_voices`, `knowledge_cutoff`, `expiration_date`, `reasoning{default_effort, default_enabled, mandatory, supported_efforts, supports_max_tokens}`.
- `GET /api/v1/models/{author}/{slug}/endpoints` (no auth, tested): per provider `supports_implicit_caching`, pricing, uptime.

## 3. Streaming
- `stream:true`, `data: {json}` lines, ends `data: [DONE]`. Skip lines starting with `:` (keep-alives like `: OPENROUTER PROCESSING`).
- Pre-stream errors: JSON + HTTP status. Mid-stream: status already 200; final event has top-level `error{code,message,metadata}` and `finish_reason:"error"`. Failover only before first token.
- Last chunk carries `usage` (always included; `usage.include` / `stream_options.include_usage` no longer needed): `prompt_tokens`, `completion_tokens`, `cost`, `prompt_tokens_details{cached_tokens, cache_write_tokens}`, `completion_tokens_details{reasoning_tokens}`.
- Abort = cancel; billing stops only on providers that support cancellation.

## 4. Reasoning
- Request `reasoning:{effort: max|xhigh|high|medium|low|minimal|none, max_tokens, exclude, enabled}`; effort or max_tokens, not both. Unsupported efforts map to nearest. Reasoning counts against `max_tokens`.
- Stream: `delta.reasoning` (string) and `delta.reasoning_details[]` (`reasoning.text` / `reasoning.summary` / `reasoning.encrypted`, with `format` like `anthropic-claude-v1`).
- Multi-turn: send back `reasoning` / `reasoning_details` on the assistant message, unmodified. Cross-model passing undocumented → strip when model changes (our inference).
- `configuration_update:{reasoning:{effort}}` on a system message changes effort mid-conversation without breaking cache (OpenRouter extension).

## 5. Prompt caching (docs/features/prompt-caching)
| Provider | Mode | Breakpoints | TTL | Min tokens |
|---|---|---|---|---|
| OpenAI < GPT-5.6 | automatic | – | – | 1024 |
| OpenAI GPT-5.6+ | automatic, or explicit `prompt_cache_breakpoint` | – | 30 min / 12 h | 1024 |
| Anthropic | top-level `cache_control` (auto) or per-block | 4 | 5 min or `ttl:"1h"` | 512–4096 |
| Qwen (Alibaba) | explicit only | – | 5 min | – |
| Gemini 2.5+ | implicit, or explicit (last breakpoint used) | – | ~3–5 min | 1024 / 4096 |
| DeepSeek, Grok, Moonshot, Groq, Z.AI | automatic | – | – | – |
- Anthropic: write 1.25× (5 min) / 2× (1 h), read 0.1×.
- Stickiness: follow-ups go to the same provider; session expires after 10 min idle. `session_id` (body) or `x-session-id` header pins from the first request. Skipped if `provider.order` set.
- Keep the prefix identical; variable content last.

## 6. Multimodal
- Image in: `{type:"image_url", image_url:{url: https or data:base64}}`, png/jpeg/webp/gif, text part first.
- PDF in: `file` content part; `plugins:[{id:"file-parser", pdf:{engine:"cloudflare-ai"|"mistral-ocr"|"native"}}]` (cloudflare-ai free). Exact part JSON: verify in OpenAPI spec.
- Audio in: `{type:"input_audio", input_audio:{data: base64, format:"wav"|"mp3"|…}}`.
- Video in: `{type:"video_url", video_url:{url}}`.
- Image out in chat: `modalities:["image","text"]`, optional `image_config{aspect_ratio}`; non-stream returns `message.images[{image_url:{url:data:…}}]`. Streaming shape undocumented → test.
- Image endpoint: `POST /api/v1/images {model, prompt, aspect_ratio, resolution, size, stream}` → `data[{b64_json, media_type}]`.
- Audio out in chat: `stream:true`, `modalities:["text","audio"]`, `audio:{voice, format}` → `delta.audio{data, transcript}`.
- TTS: `POST /api/v1/audio/speech {model, input, voice, response_format, speed, instructions}` → raw bytes. STT: `POST /api/v1/audio/transcriptions`.
- Video gen: async. `POST /api/v1/videos` → 202 + id; poll `GET /api/v1/videos/{id}`; fetch `/videos/{id}/content` (needs Bearer → blob URL) or signed `urls`. Models: `GET /api/v1/videos/models`.

## 7. Messages
- Roles: system, user, developer, assistant, tool. `name` allowed (prepended as `{name}: ` for non-OpenAI). Assistant messages accept an optional `model` field.
- Same-role merging / alternation: undocumented → handle client-side.
- Context compression: `plugins:[{id:"context-compression"}]`; off by default except ≤8k endpoints.

## 8. Other
- Prefill: end with an assistant message (provider support varies).
- `stop`, `seed` supported; unsupported params ignored.
- `GET /api/v1/generation?id=` (Bearer): cost, cache_discount, native tokens, provider, latency. `X-Generation-Id` header is exposed.
- `GET /api/v1/key`: limit, limit_remaining, usage (daily/weekly/monthly). `/credits` needs a management key → not usable.
- Web search: `:online` suffix, `plugins:[{id:"web"}]`, or `openrouter:web_search` server tool; citations in `message.annotations[]` (`url_citation`).
- Structured outputs: `response_format:{type:"json_schema", …}`.
- `~anthropic/claude-sonnet-latest` style "latest" slugs exist.
