# Feature 12: photo mode with branded one-tap share

The event's growth loop is screenshots. Right now only build mode has a screenshot + share sheet; the world itself has none. Build a photo mode so any player can capture a beautiful branded shot of their avatar in the $THREE world and share it in two taps.

## Where the code lives

- Camera: `src/game/camera-modes.js`; main loop + renderer: `src/game/coincommunities.js` (it already uses `toDataURL` and `navigator.share` for build shots; reuse those paths)
- HUD mount points: `src/game/coincommunities-ui.js`, styles in `src/game/coincommunities.css`
- Existing share-sheet precedent: the build screenshot flow in `src/game/world-persist.js` / build UI
- OG card for shared links: `api/play-og.js` (verify the /play link preview actually renders the coin image and name; fix it if stale)
- Deep-link contract: `coinWorldUrl()` covered by `tests/fits-lib.test.js`

## What to build

1. **Photo mode toggle.** A HUD button (and `P` key) that hides all HUD chrome, unlocks a free orbit camera with slow smoothed movement, and shows a minimal capture bar: shutter, frame toggle, exit. Mobile: pinch to zoom, drag to orbit, big shutter button.
2. **Branded frame.** Composite the capture on a canvas with a tasteful frame: coin image, name, symbol (from the live world state, the same values the HUD banner uses), the three.ws wordmark, and the deep link. No watermark spam; it should look like something a person wants to post.
3. **One-tap share.** `navigator.share` with the image file where supported; fallback to download + copy-link with a confirmation toast. The copied link is the canonical `/play?coin=...` URL for the current world.
4. **Quality details.** Capture at device-pixel-ratio resolution, not CSS pixels. Hide nameplates of other players in the shot unless they opted in (privacy default). Restore the exact camera and HUD state on exit.
5. **Self-attach if possible.** Prefer the `ambient-crowd.js` / `event-countdown.js` pattern (own module, own styles, zero or minimal edits to the 190 KB core files).

## Verify

- Desktop and emulated-mobile passes on `npm run dev`: enter photo mode, capture, share/download, exit; zero console errors; HUD returns exactly as it was.
- The shared deep link round-trips into the same world, and its OG preview (via `api/play-og.js`) shows the coin identity.
- `npm test` green.

## Report format

Files shipped, a saved sample capture path, what the share flow does per platform (share sheet vs download), and the `data/changelog.json` entry text you added.
