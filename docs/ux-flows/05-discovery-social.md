# Discovery & Social

UX Flow Atlas — cluster "Discovery & Social". Each entry traces the real source end-to-end, from page entry to the feature's payoff.

Routing recap (from `vercel.json`):

| Route | Page HTML | Entry module |
|---|---|---|
| `/discover` | `public/discover/index.html` | `public/discover/discover.js` |
| `/gallery` | `public/gallery/index.html` | `public/gallery/gallery.js` |
| `/animations` | `pages/animations.html` | `src/animations-gallery.js` |
| `/characters` | `public/characters.html` | `src/characters.js` |
| `/community` | `pages/community.html` | inline live-activity module in page |
| `/walk` | `pages/walk.html` | `src/walk.js` (+ `src/community/coin-world-boot.js`) |
| `/irl` | `pages/irl.html` | `src/irl.js` (+ `src/irl/*`, `src/irl-net.js`) |
| `/irl-privacy` | `pages/irl-privacy.html` | (static content) |
| `/reputation` | `public/reputation/index.html` | `public/reputation/reputation.js` |
| `/lookup` | `public/lookup.html` | inline module in page |
| `/agents` | `public/agents/index.html` | inline module in page |
| `/my-agents` | `public/my-agents/index.html` | inline module in page |
| `/sitemap` | `public/sitemap/index.html` | inline filter script in page |

---

### Discover — `/discover`
- **Source:** `public/discover/index.html`, `public/discover/discover.js`, `public/discover/detail.{html,js,css}` (detail), `/api/explore`, `/api/discover-detail` (rewrite target for `/discover/a/...`; a `kind=solana` asset that is not one of ours falls back to the crawled `solana_agents_index`, so external Solana agents get a real link preview, and a malformed id returns the bare shell instead of a 500)
- **Entry point:** Page load auto-calls `loadPage()`. URL params hydrate filters (`?q=`, `?chain=`, `?source=`, `?only3d=`, `?sort=`). Default view (no params) is **3D-only**.
- **Prerequisites / gates:** None to browse. Auth (`/api/auth/me`) only reveals the "View my agents" chip + nav link; no gate.
- **Steps (8):**
  1. User lands on `/discover`. System fetches `/api/auth/me` (best effort) to maybe show the my-agents chip, populates the chain `<select>` (23 chains), reflects any URL params in controls, renders 12 skeleton cards, and calls `loadPage()`.
  2. System fetches `GET /api/explore?only3d=1&limit=48` (params from state), clears skeletons, renders cards (onchain / avatar / solana variants). Each card thumbnail prefers static image, else lazy `<model-viewer>` auto-rotate preview, else emoji. First page also renders directory totals.
  3. (optional) User types in the search box → 250ms debounce → `syncUrl()` + `resetAndLoad()` re-queries with `q`.
  4. (optional) User clicks a source filter (All / On-chain / Avatar / Solana) or the 3D / x402 filter chip → state updates, URL synced, grid reloads. x402 + sort overlays applied client-side.
  5. (optional) User picks a chain in the dropdown → reloads filtered to that chain.
  6. (optional) User scrolls; IntersectionObserver sentinel (`480px` rootMargin) auto-loads the next cursor page, or user clicks "Load more".
  7. (optional) User clicks a card's "Embed" button → embed modal opens with tabs (Web component / iframe / Link / Markdown / Farcaster), copy buttons; or "URI" button copies `agent://<chain>/<id>`.
  8. **Payoff:** User clicks a card → its canonical detail page from the API's `detailUrl`: ERC-8004 agents `/a/<chain>/<id>`, three.ws agents `/agents/<id>`, external Solana agents `/discover/a/sol/<asset>` (served by `/api/discover-detail`), avatars `/avatars/<id>`; or "View 3D" → opens the GLB viewer.
- **Decision points / branches:** card kind (onchain / avatar / solana → different render + detail URL); 3D-only default vs `only3d=0` firehose; signed-in (chip shown) vs not; IntersectionObserver present vs manual button.
- **External calls / dependencies:** `GET /api/explore`, `GET /api/auth/me`, `/api/discover-detail` (detail nav), `model-viewer` CDN, clipboard API.
- **Success state:** Grid of agent cards with live/static thumbnails + totals line; deep-linkable filtered view via `replaceState`.
- **Empty / error states:** Filtered-empty → "No agents match these filters yet" + Clear filters button. Unfiltered-empty → "No agents indexed yet… forge a 3D model." Fetch error → inline error with Retry button.
- **Step count:** 2 required (+6 optional)

---

