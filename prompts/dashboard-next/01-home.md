# 01 — Home / Overview page

**Read `prompts/dashboard-next/_shared.md` first.** It contains the project rules, foundation paths, atomic classes, smoke-test recipe, and commit instructions. Then build the slice below.

## Your slice

Build the Overview page at **`/dashboard-next/`**. This replaces the placeholder at [src/dashboard-next/pages/home.js](src/dashboard-next/pages/home.js) with the real product.

This is the page users land on when they hit `/dashboard-next`. It is the hero of the redesign — it must feel premium and 3D-native, not like a generic admin panel.

## Layout (top to bottom)

1. **Hero heading row** — `<h1 class="dn-h1">` with the user's first name + greeting that varies by time-of-day ("Good morning, …", "Good evening, …"). One-line subheading underneath.

2. **3D avatar strip** — horizontally-scrolling rail of the user's most-recent **5–8 avatars**, each rendered as a live `<threews-avatar avatar-id="…" hide-chrome bg="transparent">` web component inside a 240×320 portrait card. The web component is loaded by including `<script src="/embed.js"></script>` once in the page HTML. Each card shows the avatar name underneath and is clickable → navigates to `/avatars/<id>` (the existing avatar-page route, not `/dashboard-next/avatars/<id>`). Empty state: the `.dn-empty` block with CTA "Create your first avatar" → `/create`.

3. **KPI row** — four `.dn-panel` cards in a CSS grid (`repeat(auto-fit, minmax(180px, 1fr))`):
   - **Avatars** (count) — `/api/avatars?limit=1` returns `total` or count the page; fall back to length
   - **Widgets** (count) — `/api/widgets`
   - **30-day revenue** (`formatUsdc`) — `/api/billing/revenue?from=<30d ago iso>&to=<now iso>&granularity=day`, sum the points
   - **Active subscriptions** (count) — pick the cheapest endpoint that returns this; if none exists, leave the KPI labelled "Subscriptions" with `—` and a tooltip explaining no endpoint yet
   Each card has a tiny sparkline at the bottom built from the relevant series (revenue card uses the revenue series directly; counts can show a 7-bar microbar from past activity — if no per-day series exists, omit the sparkline rather than fake one).

4. **Quick actions grid** — six small cards in two rows, each a CSS-grid item:
   - "Create avatar from selfie" → `/create/selfie`
   - "Upload a GLB" → `/create` (or `/dashboard-next/avatars` once that lands)
   - "Make a widget" → `/widget-studio`
   - "Issue an API key" → `/dashboard-next/api`
   - "Set up an agent" → `/dashboard-next/account`
   - "View revenue" → `/dashboard-next/monetize`
   Use the inline-SVG icons already in `src/dashboard-next/nav.js` (`ICONS`).

5. **Recent activity preview** — a `.dn-panel` showing the **last 6 events** from `/api/events?limit=6` (or the dashboard.js endpoint that already powers Activity). Each row: icon, plain-English summary, `relTime(iso)`. Empty state inside the panel says "No activity yet — your first widget view will show up here." Link at the bottom: "Open full activity →" which dispatches `window.dispatchEvent(new CustomEvent('dn:drawer:toggled', { detail: { open: true } }))` *and* sets the topbar drawer toggle. Simpler: read `localStorage.setItem('dn:drawer:open', '1')` then click the toggle button programmatically.

## Files you create / modify

- **Replace** `src/dashboard-next/pages/home.js` (already exists as placeholder)
- **Modify** `pages/dashboard-next/index.html` — add `<script src="/embed.js"></script>` before the home.js module script
- That's it. Do not touch any other file.

## Data wiring rules

- Use `requireUser()` first. If the user has zero avatars, render the empty-state CTA in the 3D strip rather than empty cards.
- KPI cards each fetch independently and show their own `.dn-skeleton` until data lands.
- A single failed KPI fetch must not break the others — wrap each in `try/catch` and show `—` with a tiny "couldn't load" tooltip via `title="…"`.
- Hide the activity panel entirely (don't show an error) if `/api/events` returns 404 — that's a known unbuilt endpoint, not an error worth surfacing.

## Visual quality bar

- The hero 3D strip is the visual signature of the page. Each card should have a soft inner glow (`box-shadow: inset 0 -40px 60px -30px var(--nxt-accent-soft)`) and a 1px stroke (`--nxt-stroke`). Rounded corners `var(--nxt-radius)`. On hover, scale to 1.02 over 200ms.
- KPI numbers in `--nxt-ink`, 28px, font-weight 600, letter-spacing -0.02em. The label above in `--nxt-ink-dim`, 11.5px, uppercase, letter-spacing 0.08em.
- Quick-action cards have a subtle hover treatment (`background: rgba(255,255,255,0.04)` → `0.07` on hover). Icon left-aligned in `--nxt-accent`, label right.

## Verification

Smoke-test screenshot at `/tmp/dn-home.png` per the recipe in `_shared.md`. Open the image and verify:
- 3D avatars actually render (you'll see faces / models, not just empty cards)
- KPIs show real numbers (or `—` if no data, never `NaN` or `undefined`)
- Quick-action grid is six items, no broken icons
- Activity panel either shows real events or is hidden

Then `npx vite build` must succeed, and `npx vitest run tests/api/widgets.test.js tests/api/widget-knowledge-helpers.test.js` must pass (defensive check that you didn't break anything).

## Commit message

`dashboard-next: overview page — 3D avatar strip + KPIs + activity preview`
