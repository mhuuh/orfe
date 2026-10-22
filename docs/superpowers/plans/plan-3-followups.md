# Plan 3 — open follow-ups

Left open after Plan 3's reviews. None blocks daily use.

## Check on the real phone
- The lens: scrolling should stay smooth and the rim should line up with the glass edge. If the middle looks too busy, raise the composer tint before touching the lens.
- One Anthropic reply that hits the cache should show a sensible tokenRatio. This assumes prompt_tokens includes cached tokens.
- The "updated in another tab" toast should never appear during a normal update.

## From the reviews
- (T6) There is no h1 once a chat is loaded, and the title button has no "Chat settings" hint for screen readers.
- (T6) A prompt-swap divider and the context marker can stack as two hairlines.
- Switching a chat between token and message mode keeps the stored window start. Reset context window clears it.
- (T1) versionchange close() mid-stream → final snapshot write may reject unhandled (rare; recoverInterrupted settles)
- (T2) no test for missing ref + note off via systemFor; no test pinning untrimmed prompt text
- (T3) 32-bit hash collision → rare false warm; hashing data URLs later (Plan 6)
- (T3) estimate ignores "…" filler and \n\n joins
- (T4) reroll before the stored start overwrites lastRequest → next turn reads cold
- (T4) usage totals/tokenRatio read-then-write outside a transaction
- (T4) window logic defined in three places (planWindow, buildOutgoing, windowOf); buildOutgoing upToId dead in prod
- (T4) tests missing for stop mid-stream keeps lastRequest, in-stream error after 200, snapped start persisted
- (T5) Save enabled when nothing changed
- (T5) prompt removed by delete without undo → next divider shows only the model
- (T5) no unit test for prompt delete → undo (hash unchanged)
- (T5) chip aria-disabled uses busy only, tap guard also checks isGenerating
- (T5) .bar hard-codes 20px sheet padding
- (T6) CommitField unmount commits without an edit
- (T6) ChatSettings live query runs while closed
- (T6) window marks unmemoized/untested in Transcript
- (T6) compact() lives in ChatSettings.tsx; "1k msgs" in messages mode
- (T6) settings read-then-write outside transactions
- (T6) dimmed replies keep inline backgrounds (contrast)
- (T6) "warm cache" ignores TTL expiry
- (T7) hard-coded filter id orfe-lens (useId + CSS var if a second composer ever exists)
- (T7) svg + draw still run under reduced transparency (wasted work)
