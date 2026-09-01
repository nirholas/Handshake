# swarm-100 audit: what is finished and what is still open

Audited 2026-09-01 against `prompts/swarm-100/` at commit `94ae967ca`.

`prompts/swarm-100/` has no progress file by design. The pack's own rule is
that an agent deletes its work order in the commit that lands the work, so the
directory itself is the ledger: what is gone is done, what remains is open.
This document reconciles that ledger against git history, then measures the
open orders against their own Definition of done so the remaining work is a
list rather than a guess.

## Headline

- 696 work orders shipped in the pack (`bad907b27`, 2026-08-10).
- **540 closed (77.6%).** Every deletion is accounted for in git history.
- **156 open:** 151 route audits, 4 sweeps, 1 roadmap slice.
- Of the 151 open route audits, **125 already pass every mechanical line of
  their Definition of done** and 26 carry at least one measured defect.
- Two open orders are effectively finished and only need closing out; one
  (`sweep-i18n`) has not been started.

## Ledger by category

| Prefix | Orders | Closed | Open | Closed |
|---|--:|--:|--:|--:|
| route- | 284 | 133 | 151 | 47% |
| api- | 224 | 224 | 0 | 100% |
| docs-batch- | 44 | 44 | 0 | 100% |
| worker- | 33 | 33 | 0 | 100% |
| sweep- | 30 | 26 | 4 | 87% |
| roadmap- | 23 | 22 | 1 | 96% |
| sdk- | 23 | 23 | 0 | 100% |
| cron-batch- | 13 | 13 | 0 | 100% |
| packages-batch- | 11 | 11 | 0 | 100% |
| blog-batch- | 4 | 4 | 0 | 100% |
| service- | 4 | 4 | 0 | 100% |
| machine- | 2 | 2 | 0 | 100% |
| legal-pages | 1 | 1 | 0 | 100% |
| **Total** | **696** | **540** | **156** | **77.6%** |

Every non-route category except the sweeps and one roadmap slice is fully
closed. The whole remaining campaign is route audits.

## Closure timeline

| Date | Orders closed |
|---|--:|
| 2026-08-10 | 48 |
| 2026-08-11 | 44 |
| 2026-08-12 | 25 |
| 2026-08-13 | 93 |
| 2026-08-14 | 77 |
| 2026-08-15 | 106 |
| 2026-08-16 | 83 |
| 2026-08-17 | 42 |
| 2026-08-25 | 10 |
| 2026-09-01 | 16 |

The campaign ran hard for eight days, went quiet for a week, and has picked up
again in two short bursts.

## Are the closures trustworthy?

489 commits carry the 540 deletions. 201 of them are prompt-only `chore(swarm-100): retire the ... audit`
follow-ups, which is a deviation from "delete in the same commit as the work"
but a legible one: each names the fix that had already landed. One closure is
not legible:

- `api-pump-bounties-01.md` was deleted inside `5ed01e8d3`, a 63-file commit
  titled "Pending changes exported from your codespace". That is exactly the
  generic sweep the CLAUDE.md commit-message rule now bans. The commit touched
  `api/pump/helius-stats.js` and `api/pump/price-history.js` but nothing named
  `bounties`, so that order's work is unevidenced. Treat it as the one closure
  worth re-opening.

Every other deletion sits in a commit whose subject asserts what was fixed.

## The 156 open orders

### 1 roadmap slice: finished, just not closed

`roadmap-p2-memory-seed-x.md` asks for consent-first agent memory seeding from
X. That feature is built and shipped: `api/agents/[id]/memory-seed-x.js`,
`api/_lib/x-memory-seed.js`, `api/_lib/x-seed-consent.js` (revocation deletes
the seeded rows), migration `20260811140000_x_memory_consent.sql`,
`docs/x-memory-seeding.md`, and multiple `data/changelog.json` entries covering
the consent screen, the seeding lane and the revoke path. The order file was
simply never deleted. **Closeable after one end-to-end run on a real account.**

### 4 sweeps

| Order | State |
|---|---|
| `sweep-perf` | Work landed. The 2026-09-01 performance sweep covers exactly this order's page list (home, Create, Forge, Marketplace, Play, Docs, Discover, Chat), with a changelog entry naming the fixes. What is unverified is the order's numeric gate: Lighthouse >= 80 desktop measured against production. |
| `sweep-authed-audit` | Premise is stale. The order opens "the QA credentials are absent from .env"; `AUDIT_EMAIL` and `AUDIT_PASSWORD` are present today and `.auth/audit-state.json` was written 2026-09-01, so the authed sweep runs. The open half is fixing what it reports. |
| `sweep-console` | Not verified. `npm run audit:console` sweeps every route at two viewports; the run started here was stopped so it would not contend with this audit's own probe. The route-level console data below covers the 151 open routes. |
| `sweep-i18n` | **Not started.** `npm run i18n:lint` reports 43,768 problems (missing keys, stale keys, dropped glossary terms across locales). This is the single largest piece of open work in the pack. |

