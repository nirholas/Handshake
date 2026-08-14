# server/ — Cloud Run production server

Runs **all of three.ws** — the static frontend, the vercel.json route table,
and the 1,100+ serverless handlers under [`api/`](../api/) — as one container
on Google Cloud Run. This replaced Vercel as the production runtime
(2026-07-07, after Vercel disabled the deployment).

**Operating the platform** (load balancer, DNS, TLS, crons, env management,
rollback, recovery procedures): see the full runbook at
[docs/ops/gcp-production.md](../docs/ops/gcp-production.md). This README
covers the server code itself.

## What it does

[`index.mjs`](index.mjs) is a single Express server with three layers:

1. **Route table** — interprets the 1,047-entry `routes` array from
   [`vercel.json`](../vercel.json) with Vercel's legacy-routes semantics:
   security-header rules (`continue: true`), clean-URL rewrites
   (`/3d → /3d.html`, `/ → /home.html`), redirects (`/home → 301 /`),
   `/cdn/* → /api/cdn-object` rewrites, asset cache headers, and the
   post-filesystem `404.html` fallback. Phase order: phase-1 rules →
   functions → filesystem → post-filesystem rules.
2. **Static frontend** — serves `dist/` (the Vite build output, baked into
   the image) with directory-index resolution, traversal guards, and gzip
   (compression skips SSE and binary types automatically).
3. **API handlers** — Vercel filesystem routing over `api/**`, so handlers
   run unmodified:

    | URL               | Resolves to                                            |
    | ----------------- | ------------------------------------------------------ |
    | `/api/healthz`    | `api/healthz.js`                                       |
    | `/api/agents/abc` | `api/agents/[id].js` — `req.query.id === 'abc'`        |
    | `/api/v1/x/a/b/c` | `api/v1/x/[...slug].js` — `req.query.slug === 'a/b/c'` |

    Precedence per segment: exact file > exact directory > `[param].js` >
    `[param]/` > `[...catchall].js`. Names starting with `_` or `.`
    (`api/_lib`, …) are never routable.

4. **Server-rendered content for JS-only pages** —
   [`ssr-pages.mjs`](ssr-pages.mjs) injects a page's own first view into its
   static shell before it is sent. Some directory pages render their whole body
   from client JS, so a crawler, a link unfurler, or a no-JS visitor saw an
   empty page: `/discover` indexes 150k+ agents and shipped a 6.8 KB shell with
   zero agents in it. The injected markup is the same default query the client
   issues on load (progressive enhancement, not cloaking), and the client clears
   the container before hydrating, so nothing is ever duplicated.

    Registered pages live in the `PAGES` array in that file. To add one, give it
    a `route`, its shell `file`, the internal `api` path to read, a `build()`
    that turns the payload into markup, and an `apply()` whose markers appear
    exactly once in the shell. `tests/ssr-pages.test.js` fails if a marker drifts
    or the client stops clearing its container.

    It never fails a page: a slow, failing, or malformed upstream falls back to
    the untouched shell. Renders are cached (5 min TTL), concurrent requests
    share one in-flight refresh, a stale render keeps serving for up to an hour
    while refreshes fail, and the upstream call is capped at 2.5 s. Only
    query-less GETs are rendered, since the injected view is the default one.

Handler-facing parity:

- `req.url` is the untouched original path + query string.
- `req.query` merges search params (repeated keys → arrays), dest-rewrite
  query params, then route params — later wins, as on Vercel.
- `req.body` is pre-parsed for JSON / urlencoded / `text/*` /
  `application/octet-stream` at an 8 MB limit (Cloud Run's ceiling is 32 MB;
  the old Vercel-era 4.5 MB limit rejected base64 token images the
  build-metadata schema allows); multipart and other
  types stay unconsumed for raw-stream handlers.
- SSE streams work: compression exempts `text/event-stream` and the server's
  idle timeouts are lifted (Cloud Run's request timeout is the real limit).
- Handlers are lazy-loaded on first hit and cached.

## Run locally

```bash
node server/index.mjs        # listens on :8080 (override with PORT)
curl localhost:8080/api/healthz
curl -I localhost:8080/      # home.html + security headers
```

## Deploy

```bash
npm run deploy:gcp
```

That runs [`cloudbuild.yaml`](cloudbuild.yaml): a 32-vCPU Cloud Build with
BuildKit layer caching (an unchanged `package-lock.json` skips the workspace
`npm ci` entirely), then deploys to the `three-ws-api` Cloud Run service in
`us-central1`. The build uses the `three-ws-build@` service account and the
service runs as `three-ws@` — the project's default compute SA was deleted,
so both must stay pinned.

The upload context is governed by the allowlist in
[`.gcloudignore`](../.gcloudignore) — if a handler starts reading a directory
that isn't listed there, add it, or the file will be missing at runtime.
`dist/` ships from the local build — run `npm run build` before deploying
frontend changes.

## Crons

The schedules declared in `vercel.json`'s `crons` array are mirrored to Cloud
Scheduler jobs (us-central1) by
[`scripts/create-gcp-scheduler.mjs`](../scripts/create-gcp-scheduler.mjs). Each
job calls its `/api/cron/*` path with `Authorization: Bearer $CRON_SECRET`, the
same header contract the handlers already validate.

The script is idempotent (create-or-update) and **config only**: it writes
schedule, target, method, deadline and header, and never changes whether an
existing job is running. Jobs it creates start ENABLED, because a declared cron
that is created paused never fires and nothing in the config would show it. The
blanket run-state levers are explicit: `--pause` stops every job, `--resume`
restarts every job.

Verify the mirror with `npm run check:cron-drift` (declared vs. live schedules
and run state) and the handlers behind it with `npm run audit:cron-liveness`.
A cron with no job at all is reported with the reason production gives for it:
`deployed, never synced` means the handler is live and a sync fixes it now,
while `handler not deployed` means the path still 404s, so its job belongs to
the deploy that ships the handler.

## Env

Service env was migrated from Vercel (`vercel env pull` → `gcloud run
services update --env-vars-file`). `CRON_SECRET` was empty on Vercel (all
cron guards fail closed with 503) and is now a real secret, set on the
service and in every Scheduler job.

## Not (yet) covered

- **`animation-sources/`** — excluded from the image (2.6 GB); the few
  endpoints that read it degrade until it moves to object storage.
- **Frontend split** — dist/ ships in the image for now; the plan of record
  is Cloudflare Pages for static + this service for `/api/*` once CF
  credentials exist.
