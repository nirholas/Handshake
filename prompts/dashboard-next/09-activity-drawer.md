# 09 — Activity drawer — live feed

**Read `prompts/dashboard-next/_shared.md` first.** Then build the slice below.

## Your slice

Replace the **stub** at [src/dashboard-next/components/drawer.js](src/dashboard-next/components/drawer.js) with a real activity feed: live events streamed from the server (SSE if available, otherwise polling), grouped by day, with filter chips and a relative-time formatter that auto-updates.

## Behaviour spec

- Drawer slot, design, and open/close plumbing already exist. Topbar toggle and ⌘K command (after prompt #08 lands) both fire `dn:drawer:toggled` events.
- When the drawer is open, fetch and render. When closed, pause the stream (don't fetch in background — wasteful).
- Persist filter selection in `localStorage` under `dn:drawer:filters`.

## Layout (inside the existing `<aside class="dn-drawer">`)

1. **Header** (already in place — preserve the title + close button structure)

2. **Filter chip row** — under the header, scrollable horizontally if it overflows:
   - All · Widget views · Chat turns · Payments · Avatar edits · Withdrawals · Sign-ins
   - Multi-select (click toggles). Empty selection = All.

3. **Event list** — scrollable, grouped by day:
   ```
   ── Today ─────────────────
   [icon] Widget viewed · wdgt_abc · 2m ago
   [icon] Payment received · $0.50 · 17m ago
   [icon] Chat turn · "What's the weather?" · 28m ago
   ── Yesterday ────────────
   [icon] Avatar updated · Bunny v2 · 1d ago
   ...
   ```
   - Each row shows: icon (per category, color-coded), title, secondary subtitle (when relevant), relative time on the right
   - Click expands the row inline to show full details + a link "Open in viewer" / "Open transcript" / "Open payment" depending on category
   - Use `relTime(iso)` from `api.js`. Re-render `relTime` every 30 seconds for visible rows (use a single `setInterval` while the drawer is open, clear on close)

## Stream / poll strategy

1. **Check for SSE first.** Try opening `new EventSource('/api/events/stream')`. If it connects (one event received within 5s), use that. Subscribe to event types: `widget.view`, `widget.chat_turn`, `payment.received`, `avatar.updated`, `withdrawal.completed`, `auth.signin`.

2. **Fallback to polling.** If SSE not available (404 / connection error), poll `GET /api/events?since=<lastEventTs>&limit=20` every 8 seconds. Use `If-None-Match`-style cursor: pass the latest event id you've seen.

3. **Backoff on error.** If polling fails 3 times in a row, double the interval up to 60s. Surface a tiny "Reconnecting…" chip at the top of the drawer (replace with checkmark when next request succeeds).

4. **Optimistic insertion.** New events get inserted at the top with a 200ms slide-down + brief accent highlight (animate `background` from `--nxt-accent-soft` to transparent).

## Files you create / replace

- **Replace** `src/dashboard-next/components/drawer.js`
- Optionally add `src/dashboard-next/components/drawer-stream.js` for the SSE/poll logic if it gets large

Do not modify any other file.

## Event icons (inline SVG, ~16px)

| Category | Icon |
|---|---|
| `widget.view` | eye |
| `widget.chat_turn` | speech bubble |
| `payment.received` | dollar sign |
| `avatar.updated` | edit pencil |
| `withdrawal.completed` | arrow-down-circle |
| `auth.signin` | shield-check |
| (unknown) | dot |

Use `--nxt-accent` for payments and withdrawals, `--nxt-success` for sign-ins, neutral `--nxt-ink-dim` for the rest.

## Empty / loading / error states

- First load: skeleton rows (4 of them) inside the list
- No events ever: `.dn-empty` "No activity yet. Embed a widget or issue an API key — events will land here as they happen."
- Stream / poll failure: tiny "Reconnecting…" chip at the top of the drawer, never a full error blanking the panel

## Endpoints

Inspect `src/dashboard/dashboard.js` and `public/dashboard/actions.html` for the existing event endpoint shape. If the endpoint is named differently (e.g. `/api/audit-log` or `/api/activity`), use that — the API endpoint and event shape are whatever the existing code uses. **Do not invent a new endpoint.** If no event endpoint exists, render only the empty state with a one-line "Live activity is coming soon — wire it up at /api/events when ready."

## Visual quality bar

- Day separators: 11px uppercase `--nxt-ink-fade`, with a 1px stroke line on either side
- Event rows: 12px vertical padding, hover background `rgba(255,255,255,0.03)`, click to expand
- Expanded detail block: monospace font for ids, soft accent background card

## Verification

```bash
node scripts/_dn-shot.mjs "http://127.0.0.1:3010/dashboard-next?drawer=open" /tmp/dn-drawer.png
```
The drawer is closed by default — in the screenshot script, before taking the shot, open it:
```js
await p.evaluate(() => {
  localStorage.setItem('dn:drawer:open', '1');
});
await p.reload({ waitUntil: 'networkidle' });
await p.waitForSelector('.dn-drawer[aria-label="Activity"]', { state: 'visible' });
```
Verify:
- Drawer renders with filter chips + event rows OR empty state
- No console errors
- A `Failed to load: /api/events/stream` 404 is acceptable IF the page then successfully starts polling

`npx vite build` passes.

## Commit message

`dashboard-next: drawer — live activity stream (SSE+poll) with filters and day grouping`
