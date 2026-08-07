# Audit 9: accessibility and internationalization

The event audience is international and diverse. Keyboard users, screen-reader users, and non-English speakers all get first-class treatment. Accessibility is not optional here; it is a hard platform rule.

## Where the code lives

- /play HUD and panels: `src/game/coincommunities-ui.js`, `src/game/hud/`, `src/game/coincommunities.css`
- i18n runtime: `i18n.js` (loaded by `pages/play.html`); play strings use `data-i18n` / `data-i18n-attr` attributes (see the meta tags in `pages/play.html` for the pattern)
- Motion audit: `npm run audit:motion`; design tokens: `docs/DESIGN-TOKENS.md`

## What to audit

1. **Keyboard.** Tab through every /play panel (store, bank, wheel, quests, cosmetics, chat, settings). Visible focus ring on every interactive element, logical order, Escape closes the top panel, no focus traps, and game hotkeys must not swallow typing in the chat input (and vice versa).
2. **Screen reader semantics.** Panels are labeled regions, buttons have accessible names (icon-only buttons need `aria-label`), balance changes and incoming chat announce via a polite live region, and the canvas has a text alternative describing the world state entry point.
3. **Contrast.** Every HUD text/background pair meets 4.5:1 (3:1 for large text). HUD text over the 3D scene is the usual failure: add scrims/backdrops where needed rather than hoping the scene stays dark.
4. **Motion sensitivity.** `prefers-reduced-motion` must tone down camera shake, wheel spin flourish, and ambient animation. Run `npm run audit:motion`.
5. **i18n coverage on the event funnel.** Every user-facing string on /play, the home page, and /launches goes through the i18n layer; hardcoded English in the play HUD is a bug. Verify at least one non-English locale renders the play HUD without broken layouts (long German/Romanian strings are the classic overflow test).
6. **Text scaling.** 200% browser zoom: HUD remains usable, nothing overlaps, no clipped labels.
7. **Platform-wide spot check.** Repeat items 1-3 briefly on the home page and /launches; fix what you find there too.

## Verify

- Full keyboard-only session: join the canonical $THREE world (URL in `docs/event-readiness/README.md`), open every panel, buy one thing, send one chat message. No mouse.
- Contrast checks recorded for the worst 5 HUD pairs, all passing after fixes.
- `npm test` stays green.

## Report format

Per-category pass/fixed list, the keyboard-only session result, locales verified, and any genuinely unfixable-today item with its concrete follow-up.
