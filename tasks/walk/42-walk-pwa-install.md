# Task 42 — Walk PWA: Installable Native-Feel App

## Priority: MEDIUM

## Objective
Make `/walk` installable as a Progressive Web App, so users can launch it from their home screen, run it fullscreen, and use it offline with their last avatar/environment cached.

## Scope
- `public/walk.webmanifest`:
  - `name: "three.ws Walk"`
  - `short_name: "Walk"`
  - `start_url: "/walk"`
  - `display: "fullscreen"`
  - `orientation: "any"`
  - `icons: [...]` — 192, 256, 384, 512 PNGs (real, generated from `public/pwa-icon.svg`)
  - `background_color: "#000000"`
  - `theme_color: "#000000"`
  - `screenshots: [...]` — real screenshots taken via Playwright for the install prompt
- Link from `pages/walk.html`: `<link rel="manifest" href="/walk.webmanifest">`
- Service worker: `public/walk-sw.js`
  - Precaches the walk page shell, walk JS bundle, default avatar GLB, default environment GLB
  - Cache strategy: cache-first for static assets, network-first for API calls, fallback to last-cached avatar on offline
- Install prompt:
  - Listen for `beforeinstallprompt`, save event
  - Show a small "Install" button in the HUD after 30 seconds of active session (don't be annoying about it)
  - Track install acceptance to `/api/walk/metrics` as `eventName: 'pwa_installed'`
- iOS standalone mode:
  - `<meta name="apple-mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
  - Apple touch icon

## Definition of Done
- Open `/walk` in Chrome on Android → "Add to Home screen" prompt appears
- Install → launches fullscreen, looks like a native app
- Offline (airplane mode) → walk still loads with cached avatar
- iOS: "Add to Home Screen" via Safari also works and launches in standalone mode
- No console errors, no SW registration errors

## Rules
Complete 100%. No stubs. No fake data. Real service worker, real manifest, real screenshots. Wire end-to-end.
