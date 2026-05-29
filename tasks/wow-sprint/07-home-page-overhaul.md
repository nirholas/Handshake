# Task: Home page overhaul — a landing that makes holders proud

`pages/home.html` is the front door. Make it world-class: clear value prop,
a signature visual moment, real data, flawless polish. Bar = Vercel / Linear / Stripe.

## Current state
- Entry: `pages/home.html` (route `/` per `vite.config.js`). Hero logic in `src/home-v4-hero.js`, scroll in `src/home-v4-scroll.js`, 3D in `src/home-act2-viewer.js`.
- Design tokens already defined in `home.html :root` (dark theme: `--bg`, `--surface-*`, `--text-*`, `--accent`). Reuse them — don't invent new ones.
- There are stale variants (`home-v2/v3/v4`, `home-classic`). Don't touch those; ship on `home.html`.

## What to build
1. **Hero** — sharp one-line value prop ("The 3D agent layer of the internet"), a real primary CTA, and a live 3D centerpiece that loads fast (lazy, with poster/skeleton). It should feel alive on first paint.
2. **Live $three signal** — surface one real stat from `api/three-token/[action].js?action=stats` (price / holders / volume / burns) in the hero or just below it, with a graceful loading + error state. Mint: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`. (If task 12 is building the reactive hero, coordinate — this task owns layout/content, 12 owns the reactive 3D.)
3. **Proof sections** — what the platform does (create → embed → monetize), with real screenshots/components, not lorem.
4. **Every state designed** — loading skeleton, error fallback, and the populated state all polished. Responsive at 320 / 768 / 1440.
5. **Microinteractions** — hover/active/focus on every interactive element, intentional enter transitions, no jarring pops.

## Constraints
- No fake data, no placeholder copy, no `setTimeout` fake-loading.
- Real fetches only; handle the boundary.

## Definition of done
- `npm run dev` → `/` loads fast, 3D lazy-loads, real $three stat renders.
- Zero console errors. Responsive at all three breakpoints. A11y basics (semantic, focusable, labelled).
- `npm run build` clean. Run the **completionist** subagent.
- You'd screenshot this and post it. Report what changed and include the reasoning for the hero design.

> Run this BEFORE tasks 12 and 04 if running in parallel (they touch the same files).
