# Daily Forge: a new 3D creative challenge every day

Daily Forge gives you one 3D creative challenge a day. The theme is deterministic, hashed from the UTC date so everyone in the world gets the same prompt on the same day, forge it into a real, textured 3D model for free with no sign-up, build a streak, and place your creation in AR on your phone. It is the platform's anonymous-first retention loop: a reason to come back tomorrow that costs nothing to start.

Page: [/daily](https://three.ws/daily) (`pages/daily.html`, `src/daily.js`)

APIs: `POST /api/forge` and `GET /api/forge?job=<id>` (free text-to-3D), `GET /api/forge-gallery?scope=community` (community strip), `GET /api/ar` (AR fallback launcher).

## Why it exists

The free forge is the platform's front door, but a one-off "make a 3D model" prompt has no reason to bring anyone back. Daily Forge wraps that same free generation in a game: a shared daily theme, a visible streak, and milestones. Because the theme is derived purely from the date, it is the same for every visitor and needs no backend, no login, and no coordination. The whole loop runs anonymously in the browser with a locally stored streak, so a first-time visitor with zero setup gets a creative prompt, a real GLB, and a reason to return the next day. It complements the logged-in streak system while asking nothing of the user up front.

## How it works

The page runs a WebGL support check first, then loads model-viewer from the CDN (behind the meshopt decoder, since Forge GLBs are meshopt-compressed) and finally the `src/daily.js` module. model-viewer is loaded only when WebGL is present, because it builds a `THREE.WebGLRenderer` the moment the element upgrades and throws on a browser that has no context to give it. If WebGL is unavailable the stage shows a "This browser can't render 3D" message and the Forge button is disabled, but the day's theme still renders: `src/daily/daily-theme.js` is DOM-free and pure, so the visitor still learns what today's challenge is. If the CDN itself is unreachable, `src/daily.js` loads anyway and a finished generation hands over its Download and AR links in place of the preview.

**Deterministic theme.** `src/daily/daily-theme.js` holds a frozen pool of 24 curated themes, each with an emoji, title, hint, accent, and three seed prompts. The theme for a date is chosen with an FNV-1a hash of the `YYYY-MM-DD` UTC key, plus a weekly rotation offset so a fixed weekday does not lock to one theme:

```javascript
function hashKey(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// idx = (hashKey(dateKey) + weeksSinceAnchor * 5) % THEMES.length
```

The "Day N" counter is anchored at 2026-07-17 (launch day is Day 1; earlier dates clamp to 1). A deterministic starter prompt is chosen the same way from the theme's seeds and pre-filled into the input; the idea chips are the theme's three seeds, and clicking one forges it immediately.

**Free forge.** `forge(prompt)` sends `POST /api/forge` with `{ prompt, backend: 'nvidia' }` and an `x-forge-client` header carrying an anonymous client id (`localStorage['forge:cid']`, generated with `crypto.randomUUID()` and shared with `/forge`, `/ar`, and AR Studio). This is the free NVIDIA NIM (Microsoft TRELLIS) text-to-3D lane: no key, no account. If the response is already `{ status: 'done', glb_url }` it renders immediately; otherwise it polls `GET /api/forge?job=<id>` every 3 seconds up to a 5-minute ceiling until the job is `done` (with a GLB) or `failed`.

**Streak state machine.** `src/daily/creator-streak.js` is a pure state machine over `{ current, best, lastDay, total }`, keyed to the UTC day and persisted at `localStorage['twx_daily_streak_v1']`. The streak bumps once per UTC day (idempotent: forging five times today counts once), on the model-viewer `load` event, since a completed creation is the qualifying action. A gap of exactly one day increments the streak; a larger gap resets `current` to 1 while preserving `best`. Milestones fire when `current` exactly hits one of `[3, 7, 14, 30, 50, 100, 365]`, with escalating celebration emoji and a haptic buzz.

**Community strip.** `loadCommunity()` reads `GET /api/forge-gallery?scope=community&limit=12`, the newest finished models across all clients, and renders links to `/viewer?src=...`. If the request is empty or fails, the strip stays hidden.

**AR handoff.** The stage `<model-viewer>` is AR-enabled (`ar-modes="webxr scene-viewer quick-look"`). "View in your room" calls `model-viewer.activateAR()` when the device supports it (WebXR, Android Scene Viewer, or iOS Quick Look), and otherwise opens the server-side device-aware launcher at `/api/ar?src=<glb>&title=<prompt>`. An "AR Studio" button opens `/ar/studio?src=<glb>&title=<prompt>`, and Share and Download build `/viewer` links and direct GLB downloads.

## Walkthrough

1. Open [/daily](https://three.ws/daily). The hero shows today's theme, its emoji, and a starter prompt already filled in. The header pill shows your current streak.
2. Edit the prompt or click an idea chip, then press Forge. The stage shows a working overlay with an elapsed timer while the free lane generates.
3. When the model loads, your streak bumps (once for today). At a milestone (3, 7, 14, 30, 50, 100, or 365 days) a celebration modal appears.
4. Tap "View in your room" to place the model in AR on your phone, or use AR Studio, Download, or Share.
5. Scroll to "Fresh from the community" to see what others forged today, and come back tomorrow for a new theme to keep the streak alive.

## Examples

The free forge lane is public and unauthenticated; the same contract powers `/daily`, `/forge`, and `/ar`.

```bash
# Start a free text-to-3D job on the NVIDIA lane
curl -X POST 'https://three.ws/api/forge' \
  -H 'content-type: application/json' \
  -H 'x-forge-client: my-anonymous-id' \
  -d '{"prompt":"a tiny brass robot with glowing eyes","backend":"nvidia"}'
# → { "job_id": "..." }  (or { "status":"done", "glb_url":"..." })

# Poll the job until it is done
curl -H 'x-forge-client: my-anonymous-id' \
  'https://three.ws/api/forge?job=<JOB_ID>'

# The community strip: newest finished models across all clients
curl 'https://three.ws/api/forge-gallery?scope=community&limit=12'
```

```javascript
// Reproduce today's deterministic theme selection
function themeIndex(dateKey, themeCount) {
  let h = 0x811c9dc5;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const anchor = Date.UTC(2026, 6, 17);
  const week = Math.floor((Date.parse(dateKey + 'T00:00:00Z') - anchor) / (86400000 * 7));
  return ((h >>> 0) + week * 5) % themeCount;
}
console.log(themeIndex(new Date().toISOString().slice(0, 10), 24));
```

## States and limits

- **No sign-up, no key.** The whole loop is anonymous: an in-browser client id, a free NVIDIA generation lane, and a local streak. Nothing is stored server-side about you.
- **Per day.** The theme, the starter seed, and the streak all key on the UTC day. The streak counts at most once per day.
- **Prompt limits.** 3 to 600 characters (enforced in JS and on the input).
- **Empty and error states.** The stage has idle, working (with an elapsed timer), and failed (with retry) overlays. The forge lane surfaces offline (503), rate-limited (429 with a retry-after), unreachable (a connection failure, phrased for a human rather than as "Failed to fetch"), and timeout (over 5 minutes of polling) states, plus a "generated but couldn't display" path that still offers a download and still counts the streak. The action bar sits above the overlays, so the Download button that copy points at is actually clickable. The community strip hides itself when empty or when the gallery is down. WebGL-unsupported browsers never load model-viewer, and still see the day's theme.
- **Shared links do not cheat the streak.** Opening `/daily?src=<glb>` to view someone else's creation does not light your streak; only a real forge does. A `src` that is neither absolute https nor a same-origin path is refused with a designed message rather than handed to the viewer.
- **The theme is data, not copy.** Every element `src/daily.js` writes is claimed with `data-i18n-owned="1"` before it is written, so the runtime i18n catalog pass (which lands after an async `/api/locale` fetch) cannot revert the day's theme back to the "Today's theme" / "Loading today's challenge" placeholders baked into the HTML. Copy this module writes itself reads back through `window.threewsI18n.t()` and re-renders on `i18n:change`.
- **Keyboard and focus.** Every control carries a visible `:focus-visible` ring in the day's accent colour. The milestone dialog takes focus on open, closes on Escape or a backdrop click, keeps Tab inside itself, and restores focus to whatever was focused before it opened.

## Related

- [The 3D pipeline](./3d-pipeline.md) and [3D API](./3d-api.md): the text-to-3D forge the free lane rides
- [Forge background generation](./forge-background-generation.md): the job and polling model
- [AR and WebXR](./ar.md): the Scene Viewer and Quick Look handoff
- [Quick start](./quick-start.md): the general free-forge onboarding
- Pages: [/daily](https://three.ws/daily) · [/forge](https://three.ws/forge) · [/ar/studio](https://three.ws/ar/studio)
