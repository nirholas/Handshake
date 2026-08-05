# pages/

Source HTML for every static page surface on three.ws. Around 260 files. Each file here becomes a live page at a clean URL (for example `pages/tracker.html` serves at `https://three.ws/tracker`).

Subdirectories group related surfaces and keep their URL structure:

| Directory | Serves under | What it is |
|---|---|---|
| `agenc/` | `/agenc/*` | AgenC embodiment surfaces (embodied, room). |
| `aws/`, `aws-marketplace/` | `/aws`, `/aws-marketplace/*` | AWS partner and marketplace pages. |
| `billing/` | `/billing/*` | Billing surfaces (API keys). |
| `create/` | `/create/*` | Creation flows (video). |
| `dashboard-next/` | `/dashboard-next/*` | Next-gen dashboard. Pages here are auto-discovered by the build; no vite config edit needed. |
| `embodiment/`, `events/`, `features/`, `play/` | matching paths | Feature detail pages, event pages, playable demos. |
| `ibm/`, `openai/` | `/ibm`, `/openai` | Partner pages (ibm/ bundles its own fonts and vendor assets). |

## How a page becomes a live route

There is no automatic file-to-URL mapping in production. Four pieces must line up:

1. **Vite input** ([../vite.config.js](../vite.config.js)). Every page is an explicit entry in `build.rollupOptions.input`. `npm run build` emits it to `dist/pages/<name>.html`, then the `flatten-pages-dir` plugin moves root-level pages to `dist/<name>.html`. Nested directories (features/, dashboard-next/, ...) keep their structure inside `dist/`. Exception: `pages/dashboard-next/` is auto-discovered by `discoverDashboardNextInputs()`, so files there need no config edit.
2. **Route table** ([../vercel.json](../vercel.json)). A rewrite maps the clean URL to the built file: `{"src": "/tracker", "dest": "/tracker.html"}` plus a twin for the trailing-slash form `"/tracker/"` (some routes use a single `"/tracker/?"` pattern instead). `vercel.json` is a LIVE config file. Production runs on Cloud Run, and [../server/index.mjs](../server/index.mjs) parses this route table at startup: phase-1 rewrite rules, then a filesystem phase over `dist/`, then post-filesystem 404 rules.
3. **No `.html` fallback exists.** The server's `resolveStatic()` serves an exact file path or a directory's `index.html`, nothing else. A page built to `dist/slug.html` is a hard 404 at `/slug` until the vercel.json rewrite lands. This shipped twice (`/timeline`, `/tracker`), which is why `check:pages` now gates the build.
4. **Page registry** ([../data/pages.json](../data/pages.json)). The single source of truth for what exists on three.ws. It feeds the sitemap, `llms.txt`, `features.json`, and the public changelog.

In dev (`npm run dev`, port 3000) a middleware in vite.config.js resolves `/<slug>` straight to `pages/<slug>.html` as a generic fallback. So a page can look fully routed in dev while being a 404 in production. Do not trust dev routing; trust `check:pages`.

## What check:pages enforces

