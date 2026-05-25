# dashboard-next 01 — Home / Overview

**First**: read `prompts/dashboard-next/_shared.md`. It has the rules, foundation paths, helpers, smoke-test script, and commit guidance. Don't skip it.

## Your slice

The landing page at `/dashboard-next`. Replace the placeholder rendered by `src/dashboard-next/pages/home.js` with the real overview.

## Files you own

- `src/dashboard-next/pages/home.js` (overwrite the placeholder)
- `pages/dashboard-next/index.html` (already exists — only touch it if you need to add an extra `<link>` for `/embed.js` to use `<threews-avatar>`)

Do **not** touch any other file.

## What the page shows

**Hero strip — live 3D**
The user's 3 most recently updated avatars rendered with `<threews-avatar avatar-id="…" bg="transparent" hide-chrome>` in 240×320 portrait cards. Each card has a hover lift and a hover overlay revealing "Open", "Embed", "Edit" links. If the user has zero avatars, replace the strip with one big "Create your first avatar" CTA card linking to `/create`.

**KPI row — 4 cards**
- This week's revenue (`/api/billing/revenue?from=<7 days ago>&granularity=day`, sum `usd_total`)
- Widget views in the last 7 days (`/api/widgets` then sum `widgetStats(id)` for each; cache per session)
- New transcripts to review (`/api/widgets` then sum unread counts; if endpoint doesn't expose unread, sum the 7-day count)
- Active avatars (count from `/api/avatars`)

Each card: small label, big number, sparkline (inline SVG, no library — draw the trend across the same window). Use the `--nxt-accent` for the sparkline stroke.

**Recent activity — right column on lg+, full-width on md-**
Last 8 events across the account. Pull from `/api/events?limit=8` if it exists, else stitch from `/api/widgets/:id/transcripts?limit=2` for each widget. Each row: icon (use a Unicode glyph or a tiny SVG), single-line description, `relTime(iso)`. Click → navigate to the relevant entity.

**Quick actions — 2x2 grid below the hero**
Big tappable cards (use `.dn-panel` with `cursor:pointer`): "Create avatar from selfie → /create", "Embed an agent → /dashboard-next/widgets", "View revenue → /dashboard-next/monetize", "Open API keys → /dashboard-next/api".

## Layout (1440 viewport)

```
┌─────────────────────────────────────────────────────────────────────┐
│ "Welcome back, <name>." + sub                                        │
├──────────────────────────────────┬──────────────────────────────────┤
│  [avatar] [avatar] [avatar]      │  Recent activity                  │
│  hero strip — live 3D            │  · widget view  3m ago            │
│                                  │  · payment      18m ago           │
├──────────────────────────────────┤  · transcript   1h ago            │
│  KPI · KPI · KPI · KPI           │  · …                              │
├──────────────────────────────────┤                                   │
│  Quick actions (2x2)             │                                   │
│  · Create from selfie            │                                   │
│  · Embed an agent                │                                   │
│  · View revenue                  │                                   │
│  · Open API keys                 │                                   │
└──────────────────────────────────┴──────────────────────────────────┘
```

Below 1100px, stack the activity column under the main column.

## States

- **Loading** — every section starts with `.dn-skeleton` blocks matching its final shape. Don't render an empty page then pop content in.
- **Empty** — if the user has 0 avatars / 0 widgets / 0 revenue, swap the corresponding card body for a `.dn-empty` block with a single CTA.
- **Error** — if any fetch throws an `ApiError` other than 401 (which `requireUser` already handles), surface `err.message` in that section's panel as a small red note. Do not blank the whole page.

## Real-time touch

Once the page is mounted, set up a 30s `setInterval` that re-fetches the KPI row and the activity feed. Clear it on `beforeunload`. Animate any KPI number change with a 400ms tween from old → new (CSS counter or rAF). The setInterval is fine — it's real polling, not fake loading.

## Smoke test

Hit `/dashboard-next` on the dev server, capture `/tmp/dn-home.png`, `Read` it, confirm:
- Hero strip shows 3 spinning avatars (or the create CTA if user has none)
- KPI numbers are real (not `0` from a failed fetch)
- Activity feed has real entries (or empty state)
- No console errors
- Sidebar shows "Overview" highlighted

## Done = reply with

1. `/tmp/dn-home.png`
2. Commit SHA (pushed to `origin` AND `threeD`)
3. Any endpoint that didn't exist and forced a workaround
