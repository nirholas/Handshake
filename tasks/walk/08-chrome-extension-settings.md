# Task 08 — Chrome Extension: Settings Page

## Priority: HIGH

## Objective
Build a dedicated extension options/settings page where users configure default behavior of their walking avatar across all sites — defaults that apply when they enable the extension on a new site.

## Scope
- File: `extensions/walk-avatar/options.html` + `options.js` + `options.css`
- Register in `manifest.json` as `options_page`
- Settings (all persisted to `chrome.storage.sync` so they roam across the user's Chrome installs):
  - Default avatar (avatar picker reused from popup)
  - Default position: bottom-right | bottom-left | top-right | top-left | follow-cursor
  - Default size: small (120×180) | medium (180×260) | large (240×340) | custom (W/H number inputs)
  - Walk speed default (0.5x–2x slider)
  - Site allowlist: textarea, one domain per line (avatar only appears on these sites)
  - Site blocklist: textarea, one domain per line (avatar never appears on these sites — takes precedence)
  - "Read page sections aloud" toggle (enables TTS narration — see task 09)
  - Voice select (uses `/api/tts/voices` real endpoint to populate dropdown)
  - Theme: light | dark | auto (follows host page background luminance)
  - Reset to defaults button
- Settings change → background.js broadcasts to all open tabs to update the running iframes via postMessage
- Diagnostics section at bottom:
  - Current session status (signed in / signed out)
  - Sign out button (clears `chrome.storage.local` session)
  - Extension version (read from `chrome.runtime.getManifest().version`)
  - Link to `https://three.ws/docs/extension` for help

## Definition of Done
- Open chrome://extensions → click extension Details → Extension options → opens this page
- Changing any setting persists across browser restarts
- Allowlist/blocklist actually filters where the avatar appears (verified on 3 different sites)
- All TTS voices listed are real voices from the API
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Wire every step end-to-end and verify in a real browser with the dev server running.
