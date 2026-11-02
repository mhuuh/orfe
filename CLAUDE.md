# ORFE

An OpenRouter chat PWA that runs on Mikael's Android phone. Live at https://mhuuh.github.io/orfe/ (public repo `mhuuh/orfe`; every push to `main` deploys via `.github/workflows/deploy.yml`).

- Design doc (the authority): `docs/superpowers/specs/2026-10-22-orfe-design.md`. Plans: `docs/superpowers/plans/` (Plans 1 and 3 are done; the roadmap for the rest is at the top of the Plan 1 file). Open follow-ups: `plan-1-followups.md` and `plan-3-followups.md` in the same folder.
- OpenRouter API facts: `docs/research/openrouter-api-2026-10.md`.
- Design system: `DESIGN.md` + `src/styles/tokens.css`. Use CSS variables only. The composer is the one glass object.

## Run and check
- `npm run dev` serves at http://localhost:5173/orfe/ (the base path matters).
- `npm test` runs Vitest unit tests (jsdom + fake-indexeddb).
- `npm run e2e` runs Playwright, Pixel 7, with OpenRouter mocked. `npm run typecheck:e2e` type-checks the e2e files.
- `npm run build` runs `tsc -b` + vite build, including the PWA service worker.

## Shape
- `src/lib/` is pure logic: `storage.ts` (the only Dexie seam), `openrouter.ts` (API + SSE), `normalise.ts` (send-time message shaping), `catalog.ts` (models, stale-while-revalidate cache), `send.ts` (generate/reroll/continue/stop; one AbortController per chat), `appUpdate.ts` (applies service-worker updates only when idle), `system.ts` (system message: prompt + capability note), `context.ts` (rolling window planner, cold-cache detection by request fingerprint, `viewWindow` for the UI), `search/` (`tokens.ts`: raw word plus Finnish and English Snowball stems; `termIndex.ts`: the `SearchIndex` term index, a Dexie seam like `storage.ts`).
- `src/bench/` is the `?bench` page: `main.tsx` imports it only for that query string, on its own `orfe-bench` database. The service worker precache leaves it out (`globIgnores` in `vite.config.ts`).
- `src/ui/` is React components. Writes to a Message always re-read inside a `db.transaction('rw', db.messages, …)`; never write back a live-query copy.
- No backend. The key lives in IndexedDB and is only sent to openrouter.ai.

## Gotchas
- E: is exFAT. TypeScript language servers and dev servers can ghost-lock folders (a git checkout or merge then fails with "cannot stat … Permission denied"). Stop the tsserver/node process holding it and retry.
- Playwright's headless shell doesn't render `backdrop-filter`. Use full Chromium for glass screenshots.
- `oddsandends.key` in the repo root is Mikael's OpenRouter key for small cheap tests, with a $5 limit. It is git-ignored and the repo is public: read it only from a script, and never print it, paste it or copy it anywhere. Print selected fields of a response, not the whole response, because `/key` returns a partial key in `label`.
- The Content Security Policy lives in `vite.config.ts` and is applied to builds only, so `npm run dev` and `npm run e2e` never exercise it. Any new origin (the relay, say) must be added to `connect-src`, and any change to it needs a check against `npm run build` plus `vite preview`.
