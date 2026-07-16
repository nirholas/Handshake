# 07: Design-system consistency sweep (tokens, states, microinteractions)

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

Make 300+ pages feel like one product. Audit and enforce a single design language: tokens for
color/spacing/type/radius/shadow, consistent interactive states, designed empty/error/loading
states everywhere, and the microinteractions that signal quality.

## Tasks

1. **Token audit.** Find the real token sheet (`src/styles/`, root CSS custom properties).
   Inventory hardcoded values across `src/`, `pages/`, `public/*.html` (colors, px spacing,
   font sizes, radii, shadows, z-indices). Consolidate to tokens; where two near-identical
   values exist (#0a0a0b vs #0b0b0c), pick the canonical one. Ship the token sheet as the
   single source with a short comment header documenting the scale.
2. **Interactive-state pass.** Every button, link, card, input across the platform gets hover,
   active, focus-visible, and disabled states from shared classes/tokens. Focus rings visible
   on dark AND light contexts. Grep for `cursor: pointer` elements missing states as a cheap
   detector.
3. **State design sweep.** For each major surface (forge, markets, marketplace/agents,
   dashboard, wallet, launches, changelog, news, play, walk, irl, ar, scene studio, docs):
   verify loading (skeletons, not spinners, matching final layout), empty (says what to DO,
   with a working CTA, ideally an illustration or 3D flourish), error (plain language +
   recovery action), and overflow (1,000 items, 200-char names, tiny screens). Fix inline;
   keep a per-surface checklist in the report.
4. **Motion language.** One transition standard: durations (150ms micro, 250ms panel), one
   easing curve set, opacity+transform only (no layout-thrashing animations),
   prefers-reduced-motion honored globally. Element enter/exit intentional on the top surfaces.
5. **Typography and rhythm.** Consistent type scale and line-height rhythm; heading hierarchy
   semantic (h1 once per page, no skipped levels); readable measure on text-heavy pages
   (docs, news, changelog).
6. **Contrast and a11y floor.** Automated pass (axe-core via Playwright, already available in
   the e2e stack) on the top 30 pages: fix contrast below AA, missing labels, keyboard traps.

## Definition of done

- Token sheet canonical; a grep for raw hex colors in `src/` returns only the token sheet and
  justified exceptions (third-party embeds), listed in the report.
- Per-surface state checklist complete with fixes shipped.
- axe pass results before/after in the report; `npm run audit:web` no new errors;
  visual spot-check at 320/768/1440 on the top 10 pages.
- One changelog entry summarizing the visible polish in holder language.

## Anticipated blockers, pre-answered

- Scale: this is a sweep, so batch by surface and commit per surface (pathspec commits); if the
  session cannot finish all surfaces, finish complete surfaces cleanly and list the remainder
  ordered by traffic; never leave a surface half-migrated.
- Legacy pages under `public/*.html` not in the Vite graph: remember the raw-/src trap (an
  unregistered page shipping `/src` imports breaks: CSS import kills the page); test each
  touched public page actually renders.
- Light/dark: the platform is dark-first; if a light context exists (docs, embeds), tokens must
  carry both or explicitly declare dark-only. Do not invent a light theme in this prompt.
