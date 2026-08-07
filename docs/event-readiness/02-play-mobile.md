# Audit 2: /play on mobile (stability and touch UX)

A large share of event traffic will arrive on phones from a shared link. There is a known report that /play kicked mobile users out right after joining. Your job: reproduce, root-cause, fix, and then polish the touch experience.

## Tools already in the repo

- `scripts/play-mobile-repro.mjs`: emulated-phone harness that records console messages, page errors, WebSocket lifecycle, failed requests, transferred bytes, and heap samples. Run both engines:
  - `ENGINE=webkit node scripts/play-mobile-repro.mjs https://three.ws/play 120000` (reproduces iOS Safari memory kills)
  - `ENGINE=chromium node scripts/play-mobile-repro.mjs https://three.ws/play 120000` (gives heap + transfer numbers)
  - It also attributes every `.glb` load and animation-clip fetch to a call stack, so duplicated downloads point at the code that asked for them.
- `npm run audit:mobile-touch`: static touch-target audit.

## What to audit

1. **Survival.** Does an emulated iPhone stay in the world for the full run window? If it dies, the harness output tells you whether it was a page error, a memory kill (WebKit), or a WebSocket drop. Fix the root cause; do not add a reconnect band-aid over a crash.
2. **Memory and transfer budget.** From the chromium run: total transferred bytes and peak heap. Duplicate GLB or clip fetches (same URL, multiple stacks) are the first thing to eliminate. Texture sizes and crowd density (`src/game/ambient-crowd.js`) are the usual heavy hitters; scale them down on mobile rather than shipping the desktop load.
3. **Touch controls.** Virtual joystick or tap-to-move must work one-handed in portrait. Buttons at least 44px targets (`npm run audit:mobile-touch`). No hover-only affordances.
4. **Viewport correctness.** No horizontal scroll, no UI under the notch or home indicator (safe-area insets), no 100vh keyboard bugs in the chat input.
5. **Orientation.** Rotate mid-session; the canvas and HUD must reflow without a reload.

## Verify

- Both harness engines complete a 120s run on the canonical $THREE URL (see `docs/event-readiness/README.md`) with zero page errors and no disconnect.
- `npm run audit:mobile-touch` passes on the play surface.
- `npm test` stays green.

## Report format

Root cause of any crash found (with the harness evidence), fixes applied, remaining risk on real hardware that emulation cannot prove, stated plainly.
