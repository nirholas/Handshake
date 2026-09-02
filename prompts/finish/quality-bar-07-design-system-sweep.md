# QB-07: Design-system consistency sweep (tokens, states, microinteractions)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/quality-bar-07-design-system-sweep.md`".
It is complete on its own. Also read `prompts/finish/quality-bar-_shared.md`, `DESIGN-TOKENS.md`
and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. This is a sweep, so if the
   session cannot cover every surface, finish complete surfaces cleanly and list the remainder
   ordered by traffic. Never leave a surface half-migrated.
2. Blockers have pre-answered routes at the bottom.
3. CLAUDE.md hard rules: no mocks, no TODO comments, no commented-out code, no em-dash or
   en-dash characters. Stage explicit paths only, commit per surface.

## Mission

Make 300+ pages feel like one product: one token sheet, consistent interactive states,
designed empty, error and loading states everywhere, and the microinteractions that signal
quality.

## Step 0: re-derive current state (trust nothing below)

```bash
npm run audit:tokens        # scripts/audit-token-drift.mjs, the drift gate
npm run audit:console       # console errors across pages
npm run audit:overlays
npm run audit:a11y          # playwright axe pass on the top pages
grep -rn "#[0-9a-fA-F]\{6\}" src/ pages/ --include=*.css --include=*.html | wc -l
```

Record those numbers. They are your before-baseline and the report must show the after-numbers
next to them.

## Tasks

1. **Token audit.** Find the canonical token sheet (`src/styles/`, `DESIGN-TOKENS.md`).
   Inventory hardcoded values across `src/`, `pages/`, `public/*.html` (colors, px spacing,
   font sizes, radii, shadows, z-indices). Consolidate to tokens; where two near-identical
   values exist, pick one canonical value and use it everywhere.
2. **Interactive-state pass.** Every button, link, card and input gets hover, active,
   focus-visible and disabled states from shared classes and tokens. Focus rings must be
   visible on dark and light contexts. Grep for `cursor: pointer` elements with no state rules
   as a cheap detector.
3. **State design sweep.** For each major surface (forge, markets, marketplace, agents,
   dashboard, wallet, launches, changelog, news, play, walk, irl, ar, scene studio, docs):
   verify loading (skeletons matching the final layout, not spinners), empty (says what to do
   with a working call to action), error (plain language plus a recovery action), and overflow
   (1,000 items, 200-character names, tiny screens). Fix inline; keep a per-surface checklist.
4. **Motion language.** One standard: 150 ms micro, 250 ms panel, one easing set, opacity and
   transform only, `prefers-reduced-motion` honored globally.
5. **Typography and rhythm.** One type scale and line-height rhythm; semantic heading
   hierarchy (one h1 per page, no skipped levels); readable measure on text-heavy pages.
6. **Contrast and accessibility floor.** Fix everything `npm run audit:a11y` reports on the top
   30 pages: contrast below AA, missing labels, keyboard traps.

## Definition of done

- [ ] Token sheet canonical; a raw-hex grep over `src/` returns only the token sheet plus
      justified exceptions, each listed in the report.
- [ ] Per-surface state checklist complete, with the fixes shipped.
- [ ] `npm run audit:tokens`, `npm run audit:console`, `npm run audit:a11y` all better than the
      Step 0 baseline and none worse. Before and after numbers in the report.
- [ ] `npm run audit:web` shows no new errors; visual spot-check at 320, 768, 1440 px on the
      top 10 pages.
- [ ] One `data/changelog.json` entry summarizing the visible polish in holder language.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| Scale: too many surfaces for one session | Batch by surface, commit per surface with explicit paths, and list the remainder ordered by traffic. Never leave one half-migrated. |
| A legacy page under `public/*.html` is not in the Vite graph | Remember the raw-`/src` trap: an unregistered page shipping `/src` imports breaks (a CSS import kills the page). Test every touched public page actually renders. |
| Light vs dark | The platform is dark-first. If a light context exists (docs, embeds), tokens carry both or explicitly declare dark-only. Do not invent a light theme here. |
| A token change touches a file another agent is editing | Re-read the file immediately before each edit and stage only your own paths. |

## Report format

Before and after audit numbers, the per-surface checklist, the exceptions list, and the
remainder ordered by traffic. No recap of this file.