`npm run check:pages` runs [../scripts/check-pages.mjs](../scripts/check-pages.mjs). It loads every path declared in `data/pages.json` and resolves each one exactly the way the production server would, using [../scripts/lib/page-routing.mjs](../scripts/lib/page-routing.mjs) (an offline mirror of the server's route-table split, `substitute()`, `hasMatches()`, and `resolveStatic()`), against the local `dist/`. Any declared path that falls through to the 404 fallback fails the build and prints why: either the dist file exists but no rewrite maps the clean URL to it, or the page was never built (missing vite input entry). Resolution is checked as a bare anonymous GET, so cookie-gated or crawler-only routes correctly count as unreachable.

It runs automatically inside `npm run build:gcp` and again in `npm run deploy:gcp`. The same script sweeps the live site after deploy: `npm run smoke:prod` is `check-pages.mjs --base https://three.ws`.

`npm run check:dist` is separate: it verifies the built agent-3d library bundle in `dist/agent-3d/` and its version manifest, not pages.

## Page conventions

Read two or three neighboring pages before writing one. The established head structure, in order:

1. **Theme boot script first**, before anything else in `<head>`: the inline no-flash snippet that reads `localStorage.twx_theme` and sets `data-theme` on `<html>`. Copy it from any existing page.
2. `<meta charset>`, `<meta name="viewport">` with `viewport-fit=cover`.
3. `<title>` and `<meta name="description">`, both carrying `data-i18n` / `data-i18n-attr` attributes (the i18n pipeline in `docs/i18n.md` derives its catalog from these; `scripts/i18n-annotate.mjs` can add them).
4. `<link rel="canonical">` with the full `https://three.ws/<slug>` URL, favicon links, `manifest.webmanifest`.
5. Shared stylesheets: `/style.css`, `/nav.css`, `/footer.css` (sources in [../public/](../public/)).
6. OG and Twitter card meta. The image comes from the dynamic generator: `/api/page-og?s=<section>&t=<title>&d=<description>&p=/<slug>`.
7. Page-scoped styles in an inline `<style>` block, built entirely from the design tokens in [../public/style.css](../public/style.css): `--space-*`, `--text-*`, `--font-*`, `--weight-*`, `--color-*`, `--surface-*`, `--radius-*`, `--duration-*`, `--ease-*`, `--focus-ring-*`. No hardcoded colors or spacing.

Body conventions:

- `<header><div id="nav-container"></div></header>` plus `<script src="/nav.js"></script>` for the shared nav. Footer via `<script src="/footer.js"></script>`. Brand assets via `/brand.js`. The i18n runtime loads last: `<script type="module" src="/i18n.js"></script>` (built from `src/i18n.js`, emitted at the dist root).
- Page logic is either an inline `<script type="module">` or a module in `src/` referenced as `<script type="module" src="/src/<page>.js"></script>`.
- Data comes from real `/api/*` endpoints. In dev, `/api/*` proxies to production (override with `DEV_API_PROXY`). Never ship sample arrays or mocks.
- Admin and other internal pages add `<meta name="robots" content="noindex, nofollow" />` and are not registered in `data/pages.json`.

Quality bar (from CLAUDE.md, enforced at review): every interactive element has hover, active, and `:focus-visible` states; loading, empty, error, and populated states are all designed; layouts are responsive at 320, 768, and 1440 px with wide content scrolling in its own `overflow-x: auto` container; semantic HTML with ARIA labels on interactive elements.

## Checklist: adding a new page

1. Create `pages/<slug>.html` following the conventions above. Nested surfaces go in the matching subdirectory.
2. Add the entry to `build.rollupOptions.input` in [../vite.config.js](../vite.config.js): `'<slug>': resolve(__dirname, 'pages/<slug>.html')`. Skip this step only for `pages/dashboard-next/`.
3. Add the rewrite pair to the `routes` array in [../vercel.json](../vercel.json), before the `{"handle": "filesystem"}` marker, next to the other page rewrites: `{"src": "/<slug>", "dest": "/<slug>.html"}` and `{"src": "/<slug>/", "dest": "/<slug>.html"}`.
4. Register the page in [../data/pages.json](../data/pages.json) under the right section: `path`, `title`, `description`, `priority`, `changefreq`, and the `added` date (today, `YYYY-MM-DD`). The `added` date feeds the public changelog automatically; no separate `data/changelog.json` entry is needed for a new page.
5. Run `npm run build:pages` to regenerate the discovery surfaces (`public/llms.txt`, `public/llms-full.txt`, `public/sitemap/index.html`, `public/features.json`, `CHANGELOG.md`, `public/changelog.json`, `public/changelog.xml`). It validates your entry and fails on a malformed one. Never edit those generated files by hand.
6. Build and verify reachability: `npm run build`, then `npm run check:pages`. Green means the declared path resolves to a real file through the real route table.
7. Exercise the page in a browser with `npm run dev` (port 3000): real API calls in the network tab, no console errors, all states reachable.
8. If the page is a genuinely new product surface, add a row to [../STRUCTURE.md](../STRUCTURE.md).

Deployment note: `npm run build:gcp` runs the full production build (which includes `check:dist` and `check:pages`), and `npm run deploy:gcp` ships it, then sweeps the live site with `smoke:prod`. Deploys need owner approval.
