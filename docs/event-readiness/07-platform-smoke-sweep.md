# Audit 7: whole-platform smoke sweep (every page, every link)

Event visitors will not stay on /play; they will click around. Every page declared in `data/pages.json` must load clean, every link must resolve, every button must do something.

## The tooling (all already in the repo)

Run these against production first to find real user-facing breakage, then against `npm run dev` to fix:

- `npm run smoke:prod`: sweeps every page in `data/pages.json` against the live site.
- `npm run audit:web`: unauthenticated browser sweep. `npm run audit:web:login`: authed sweep using the QA account (`AUDIT_EMAIL`/`AUDIT_PASSWORD` in `.env`).
- `npm run audit:links`: dead links. `npm run audit:pages` and `npm run check:pages`: pages.json integrity.
- `npm run audit:console`: console errors per page. `npm run audit:overlays`, `npm run audit:inline-handlers`, `npm run audit:routes`, `npm run audit:route-shadowing`: overlay/handler/route health.
- `npm run audit:docs`: dead doc links and commands naming scripts that no longer exist.

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
