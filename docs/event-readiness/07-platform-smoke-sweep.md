# Audit 7: whole-platform smoke sweep (every page, every link)

Event visitors will not stay on /play; they will click around. Every page declared in `data/pages.json` must load clean, every link must resolve, every button must do something.

## The tooling (all already in the repo)

Run these against production first to find real user-facing breakage, then against `npm run dev` to fix:

- `npm run smoke:prod`: sweeps every page in `data/pages.json` against the live site.
- `npm run audit:web`: unauthenticated browser sweep. `npm run audit:web:login`: authed sweep using the QA account (`AUDIT_EMAIL`/`AUDIT_PASSWORD` in `.env`). Both accept route paths as arguments to narrow the sweep and `--engine webkit` or `--engine firefox` to run it outside Chromium (`npx playwright install webkit` once); a WebKit run counts one failed resource as one finding, not three. `npm run ui:review` is the visual sweep over the same route list.
- `npm run audit:links`: dead links. `npm run audit:pages` and `npm run check:pages`: pages.json integrity.
- `npm run audit:console`: console errors per page. `npm run audit:overlays`, `npm run audit:inline-handlers`, `npm run audit:routes`, `npm run audit:route-shadowing`: overlay/handler/route health.
- `npm run audit:docs`: dead doc links and commands naming scripts that no longer exist.

`audit:console` drives a real browser per route, so a machine already busy with
other browser fleets or test workers distorts it: navigations blow the 30s
budget and the dev server itself can miss its boot window, and both land in the
report as page failures they are not. It reuses a dev server already answering
on :3000 when there is one, which is the cheapest way to keep a long sweep
honest. Four env knobs cover the rest: `CONCURRENCY` (default 5) routes checked
at once, `SETTLE_MS` (default 3000) the per-route wait for async work to land,
`SERVER_BOOT_MS` (default 240000) how long Vite gets to come up, and
`REUSE_PROBE_MS` (default 20000) how long the :3000 reuse probe waits for an
answer. Lower the first, raise the rest, on a loaded box. Treat a run whose
failures are all navigation timeouts or `net::ERR_*` as unmeasured rather than
red, and re-run it when the machine is quiet.

## What to do

1. Run the full battery above. Triage every failure into: broken for users (fix now), cosmetic (fix now if under 15 minutes), false positive (note why).
2. **Fix priority order:** pages that 404 or render blank, then console errors, then dead links/buttons, then layout breakage at 320px/768px/1440px.
3. **The event funnel gets extra depth.** Walk these by hand, signed out, as a stranger would: home page, /play (canonical $THREE URL in `docs/event-readiness/README.md`), /launches, /changelog, the nav between them. Every step must be obvious and fast.
4. **Cross-linking check.** From /play, can a curious visitor find what three.ws is and how to launch their own coin world? If the path is more than 2 clicks or invisible, wire it (a HUD link, a share control, whatever fits the existing design language).
5. **OG cards.** The event link will be pasted into Telegram/X/Discord. Verify /play and the home page return correct og:image, title, and description (play.html uses /api/page-og; confirm it renders live).
6. Re-run the battery until clean, fixing as you go. A false positive that will confuse the next person gets its audit rule adjusted, not ignored.

## Verify

- All listed audits pass (or have a one-line justified exception in the report).
- `npm test` stays green.

## Report format

Battery results before and after, fixes grouped by page, the manual event-funnel walkthrough result, and any exception you accepted with its reason.
