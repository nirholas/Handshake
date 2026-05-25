# Task 27 — Dashboard: Walking Avatar in Topbar / Sidebar

## Priority: MEDIUM

## Objective
Show the signed-in user's primary avatar walking inside a small embedded canvas in the dashboard topbar. The avatar is a live status indicator: idle when no notifications, walks/waves when there's something new.

## Scope
- Files: `public/dashboard-classic/index.html`, `public/dashboard/`, `src/dashboard/dashboard.js`, `public/dashboard-next/`
- Add a 64×80px walking avatar canvas in the topbar (right side, before user menu)
- Uses real `/api/avatars/mine?primary=true` to get the user's primary avatar
- State driven by real data:
  - Default: avatar idles
  - New notification (poll `/api/notifications/unread-count` every 30s or via existing SSE/WS): avatar plays `wave` gesture
  - User receives a tip / payment: avatar plays `cheer` gesture
  - Long inactivity (10 min): avatar sits down
- Click the avatar → opens a dropdown with:
  - Avatar's name + handle
  - "Open Walk" → `/walk?avatar=<id>`
  - "Edit Avatar" → `/avatar-edit?id=<id>`
- Render with low-cost settings: 30 FPS, antialias off, no shadows — keeps dashboard snappy

## Definition of Done
- Sign in, open dashboard → avatar walks/idles in topbar
- Trigger a real notification → avatar waves within 30s
- Click avatar → dropdown opens with working links
- No measurable impact on dashboard render performance (verify with DevTools Performance tab)
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real avatar fetch, real notification source, real interactions. Wire end-to-end.
