# 06 — Monetize page

**Read `prompts/dashboard-next/_shared.md` first.** Then build the slice below.

## Your slice

Build the Monetize page at **`/dashboard-next/monetize`** — consolidates Revenue, Payments, Subscriptions, Plan & Usage, Withdrawals, Earnings, and Tokens into one creator-friendly money hub.

## Layout (top to bottom)

1. **Header** — `.dn-h1` "Money" / `.dn-h1-sub` "Where your agents earn — and where it goes."

2. **Hero metric row** — three large stat cards (`.dn-panel`):
   - **Available to withdraw** (`formatUsdc`) — sum of `referral_earnings_total` + agent revenue not yet withdrawn. Below: `.dn-btn.primary` "Withdraw" → opens withdraw modal
   - **30-day revenue** (`formatUsdc`) — `/api/billing/revenue?from=<30d ago>&to=<now>&granularity=day`
   - **Active subscriptions** (count + `formatUsdc`/mo MRR) — `/api/billing/subscriptions` (or whatever the existing path is — check `src/dashboard/dashboard.js`)

3. **Revenue chart** — `.dn-panel`:
   - Title "Revenue · last 30 days" with a small dropdown to switch range (7d / 30d / 90d / 1y)
   - Vanilla `<svg>` bar chart, 240px tall, full width. One bar per day. Hover shows tooltip with day + amount.
   - Granularity adjusts with range: day for ≤90d, week for >90d
   - Source breakdown legend below the chart: how much came from API calls · subscriptions · skill unlocks · tips · token royalties

4. **Recent payments table** — `.dn-panel`:
   - Columns: When (`relTime`) · Source · Amount · Status (`.dn-tag.success` "Settled" / `.dn-tag.warn` "Pending" / `.dn-tag.danger` "Failed") · TX link
   - Source examples: "API call · key tws_abc" · "Subscription · @handle" · "Skill unlock · pump-strategy"
   - Pagination: cursor or "Load more"
   - Filter chips at top: All · Subscriptions · API · Skills · Tips

5. **Withdrawals section** — `.dn-panel`:
   - Pending withdrawals table at top (id · amount · chain · status · est arrival)
   - "Withdraw now" button → opens modal: chain selector (Solana / Base / Polygon / etc, only those with treasury keys configured), destination address (validate format per chain), amount input (clamps to available)
   - Past withdrawals (last 10) collapsed under a "Show past withdrawals" toggle

6. **Plan & usage** — `.dn-panel`:
   - Current plan name + price + renewal date (`relTime`)
   - Usage bars: avatars (X / Y), widgets (X / Y), LLM tokens this period (X / Y), storage GB (X / Y)
   - "Upgrade plan" CTA → `/pricing`

7. **Token earnings** (only if user has launched a token via Pump.fun):
   - Per-token row: ticker · holders · royalties earned · "View token" link
   - Hide section entirely if `/api/tokens?owner=me` is empty

## Files you create

- `pages/dashboard-next/monetize.html`
- `src/dashboard-next/pages/monetize.js`

Do not modify any other file. This page is dense — consider splitting into per-section helper functions for readability, all in the one `monetize.js` file or under `src/dashboard-next/pages/monetize/` if helpful.

## API endpoints

Read `src/dashboard/dashboard.js` and the existing `public/dashboard/` HTML files (`monetization.html`, `payments.html`, `subscriptions.html`, `billing.html`, `revenue.html`, `withdrawals.html`, `earnings.html`, `tokens.html`) to find the canonical endpoint paths. **Reuse them exactly.**

Likely:
- `GET /api/billing/revenue` `?from=&to=&granularity=`
- `GET /api/billing/usage`
- `GET /api/billing/payments`
- `GET /api/billing/subscriptions`
- `GET /api/agent-withdrawals` / `POST /api/agent-withdrawals`
- `GET /api/tokens?owner=me`

If an endpoint doesn't exist (e.g. unified "available to withdraw"), compute client-side from the data you do have, or surface `—` with a tooltip — don't invent backend.

## Empty / loading / error states

- Skeleton bars on the chart while loading
- Empty payments: `.dn-empty` "No payments yet. Hook a widget into your site or issue an API key to start earning."
- Withdrawal modal errors (insufficient balance, bad address): inline error message, keep modal open

## Chart implementation hint

Vanilla SVG. No chart library. Each bar:
```js
<rect x="..." y="..." width="..." height="..." fill="var(--nxt-accent)" rx="2"
      data-day="..." data-amount="..." />
```
On mouseover, position a `<g>` tooltip absolutely. Keep it under 80 lines.

## Verification

```bash
node scripts/_dn-shot.mjs http://127.0.0.1:3010/dashboard-next/monetize /tmp/dn-monetize.png
```
Verify:
- Hero metrics render real values (or `—` with tooltip)
- Chart bars visible
- Tables render with real or empty-state content
- No `NaN`, no `undefined`, no console errors

`npx vite build` passes.

## Commit message

`dashboard-next: monetize page — revenue chart + payments + withdrawals + plan + tokens`
