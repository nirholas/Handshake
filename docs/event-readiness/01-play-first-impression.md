# Audit 1: /play first impression and core UX

We have a major event tomorrow and /play is the showcase surface. Your job: make the first 60 seconds of the $THREE world feel world-class. Load, audit, and fix; do not just report.

Canonical URL (the exact link we will share at the event):

```
https://three.ws/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three&image=%2Fapi%2Fimg%3Furl%3Dhttps%253A%252F%252Fipfs.io%252Fipfs%252Fbafybeihe22b5sxr3ihnxt7pregfieyteqvubqhik3j3y4bbx243xlqjw3q%26seed%3DFeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
```

## Where the code lives

- Page shell: `pages/play.html` (served at /play via the vercel.json route table)
- World boot and main loop: `src/game/coincommunities.js`
- HUD and panels: `src/game/coincommunities-ui.js`, `src/game/coincommunities.css`, `src/game/hud/`
- Intro and onboarding: `src/game/play-intro.js`, `src/game/play-onboard.js`, `src/game/play-handoff.js`
- Avatar boot: `src/game/boot-avatar.js`
- Ambient population: `src/game/ambient-crowd.js`

## What to audit (walk it as a first-time visitor, in a real browser via `npm run dev`)

1. **The blank-screen window.** Time from navigation to first meaningful paint of the world. Anything over a couple of seconds of dead screen needs a designed loading state: skeleton or branded loader with real progress (assets actually loading), never a fake timer.
2. **Query-string identity.** The coin name, symbol, and image from the URL must be visibly used: page title, HUD, world signage. Verify the `image` param (an /api/img proxy URL) renders everywhere it should and has a fallback if the IPFS fetch fails.
3. **Intro/onboarding flow.** Run it fresh (clear localStorage). Is it skippable? Does it explain movement, chat, and the economy in under 30 seconds? Does it re-appear when it should not?
4. **HUD polish.** Every button: hover, active, focus states. Panel open/close transitions (opacity + transform, no pops). Consistent spacing and typography with the existing design tokens (`docs/DESIGN-TOKENS.md`).
5. **Dead paths.** Click every visible control. Anything that does nothing, links nowhere, or throws is a bug to fix now.
6. **The screenshot test.** Would a stranger screenshot this and share it? If not, identify the top 3 visual gaps (lighting, framing, initial camera position, signage) and fix them.

## Verify

- `npm run dev`, exercise /play with the canonical query string; zero console errors, zero warnings from your code.
- `npm test` stays green.
- Re-run your walkthrough after fixes; capture before/after notes in the final report.

## Report format

What you changed (files + one line each), what you verified in-browser, anything you judged out of scope with a one-line reason. No open questions.
