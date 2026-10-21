# ORFE design system

Direction: child 1 of A x B. Source of truth: spec section 10. Tokens live in `src/styles/tokens.css`.

```
Format    Phone first, 360-430 wide; margins 20; height open. Desktop: centred column, max 720.
Type      UI: Geist 15/22 (sans), meta in Geist Mono 11/16. Model prose: Newsreader 17/26 (default; a chat theme can swap it).
Scale     1.2 · 11 · 13 · 15 · 18 · 22 (17 for prose is the serif's optical match to 15 sans, named exception).
Space     4 pt unit · 4 8 12 16 24 32 48.
Radius    14 for surfaces (bubble, cards, frames), pills for chips and round buttons. Nothing else.
Reasons   A daily tool for dense use: quiet ratio, one UI face. The model gets a book voice; you and the app speak sans.
```

## Palette

Neutral, no colour in the chrome: off-blacks, dark greys, off-whites.

| token | dark | light |
|---|---|---|
| bg | `#0e0e0f` | `#f5f5f3` |
| surface (user bubble, chips) | `#18181a` | `#e9e9e6` |
| line | `#27272a` | `#dcdcd8` |
| ink | `#e9e7e2` | `#1a1a19` |
| prose | `#dcdad5` | `#262624` |
| mute (meta) | `#8b8a86` | `#6b6a66` |
| faint (placeholder, 3:1 min) | `#75746f` | `#82817b` |

Light follows `prefers-color-scheme`; `<html data-theme="light|dark">` overrides it.

## Rules

- User messages: grey bubble (`surface`), right-aligned, max 84% width, radius 14.
- Assistant messages: no bubble, full width, mono meta line above.
- Composer: the one glass object. 12 px from the edges, radius 22, `backdrop-filter: blur(22px) saturate(1.4)`, 1 px gradient edge (light at top-left and bottom-right), inset top highlight, round ink-filled send button.
- Theme: system light/dark, manual override in Settings.
- Motion: 150-220 ms ease-out on sheets and folds, none on text. Respect reduced motion.
- Minimum text 11 px. Real text passes WCAG AA 4.5:1, including mono meta. Placeholder passes at least 3:1.

## Contrast (computed, WCAG relative luminance)

| pair | dark bg | dark surface | light bg | light surface |
|---|---|---|---|---|
| ink | 15.61 | 14.35 | 15.96 | 14.32 |
| prose | 13.81 | 12.69 | 13.89 | 12.46 |
| mute | 5.58 | 5.13 | 4.96 | 4.45 |
| faint | 4.12 | 3.79 | 3.58 | 3.21 |

Known gap: light `mute` on `surface` is 4.45, just under 4.5. Spec value kept; avoid mute text on surface in light until decided.
