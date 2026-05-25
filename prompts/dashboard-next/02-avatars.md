# 02 — Avatars page

**Read `prompts/dashboard-next/_shared.md` first.** It contains the project rules, foundation paths, atomic classes, smoke-test recipe, and commit instructions. Then build the slice below.

## Your slice

Build the Avatars page at **`/dashboard-next/avatars`** — a grid of every avatar the signed-in user owns, with live 3D thumbnails and inline management.

## Layout (top to bottom)

1. **Page header row** — `.dn-h1` ("Avatars") + `.dn-h1-sub` ("Your 3D models, animated and ready to embed."). On the right of the row, a `.dn-btn.primary` "+ New avatar" that opens a small popover with three options:
   - "From a selfie" → `/create/selfie`
   - "Upload a GLB" → `/create`
   - "From an existing avatar" → `/marketplace`

2. **Filter bar** — a thin row with:
   - Search input (`.dn-btn`-styled, full-width on the left) — filters client-side by name as the user types
   - Visibility filter chips: All · Public · Unlisted · Private (one chip active, click toggles)
   - Sort dropdown: Newest · Oldest · Name A→Z · Name Z→A

3. **Avatar grid** — `grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))`. Each card:
   - Top: live `<threews-avatar avatar-id="…" hide-chrome bg="transparent">` (load via `<script src="/embed.js">` in the page HTML), 220×280 portrait
   - Below: name (editable inline on click — pencil icon on hover), visibility tag (`.dn-tag.success` for public, `.dn-tag` neutral for unlisted, `.dn-tag.warn` for private), `relTime(updated_at)`
   - Top-right corner of the card: a `⋮` menu button revealing: Rename · Change visibility · Copy embed snippet · Open in viewer (`/app#avatar=<id>`) · Download GLB · Delete (`.dn-btn.danger`, confirm modal required)

4. **Pagination** — cursor-based using `/api/avatars?cursor=…&limit=24`. Render a `.dn-btn.ghost` "Load more" at the bottom while `next_cursor` is non-null. Auto-load the next page when the button enters the viewport (IntersectionObserver). Stop showing the button when `next_cursor === null`.

## Files you create

- `pages/dashboard-next/avatars.html` (use the page boilerplate from `_shared.md`, add `<script src="/embed.js"></script>`)
- `src/dashboard-next/pages/avatars.js`

Do not modify any other file.

## API endpoints to use

- `GET /api/avatars?limit=24&cursor=…` → `{ avatars: [{ id, name, visibility, updated_at, thumbnail_url?, source_meta? }], next_cursor }`
- `PATCH /api/avatars/:id` → `{ name?, visibility? }` for inline rename and visibility change
- `DELETE /api/avatars/:id` → confirm via a custom modal (not `confirm()`), then optimistically remove from the grid and toast on success / undo on failure
- `GET /api/avatars/:id` → for the embed snippet (returns id you already have, but read the helper in `src/dashboard/dashboard.js` to see what extra metadata the existing avatar page uses)

Read `src/dashboard/dashboard.js` for the existing avatar list/edit/delete patterns before writing — match them.

## Empty / loading / error states

- **First load:** show 8 skeleton cards (`.dn-skeleton` boxes shaped 220×280).
- **No avatars at all:** `.dn-empty` block:
  > **No avatars yet.** Build your first 3D agent — drop a selfie or upload a GLB.
  > [Create from selfie] [Upload a GLB]
- **Network failure:** inline error banner above the (empty) grid with a Retry button. Do not blank the page.
- **Inline action failure** (rename, visibility change, delete): toast with the server error string, never silently fail.

## Visual quality bar

- Card hover: scale 1.015 over 180ms, soft accent glow (`box-shadow: 0 0 0 1px var(--nxt-accent-soft), 0 8px 24px rgba(0,0,0,0.4)`)
- Visibility chips: pill-shaped, `--nxt-accent-soft` background when active
- ⋮ menu opens with a 120ms fade + 4px upward translate; closes on outside click and ESC
- Delete confirm modal uses a `.dn-panel` style with `.dn-btn.danger` for Delete, `.dn-btn.ghost` for Cancel

## Verification

Smoke-test per `_shared.md`:
```bash
node scripts/_dn-shot.mjs http://127.0.0.1:3010/dashboard-next/avatars /tmp/dn-avatars.png
```
Open the image. Verify:
- At least one real 3D avatar is rendered in the grid (if the test user has avatars)
- No console errors
- Hover an avatar card in headless mode by appending `await p.hover('.dn-avatar-card:first-child')` before screenshot to capture the hover treatment

Run `npx vite build` and confirm clean.

## Commit message

`dashboard-next: avatars page — live 3D grid + inline manage + cursor pagination`
