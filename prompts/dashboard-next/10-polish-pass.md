# 10 — Polish pass (motion, focus, mobile, perf, a11y)

**Read `prompts/dashboard-next/_shared.md` first.** Then build the slice below.

## Your slice

A cross-cutting polish pass over `/dashboard-next`. This prompt **assumes the other slices have landed**, so you'll be touching shell CSS, JS, and reviewing the existing pages. If a page doesn't exist yet because its prompt hasn't run, skip checks against it — just leave any CSS rules that would apply to it in place (they'll activate when the page lands).

This is the "make it feel premium" pass.

## Scope

### 1. Motion + micro-interactions

Add subtle, performant motion in `public/dashboard-next/shell.css`:
- Page-load fade-in (200ms ease-out) on `.dn-main-inner` (single transform/opacity, no layout shift)
- Hover lift on `.dn-panel` (translateY(-1px) + soft accent shadow, 160ms)
- Active-state press on `.dn-btn` (scale(0.98), 100ms)
- Sidebar collapse / expand: animate the grid-template-columns change (use the `transition` shorthand on `.dn-shell`)
- Drawer open / close: 220ms ease-out slide-in from the right
- Subtle accent pulse on the topbar drawer toggle when the drawer receives a new event (listen for `dn:drawer:new-event` window event — if prompt #9 dispatched it; otherwise add a comment that it'll wire up later)

All motion should respect `prefers-reduced-motion: reduce` — wrap each `@keyframes` / transition rule in a media query that flips it off.

### 2. Focus rings + keyboard nav

- Every interactive element gets a visible focus ring (`outline: 2px solid var(--nxt-accent); outline-offset: 2px;`)
- Sidebar items are keyboard-navigable in DOM order (no `tabindex="-1"` traps)
- `Tab` from the input inside the palette doesn't escape the overlay (focus trap — capture and cycle within the palette)
- `Esc` closes the palette and any open popover / modal
- Skip-link at the top of the shell: `<a href="#dn-main" class="dn-skip">Skip to content</a>`, hidden until focused, then jumps to the main content slot

### 3. Mobile / responsive QA

The shell.css already has a `@media (max-width: 880px)` block. Verify and tighten:
- Sidebar collapses into a bottom tab bar at ≤880px (icons + tiny labels, 4–5 items max — pick the most important from each group: Overview · Avatars · Widgets · Money · Account)
- Topbar shrinks: hide the breadcrumb, keep search button and user chip
- Drawer becomes a full-screen sheet at ≤640px (slides up from bottom)
- All page grids reflow to single column at ≤640px
- Tap targets ≥44px tall

Test at 375px (iPhone SE), 768px (iPad portrait), 1024px (iPad landscape), 1440px (desktop). Take a screenshot at each breakpoint.

### 4. Performance

- `<threews-avatar>` and iframe widgets MUST be lazy-loaded (IntersectionObserver, root margin 200px). If a prompt-2 or prompt-3 page didn't do this, fix it.
- Verify all images use `loading="lazy"` and `decoding="async"`
- No blocking webfonts: ensure `font-display: swap` in `public/fonts/fonts.css` (only edit if it's missing — leave existing rules untouched otherwise)
- Lighthouse-equivalent: open `/dashboard-next` in headless Chrome, capture performance metrics via CDP — log FCP and LCP. Document the numbers in the commit message.

### 5. Accessibility audit

- Every interactive element has an accessible name (`aria-label` or visible text)
- Color contrast ≥4.5:1 for text (the palette already passes; verify by spot-checking the cards)
- Screen reader smoke: open `/dashboard-next` and check that the sidebar is announced as a `<nav aria-label="Dashboard sections">`, the main area as `<main>`, the drawer as `<aside aria-label="Activity">` (foundation already does this — verify)

### 6. Empty-state quality pass

Walk through every page and verify the empty state matches the bar:
- A short title (max 5 words)
- A one-sentence explainer
- A single primary CTA
- Optional secondary CTA only when there's genuinely a second path

## Files you may create / modify

- **Modify** `public/dashboard-next/shell.css` (additions only — don't remove existing rules)
- **Modify** `src/dashboard-next/shell.js` (add skip-link if missing, focus trap for any modal helpers)
- **Modify** `src/dashboard-next/components/palette.js` (focus trap — only if prompt #8 didn't already add it)
- **Modify** individual page files **only** to fix obvious bugs you encounter (e.g. missing `loading="lazy"`); document each modification in the commit body. Do NOT redesign pages.

Do not modify `nav.js`, `api.js`, `tokens.css`.

## Verification

Take screenshots at four widths:
```bash
cat > scripts/_dn-shot-mobile.mjs <<'EOF'
import { chromium } from 'playwright';
const url = process.argv[2]; const out = process.argv[3]; const w = Number(process.argv[4]);
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0,200)));
p.on('console',  m => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0,200)); });
await p.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForSelector('.dn-shell', { timeout: 20000 });
await p.screenshot({ path: out, fullPage: true });
console.log('saved', out);
if (errs.length) { console.log('errors:'); for (const e of errs) console.log(' ' + e); process.exit(1); }
await b.close();
EOF

for w in 375 768 1024 1440; do
  node scripts/_dn-shot-mobile.mjs http://127.0.0.1:3010/dashboard-next /tmp/dn-polish-$w.png $w
done
rm scripts/_dn-shot-mobile.mjs
```
Open all four. Verify:
- 375px: bottom tab bar, single-column content, all tap targets reachable
- 768px: bottom tab bar still, content uses available width
- 1024px: sidebar visible, content in 2-column grid where appropriate
- 1440px: full three-column shell (if drawer is open) — drawer can be opened in the script via `localStorage.setItem('dn:drawer:open', '1')` before navigation

Lighthouse-equivalent perf:
```js
// in headless playwright, after page load:
const metrics = await p.evaluate(() => JSON.stringify(performance.getEntriesByType('navigation')));
console.log('nav:', metrics);
const lcp = await p.evaluate(() => new Promise(r => new PerformanceObserver(l => r(l.getEntries().pop()?.startTime ?? null)).observe({ type: 'largest-contentful-paint', buffered: true })));
console.log('lcp:', lcp);
```
Document FCP / LCP in the commit body.

`npx vite build` and `npx vitest run` must both pass.

## Commit message

```
dashboard-next: polish pass — motion, focus rings, mobile QA, perf, a11y

- Motion: page-load fade-in, panel hover lift, button press, drawer slide
- Focus: visible rings, skip-link, palette focus trap
- Mobile: bottom-tab nav ≤880px, full-sheet drawer ≤640px
- Perf: lazy 3D + iframes (LCP <Xms / FCP <Yms on /dashboard-next)
- A11y: aria labels, contrast pass
```
