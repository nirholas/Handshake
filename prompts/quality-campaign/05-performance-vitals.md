# 05 - Performance: fast first paint, no jank, honest async

Read `README.md` in this directory first (never-stop contract, standing approvals, shared
context). Never end a turn with a question.

## Mission

Make the platform feel instant. Measure Core Web Vitals on the ten highest-traffic pages, fix
what the numbers say, and protect the wins with budgets. Perceived speed counts double: a
skeleton at 100ms beats a spinner at 400ms beats a blank page at 250ms.

## Measure first (baseline goes in the report)

- Pages: `/`, `/forge`, `/markets`, `/markets/news`, `/coins`, `/coin/bitcoin`, `/agents`,
  `/play`, `/walk`, one agent profile. Production URLs (https://three.ws), not dev.
- Tool: Lighthouse CLI is already installable via npx (`npx lighthouse <url> --preset=desktop`
  and default mobile, `--output=json`). Capture LCP, CLS, TBT, transfer size per page. Three
  runs each, take the median; single runs lie.
- Bundle: `npm run build` then read the Vite output table. Anything > 250 kB gzip in the
  initial graph of a page is a finding. `dist/` chunk names are hashed; grep the manifest, not
  the filenames (chunk-grep gotcha, memory 07-15).

## Fix what the numbers say (typical findings and their standard fixes)

- Three.js in the initial bundle of non-3D pages: dynamic-import the viewer behind first
  interaction or viewport entry (pattern exists in `src/game/wheel-station.js`: lazy-import on
  interact).
- Fonts blocking render: `font-display: swap` and preload only the weights above the fold
  (`public/fonts/fonts.css`).
- CLS from images/thumbnails: explicit width/height or aspect-ratio boxes everywhere a dynamic
  image lands (news cards, marketplace grids, coin tables).
- Uncompressed or oversized textures/posters: posters for 3D scenes should be WebP <= 100 kB;
  the full GLB loads only on interaction.
- API waterfalls: pages that fetch sequentially (profile -> then assets -> then prices) get
  `Promise.all` or a combined endpoint if one already exists (check `api/` before adding one).
- Long main-thread tasks from JSON parsing (news/markets): move to `response.json()` streaming
  patterns or slice rendering with `requestIdleCallback` batches; the tables already paginate,
  ensure initial page size is sane.

## Infrastructure lever (GCP credits, pre-approved)

- `three-ws-api` Cloud Run: check `minInstances` on the service; if cold starts show in TTFB
  (compare first-hit vs warm TTFB), raise minScale to keep 1..2 warm instances. Credits absorb it.
- Confirm CDN cache hit rates for static assets (`gcloud compute backend-services` /
  `docs/ops/gcp-production.md` runbook has the LB layout). Assets with hashed names must be
  `cache-control: immutable`; HTML must not be cached stale (deploys purge via
  `npm run deploy:gcp`, never raw `gcloud builds submit`, which skips the purge).

## Guardrails

- Never fake it: no `setTimeout` progress, no optimistic spinners that lie (hard rule 5).
- Lazy-loading must not break deep links or SEO: server-rendered/SEO-injected meta stays
  (the SEO injector stamps pages at build; do not move meta client-side).
- Do not regress the audit:web console-error count.
- `npm test` failures gate the e2e stage; run the full suite, do not pipe through `tail`.

## Acceptance criteria

- [ ] Baseline vs after table for all 10 pages (LCP, CLS, TBT, transfer), medians of 3 runs.
- [ ] Every page: mobile LCP <= 3.0s, CLS <= 0.1, or a written reason why a page is at its floor.
- [ ] Initial JS on non-3D pages excludes three.js (proven from the build manifest).
- [ ] Cold-start TTFB measured; minScale raised if it was the bottleneck (numbers in report).
- [ ] Committed with changelog entry ("the site got faster": holders notice speed); `npm test` green.
