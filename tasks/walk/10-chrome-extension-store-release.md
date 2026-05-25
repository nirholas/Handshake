# Task 10 — Chrome Extension: Web Store Release Package

## Priority: HIGH

## Objective
Prepare the extension for publishing to the Chrome Web Store: legal pages, listing assets, privacy policy, content security review, and production build pipeline.

## Scope
- Production build:
  - `npm run build:extension:prod` — minifies, removes source maps, bumps version from `package.json`
  - Outputs a zip at `dist/extension-<version>.zip` ready to upload
- `extensions/walk-avatar/PRIVACY.md` — real privacy policy: declares what we collect (avatar selection, site allow/blocklist, session token), how we use it (rendering avatars), what we don't (no page content sent to our servers without explicit user action via TTS toggle)
- Publish corresponding page at `pages/extension-privacy.html` routed via vercel.json to `https://three.ws/extension/privacy`
- `extensions/walk-avatar/TERMS.md` and `pages/extension-terms.html` at `https://three.ws/extension/terms`
- Listing assets generated and placed at `extensions/walk-avatar/store-assets/`:
  - 128×128 icon (PNG)
  - 440×280 small promotional tile (PNG)
  - 1280×800 marquee (PNG)
  - 5 screenshots (1280×800) — take real screenshots of the extension running on real sites using Playwright (script at `scripts/extension-screenshots.mjs`)
- Update `manifest.json`:
  - `description`: under 132 chars, accurate
  - `permissions`: justify each one in `extensions/walk-avatar/PERMISSIONS.md` (Chrome reviewers require this)
  - Remove any wildcard permissions not actually used
- CSP review: ensure no inline scripts, no remote code execution; all JS bundled locally
- Add `extensions/walk-avatar/RELEASE.md` — manual checklist for each Web Store submission

## Definition of Done
- `npm run build:extension:prod` produces a zip that loads cleanly in Chrome with no warnings
- Privacy and terms pages are live at the documented URLs and pass a real CSP/lint check
- All listing assets exist as real PNGs of the actual product (no mockups)
- A self-review against [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies/) is documented in `RELEASE.md` with each item checked

## Rules
Complete 100%. No stubs. No fake data. Take real screenshots from a real browser. Wire everything end-to-end.
