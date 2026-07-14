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

## Commands

```sh
# One-time: create the auth session (server-set HttpOnly cookie -> storageState)
AUDIT_EMAIL=you@example.com AUDIT_PASSWORD=secret npm run audit:web:login

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
```

## Targeting

`BASE_URL` selects the target and defaults to production:

```sh
BASE_URL=https://three.ws npm run audit:web        # default
BASE_URL=http://localhost:3000 npm run audit:web   # vite dev server
```

Local targets get an extra noise filter for failures that only exist because
serverless functions and CDNs are absent under a bare dev server.

## Session file

`--login` posts `AUDIT_EMAIL` / `AUDIT_PASSWORD` to `/api/auth/login` on the
chosen `BASE_URL` and saves cookies plus localStorage (including the
optimistic auth hint) to `.auth/audit-state.json`. The `.auth/` directory is
gitignored. Every later run replays that storageState; without it the audit
runs anonymously and skips the authenticated-only routes. Re-run
`npm run audit:web:login` when the session expires.

## Reports

Findings are deduped, grouped per route, scored by severity (error / warn /
info), and written to `reports/page-audit-<timestamp>.json` and `.md`, with a
summary printed to the console. The `reports/` directory is gitignored, so
sweep output never lands in commits. `--strict` makes the process exit
nonzero when any error-severity finding exists, for use as a gate.
