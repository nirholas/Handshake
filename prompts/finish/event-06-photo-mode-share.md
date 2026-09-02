# 06 · Photo mode: the screenshot people post

**How to run:** paste this whole file into a fresh Claude Code chat in the three.ws repo, or tell the agent to read `prompts/finish/event-06-photo-mode-share.md`. Read [00-CONTEXT.md](event-00-CONTEXT.md) first.

**Operating clause:** finish 100%. Never end the session with a question, an unexecuted plan, or "let me know". CLAUDE.md hard rules bind: no mocks, no TODO comments, no em-dash characters, commits stage explicit paths only, pushes and production deploys are owner-gated.

## Step 0 · Re-derive the current state

```bash
sed -n '1,60p' src/walk-capture.js
grep -rn "capture\|screenshot" src/game/*.js | head -20
```

`/walk` already has a capture system (`src/walk-capture.js`). Read it fully first: if it can be shared or adapted, that beats a second implementation. Check whether `/play` already exposes any capture affordance; whatever exists, extend rather than duplicate.

## The feature

Event attendees will want proof they were there. Give `/play` a photo mode worth posting:

- **Trigger:** a HUD camera button plus the `P` key (check the existing keybinding map in [src/game/coincommunities.js](../../src/game/coincommunities.js) for collisions first; pick a free key if `P` is taken).
- **The shot:** captures the WebGL canvas at render resolution with the HUD chrome excluded, composited onto a clean share card: the world screenshot, the three.ws mark, the coin's name/symbol, and during the event window (read `public/event.json`) a subtle "$THREE Community Day 2026" stamp. Canvas compositing client-side; no server round trip.
- **The flow:** press, a shutter beat (respecting `prefers-reduced-motion`), a preview card slides in with Download and Copy-to-clipboard actions, Escape or X closes it. While the preview is open the world keeps running behind it.
- **Wire the capture path properly:** WebGL canvases need `preserveDrawingBuffer` or a same-frame read; check how the renderer is created in `coincommunities.js` and how `walk-capture.js` solved this, and take the zero-cost path (render-then-read in the same rAF), never a permanent `preserveDrawingBuffer` flip without measuring.

## Tasks

1. Build it as a lazy-loaded module under [src/game/](../../src/game/) (the pattern every heavy panel on this surface uses): nothing loads until first use.
2. HUD button with hover/active/focus states, and the keybinding, both discoverable (the button's title names the key).
3. The share card design: monochrome, tasteful, correct at portrait and landscape canvas sizes. This is the artifact people will judge the platform by; hit the screenshot-and-share bar.
4. Verify in a real browser desktop + mobile emulation: capture in the lobby-adjacent world, in a dense scene, and during zen mode (decide and implement the sane behavior: photo mode should work in zen, it is what zen is for).
5. Changelog entry (tags: `feature`); `npm run build:pages`.

## Definition of done

- [ ] Press-to-preview-to-download works with zero console errors; the downloaded PNG contains the world, not a black frame (the classic drawing-buffer bug), on Chromium and one other engine.
- [ ] Copy-to-clipboard produces a pasteable image where the Clipboard API allows it, and the button communicates unsupported browsers honestly.
- [ ] No measurable frame cost when photo mode is not open (lazy import verified in the network tab).
- [ ] `npm run check:rules -- --paths <files you touched>` passes; `npm run test:core` passes.
- [ ] Changelog entry present; committed with explicit paths; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Black captures | Same-frame read: perform the canvas read inside the render loop right after the frame draws; `walk-capture.js` shows the working pattern. |
| Clipboard API unavailable (Safari/firefox variants) | Feature-detect `navigator.clipboard.write` + `ClipboardItem`; fall back to download-only with the copy button hidden, not broken. |
| Keybinding collisions | The input handling in `coincommunities.js` is the registry; read it and pick an unbound key. |
| Font/mark assets for the card | The brand SVG is inline in `coincommunities-ui.js` and `/three.svg` is served; reuse, never re-draw. |

## Report format

The trigger shipped, the capture path chosen and why, browsers verified, a note on where the sample card was saved locally for the owner to eyeball, files committed.
