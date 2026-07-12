# Shared context for the user-value prompt pack (read this first, every prompt)

## The mandate

2026-07-12 audit verdict: three.ws has deep generation tech (avatar/model forging, world
building, markets, launcher) but almost nothing that turns a one-time creator into a returning
user. The infra is broad; the retention/discovery/social layer is thin to absent. This pack
closes that gap. Every prompt in this pack is a USER-FACING VALUE feature — not ops, not infra,
not a new generation pipeline. If a task starts looking like "add a cron" or "fix a rate
limiter," it's out of scope for this pack.

## Ground truth (verified 2026-07-12, don't re-derive)

- `pages/profile.html` (2,774 lines, live at `/profile`) renders **agent** (ERC-8004 on-chain)
  identities only — no human creator portfolio view.
- `pages/handle.html` (260 lines, `/handle`) — per-handle page, same agent-only scope.
- `pages/community.html` (176 lines) is a static card-link grid. No dynamic content.
- `pages/feed.html` (381 lines) exists but has no wired activity source — verify its current
  data source before assuming it's empty; it may be a partial start worth extending, not
  replacing.
- `api/remix-feed.js` (196 lines) already exists — a remix/creation feed backend. Read it before
  building a new feed endpoint; likely reusable or extensible.
- `pages/collection.html` (189 lines) shows purchased skills only, not a user's own creations.
- `pages/leaderboard.html` and `pages/walk-leaderboard.html` are the only leaderboards, both
  scoped to one surface (`/walk`).
- `src/friends.js`, `friends-panel.js`, `src/social/` already implement DMs, presence, and a
  social layer — but scoped to `/play`/`/walk`, not the whole site.
- `tour-sdk/` (own package, `robinhood/`-style standalone repo under `tour-sdk/`) does guided
  narration/tours **for other sites** via its SDK — three.ws does not use it on itself yet.
- `data/pages.json` has 317 registered pages; `notifications` does not appear as a path or
  feature anywhere in it.
- Neither `forge_creations` tracking (referenced in `api/_lib/tokenize-3d.js`,
  `api/_lib/avatar-thumbs.js`, `api/forge-og.js`) nor diorama/world creation is currently
  aggregated into one "my creations" view.

Do not take any of the above as license to skip verification — confirm current state with
`grep`/`Read` before building; the codebase moves fast and other agents may have touched these
files since this was written.

## Behavioral rules (override defaults, per CLAUDE.md)

- **Execute. Do not interview the user.** Pick the most reasonable interpretation, ship a
  complete feature, verify it, then report. Never end a turn with "should I proceed?"
- **No mocks, no fake data, no TODO comments, no stub functions, no placeholder copy.** Real
  data from real tables/endpoints only. If a data source is genuinely empty (e.g. a brand-new
  user with zero creations), that's a designed empty state — not a mock.
- **Read before you write.** Match existing patterns in `pages/*.html`, `api/*.js`, `src/*.js`.
  Reuse `api/remix-feed.js`, `src/friends.js`, `src/social/` where they already solve part of
  the problem — do not build parallel systems.
- **No errors without solutions.** Every error has a root cause; find and fix it, don't paper
  over it with a fallback.

## Definition of done (every prompt, beyond its own checklist)

- Feature is reachable via real navigation, not just a raw URL — link it from the pages/surfaces
  it naturally connects to.
- Every state designed: empty (new user, zero data), loading, error, populated, overflow
  (hundreds of items).
- New public page/route → entry in `data/pages.json` (path, title, description, `added: 2026-07-12`).
  `npm run build:pages` validates this — run it.
- New user-visible feature → entry in `data/changelog.json` (holder-readable title + summary,
  tag `feature`).
- New top-level directory/surface → row in `STRUCTURE.md`; `README.md` if it's a new package.
- Targeted tests for what you touched: `npx vitest run tests/api/<your-file>.test.js` or the
  nearest existing pattern. Don't run the full slow suite unless asked.
- Dev-server check: `npm run dev`, exercise the feature in a real browser, confirm no console
  errors and real network calls succeeding.

## Git rules

- **Concurrent agents share this worktree.** Stage explicit file paths only — never `git add -A`
  or `git add .`. Re-check `git status` / `git diff --staged` immediately before committing.
- Commit when your prompt's work is verified complete. Do not push — the owner pushes
  (`git push threews main` is the only allowed remote; never touch `threeD`).
- No GitHub Actions, ever.
- `npx vercel build` overwrites `api/*.js` in place with bundled output — never run it. Recover
  with `git restore -- api/ public/` if it happens.

## $THREE rule

Sample data, fixtures, and copy in this pack reference real three.ws users/creations at runtime
only — no hardcoded third-party coin/project examples. If in doubt, use `$THREE`
(`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) or a clearly-synthetic placeholder. Anything
that would reference another crypto project in committed code needs the owner's explicit
approval first (see CLAUDE.md's commit gate) — ask once, then keep working on everything else.

## Reporting

End every prompt with: what shipped (files + routes), what you verified (commands + output),
commit hash, and any owner-side gaps (exact env vars / manual steps needed). No questions unless
truly blocked on an owner-only decision.