### Avatar Gallery — `/gallery`
- **Source:** `public/gallery/index.html`, `public/gallery/gallery.js`, `public/gallery/surprise.js` (one-click instant avatar), `public/gallery/gallery.css`, `/api/avatars/public`, `/api/forge-gallery`, `/api/avatars` (equip modal), `/api/avatars/surprise`
- **Entry point:** Page load calls `renderCats()` then `resetAndLoad()`, then `loadForgeSection()`. Filters hydrate from URL (`?q=`, `?category=`, `?tag=`, `?sort=`); `?surprise=<seed>` auto-opens the shared Surprise-me avatar.
- **Prerequisites / gates:** None to browse. Auth (`/api/auth/me`) only reveals the "My avatars" chip. Equipping an accessory requires sign-in (gated inside the equip modal via `/api/avatars` 401).
- **Steps (8):**
  1. User lands on `/gallery`. System fetches `/api/auth/me` (chip), renders 8 skeleton cards, calls `loadPage()`.
  2. System fetches `GET /api/avatars/public?limit=24&totals=1`, renders cards. Each thumbnail is a lazy auto-rotating `<model-viewer>` (poster = thumbnail) or an `<img>`. Tag chips, onchain badge, fork count rendered. Stat count + tag/category filter rows populated.
  3. (optional) Search box → 250ms debounce → reload with `q`.
  4. (optional) Click a category chip (Avatars / Accessories / Items / Scenes / Creatures), a tag chip, or a **popular-search** chip (`GET /api/avatars/popular-searches?limit=10`, read off the Avatar Search Index's warm cache; a second click clears it) → reload filtered. Sort dropdown (newest / alpha) re-sorts.
  5. (optional) Scroll → IntersectionObserver auto-loads next cursor page, or "Load more" button.
  6. (optional) Click "Embed" on a card → avatar embed modal (Web component / iframe / Link / Markdown tabs, copy buttons); or click the hero's "✨ Surprise me" button (`data-surprise-avatar`) → `POST /api/avatars/surprise` composes a unique rigged GLB, revealed live in a tinted-stage modal with Reroll, a shareable `/gallery?surprise=<seed>` link, and "Make it mine" (stages the GLB into the guest flow → `/create-review`). No sign-in needed to see it.
  7. (optional) For accessory cards, click "Equip" → modal fetches `GET /api/avatars` (user's own); if 401, shows Sign-in CTA; else lists up to 12 avatars; choosing one navigates to `/avatars/:id/edit?equip-glb=…&equip-bone=Head`.
  8. **Payoff:** Click a card thumbnail → `/avatars/<id>` (the avatar's own page, not the bare GLB viewer); or "Use" → `/studio?avatar=<id>`; or "Animate" → `/pose?avatar=<id>`; or "View avatar" → `/avatars/<id>`. Below the grid, the **From the Forge** section renders community 3D models (`GET /api/forge-gallery?scope=community&limit=16`, deduped by prompt; a forge row has no title, so the card shows the first clause of its spec prompt and keeps the full text in the tooltip) with View/Remix actions.
- **Decision points / branches:** accessory category → Equip flow vs Use/Animate; model_url present → model-viewer vs img; signed-in chip; forge section enabled vs hidden (additive, never blocks).
- **External calls / dependencies:** `GET /api/avatars/public`, `GET /api/forge-gallery`, `GET /api/avatars` (equip), `GET /api/auth/me`, `model-viewer` CDN, `onchain-badge.js`, `template-picker.js`, clipboard API.
- **Success state:** Grid of 3D avatar cards + total count + Forge community section.
- **Empty / error states:** Filtered-empty → "No public avatars match your filters" + Clear filters + Upload CTA. Unfiltered-empty → "No public avatars yet" + Create-from-prompt / dashboard CTAs. Fetch error → "Failed to load avatars: <msg>". Forge section errors swallowed silently. A popular-search chip whose sample thumbnail has been pruned drops the image and renders as text rather than a broken-image box; the popular row stays hidden entirely when the endpoint returns nothing.
- **Step count:** 2 required (+6 optional)

---

### Animation Gallery — `/animations`
- **Source:** `pages/animations.html`, `src/animations-gallery.js`, `src/animation-categories.js` (derived categories), `src/animations-live-preview.js` (shared WebGL preview engine), `/api/animations/clips`, `/animations/manifest.json`, `/api/animations/library`, `/pose` (studio)
- **Entry point:** Module runs `loadAll()` on import. Query (`?q=`, `?cat=`, `?filter=loop|once`, `?sort=`) round-trips through the URL, and an unknown `cat`, `filter` or `sort` value falls back to the default rather than blanking the control or filtering everything away; `?clip=<id>` deep-links straight into the detail modal.
- **Prerequisites / gates:** None. Community clips fetched with `credentials: 'include'` but public visibility is the query; no sign-in required to browse.
- **Steps (5):**
  1. User lands on `/animations`. System shows loading state and merges three sources into one grid: community clips (`GET /api/animations/clips?include_public=true&visibility=public`, capped at 300, newest first), the built-in three.ws motion library (`/animations/manifest.json`, the same curated clips `/pose` ships with), and the full Mixamo-sourced catalog (`GET /api/animations/library`, fetched from the R2 CDN in bounded 1000-clip pages; only clips whose manifest entry carries a `thumb` get a thumbnail request, the rest show the icon placeholder without a doomed fetch).
  2. System normalizes every clip to one card shape (poster thumbnail, derived category, duration, loop/once badge) and paginates client-side (36 per page, infinite scroll, lazy thumbnails).
  3. (optional) User searches (`/` hotkey focuses the box), picks a category chip, a loop/once filter, or a sort → grid re-filters client-side; the URL stays shareable.
  4. (optional) User hovers a card's preview zone → the ONE shared WebGL engine moves its singleton canvas into that card and plays the retargeted clip on the preview avatar (no iframes, no per-card GL contexts; skipped for touch and reduced-motion users, who get the preview inside the detail modal instead).
  5. **Payoff:** Click a card → detail modal (arrow keys step between clips, Space toggles play, Copy link copies `/animations?clip=<id>`, Copy embed copies an `/embed/avatar?anim=<id>` iframe snippet) → "Open in Studio" navigates to `/pose?anim=<id>` to apply/remix the clip on an avatar. The transport stays hidden until the clip is on the stage, Tab is trapped inside the dialog, the sliders keep their own arrow and Space keys, and closing returns focus to the card that opened it.
- **Decision points / branches:** community vs library vs full-catalog card (community listed first); thumbnail present vs placeholder; touch/reduced-motion (modal-only preview) vs hover preview; search/filter active → empty-search state.
- **External calls / dependencies:** `GET /api/animations/clips`, `GET /animations/manifest.json`, `GET /api/animations/library` (R2 CDN pages), shared live-preview engine, `/pose` nav.
- **Success state:** One searchable grid across all three clip sources, each card live-previewable in place; "Open in Studio" reaches the editor.
- **Empty / error states:** No results + no filter → empty state; with filter/query → empty-search state with the query echoed + Clear-search; fetch failure → error state with Retry only when nothing loaded and at least one source failed, since a partial failure still renders whatever answered.
- **Step count:** 2 required (+3 optional)

---

### Characters — `/characters`
- **Source:** `public/characters.html`, `src/characters.js`, `/api/characters`, links to `/character/:id`
- **Entry point:** `init()` runs on import → calls `fetchCharacters(true)`.
- **Prerequisites / gates:** None.
- **Steps (4):**
  1. User lands on `/characters`. System renders 6 skeleton cards and fetches `GET /api/characters?limit=24&sort=new`.
  2. System renders character cards: avatar image (or color-hash placeholder), creator handle, description, chat-count / holders stats, optional `$`token block (symbol, market cap, 24h change), and a wallet chip if the character has a Solana address (`walletChipHTML`).
  3. (optional) User types in search → 300ms debounce → reload with `q`; or clicks a sort button (`data-sort`) → reload; or clicks "Load more" → paginates by cursor (opaque: `sort=new` echoes `created_at`, `sort=chats` echoes `<chat_count>:<created_at>` so Top pages through every character instead of ending after one page; a hand-edited cursor is a 400).
  4. **Payoff:** User clicks a card → navigates to `/character/:id` (character detail / chat).
- **Decision points / branches:** has token block vs not; has Solana address → wallet chip; image URL valid http(s) vs placeholder; reset vs append render (a reset supersedes an in-flight request through a generation token, so a slow first page cannot paint over a newer sort or search).
- **External calls / dependencies:** `GET /api/characters`, `walletChipHTML` from `src/shared/agent-wallet-chip.js`.
- **Success state:** Grid of character cards each linking to its detail page; the header carries a "Create a character" link to `/create-agent`.
- **Empty / error states:** Search-empty → "No characters match “<q>”." with Clear search; feed-empty → "No characters published yet." with a Create a character link (`/create-agent`); fetch error → "Could not load characters." with Try again; a failed Load more keeps the cards already on screen and relabels the button "Retry loading more".
- **Step count:** 1 required (+3 optional)

---

### Community — `/community`
- **Source:** `pages/community.html` (content, an Official channels ledger, inline live-activity module, an inline newsletter form plus the footer one; the palette is token-derived, so the page follows the site theme switcher)
- **Entry point:** Page load; the inline module fetches the live activity feed.
- **Prerequisites / gates:** None.
- **Steps (4):**
  1. User lands on `/community` and reads the hero ("Build with us.").
  2. System: the "Live activity" section fetches `GET /api/users/me/feed?scope=all&limit=10` (3 skeleton rows while loading) and renders the latest platform activity rows (avatar, actor + verb, title · relative time, thumbnail; the item is a stretched overlay link and the actor's name is a separate `/u/<username>` link, so one row carries two destinations without nesting anchors); "Open the full feed →" links to `/feed`.
  3. (optional) User clicks a channel card: Follow on X (`@trythreews`), GitHub (`nirholas/three.ws`), Docs (`/docs`), Tutorials (`/tutorials`), IBM user group, Rankings (`/rankings`). Below the cards, **Official channels** lists every account and address the platform operates (X, Telegram `t.me/three_ws` plus the community chat, GitHub, the web domain, `support@three.ws`, and the `$THREE` contract with a Copy button that falls back to selecting the text when the clipboard is unavailable) and a "Two things we never do" impostor notice.
  4. (optional) User reads "Ways to get involved" (ship an agent at `/create`, report bugs on GitHub issues, share feedback to `support@three.ws`) or subscribes via the inline newsletter form (email + Subscribe, with a status line beneath it) or the footer one.
- **Decision points / branches:** activity populated vs empty vs error; which outbound channel the user follows; newsletter subscribe vs not.
- **External calls / dependencies:** `GET /api/users/me/feed?scope=all` (live activity), external links (x.com, github.com, t.me, IBM Community), mailto, clipboard API, footer newsletter script.
- **Success state:** Live activity rows render; user reaches a community channel / submits the newsletter form / opens `/feed` / copies the `$THREE` contract.
- **Empty / error states:** Activity empty → "No activity yet. Be the first to create something." with a `/create` link; fetch failure → "Could not load live activity right now." with a Try again button that reloads the feed. Newsletter form handles its own submit feedback.
- **Step count:** 2 required (+2 optional); content page with a live feed section

---

### Walk — `/walk`
- **Source:** `pages/walk.html` (inline boot), `src/walk.js`, `src/community/coin-world-boot.js`
- **Entry point:** `/src/walk.js` loaded as module. Splash overlay "Loading avatar…" shows while the scene boots. URL params: `?avatar=`, `?avatarUrl=`, `?name=`, `?coin=`, `?ui=hidden`, `?handle=`, `?agent=`.
- **Prerequisites / gates:** None to play (solo mode works offline). **Camera permission** requested only on AR-button tap (`navigator.mediaDevices.getUserMedia`, not on load). Auth only needed to list personal avatars in the picker. No motion/geolocation. WebGL required for full render.
- **Steps (6 required + many optional):**
  1. Page loads → avatar resolves (`?avatarUrl` direct, else `GET /api/avatars/{id}` for `?avatar`, else `/avatars/default.glb`); GLB loads via GLTFLoader; `GET /animations/manifest.json` preloads idle/walk/run; splash fades; status pill "Ready — drag to look around"; cosmetics + emote tray applied; Rapier physics WASM inits async (legacy movement until ready); multiplayer `startNet()` joins the Colyseus room best-effort.
  2. **Payoff (move):** On desktop, press **W/A/S/D / arrows** (Shift = run) to walk the avatar camera-relative; on mobile, drag the **left joystick** (nipplejs). Animation crossfades idle→walk→run to actual ground speed.
  3. Orbit camera — drag mouse / pointer-lock (desktop) or the right look-stick (mobile); scroll/pinch to zoom; Q/E snap-turn 45°.
  4. (optional) Set player name (`#walk-name-input`, persisted, broadcast); open Avatar picker → `GET /api/avatars?limit=20` (auth) → choose avatar (broadcast to room).
  5. (optional) Jump (Space / button), cycle camera mode C (follow/cinematic/firstperson/topdown), cycle environment V (rebuilds physics colliders), emote G + 1 to 9 (broadcast), minimap M, chat T/Enter (broadcast bubble), friends F, players-panel; inspecting a remote player offers a DM that opens that thread in the in-world friends panel rather than sending the player to another surface.
  6. (optional) **AR passthrough:** tap AR button/CTA → `getUserMedia({ video: { facingMode: { ideal: 'environment' } } })`; on grant the canvas goes transparent over the live rear-camera feed, terrain hides (shadow-catcher only), camera freezes in world space, blob shadow grounds the avatar; light estimation adapts intensities. (optional) Screenshot P, record 6s clip R (`MediaRecorder` → `navigator.share()` / download).
- **Decision points / branches:** mobile (touch joysticks) vs desktop (WASD + mouse); avatar source param; coin community mode (`?coin=` spawns CoinTotem + trade polling) vs solo/lobby; physics ready (Rapier) vs legacy movement; AR on/off; camera permission granted/denied/unavailable; multiplayer connected vs solo; zen mode (`?ui=hidden`).
- **External calls / dependencies:** `GET /api/avatars/{id}`, `GET /api/avatars?limit=20`, `GET /animations/manifest.json`, coin trades poll (`/api/pump/coin-trades?mint=` every 7s in coin mode), Colyseus WebSocket (multiplayer). Device APIs: `getUserMedia` (camera), `navigator.vibrate` (haptics), `navigator.share`, `requestPointerLock`, localStorage/sessionStorage.
- **Success state:** Avatar driven smoothly around the world (joystick/WASD), camera follows; optionally on the real floor via AR; remote players + chat visible if multiplayer connected.
- **Empty / error states:** Avatar load fail → error pill + "try the default avatar". Camera API absent → AR button disabled w/ tooltip. Camera denied → sticky "camera permission denied". Physics WASM fail → silent legacy fallback. Multiplayer offline → "unavailable", solo play continues. Recording unsupported → status error. Avatar picker w/o auth → "Sign in to use your avatars".
- **Step count:** 3 required (load, move, orbit) (+ ~12 optional)

---

### IRL — `/irl`
- **Source:** `pages/irl.html` (WebGL-gate inline boot), `src/irl.js`, `src/irl/*` (`onboarding.js`, `floor-anchor.js`, `room-anchor.js`, `room-session.js`, `room-mode.js`, `tap-pick.js`, `gps-lifecycle.js`, `discovery.js`, `privacy-center.js`, `proximity-band.js`, `proximity-cue.js`, `sensor-fusion.js`, `share-frame.js`, `map-place.js`, `marker-mode.js` + `marker-anchor.js`/`marker-pose.js`/`qr-detect.js` (QR-marker indoor colocalization), `camera-fov.js`, `load-queue.js`, `perf-budget.js`, `pin-celebration.js`, `pin-idle.js`, and more), `src/ar/*` (`pinch-scale.js`, `quick-look.js`, `quicklook-banner.js`, `placement-capability.js`, `depth-occlusion.js`, `estimated-lighting.js`), `src/irl-net.js`
- **Entry point:** `pages/irl.html` runs an inline WebGL-support check; if supported it `import('/src/irl.js')`, else it renders a designed "This device can't run IRL AR" state with "Browse agents"/"Open marketplace" actions. URL param `?avatar=` chooses the placed agent.
- **Prerequisites / gates:** No auth, no wallet (anonymous `irl_device_token` in localStorage). **WebGL** required (hard gate at HTML load). Requested progressively via `onboarding.ensurePermission(...)`: **camera** (`getUserMedia`) on first "Camera AR" tap; **motion** (`DeviceOrientationEvent.requestPermission` on iOS 13+) when locking; **geolocation** (`navigator.geolocation.watchPosition`, enableHighAccuracy) when locking/discovering. None are hard blockers — each has a designed fallback.
- **Steps (7 required + optional):**
  1. Page loads (WebGL OK) → Three.js scene + default/`?avatar=` GLB; device token restored; onboarding/discovery initialized; subtitle "Turn on Camera AR, then tap Pin here to anchor your agent." Discovery empty-state CTA visible.
  2. User taps **Camera AR** → onboarding card → grant `getUserMedia({ video: { facingMode: 'environment' } })` → `enableAR()` shows the rear-camera feed, applies derived camera FOV, freezes the 3D camera so the phone gyro looks around the room.
  3. User taps **Pin here** → `setLocked(true)` requests **location** (`watchPosition`) and **motion** (iOS `DeviceOrientationEvent.requestPermission`), waits briefly for a compass sample, captures the gyro lock pose; if GPS not yet ready shows "Getting your location…".
  4. On first GPS fix → anchors the pin, begins 10s nearby polling, joins the IrlNet presence room (Colyseus, optional).
  5. User aims at the floor spot and **taps the canvas** → optional caption → Confirm → `commitPin()` → `POST /api/irl/pins` with `{ lat, lng, heading, caption, avatarUrl, avatarName, deviceToken, agentId, anchor: { yawDeg, source: 'gyro-gps'… } }`.
  6. System polls `GET /api/irl/pins?lat=&lng=&radius=60` every 10s; nearby agents spawn (LOD: dot → impostor → full mesh), name labels + confidence rings render; crossing the ~40m ENTER band fires the proximity-arrival cue (haptic + chime + directional glow). Tapping a nearby agent opens a bottom sheet → "View" (`GET /api/irl/agent-card`), "Pay" ($THREE x402), "Message"; interactions `POST /api/irl/interactions`. A `pay` is the one interaction that names money, so it is never taken on the caller's word: it must carry a well-formed on-chain signature paying an allow-listed mint, it is de-duped globally by that signature, and the transaction is verified on-chain (exists, succeeded, moved at least the amount claimed, and credited one of the agent's own payout wallets when any are on record). A settlement the RPC cannot see yet lands with `verified_at` null, counting for nothing and notifying nobody until `api/cron/settlement-verify.js` proves or discards it.
  7. **Payoff:** The user's chosen agent is anchored and visible in AR on the real floor, persisted for nearby users to discover; the user can also discover and interact with other agents pinned around them.
  8. (optional alt placement) **Place in AR** (WebXR, Android Chrome) now fronts the dock's secondary row on AR-capable devices: `XRSession.requestSession('immersive-ar')` hit-test → `POST /api/irl/pins` with `anchor.quat` + shared room frame; a two-finger pinch resizes the agent (0.25x to 4x, `src/ar/pinch-scale.js`) and the chosen size persists (`anchor.scale` on POST, owner-gated `PATCH {id, scale}` after placement; every viewer renders the owner's size). Camera-mode AR gets the same pinch-to-resize without WebXR. iOS Safari → AR Quick Look (USDZ) with an in-AR "Pin it here for people nearby" banner whose tap lands back on `/irl` with Pin here pulsing. **Anchor to a marker** (indoor, no GPS/compass): scan or print a QR marker; once locked it becomes a shared origin, so "Place here" anchors the agent relative to the marker for anyone who scans the same one. **Place on map** (privacy-first): Leaflet picker → `commitMapPin()` `POST /api/irl/pins source:'map'`.
  9. (optional) Privacy center (`openPrivacyCenter`): geolocation precision Exact vs Nearby, "Appear nearby" ghost toggle. Share button flattens camera + canvas to PNG. "My pins" sheet → `GET /api/irl/pins/mine`, map + list, `DELETE /api/irl/pins?id=` or `?all=1`. Calibrate / refine-on-floor → `PATCH /api/irl/pins`.
- **Decision points / branches:** WebGL supported vs fatal overlay; placement path (gyro-GPS / WebXR floor / iOS Quick Look / QR marker / map); camera/motion/location granted vs denied (each → fallback); compass available (north-aligned) vs relative-only (`gyro-gps:rel`); GPS ready vs warm-up hold; agent crosses ENTER vs EXIT band; tap on mesh vs label vs background; precision Exact vs Nearby; room mode (shared frame) vs solo.
- **External calls / dependencies:** `POST/PATCH/DELETE /api/irl/pins`, `GET /api/irl/pins` (+ `/mine`), `GET /api/irl/agent-card`, `POST /api/irl/interactions`, `GET /api/irl/interactions-stream` (SSE), `POST /api/irl/report`, `POST /api/irl/fix-token`. Device: `getUserMedia` (camera), `DeviceOrientationEvent.requestPermission` / `deviceorientation(absolute)` (motion), `navigator.geolocation.watchPosition`, `navigator.permissions.query`, `navigator.vibrate`, `AudioContext`, WebXR `immersive-ar`. Realtime: Colyseus WebSocket (`IrlNet`, room `irl_world`). Libs: GLTFLoader (+Draco/meshopt), Leaflet/CARTO, in-browser USDZ exporter.
- **Success state:** Agent anchored to a real-world spot, visible in AR; nearby agents discovered by proximity (dots→impostors→meshes) with name labels, arrival cues, and an interaction sheet.
- **Empty / error states:** WebGL unsupported → fatal designed overlay. Camera/motion/location denied → designed recovery cards with platform Settings steps + fallbacks. GPS warm-up → shimmer "Acquiring…". No nearby agents → calm "0 nearby" + "Place an agent here" CTA. Poll fail → amber "refresh failed" (15s retry). Rate-limited → calm blue chip, self-recovers. Avatar load fail → "Couldn't load this agent" + Retry. WebGL context lost → "AR paused" + Reload. Placement rejected (moderation/full/rate) → status message, lock released; a caption naming a cashtag or pump.fun-style mint other than `$THREE` is refused whatever the ticker's length. Pin ids are strict UUIDs on every pin route (`/api/irl/pins`, `/api/irl/interactions`, privacy, report), so a malformed id answers 400 rather than surfacing a Postgres cast error as a 500, and reports read the device credential from the `x-irl-device` header (body fallback) so an owner cannot self-report their own pin as an independent reporter.
- **Step count:** 7 required (+ several optional)

---

### IRL Location Privacy — `/irl-privacy`
- **Source:** `pages/irl-privacy.html` (static content), `nav.js`, `footer.js`
- **Entry point:** Static page load. Read-only policy/explainer page.
- **Prerequisites / gates:** None.
- **Steps (2):**
  1. User lands on `/irl-privacy` and reads how location works on IRL — placed agents are private by location (appear only to people physically near them, never on a map/list), what camera/motion/location are used for, and what is/isn't shared.
  2. (optional) User follows in-page links (e.g. back to `/irl`, footer links).
- **Decision points / branches:** none.
- **External calls / dependencies:** none for content (nav/footer scripts only).
- **Success state:** User understands the IRL location-privacy model.
- **Empty / error states:** none (static content).
- **Step count:** 1 required (+1 optional) — content page (read)

---

### Reputation Explorer — `/reputation`
- **Source:** `public/reputation/index.html`, `public/reputation/reputation.js`, `src/erc8004/{chain-meta,abi,reputation}.js`, EAS (Ethereum Attestation Service) EASScan GraphQL, EAS SDK + ethers
- **Entry point:** On load the module parses URL params (`?address=`, `?chain=`, legacy `?agent=N:M`). With an address it renders a profile; without one it renders the search landing. A banner above the app cross-links the Reputation Staking Market (`/reputation/market`).
- **Prerequisites / gates:** **Reading** attestations needs no wallet (EASScan GraphQL + public RPC). **Writing** a review requires an injected wallet (MetaMask) on the write chain (Base Sepolia by default) + gas.
- **Steps (6):**
  1. User lands on `/reputation`. With no `?address`, system renders the search form (address / ENS input, chain select, example chips).
  2. User enters an address or ENS name (or clicks an example chip), submits → navigates to `?address=…&chain=…`.
  3. System resolves ENS if needed (public RPC), then fetches attestations via EASScan GraphQL (`fetchAttestations`) and the ERC-8004 on-chain reputation (`getReputation`) for the resolved address/chain.
  4. System renders the profile: aggregate score bar (color-coded), star ratings, tabbed review list (all / by category), copy-address + copy-share-link buttons.
  5. (optional) **Write a review:** click "Connect wallet to review" → `eth_requestAccounts`; pick a star score + comment; click "Sign & submit review" → switches/adds the write chain (`wallet_switchEthereumChain` / `wallet_addEthereumChain`), encodes the `address agent, uint8 score, string comment` schema, and calls `EAS.attest(...)`.
  6. **Payoff:** Transaction confirms → success card with "View transaction" (block explorer) + "View attestation" (EASScan) links; the on-chain review is now part of the agent's reputation.
- **Decision points / branches:** address vs ENS vs legacy `agent=N:M` (→ `renderLegacyAgent`, resolves owner then redirects); supported EAS chain vs unsupported; wallet present vs absent; correct write chain vs needs switch/add; user-rejected tx vs failure.
- **External calls / dependencies:** EASScan GraphQL per chain (Base/Ethereum/Optimism/Arbitrum/Polygon/Base Sepolia), public RPC for ENS + ERC-8004 reads, injected wallet (`window.ethereum`), EAS SDK `attest`. ERC-8004 helpers `getReputation`/`submitReputation`.
- **Success state:** Reputation profile with score bar + reviews rendered; on write, a confirmed attestation with explorer/EASScan links.
- **Empty / error states:** Unsupported network card; invalid address / ENS-not-found / ENS-failed cards (with "Search again"); no attestations → "Be the first to review!"; no wallet → "Install MetaMask…"; tx cancelled (4001) → "Cancelled by user"; tx failure → "Failed: <reason>".
- **Step count:** 4 required (+2 optional write)

---

### Agent Lookup — `/lookup`
- **Source:** `public/lookup.html` (inline module), `/api/registry/resolve`
- **Entry point:** On load the inline module reads `?q=`, fills the input, and auto-runs `lookup()` if a query is present.
- **Prerequisites / gates:** None.
- **Steps (4):**
  1. User lands on `/lookup`. If `?q=` is present, the lookup runs immediately; otherwise the input is empty.
  2. User types a Solana asset mint / agent ID / avatar ID / slug into the input and presses Enter or clicks "go". System sets `?q=` via `replaceState`, disables the button, shows a skeleton.
  3. System fetches `GET /api/registry/resolve?q=<input>` and renders the result.
  4. **Payoff:** The resolved agent renders as an interactive `<model-viewer>` 3D avatar (or 🔒/🤖/image placeholder) alongside its identity card and on-chain panel (Active / x402 status, owner, collection, copy buttons, Metaplex / Solscan / Magic Eden links). "Share" copies the current URL.
- **Decision points / branches:** has `modelUrl` → 3D viewer; `state === 'private'` → 🔒 placeholder; `imageUrl` → thumbnail (served only for a public avatar; a private one yields identity metadata and no imagery); none → 🤖 placeholder; on-chain present vs "Not deployed on-chain yet".
- **External calls / dependencies:** `GET /api/registry/resolve`, `model-viewer` CDN, clipboard API.
- **Success state:** A single agent resolved and rendered with its 3D avatar + on-chain identity.
- **Empty / error states:** No match → "No agent found" with a tip + link to the explore feed. Fetch error → "Something went wrong" with the error message.
- **Step count:** 2 required (+2 optional)

---

### Agents Index — `/agents`
- **Source:** `public/agents/index.html` (inline module), `/api/explore` (`source=agents` meta-source), `public/agents/boot.js`
- **Entry point:** Inline module runs `load(true)` on load; `?source=`, `?q=` and `?sort=` are read first and kept in sync with `replaceState`, so a filtered directory is a shareable, reload-safe link.
- **Prerequisites / gates:** None to browse.
- **Steps (4):**
  1. User lands on `/agents` ("Agent Index"). System renders 8 skeleton cards and fetches `GET /api/explore?source=agents&limit=24`, one unified feed across every registry the platform crawls: ERC-8004 (EVM, erc8004-crawl cron), the Metaplex Agent Registry + AgenC protocol (Solana, solana-agents-crawl cron), and three.ws's own agents. The meta-source returns on-chain agents only, never avatars.
  2. System renders agent cards: thumbnail proxied through `/api/img` (lettered-initial fallback), a source badge (chain short-name for EVM / Metaplex / AgenC / three.ws), name + description, up to 3 service/skill chips, and an `x402` chip when the agent accepts x402 payments. Count label shows loaded total.
  3. (optional) Source chips All sources / Solana / EVM (a pressed-button group) → reload; search box → 320ms debounce → reload with `q` (an unchanged term does not refetch); sort select (Newest first / Name A-Z, client-side re-sort); "Load more" → cursor pagination (`cursor`), the button showing a spinner via `aria-busy` while it fetches and appending the new page instead of rebuilding the grid. A newer request always supersedes the one in flight.
  4. **Payoff:** Click a card → its canonical detail page: EVM agents → `/a/<chain>/<id>`, three.ws Solana agents → `/agents/<id>`, external Solana agents → the API's `detailUrl` (`/discover/a/sol/<asset>`), else their 3D viewer or on-chain explorer (new tab); a registry row with nowhere real to go renders without a link rather than with a dead one. Hero CTAs link to `/create-agent` and `/marketplace`.
- **Decision points / branches:** source chip (all / solana / onchain); card kind → internal vs external (target="_blank") destination; thumbnail vs initial fallback; nextCursor present (Load more shown) vs not.
- **External calls / dependencies:** `GET /api/explore?source=agents`, `/api/img` (thumbnail proxy).
- **Success state:** Grid of on-chain agents across all crawled registries, each linking to its detail surface.
- **Empty / error states:** Query-empty → "No agents match "<q>"" with Clear search and Create an agent; unfiltered-empty → "No agents in this source yet" with Check again and Create the first one (registries are crawled continuously); fetch error → "Couldn't load agents" naming the failure, with Try again and Browse the marketplace; a failed Load more → "Couldn't load more agents" keeping every page already on screen, with Resume loading (off the surviving cursor) or Start over. The panel is a live region, so the outcome is announced.
- **Step count:** 1 required (+3 optional)

---

### My Agents — `/my-agents`
- **Source:** `public/my-agents/index.html` (inline module), `public/my-agents/my-agents.{js,css}`, `/api/agents`
- **Entry point:** Inline module runs `load()` on load.
- **Prerequisites / gates:** **Auth required** — `GET /api/agents` returning 401 renders a sign-in gate.
- **Steps (4):**
  1. User lands on `/my-agents`. System renders 4 skeletons and fetches `GET /api/agents` with `credentials: 'include'`.
  2. If 401 → auth gate ("Sign in to manage your agents") with Sign-in (`/login?next=`) + Create-account links — flow stops here until signed in.
  3. On success, reveals the "+ Create agent" CTA and renders each owned agent as a row: thumbnail/initial, name, on-chain vs "not registered" badge, description, top skills.
  4. **Payoff:** Per-row actions: "View" (`home_url` or `/agents/:id`), "Edit" (`/agents/:id/edit`), and for unregistered agents a gold "Deploy" link to the edit page's deploy flow.
- **Decision points / branches:** 401 (auth gate) vs authed; on-chain (badge + no Deploy) vs not registered (Deploy link); zero agents (empty state) vs populated.
- **External calls / dependencies:** `GET /api/agents` (session cookie).
- **Success state:** List of the signed-in user's agents with View / Edit / Deploy actions.
- **Empty / error states:** 401 → sign-in gate; connection error → "Connection error — Check your network"; non-OK → "Failed to load agents"; zero agents → "No agents yet" + Create CTA.
- **Step count:** 3 required (+1 optional, e.g. Deploy)

---

### Sitemap — `/sitemap`
- **Source:** `public/sitemap/index.html` (static content + inline filter script), `nav.js`, `footer.js`
- **Entry point:** Static page load; inline script wires the live filter. Read-only directory page.
- **Prerequisites / gates:** None.
- **Steps (3):**
  1. User lands on `/sitemap` and sees all pages grouped into sections (Main, Build, Labs, Crypto, Agent Tools, Account, Learn, Blog, Legal, Machine-readable) with per-section counts and a total ("N pages · M sections").
  2. (optional) User types in the filter input → inline script hides non-matching `<li>` items + sections live, updates the count, and shows an empty state echoing the query if nothing matches.
  3. (optional) User clicks a TOC anchor to jump to a section, or any page link to navigate. (The `/sitemap.xml` and `/sitemap/<type>.xml` machine-readable variants are served by `/api/sitemap`.)
- **Decision points / branches:** filter query matches vs empty result; section visibility toggled by matches.
- **External calls / dependencies:** none for content (purely client-side filter; nav/footer scripts).
- **Success state:** User finds and navigates to the page they want via browse or filter.
- **Empty / error states:** Filter with no matches → empty state with the query echoed.
- **Step count:** 1 required (+2 optional) — content page (read)

---

## Notes
- All listed sources were located and traced from real files; no source was missing.
- `/characters` page HTML lives at `public/characters.html` (root-level dest in `vercel.json`), not under `pages/`.
- `/agents`, `/my-agents`, and `/lookup` keep their grid/lookup logic in **inline `<script type="module">` blocks** within the page HTML rather than a separate `src/` module.
- Detail pages reached from these routes (`/discover/a/...`, `/a/:chain/:id`, `/character/:id`, `/avatars/:id`, `/agents/:id`, agent profile `home_url`) are outside this cluster's scope but are the payoff destinations. `/agents/:id` is the canonical agent route; the singular `/agent/:id` now 301s to it.
