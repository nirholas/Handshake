# Page audit: authed full-site console sweep

`scripts/page-audit.mjs` drives a real Chromium across every public page (from
`data/pages.json`, skipping the machine-readable section and any non-HTML
path) plus the authenticated dashboard/profile routes and live-seeded dynamic
agent routes. It runs each route in a desktop (1440x900) and a mobile
(iPhone 13) viewport and records what a human would otherwise hunt for with
the dev console open:

- `console.error` / `console.warn` output
- uncaught exceptions (`pageerror`)
- failed network requests (`requestfailed`)
- HTTP responses with status >= 400 (a 402 from an `/api/` path is recorded
  as info-severity `payment-gated`, since x402 endpoints correctly answer 402
  to a non-paying browser)
- horizontal overflow and elements escaping the viewport
- interactive controls below the 32px tap-target floor (mobile pass only)
- accessibility smells: missing `<title>`, missing image alt text, dead links

The sweep is read-only. It never mutates the target.

Console output from the headless box's software GL stack (ANGLE over
SwiftShader) is filtered out: `GL Driver Message (OpenGL, Performance, …)`
advisories such as "GPU stall due to ReadPixels" come from the emulated driver
rather than page code, and no visitor on a real GPU sees them. The filter is
scoped to the Performance category, so a driver message in the Error category
is still reported.

## Commands

```sh
# One-time: provision the QA account if AUDIT_EMAIL / AUDIT_PASSWORD are absent
npm run audit:web:provision

# One-time: create the auth session (server-set HttpOnly cookie -> storageState)
npm run audit:web:login

# Full sweep (picks up the saved session automatically)
npm run audit:web
```

Useful direct invocations:

```sh
node scripts/page-audit.mjs / /agents /pay   # only these routes
node scripts/page-audit.mjs --desktop-only   # skip the mobile viewport
node scripts/page-audit.mjs --mobile-only    # skip the desktop viewport
node scripts/page-audit.mjs --concurrency 6  # parallel pages per viewport
node scripts/page-audit.mjs --strict         # exit 1 on any error-severity finding
node scripts/page-audit.mjs --reverify-cap 0 # skip the solo re-check pass
node scripts/page-audit.mjs --engine webkit   # audit in Safari's engine
```

## Engines: why Chromium alone is not enough

`--engine` picks the renderer: `chromium` (default), `webkit`, or `firefox`.

Chromium is the default because it is the only browser every machine here
already has. It cannot, on its own, see a class of bug that only Safari shows.
JavaScriptCore and V8 disagree about *when* a temporal dead zone is checked:
JavaScriptCore checks an assignment target before it evaluates the right-hand
side, V8 checks it afterwards. So a module that bootstraps itself above the
`let`s it writes renders perfectly in Chrome and throws
`Cannot access uninitialized variable.` in every Safari, desktop and iOS alike.

That is not hypothetical. It is how every `/avatars/:id` page shipped dead in
Safari while this audit, the production smoke sweep, and review all stayed
green. `npm run check:tdz-bootstrap` now refuses that ordering at build time
(it runs inside `build:gcp`), and a WebKit pass here catches the runtime half:

```sh
npx playwright install webkit        # one time
node scripts/page-audit.mjs --engine webkit --desktop-only --strict
```

Run a WebKit pass before any release that touched page-level JavaScript. It is
worth the extra minutes precisely because nothing else in the pipeline looks at
a non-V8 engine.

## Which routes get audited

`scripts/lib/audit-routes.mjs` is the one answer, shared with the visual sweep
(`scripts/page-snapshot.mjs`) so the two can never disagree about what pages
the site has. It draws from three sources:

1. **`data/pages.json`**, the public manifest that also drives `/sitemap`,
   `llms.txt` and the changelog. The machine-readable section and any non-HTML
   path are skipped: there is no DOM to audit.
2. **`AUTHED_ROUTES`**, the signed-in surfaces the public manifest deliberately
   omits. These are read out of the `vercel.json` route table rather than
   hand-listed: every concrete `/dashboard/*` entry that serves a page, plus
   `/profile`, `/settings` and `/my-agents`. Redirect stubs and regex patterns
   are excluded, since neither addresses a page with content in it.
3. **`seedDynamicRoutes()`**, parameterised routes (an agent id, a launch mint)
   filled with real ids read from the live API at run time.

The authed list is derived because the hand-kept copy of it went stale with no
signal at all. By 2026-09-04 ten of its eighteen entries had become 301 stubs
pointing at consolidated dashboard pages, so a third of every authenticated
sweep was spent loading empty redirects, while twenty-one live dashboard pages
had never once been audited under a session. The first sweep after the change
found real defects on two of the newly covered pages. Reading the route table
means a dashboard page that is added, renamed or consolidated is picked up by
the next sweep without anyone remembering to edit a second list.
`tests/audit-routes.test.js` pins that: a stub or a pattern in `AUTHED_ROUTES`,
or a served dashboard page missing from it, fails the suite.

## Targeting

`BASE_URL` selects the target and defaults to production:

```sh
BASE_URL=https://three.ws npm run audit:web        # default
BASE_URL=http://localhost:3000 npm run audit:web   # vite dev server
```

