# 01 · Event countdown: real times, every surface, verified live

**How to run:** paste this whole file into a fresh Claude Code chat in the three.ws repo, or tell the agent to read `prompts/event/01-event-countdown.md`. Read [00-CONTEXT.md](00-CONTEXT.md) first.

**Operating clause:** finish 100%. Never end the session with a question, an unexecuted plan, or "let me know". CLAUDE.md hard rules bind: no mocks, no TODO comments, no em-dash characters, commits stage explicit paths only, pushes and production deploys are owner-gated.

## Step 0 · Re-derive the current state (do not trust this file's claims)

```bash
cat public/event.json
ls -la src/game/event-countdown.js
grep -n "event-countdown" pages/play.html
git log --oneline -5 -- src/game/event-countdown.js public/event.json
```

Expected baseline: the countdown module exists, is wired into `pages/play.html`, and `public/event.json` carries a start time of 2026-08-08T17:00:00Z, which was a reasonable default chosen by the agent that built it, NOT a time the owner confirmed. Whatever you find, the tasks below are stated against intent, not against that baseline; skip anything already true.

## Tasks

1. **Set the real event window.** If the owner's instructions (this chat, recent commits, `docs/`, or marketing copy in the repo) state the actual start/end time, write it into `public/event.json`. If no authoritative time exists anywhere, keep the current value and flag it as the single owner decision in your report; do not stall on it.
2. **Verify the two mounted views in a real browser** (`npm run dev`, open `http://localhost:3000/play`):
   - Lobby banner: name, tagline, local-time start line, ticking D/H/M/S clock, CTA into the $THREE world. Hover, active, and focus-visible states on the CTA.
   - In-world pill: enter any world (or open `/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`), confirm the top-center pill ticks, its dismiss button works and persists across reload (localStorage key `cc-event-dismissed:<startsAt>`), and the CTA link is absent when already standing in the event world.
   - State transitions: temporarily set `startsAt` a minute in the future and watch upcoming flip to live (pulsing dot, LIVE copy) without a reload; set `endsAt` in the past and confirm everything unmounts. Restore the real values afterward.
3. **Mobile pass:** at 375px width, the banner wraps cleanly and the pill sits above the touch controls without covering chat or the joystick.
4. **Extend the countdown to the home page** so the event is visible before anyone reaches `/play`: reuse the same `public/event.json` (never a second copy of the times) and mount a compact banner on `/` consistent with the home page's own design system. Read how the home page is built before touching it; if it has a hero or announcement slot, use it. Same three states, same auto-unmount.
5. **Changelog:** one `data/changelog.json` entry (tags: `feature`) written for holders, then `npm run build:pages`.

## Definition of done

- [ ] `public/event.json` carries the best-known real event window; the one open owner decision (if any) is a single line in the report, not a blocker.
- [ ] All three states (upcoming, live, over) observed in a real browser on `/play`, plus the home-page banner, with zero console errors.
- [ ] Dismissal persists across reload; reduced-motion users get no pulse animation (verify with DevTools emulation).
- [ ] `npm run check:rules -- --paths <files you touched>` passes; `npm run test:core` passes.
- [ ] Changelog entry present and `npm run build:pages` clean.
- [ ] Work committed with explicit paths and a descriptive `type(scope):` message; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Real event time unknown | Keep the configured default, state it in the report as the one owner edit, ship everything else. |
| Home page structure unfamiliar | `STRUCTURE.md` maps it; read the entry HTML and its JS before editing. |
| Dev server port busy | Another agent is running it; reuse the running instance instead of starting a second. |
| Lobby DOM changed under you | The module waits for `#cc-lobby .cc-lobby-inner` and mounts nothing if absent; re-read `coincommunities-ui.js` for the current class names and adjust the selector. |

## Report format

State: the event window shipped, the surfaces verified (with what you actually observed for each state), console cleanliness, test results verbatim, files committed, and any single owner decision left open.
