# 08 — Command palette (full replace)

**Read `prompts/dashboard-next/_shared.md` first.** Rules, helpers, smoke-test recipe, and commit guidance all live there.

## Your slice

Replace the foundation stub at **`src/dashboard-next/components/palette.js`** with a full-featured command palette. The stub already handles open/close/keyboard and basic filtering — you're upgrading it with fuzzy search, recent history, action handlers beyond navigation, and keyboard accessibility polish.

## Files you own

- `src/dashboard-next/components/palette.js` — **full replace** (the stub comment says "Prompt #8 replaces this")

Do not modify any other file. The shell.js imports this via `mountPaletteBehavior()` — keep that export name.

## What the palette does

### Trigger
- Keyboard: ⌘K / Ctrl+K (already wired in `topbar.js`)
- Event: `window.dispatchEvent(new CustomEvent('dn:palette:open'))` (keep this working)
- Close: Escape, click outside, or selecting an item

### Items (five types)

**1. Navigation** — every route from `nav.js`. Show: icon (from `ICONS`), label, group name right-aligned. Selecting navigates via `location.href`.

**2. Recent pages** — last 6 pages visited, stored in `localStorage` under `dn:recent`. Each visit to a dashboard-next route pushes its `path` + `label` + `timestamp`. Show a "Recent" section above navigation when query is empty. Selecting navigates.

**3. Actions** — hardcoded shortcuts that fire JS, not navigation:
| Label | Group | Action |
|---|---|---|
| "Upload a GLB" | Create | `location.href = '/create'` |
| "Create from selfie" | Create | `location.href = '/create/selfie'` |
| "New widget" | Distribute | `location.href = '/widget-studio'` |
| "Issue API key" | Distribute | fires `window.dispatchEvent(new CustomEvent('dn:action:new-api-key'))` |
| "Sign out" | Account | `POST /api/auth/logout` then redirect `/` |

**4. Avatar quick-jump** — when the user types more than 2 chars, search their avatars: `GET /api/avatars?q=<query>&limit=5`. Show avatar name + "Open avatar" label. Selecting goes to `/a/<handle>` or `/avatar-page.html?id=<id>`. Show a loading spinner next to the input while the fetch is in flight (debounce 200ms).

**5. Help / docs** — static list of doc links visible when query is empty or matches:
- "Docs home" → `/docs`
- "ERC-8004 spec" → `https://eips.ethereum.org/EIPS/eip-8004`
- "API reference" → `/docs/api`

### Rendering

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍  Search or jump to…                              ⌘K     │
├─────────────────────────────────────────────────────────────┤
│  RECENT                                                      │
│  🏠  Overview                               Create   2m ago │
│  💰  Monetize                            Monetize  18m ago  │
├─────────────────────────────────────────────────────────────┤
│  NAVIGATION                                                  │
│  👤  Avatars                                        Create  │
│  📚  Library                                        Create  │
│  …                                                           │
├─────────────────────────────────────────────────────────────┤
│  ACTIONS                                                     │
│  ⬆  Upload a GLB                                   Create  │
│  …                                                           │
└─────────────────────────────────────────────────────────────┘
```

Sections with no matching items are hidden entirely. When query is non-empty, collapse the "Recent" section and merge all matching items (nav + actions + avatar results) into a single flat list sorted by: actions first, then nav, then avatar results.

### Keyboard navigation

- Arrow Up / Down: move the highlight. Wrap around.
- Enter: activate highlighted item.
- The highlighted item scrolls into view.
- Tab: move focus within the input / list (standard browser behavior — don't intercept it).

### Fuzzy matching

Use a simple scorer — no library:
```js
function score(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 3;
  if (t.startsWith(q)) return 2;
  if (t.includes(q)) return 1;
  // character-walk fuzzy
  let qi = 0;
  for (const c of t) { if (c === q[qi]) qi++; }
  return qi === q.length ? 0.5 : 0;
}
```
Items with `score === 0` are hidden.

### Visual spec

- Overlay: `position:fixed; inset:0; z-index:100; background:rgba(2,3,6,0.6); backdrop-filter:blur(8px)`. Fade in 120ms.
- Dialog: `width: min(580px, 92vw)`. `background: linear-gradient(180deg, rgba(28,29,39,0.97), rgba(18,19,26,0.97))`. `border: 1px solid var(--nxt-stroke-strong)`. `border-radius: var(--nxt-radius)`. `box-shadow: 0 30px 80px rgba(0,0,0,0.6)`.
- Input: 16px, `color: var(--nxt-ink)`, no border, transparent bg, `padding: 16px 18px`, border-bottom `1px solid var(--nxt-stroke)`.
- Section header: `font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--nxt-ink-fade); padding: 10px 12px 4px`.
- Item: `display:flex; align-items:center; gap:12px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; cursor:pointer`. Highlighted: `background: var(--nxt-accent-soft)`.
- Icon: 16×16 SVG from `ICONS` dict, or a Unicode glyph fallback. Color `var(--nxt-accent)` when highlighted.
- Group label right-aligned: `font-size: 11px; color: var(--nxt-ink-fade)`.
- Recent timestamp right-aligned: `font-size: 11px; color: var(--nxt-ink-fade)`.
- Loading spinner next to the input: a 12px CSS spinner (`border: 2px solid var(--nxt-stroke); border-top-color: var(--nxt-accent); animation: spin 0.7s linear infinite`) shown only during the avatar fetch.

## Smoke test

Open the page at `http://127.0.0.1:3010/dashboard-next`, press ⌘K (simulate via `p.keyboard.press('Meta+k')`):
```bash
cat > scripts/_dn-palette-shot.mjs << 'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message.slice(0,200)));
p.on('console', m => { if (m.type()==='error') errs.push(m.text().slice(0,200)); });
await p.goto('http://127.0.0.1:3010/dashboard-next', { waitUntil: 'networkidle', timeout: 60000 });
await p.keyboard.press('Meta+k');
await p.waitForSelector('#dn-palette[style*="flex"]', { timeout: 5000 });
await p.screenshot({ path: '/tmp/dn-palette.png' });
console.log('saved /tmp/dn-palette.png');
if (errs.length) { errs.forEach(e => console.log('ERR', e)); process.exit(1); }
await b.close();
EOF
node scripts/_dn-palette-shot.mjs
rm scripts/_dn-palette-shot.mjs
```
`Read /tmp/dn-palette.png` — verify the overlay renders, sections visible, no console errors. `npx vite build` passes.

## Commit message

`dashboard-next: command palette — fuzzy search, recent history, action shortcuts, avatar jump`