Local targets get an extra noise filter for failures that only exist because
serverless functions and CDNs are absent under a bare dev server.

## QA account

The authed sweep signs in as a real member, so it needs `AUDIT_EMAIL` and
`AUDIT_PASSWORD` in `.env`. If they are missing, `npm run audit:web:provision`
(`scripts/provision-audit-account.mjs`) creates a fresh account by driving the
real `/register` page in a headless Chromium: same form, same clickwrap
checkbox, same `POST /api/auth/register` the page makes. It then proves the new
credentials authenticate through `/api/auth/login` and writes them into `.env`
(mode 0600), leaving every other line in the file untouched.

```sh
npm run audit:web:provision                                  # against production
npm run audit:web:provision -- --username qa-audit-mine      # pick the username
npm run audit:web:provision -- --print-only                  # don't touch .env
BASE_URL=http://localhost:3000 npm run audit:web:provision   # against dev
```

The register form takes a username, not an email address, and the server
derives `<username>@users.three.ws.local` as the account email. That derived
address is what lands in `AUDIT_EMAIL`, because `/api/auth/login` treats any
value containing `@` as an email lookup. No server-side code reads these two
vars: they are a local-harness credential, so the Cloud Run service env does
not need them. `scripts/likeness-eval.mjs`,
`scripts/reconstruct-load-test.mjs` and `scripts/capture-bundles-media.mjs`
read the same pair.

## Session file

`--login` posts `AUDIT_EMAIL` / `AUDIT_PASSWORD` to `/api/auth/login` on the
chosen `BASE_URL` and saves cookies plus localStorage (including the
optimistic auth hint) to `.auth/audit-state.json`. The `.auth/` directory is
gitignored. Every later run replays that storageState; without it the audit
runs anonymously and skips the authenticated-only routes. Re-run
`npm run audit:web:login` when the session expires.

## Re-verification: every error is confirmed solo

The sweep loads `--concurrency` pages at once, and a WebGL-heavy page audited
alongside four others inside one headless browser fails in ways no real visitor
sees. Software GL contention makes texture uploads fail, and a contended page
misses a 25 s `networkidle` it would otherwise clear easily. On 2026-07-28 that
put 108 phantom `GLTFLoader: Couldn't load texture blob:…` errors plus a run of
nav timeouts into one report: 4 findings in 5 were noise, and the real defects
were buried under them.

So after the sweep, every route/viewport pair holding an error-severity finding
is audited again **on its own**, in a fresh context, with nothing else running:

- A finding that reproduces keeps `error` severity and is marked `reproduced`.
- A finding that does not reproduce is demoted to `info` and labelled
  `[not reproduced on a solo re-check: contention artifact]`. It is never
  deleted, so a genuinely intermittent bug is still visible in the report.
- Findings are matched across runs by a fingerprint that strips blob URLs,
  uuids, base58 addresses, query strings and bare numbers, so the same defect
  matches even though its ids differ every load.

Errors that survive this pass reproduced on a page loaded by itself, which is
what makes the error count worth acting on. `--reverify-cap N` bounds how many
pairs get re-checked (default 60, `0` disables the pass); anything past the cap
is reported unverified and named as such.

The cap is spread evenly across viewports rather than spent in arrival order.
Desktop runs first, so a flat slice handed every slot to desktop: the full sweep
of 2026-08-11 re-checked 60 desktop pairs and published 28 mobile pages
unverified as the report's worst offenders, while the desktop pages beside them
demoted at four in five. Re-running those 28 one at a time confirmed all but two
were contention artifacts. If a run still reports pairs beyond the cap, raise
`--reverify-cap` or re-run just those routes with `--concurrency 1` before
acting on them.

## A crashed browser no longer costs you the run

A full sweep drives 700+ routes, most of them WebGL, through one browser
process for well over an hour, on a box that is usually running other agents'
builds beside it. That browser gets killed sometimes. Until 2026-09-03 the
sweep had no answer for it: the next `newContext` threw
`Target page, context or browser has been closed`, and the run died with every
already-collected finding still in memory and nothing written to `reports/`.
The run of 2026-09-03 lost 782 desktop routes plus 49 crawl-discovered ones
that way, at the very last step before the report.

The browser is now a session that relaunches when its process is gone, the
per-viewport context is rebuilt on demand, and a route that failed only because
its session was torn down is retried against the fresh one rather than reported
as an `audit-crash` against a page nobody ever loaded. If the solo re-check
cannot get a browser at all, it stops early and the report is still written,
carrying a line that says which errors went unverified. The one thing that
never happens now is finishing the sweep and having nothing to show for it.

You will see `⚠ browser process gone; relaunching (#n)` when it fires. A run
with many of those was fighting for memory: lower `--concurrency` before
trusting its error counts.

## Reports

Findings are deduped, grouped per route, scored by severity (error / warn /
info), and written to `reports/page-audit-<timestamp>.json` and `.md`, with a
summary printed to the console. The `reports/` directory is gitignored, so
sweep output never lands in commits. `--strict` makes the process exit
nonzero when any error-severity finding exists, for use as a gate.
