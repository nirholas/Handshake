# dashboard-next — shared briefing

You're a senior engineer working in the **three.ws** monorepo (Vite + vanilla JS + Vercel serverless). Read `/CLAUDE.md` before you touch any code — the project rules below are non-negotiable.

## Project rules (hard, non-negotiable)

1. **No mocks, no fake data, no placeholder arrays.** Use real `/api/*` endpoints. Real APIs, real data.
2. **No TODO / FIXME / XXX / commented-out code.** Finish what you start.
3. **No `throw new Error("not implemented")`, no fake `setTimeout` progress bars.**
4. **Definition of done:** code written, wired, exercised in a real browser (`npx vite --port 3010`), no console errors, screenshot captured and verified, `npx vite build` green, `npx vitest run` passes.
5. **Push to BOTH remotes when you commit.** `origin` (canonical) AND `threeD` (mirror). See the "Commit + push" section below.
6. **Tone:** professional, terse. No emojis in code or commits.

## What you're building

A new dashboard prototype at `/dashboard-next`. The shell, design tokens, sidebar, topbar, drawer stub, palette stub, and route registry are already on disk. You build **exactly one self-contained slice** end-to-end. Other slices are being built by other agents in parallel — stay in your lane and you'll never conflict.

## Foundation already committed

- `pages/dashboard-next/index.html` — page template (overview page entry, JS at `src/dashboard-next/pages/home.js`)
- `public/dashboard-next/tokens.css` — `--nxt-*` design tokens
- `public/dashboard-next/shell.css` — layout grid + atomic classes
- `src/dashboard-next/shell.js` — exports `mountShell()` which renders chrome and returns the `<main>` content slot
- `src/dashboard-next/api.js` — exports `get/post/put/del/patch`, `requireUser`, `getMe`, `initialsOf`, `relTime`, `formatUsdc`, `esc`, `ApiError`
- `src/dashboard-next/nav.js` — sidebar route registry (treat as read-only)
- `src/dashboard-next/components/{sidebar,topbar,drawer,palette}.js` — read-only unless your prompt explicitly tells you to replace one
- `src/dashboard-next/pages/home.js` — minimal placeholder home page

Vite's input list auto-discovers any `pages/dashboard-next/*.html` you add — no central registry to update.

## Atomic classes (reuse, don't reinvent)

| Class | Purpose |
|---|---|
| `.dn-panel` | Bordered glass card |
| `.dn-panel-title` / `.dn-panel-sub` | Card title + subtitle |
| `.dn-h1` / `.dn-h1-sub` | Page hero heading + subheading |
| `.dn-btn` + `.primary` / `.ghost` / `.danger` | Button variants |
| `.dn-tag` + `.success` / `.warn` / `.danger` | Pill labels |
| `.dn-skeleton` | Loading shimmer — set width/height inline |
| `.dn-empty` | Centered empty-state block (use child `<h3>` + `<p>`) |

## Page boilerplate

Every new page goes in two files:

`pages/dashboard-next/<slug>.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>… · Dashboard · three.ws</title>
    <meta name="robots" content="noindex" />
    <link rel="icon" href="/favicon.ico" />
    <link rel="stylesheet" href="/fonts/fonts.css" />
    <link rel="stylesheet" href="/dashboard-next/shell.css" />
  </head>
  <body>
    <script type="module" src="/src/dashboard-next/pages/<slug>.js"></script>
  </body>
</html>
```

`src/dashboard-next/pages/<slug>.js`:
```js
import { mountShell } from '../shell.js';
import { requireUser, get, esc, relTime } from '../api.js';

(async function boot() {
  const main = await mountShell();
  const me = await requireUser(); // redirects if signed out

  main.innerHTML = `
    <h1 class="dn-h1">…</h1>
    <p class="dn-h1-sub">…</p>
    <div data-slot="content"></div>
  `;

  await renderContent(main.querySelector('[data-slot="content"]'), me);
})();

async function renderContent(host, me) {
  // skeleton first, then real fetch, then render
}
```

## Real-data sources

Read `/src/dashboard/dashboard.js` for the canonical API patterns this repo uses (cursor pagination, error envelopes, CSRF). Endpoints you'll likely touch:

- `/api/auth/me`
- `/api/avatars` (list with `cursor`, `limit`), `/api/avatars/:id` (GET/PATCH/DELETE)
- `/api/widgets`, `/api/widgets/:id`, `/api/widgets/:id/stats`, `/api/widgets/:id/transcripts`
- `/api/agents`, `/api/agents/:id`, `/api/agents/me`
- `/api/keys` (GET/POST/DELETE)
- `/api/billing/revenue?from=…&to=…&granularity=day`
- `/api/billing/usage`
- `/api/animations`, `/api/animations/presign`
- Activity / events: `/api/events?since=…` (poll) or `/api/events/stream` (SSE) — check existing dashboard.js for the actual path

If an endpoint doesn't exist yet, prefer extending an existing endpoint to inventing a new one. Open an issue mentally and DM the user before adding new server routes.

## Live 3D previews

The web component `<threews-avatar>` is loaded automatically when you do `<script src="/embed.js"></script>` on the page. Use:

```html
<threews-avatar avatar-id="abc..." bg="transparent" hide-chrome></threews-avatar>
```

It renders a live GLB at the user's avatar with built-in idle anim. Use it for hero thumbnails on the home page and avatars grid.

## Smoke-test (mandatory before reporting done)

```bash
# Start dev server (skip if already running)
nohup npx vite --port 3010 --host 127.0.0.1 > /tmp/dn-dev.log 2>&1 &

# Wait for it
until curl -sf -o /dev/null http://127.0.0.1:3010/dashboard-next; do sleep 2; done

# Headless screenshot script
cat > scripts/_dn-shot.mjs <<'EOF'
import { chromium } from 'playwright';
const url = process.argv[2]; const out = process.argv[3];
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
p.on('console',  m => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 200)); });
p.on('requestfailed', r => errs.push('REQ FAIL ' + r.url() + ' ' + r.failure()?.errorText));
await p.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20000 });
await p.screenshot({ path: out, fullPage: false });
console.log('saved', out);
if (errs.length) { console.log('errors:'); for (const e of errs) console.log(' ' + e); process.exit(1); }
await b.close();
EOF

node scripts/_dn-shot.mjs http://127.0.0.1:3010/dashboard-next/<your-page> /tmp/dn-<name>.png
rm scripts/_dn-shot.mjs
```

Then `Read /tmp/dn-<name>.png` so you actually see what you shipped. If something looks wrong, fix it before claiming done. Zero console errors required.

## Commit + push (both remotes — per CLAUDE.md)

```bash
git add -A
git status            # double-check you only touched your slice
git diff --cached | head -200

git commit -m "$(cat <<'EOF'
dashboard-next: <one-line title>

<2-3 lines: what + why>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push origin main
git push threeD main
```

Do **not** force-push. Do **not** skip hooks. If a push to `threeD` is rejected because someone else's commit landed first, `git pull --rebase origin main` then push both again.

## When you're done

Reply with: (1) the screenshot path, (2) the commit SHA, (3) any endpoints you hit that didn't exist (so the user can decide whether to add them later). Nothing else.