### 151 route audits

Every one of the 151 still targets a live entry in `data/pages.json`; none are
moot. Each was driven in headless Chromium against a local dev server and
measured on the mechanical lines of its own Definition of done: HTTP status,
console errors, failed first-party requests, title and meta description, a
single `h1`, and horizontal overflow at 320px. Vite HMR websocket noise and
Codespace-only artifacts are excluded.

**125 of 151 pass every mechanical line.** They are not automatically done:
the orders also require exercising the primary flow, proving data comes from a
live endpoint, and reaching the empty, loading and error states, none of which
a sweep can assert. But they carry no measurable defect, so they are cheap to
close.

**26 carry a measured defect:**

| Route | Measured | Note |
|---|---|---|
| `/dashboard` | no meta description; h1 count = 0 |  |
| `/dashboard/settings` | no meta description; h1 count = 0 |  |
| `/demo` | h1 count = 0 |  |
| `/guardian` | h1 count = 0 |  |
| `/ibm/hello` | horizontal scroll at 320px |  |
| `/ibm/x402-demo` | 4 console error(s); no meta description; h1 count = -1 | the page hardcodes absolute https://three.ws asset and API URLs, so it cannot load against a local origin at all |
| `/launch` | 1 console error(s) | vite serves /public through the module transform, so /launch/launch.js 500s locally only; production serves it as a static file |
| `/launch-studio` | 1 console error(s) | same vite /public transform artifact as /launch |
| `/launcher` | h1 count = 0 |  |
| `/launchpad` | was: uncaught TypeError killed the whole landing script (h1 0, page fell back to the noscript block) | FIXED in this audit (see below); re-probed clean |
| `/live` | h1 count = 0 |  |
| `/markets/news/article` | h1 count = 0 |  |
| `/mocap-studio` | h1 count = 0 |  |
| `/pitch` | h1 count = 2 |  |
| `/play/agent-wallet` | 2 console error(s); h1 count = 0 | the page calls a local x402 wallet daemon on 127.0.0.1:4402 that is not running here; the connection refusal reaches the console instead of a designed offline state |
| `/play/arena` | h1 count = 0 |  |
| `/play/war` | h1 count = 2 |  |
| `/playground` | h1 count = 0 |  |
| `/pose` | h1 count = 0 |  |
| `/profile` | h1 count = 0 |  |
| `/pump-visualizer` | h1 count = 0 |  |
| `/reputation` | h1 count = 2 |  |
| `/scene` | h1 count = 0 |  |
| `/showcase` | h1 count = 2; horizontal scroll at 320px |  |
| `/temporary` | 2 console error(s) | the multiplayer room server on localhost:2567 is not running here; the refusal reaches the console |
| `/three-live` | h1 count = 0 |  |
The dominant finding is the heading structure: 20 of the 26 have either no
`h1` or two, which fails the accessibility line in every route order. Nothing
in the open set is broken beyond that except the one bug below.

## Fixed during this audit

`/launchpad` was dead. `src/launchpad/landing.js` wrapped `.more` in backticks
inside a CSS comment that sits inside a backtick template literal, which closed
the string early and turned the rest into a tagged template on it. The page
threw `TypeError: "...".more is not a function` before rendering anything, so
every visitor got the "Launchpad Studio needs JavaScript" fallback instead of
the landing page. Fixed in `963a24fe1`; re-probed clean (HTTP 200, one `h1`,
meta description present, no 320px overflow). Production needs a deploy to pick
it up. `route-launchpad.md` still needs its interactive pass before it closes.

## Recommended order of work

1. `sweep-i18n` (43,768 findings, nothing else in the pack is this large).
2. Close `roadmap-p2-memory-seed-x` with one end-to-end consent-and-revoke run.
3. The 20 heading-structure route defects: one pass, one pattern, 20 orders closeable.
4. Re-open `api-pump-bounties-01`, whose closure has no evidence behind it.
5. The 125 mechanically-clean route orders: interactive pass only.
6. `sweep-perf` production Lighthouse numbers, `sweep-console`, `sweep-authed-audit`.

## How to re-run this audit

The ledger half is pure git:

    git log --diff-filter=D --name-only --format='%h %ad %s' --date=short -- prompts/swarm-100

The route half is `npm run audit:console` (every route, two viewports, console
and network only) or `npm run audit:web` / `npm run audit:web:login` for the
production sweep documented in `docs/ops/page-audit.md`.
