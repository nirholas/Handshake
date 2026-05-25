# 09 — Mobile bottom navigation

**Read `prompts/dashboard-next/_shared.md` first.** Rules, helpers, smoke-test recipe, and commit guidance all live there.

## Your slice

The shell CSS already converts the sidebar to a bottom nav bar at ≤880px (the rail becomes `position:fixed; bottom:0; height:64px; flex-direction:row`). But it spills all 7 nav items into a horizontal scroll which is cramped. This prompt upgrades the mobile nav to show exactly **5 items max** in the bar with a "More" item that opens a bottom sheet for the rest.

## Files you own

- `public/dashboard-next/shell.css` — add/replace only the `@media (max-width: 880px)` block (lines ~413–455). Do not change anything above it.
- `src/dashboard-next/components/sidebar.js` — add mobile-specific rendering logic (a `renderMobileNav()` helper and a `mountMobileNavBehavior(shellEl)` function). Do not change `renderSidebar` or `mountSidebarBehavior`.
- `src/dashboard-next/shell.js` — call `renderMobileNav()` and `mountMobileNavBehavior()` on the shell element, conditional on viewport width. Do this **after** the existing `mountSidebarBehavior` call.

Do not modify any other file. In particular: do not change `tokens.css`, `nav.js`, `api.js`, or any page JS file.

## Behaviour

### Bottom bar (≤880px)

Show the **first 4 nav items** from `NAV` plus a "More" item as the 5th slot:

| Slot | Item |
|---|---|
| 1 | Overview (home icon) |
| 2 | Avatars (avatar icon) |
| 3 | Widgets (widget icon) |
| 4 | Monetize (coin icon) |
| 5 | "More" (three-dots icon, see SVG below) |

Each tab: icon 22×22, label 10.5px below. Active tab: `background: var(--nxt-accent-soft)`, icon and label in `var(--nxt-accent)`. Tap area min 56px wide.

"More" icon SVG:
```html
<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="10" r="1.2" fill="currentColor" stroke="none"/></svg>
```

### "More" bottom sheet

Tapping "More" slides up a bottom sheet (a `<div>` that translates from `translateY(100%)` to `translateY(0)` over 240ms `cubic-bezier(0.2,0.8,0.2,1)`), overlaying a semi-transparent backdrop.

The sheet contains:
- A drag handle bar (32×4px pill, centered, `background: var(--nxt-stroke-strong)`)
- Remaining nav items: Library, API & Embed, Account — same row format as the sidebar items (icon + label)
- A divider
- "Collapse sidebar" is hidden on mobile; replace with "Settings" → `/settings`
- "⌘K Command palette" button → fires `window.dispatchEvent(new CustomEvent('dn:palette:open'))`

Close the sheet on: backdrop click, swipe-down drag ≥60px, Escape key.

### Swipe-to-close

Track `touchstart` / `touchmove` / `touchend` on the sheet. If the user drags down by ≥60px before lifting, animate the sheet back down and remove it.

### No horizontal scroll

The existing mobile CSS uses `overflow-x: auto` on `.dn-rail-scroll`. Replace this so the bar never scrolls — it always shows exactly 5 fixed-width slots.

## CSS changes (inside `@media (max-width: 880px)`)

Replace the existing block with:

```css
@media (max-width: 880px) {
  .dn-shell,
  .dn-shell[data-rail-collapsed='true'] {
    grid-template-columns: 1fr;
    grid-template-rows: var(--dn-topbar-h) 1fr 64px;
    grid-template-areas: 'topbar' 'main' 'rail';
  }
  .dn-rail {
    flex-direction: row;
    position: fixed;
    bottom: 0; left: 0; right: 0;
    height: 64px;
    border-right: none;
    border-top: 1px solid var(--nxt-stroke);
    background: var(--nxt-glass-strong);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    z-index: 20;
  }
  .dn-rail-head, .dn-rail-foot, .dn-rail-group-label { display: none; }
  .dn-rail-scroll {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    padding: 0;
    gap: 0;
    overflow: hidden;
  }
  /* hide all nav items except the 5 mobile slots injected by JS */
  .dn-rail-group { display: none; }
  .dn-rail-mobile-slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    font-size: 10.5px;
    color: var(--nxt-ink-dim);
    padding: 6px 4px;
    cursor: pointer;
    border: none;
    background: transparent;
    font-family: inherit;
    text-decoration: none;
    transition: color 0.12s, background 0.12s;
    min-width: 0;
  }
  .dn-rail-mobile-slot:hover,
  .dn-rail-mobile-slot[aria-current='page'],
  .dn-rail-mobile-slot.active {
    color: var(--nxt-accent);
    background: var(--nxt-accent-soft);
  }
  .dn-rail-mobile-slot svg {
    width: 22px; height: 22px; flex-shrink: 0;
  }
  .dn-rail-mobile-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  /* bottom sheet */
  .dn-mobile-sheet-backdrop {
    position: fixed; inset: 0; z-index: 40;
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .dn-mobile-sheet {
    position: fixed; bottom: 64px; left: 0; right: 0; z-index: 41;
    background: var(--nxt-bg-1);
    border-top: 1px solid var(--nxt-stroke-strong);
    border-radius: 18px 18px 0 0;
    padding: 8px 0 env(safe-area-inset-bottom,0) 0;
    transform: translateY(100%);
    transition: transform 240ms cubic-bezier(0.2,0.8,0.2,1);
    touch-action: none;
  }
  .dn-mobile-sheet.open { transform: translateY(0); }
  .dn-mobile-sheet-handle {
    width: 32px; height: 4px;
    background: var(--nxt-stroke-strong);
    border-radius: 99px;
    margin: 6px auto 12px;
  }
  .dn-mobile-sheet-item {
    display: flex; align-items: center; gap: 14px;
    padding: 13px 20px;
    color: var(--nxt-ink-dim);
    font-size: 14.5px;
    cursor: pointer;
    border: none; background: transparent; font-family: inherit;
    text-decoration: none; width: 100%; text-align: left;
    transition: color 0.12s, background 0.12s;
  }
  .dn-mobile-sheet-item:hover,
  .dn-mobile-sheet-item[aria-current='page'] {
    color: var(--nxt-ink); background: rgba(255,255,255,0.04);
  }
  .dn-mobile-sheet-item svg { width: 20px; height: 20px; color: var(--nxt-ink-fade); flex-shrink: 0; }
  .dn-mobile-sheet-divider {
    height: 1px; background: var(--nxt-stroke); margin: 6px 0;
  }
  .dn-main-inner { padding: 18px 16px 80px; } /* extra bottom padding so content isn't under the nav */
}
```

## JS changes in `sidebar.js`

Add at the bottom of the file (do not alter existing functions):

