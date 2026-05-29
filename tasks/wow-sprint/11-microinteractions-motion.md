# Task: Microinteractions & motion pass

CLAUDE.md: "Microinteractions signal quality." Add the layer of hover/active/
focus feedback and intentional motion that separates great products from adequate
ones — across the core pages.

## Scope
`pages/home.html`, `pages/marketplace.html`, `pages/agent-home.html`,
`pages/dashboard/`, `pages/pricing.html`, shared components in `src/components/`.
Use the motion tokens from task 08 (or `home.html :root`) — `--ease-out`, durations.

## What to add (tastefully — restraint over flash)
1. **Interactive feedback** — every button, link, card, and input gets hover, active, and `:focus-visible` states. Subtle: a lift, a tint, a border brighten. Consistent across the app.
2. **Enter/exit transitions** — lists and cards fade/slide in on load (staggered, short). Modals/sheets animate in and out, never pop. Use `opacity` + `transform` only.
3. **State-change motion** — toggles, tabs, accordions animate between states. Numbers that update (prices, counts) tween rather than snap.
4. **Loading → loaded** — skeleton crossfades to content; no hard swap.
5. **Scroll cues** — reveal-on-scroll for sections (IntersectionObserver), with a sensible threshold. Don't animate everything; pick the moments.
6. **Pointer affordances** — correct `cursor`, disabled states visibly disabled.

## Constraints
- Respect `prefers-reduced-motion`: disable non-essential motion when set.
- Performance: animate only `transform`/`opacity`; no layout thrash; 60fps.
- No gratuitous animation — if it doesn't aid comprehension or delight, cut it.

## Definition of done
- Every interactive element on the audited pages has hover/active/focus states.
- Key transitions feel intentional; reduced-motion respected; 60fps.
- No console errors. `npm run build` clean. Run the **completionist** subagent.
- Report: the interactions added per page.
