# 03 · /event landing page: one link to share everywhere

**How to run:** paste this whole file into a fresh Claude Code chat in the three.ws repo, or tell the agent to read `prompts/event/03-event-landing-page.md`. Read [00-CONTEXT.md](00-CONTEXT.md) first.

**Operating clause:** finish 100%. Never end the session with a question, an unexecuted plan, or "let me know". CLAUDE.md hard rules bind: no mocks, no TODO comments, no em-dash characters, commits stage explicit paths only, pushes and production deploys are owner-gated.

## Step 0 · Re-derive the current state

```bash
ls pages/ | grep -i event
grep -n "\"/event\"" vercel.json data/pages.json
cat public/event.json
```

If `/event` already exists, this order becomes an upgrade pass over it; skip what is already true.

## The feature

A single public page, `https://three.ws/event`, that the community shares before and during the event. It is the event's front door for someone with zero context:

- **Hero:** event name, tagline, the same ticking countdown `/play` shows (read `public/event.json`; one source of truth, never a second copy of the times), flipping to a LIVE state at start.
- **The one CTA:** a large "Join the $THREE world" button into `/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three`. Above the fold, keyboard-focusable, obvious on a phone.
- **What to expect:** a short section for newcomers: you get an avatar (create from a photo, pick a preset, or bring a GLB), you drop into a shared 3D world, you can gather, fight, trade, spin the wheel, and hang out. Write it from what `/play` actually does (read the `/play` rows of `STRUCTURE.md`); promise nothing that is not live.
- **Schedule:** render the start/end window in the visitor's local timezone, with an "Add to calendar" link (a generated `.ics` served from the page or a data URL; no third-party calendar service).
- **Live section (during the event):** when between `startsAt` and `endsAt`, surface something real and live, not decoration. Cheapest honest option: the world's live population via whatever presence endpoint the lobby's coin grid already uses (read how [src/game/coincommunities.js](../../src/game/coincommunities.js) fetches live counts and reuse that API).

## Tasks

1. Build the page under [pages/](../../pages/) following the repo's existing static-page pattern (pick a recent page as the template for head tags, OG image via `/api/page-og`, theme boot, i18n annotations). Its JS module lives under [src/](../../src/) like its neighbors.
2. Route it: add the `/event` route to `vercel.json` next to the other page routes (the Cloud Run server reads that route table at boot).
3. Register it in [data/pages.json](../../data/pages.json) with today's `added` date: this feeds the sitemap, `llms.txt`, and the changelog automatically. Run `npm run check:pages`.
4. Design bar: this page will be screenshotted and shared. Monochrome-compatible with the site's design tokens, responsive at 320/768/1440, transitions on state change, dark and light themes both correct.
5. Verify in a real browser: upcoming state, live state (temporarily shift the config times, then restore), ended state (after `endsAt`, the page must still make sense: say the event happened and route people to `/play`).
6. `npm run build:pages`; confirm the changelog picked the page up (new-page entries flow from `data/pages.json` automatically; add nothing manual unless you shipped extra user-visible behavior beyond the page itself).

## Definition of done

- [ ] `/event` renders in all three states with zero console errors, desktop and 375px, both themes.
- [ ] The countdown on `/event` and the one on `/play` read the same `public/event.json`; grep proves no second copy of the times exists.
- [ ] The `.ics` download imports cleanly into a calendar app.
- [ ] Route resolves in dev (`npm run dev`, `http://localhost:3000/event`); `npm run check:pages` passes; `npm run test:core` passes; `npm run check:rules -- --paths <files you touched>` passes.
- [ ] Committed with explicit paths; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Unsure which page to use as the HTML template | Pick the most recently added path in `data/pages.json` and read its `pages/*.html` + `src/*.js` pair. |
| No presence endpoint found for the live section | The lobby grid provably renders live counts; trace its fetch in `coincommunities-ui.js` / `coincommunities.js` and use the same endpoint. If it truly is socket-only, show the live state without a number rather than a fake one. |
| OG image | `/api/page-og` generates one from query params; copy a neighbor page's tag. |
| Route table confusion | `server/index.mjs` reads `vercel.json` `routes` at boot; mirror an existing static-page entry exactly. |

## Report format

The URL, the three states as observed, where the live data comes from, check/test output verbatim, files committed.
