# 03 — Widgets page

**Read `prompts/dashboard-next/_shared.md` first.** Then build the slice below.

## Your slice

Build the Widgets page at **`/dashboard-next/widgets`** — a grid of every widget the user has configured, each with a live iframe preview, stats, and quick management actions.

## Layout (top to bottom)

1. **Header row** — `.dn-h1` "Widgets" / `.dn-h1-sub` "Embed your agents anywhere — and see how they're performing." On the right, `.dn-btn.primary` "+ New widget" → `/widget-studio`.

2. **Aggregate stat strip** — four small inline stats (not full cards, more like an inline summary row): Total widgets · Views (7d) · Chat turns (7d) · Avg session (s). Compact, single-line, separated by `·` characters in `--nxt-ink-fade`. Fetch in parallel; each shows `—` until ready. Skip the entire strip if all four return zero.

3. **Widget grid** — `grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`, gap 14px. Each card is a `.dn-panel` with:
   - **Top half (220px tall):** live `<iframe src="/widget#widget=<id>&kiosk=true" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups">`. This is the same surface the public embed uses, so we're dogfooding.
   - **Bottom (padding 14px):** widget name (link to `/widget-studio?id=<id>`), tiny status badge (`.dn-tag.success` "Active" if last view < 24h else `.dn-tag` "Idle"), two columns of stats: Views 7d / Turns 7d.
   - **Top-right corner ⋮ menu:** Open studio · Copy embed snippet · Duplicate · Open transcripts · Delete

4. **Empty state** — `.dn-empty` if `/api/widgets` returns no rows:
   > **No widgets yet.** Turn any avatar into an embeddable agent — from a brand widget to a talking guide.
   > [Open widget studio]

## Files you create

- `pages/dashboard-next/widgets.html`
- `src/dashboard-next/pages/widgets.js`

Do not modify any other file.

## API endpoints

- `GET /api/widgets` → `{ widgets: [...] }` (or array; check `src/dashboard/dashboard.js`)
- `GET /api/widgets/:id/stats?days=7` → views, turns, avg session
- `POST /api/widgets/:id/duplicate` → returns new widget id, push it to the front of the grid
- `DELETE /api/widgets/:id` → confirm modal, optimistic remove

For the aggregate stat strip, sum across the per-widget `/stats` calls rather than inventing a new endpoint. Fire all stats requests in `Promise.allSettled` and use `.value` on fulfilled ones.

## "Copy embed snippet"

Opens a small popover (NOT a full modal) with three tabs:

1. **Script tag** (default, easiest):
   ```html
   <script async src="https://three.ws/embed.js"
           data-widget="WIDGET_ID"
           data-reveal="interaction"
           data-poster="auto"></script>
   ```
2. **iframe**:
   ```html
   <iframe src="https://three.ws/widget#widget=WIDGET_ID&kiosk=true"
           width="600" height="600" frameborder="0"></iframe>
   ```
3. **Web component**:
   ```html
   <threews-avatar avatar-id="AVATAR_ID" hide-chrome></threews-avatar>
   ```

Each tab has a "Copy" button (uses `navigator.clipboard.writeText`) and a toast on success.

## Empty / loading / error states

- 6 skeleton cards on first load (220px iframe slot shown as `.dn-skeleton`)
- Stats failure on a single card: the card still renders, stats slots show `—`
- Whole list failure: inline error banner with Retry, do not blank the page

## Performance note

Iframes are heavy. Use `loading="lazy"` and `<iframe>` only when the card scrolls into view (IntersectionObserver). Until then, render a poster image at `/api/widgets/<id>/og` (the existing OG-card endpoint — confirms exists in `public/embed.js`) inside the card with a "Click to preview" overlay.

## Verification

Smoke-test:
```bash
node scripts/_dn-shot.mjs http://127.0.0.1:3010/dashboard-next/widgets /tmp/dn-widgets.png
```
Verify:
- Cards render with either iframes or poster images
- Stats appear or skeleton, never `NaN`
- No console errors (a `Failed to load resource: /api/widgets/.../og` 404 is acceptable if a widget has no OG; gracefully fall back to a generic placeholder gradient)

`npx vite build` must pass.

## Commit message

`dashboard-next: widgets page — live iframe previews + per-card stats + embed snippet popover`
