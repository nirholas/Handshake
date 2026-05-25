# 10 — Production wiring

**Read `prompts/dashboard-next/_shared.md` first.** Rules, helpers, smoke-test recipe, and commit guidance all live there.

## Your slice

The `/dashboard-next` prototype pages are built. This prompt wires the prototype into the production URL space so users can try it, and adds a discovery banner to the old dashboard.

**This prompt runs after all other prompts are complete.** If you see placeholder pages at any `/dashboard-next/*` route, that's expected — ship the wiring anyway so routes resolve.

## Files you own

- `vercel.json` — add routing rules for the new pages
- `public/dashboard/index.html` — add a "Try the new dashboard" banner
- `public/dashboard-next/shell.css` — add an "⬅ Production dashboard" escape hatch link in the rail foot (≥880px only)

Do not modify `nav.js`, `shell.js`, any page JS, or any other file.

---

## 1. vercel.json routing

Read the existing `vercel.json` to understand the routing pattern. The file already has these two entries (lines ~413–466 per the summary):

```json
{ "src": "/dashboard-next", "dest": "/dashboard-next/index.html" },
{ "src": "/dashboard-next/", "dest": "/dashboard-next/index.html" }
```

Add entries for each sub-page (after the existing two):

```json
{ "src": "/dashboard-next/avatars",    "dest": "/dashboard-next/avatars.html" },
{ "src": "/dashboard-next/avatars/",   "dest": "/dashboard-next/avatars.html" },
{ "src": "/dashboard-next/library",    "dest": "/dashboard-next/library.html" },
{ "src": "/dashboard-next/library/",   "dest": "/dashboard-next/library.html" },
{ "src": "/dashboard-next/widgets",    "dest": "/dashboard-next/widgets.html" },
{ "src": "/dashboard-next/widgets/",   "dest": "/dashboard-next/widgets.html" },
{ "src": "/dashboard-next/api",        "dest": "/dashboard-next/api.html" },
{ "src": "/dashboard-next/api/",       "dest": "/dashboard-next/api.html" },
{ "src": "/dashboard-next/monetize",   "dest": "/dashboard-next/monetize.html" },
{ "src": "/dashboard-next/monetize/",  "dest": "/dashboard-next/monetize.html" },
{ "src": "/dashboard-next/account",    "dest": "/dashboard-next/account.html" },
{ "src": "/dashboard-next/account/",   "dest": "/dashboard-next/account.html" }
```

Insert these **inside the existing `/dashboard-next` route block** in `vercel.json`, not at the end of the file. Read the file first to find the right insertion point.

**Important**: if any of the `.html` files don't exist yet (because that prompt hasn't run), the route still needs to be added — Vercel will 404 gracefully and the route will start working as soon as the page is deployed.

---

## 2. "Try the new dashboard" banner — `public/dashboard/index.html`

Read `public/dashboard/index.html` first. Add a banner **inside the `<body>` tag, before `<header>`**:

```html
<div id="dn-next-banner" style="
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 20px;
  background: linear-gradient(90deg, rgba(154,124,255,0.12), rgba(255,92,168,0.08));
  border-bottom: 1px solid rgba(154,124,255,0.25);
  font-size: 13px;
  color: #c8bfff;
">
  <span>
    ✦ The redesigned dashboard is in preview —
    <a href="/dashboard-next" style="color:#b39bff;font-weight:600;text-decoration:underline">try it now</a>
  </span>
  <button onclick="document.getElementById('dn-next-banner').remove();localStorage.setItem('dn-next-dismissed','1')"
    style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;line-height:1;padding:0 2px"
    aria-label="Dismiss">&times;</button>
</div>
<script>
  if (localStorage.getItem('dn-next-dismissed') === '1') {
    document.getElementById('dn-next-banner').style.display = 'none';
  }
</script>
```

The banner is dismissible (× button), persists the dismiss in `localStorage`, and does not require a server round-trip. Place the `<script>` tag immediately after the banner div so it runs synchronously and avoids flash.

---

## 3. "⬅ Back to production" link in `shell.css` rail foot

In `public/dashboard-next/shell.css`, find `.dn-rail-foot` or the rail footer section. The `shell.js` renders a "Collapse" button there. Add a second link below it (visible only on ≥880px) by injecting it via shell.js — but since this prompt owns shell.css not shell.js, add a CSS rule that shows a styled `<a>` when it appears in `.dn-rail-foot`:

Actually: edit `public/dashboard-next/shell.css` to add:

```css
.dn-rail-foot-back {
  display: block;
  padding: 8px 16px;
  font-size: 11px;
  color: var(--nxt-ink-fade);
  text-decoration: none;
  transition: color 0.12s;
}
.dn-rail-foot-back:hover { color: var(--nxt-ink-dim); }
@media (max-width: 880px) { .dn-rail-foot-back { display: none; } }
```

Then edit `src/dashboard-next/components/sidebar.js` **only** to add the link to the `renderSidebar` footer:

```js
// inside the .dn-rail-foot div, after the collapse button:
`<a href="/dashboard" class="dn-rail-foot-back">← Production dashboard</a>`
```

Find the exact line in `renderSidebar` where `.dn-rail-foot` is built and insert the anchor after the existing collapse button.

---

## Smoke test

After applying changes, verify:

```bash
# 1. Build succeeds
npx vite build

# 2. Dev server responds to all new routes
nohup npx vite --port 3010 --host 127.0.0.1 > /tmp/dn-dev.log 2>&1 &
until curl -sf -o /dev/null http://127.0.0.1:3010/dashboard-next; do sleep 2; done

for route in "" /avatars /library /widgets /api /monetize /account; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3010/dashboard-next${route}")
  echo "/dashboard-next${route} → HTTP $status"
done
```

All routes should return 200. Then take screenshots:

```bash
node scripts/_dn-shot.mjs http://127.0.0.1:3010/dashboard /tmp/dn-production-banner.png
node scripts/_dn-shot.mjs http://127.0.0.1:3010/dashboard-next /tmp/dn-next-home.png
```

`Read /tmp/dn-production-banner.png` — verify the purple/pink "Try the new dashboard" banner appears at the top of the old dashboard.

`Read /tmp/dn-next-home.png` — verify the "← Production dashboard" link is visible in the sidebar rail footer.

No console errors. `npx vite build` clean.

---

## Commit message

`dashboard-next: production wiring — vercel routes + try-new-dashboard banner + back link`