```js
const MOBILE_NAV_ROUTES = ['/dashboard-next', '/dashboard-next/avatars', '/dashboard-next/widgets', '/dashboard-next/monetize'];
const SHEET_ROUTES = NAV.filter(r => !MOBILE_NAV_ROUTES.includes(r.path));

export function renderMobileNav(pathname) {
  const here = currentRoute(pathname)?.path;
  const slots = MOBILE_NAV_ROUTES.map(path => {
    const r = NAV.find(n => n.path === path);
    if (!r) return '';
    const active = r.path === here ? ' aria-current="page"' : '';
    return `<a href="${esc(r.path)}" class="dn-rail-mobile-slot"${active}>
      <span aria-hidden="true">${ICONS[r.icon] || ''}</span>
      <span class="dn-rail-mobile-label">${esc(r.label)}</span>
    </a>`;
  }).join('');
  const moreActive = SHEET_ROUTES.some(r => r.path === here) ? ' active' : '';
  const moreBtn = `<button type="button" class="dn-rail-mobile-slot${moreActive}" data-action="mobile-more" aria-haspopup="true">
    <span aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="10" r="1.2" fill="currentColor" stroke="none"/></svg></span>
    <span class="dn-rail-mobile-label">More</span>
  </button>`;
  return `<div class="dn-rail-scroll" role="tablist" aria-label="Main navigation">${slots}${moreBtn}</div>`;
}

export function mountMobileNavBehavior(shellEl, pathname) {
  if (window.innerWidth > 880) return;
  // Replace the existing rail scroll with the 5-slot mobile bar
  const rail = shellEl.querySelector('.dn-rail');
  if (!rail) return;
  rail.innerHTML = `
    <div class="dn-rail-head" style="display:none"></div>
    ${renderMobileNav(pathname)}
    <div class="dn-rail-foot" style="display:none"></div>
  `;
  rail.querySelector('[data-action="mobile-more"]')?.addEventListener('click', openSheet);
}

function openSheet() {
  const here = currentRoute(location.pathname)?.path;
  const backdrop = document.createElement('div');
  backdrop.className = 'dn-mobile-sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'dn-mobile-sheet';
  sheet.innerHTML = `
    <div class="dn-mobile-sheet-handle" aria-hidden="true"></div>
    ${SHEET_ROUTES.map(r => `<a href="${esc(r.path)}" class="dn-mobile-sheet-item"${r.path===here?' aria-current="page"':''}>
      <span aria-hidden="true">${ICONS[r.icon]||''}</span>
      <span>${esc(r.label)}</span>
    </a>`).join('')}
    <div class="dn-mobile-sheet-divider"></div>
    <a href="/settings" class="dn-mobile-sheet-item">
      <span aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="2.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg></span>
      <span>Settings</span>
    </a>
    <button type="button" class="dn-mobile-sheet-item" onclick="window.dispatchEvent(new CustomEvent('dn:palette:open'))">
      <span aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5"/><path d="M15 15l2.5 2.5"/></svg></span>
      <span>Command palette  ⌘K</span>
    </button>
  `;
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('open'));
  const close = () => {
    sheet.classList.remove('open');
    backdrop.style.opacity = '0';
    setTimeout(() => { sheet.remove(); backdrop.remove(); }, 260);
  };
  backdrop.addEventListener('click', close);
  window.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); window.removeEventListener('keydown', onKey); }});
  // Swipe-to-close
  let startY = 0, currentY = 0;
  sheet.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    currentY = e.touches[0].clientY;
    const dy = currentY - startY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (currentY - startY >= 60) { close(); }
    else { sheet.style.transform = ''; }
    startY = 0; currentY = 0;
  });
}
```

## JS changes in `shell.js`

After the existing `mountSidebarBehavior(shell)` call, add:

```js
import { mountMobileNavBehavior } from './components/sidebar.js';
// …
mountMobileNavBehavior(shell, location.pathname);
```

The import already exists at the top of `shell.js` — just add `mountMobileNavBehavior` to the named import list.

## Smoke test

Resize the Playwright viewport to 375×812 (iPhone 14 size) and take a screenshot:
```bash
cat > scripts/_dn-mobile-shot.mjs << 'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 375, height: 812 }, isMobile: true })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message.slice(0,200)));
p.on('console', m => { if (m.type()==='error') errs.push(m.text().slice(0,200)); });
await p.goto('http://127.0.0.1:3010/dashboard-next', { waitUntil: 'networkidle', timeout: 60000 });
await p.screenshot({ path: '/tmp/dn-mobile.png' });
await p.click('[data-action="mobile-more"]');
await p.waitForSelector('.dn-mobile-sheet.open', { timeout: 3000 });
await p.screenshot({ path: '/tmp/dn-mobile-sheet.png' });
if (errs.length) { errs.forEach(e => console.log('ERR', e)); process.exit(1); }
await b.close();
EOF
node scripts/_dn-mobile-shot.mjs
rm scripts/_dn-mobile-shot.mjs
```
`Read /tmp/dn-mobile.png` and `/tmp/dn-mobile-sheet.png`. Verify:
- Bottom bar shows exactly 5 slots, no horizontal scroll
- Sheet slides up when "More" is tapped
- No console errors
`npx vite build` passes.

## Commit message

`dashboard-next: mobile nav — 5-slot bottom bar + slide-up sheet for overflow items`
