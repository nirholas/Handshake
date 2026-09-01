# Chat, Brain & Labs

UX Flow Atlas cluster covering the conversational, multi-LLM, and experimental-feature
surfaces of three.ws. Each entry traces real source from route → page HTML → imported
modules. Routes resolved via `vercel.json` rewrites.

---

### Conversational AI Chat (3D talking agent) — `/chat`
- **Source:** `/workspaces/three.ws/chat/` (a standalone Svelte app, separate Vite build). Entry `/workspaces/three.ws/chat/index.html` → `/workspaces/three.ws/chat/src/main.js` → `/workspaces/three.ws/chat/src/App.svelte`. Key modules: `chat/src/providers.js` (LLM providers), `chat/src/convo.js` (streaming completion pipeline), `chat/src/AgentPicker.svelte`, `chat/src/ModelSelector.svelte`, `chat/src/stores.js`, `chat/src/walletAuth.js` (SIWE/SIWS), `chat/src/tools.js`, `chat/src/sync.js`, `chat/src/SkillsMarketplaceModal.svelte`, `chat/src/TxApprovalModal.svelte`.
- **Entry point:** `/chat` → `chat/index.html` (`<div id="app">` mounted by `main.js`).
- **Prerequisites / gates:** None to start chatting: free built-in models stream through the server proxy with no key. Optional gates: user-supplied API key (Anthropic/OpenAI/Groq/Mistral/Ollama/OpenRouter) stored locally for non-built-in models; sign-in only for cross-device sync + on-chain tool calls, either by wallet (SIWE/SIWS via `/api/auth/*`, `chat/src/walletAuth.js`) or by email/password on the platform's own cookie session (`chat/src/passwordAuth.js` POSTs `/api/auth/login` / `/api/auth/register`, with the Terms clickwrap gating the submit); `TxApprovalModal` requires a connected wallet for wallet/pump tool transactions. No $THREE gate. Voice output is opt-in (off by default).
- **Steps (6):**
  1. Open `/chat`; app boots, fetches the free model list from `/api/chat/models`, shows empty state with suggestion chips. `BUILTIN_MODELS` in `providers.js` is only a first-paint seed; `resolveDefaultModel()` prefers a model the server reports as live, so if the configured default has been retired upstream a new conversation opens on a live model instead of a dead one. The list also carries one virtual entry, "three.ws Agent · server tools": a server-side agent loop that answers through `/api/chat/proxy` in the same wire format but runs multiple tool-calling LLM rounds per message; it is appended last so it can never become the silent default.
  2. (optional) Click the model selector and pick an LLM, or open `AgentPicker` to load a persona/agent (from `/api/agents`, `/api/marketplace/agents`, or the agent library JSON). Loading an agent mounts its live `<agent-3d>` avatar in the panel.
  3. (optional) Open Settings → Avatar and turn on "Speak replies aloud", optionally picking one of the browser's installed voices and previewing it. The sidebar holding the Settings button renders once a conversation has messages, so a first-time visitor reaches it after their first reply.
  4. Type a message in the composer and submit (or attach an image / file for multimodal).
  5. `convo.complete()` POSTs to the provider's completion URL (built-in → `/api/chat/proxy`; Anthropic → `/v1/messages`; others → `/v1/chat/completions`) and streams tokens back into the assistant bubble (markdown + KaTeX rendered live).
  6. On reply completion: if an agent is loaded, its `<agent-3d>` avatar plays the talk animation (`agentEl.speak(...)`) and expresses the classified emotion (`agentEl.expressEmotion(...)`); those two calls are animation only and carry no audio. With voice output enabled, browser `speechSynthesis` reads the reply aloud, agent or not. Payoff: a 3D agent that answers in voice with mood animation.
- **Decision points / branches:** model/provider choice (free built-in vs keyed provider vs OpenRouter "all models" vs local Ollama); text vs voice output (agent-3d speech vs browser speechSynthesis vs silent); persona/agent loaded vs raw model; tool-calling on/off (16 curated tool packs in `tools.js` `curatedToolPacks`, surfaced via `ToolPackModal`: wallet-transactions, x402-pay, tradingview, price-chart-3d, token-price, token-ticker-3d, web-search, date-time, pump-launch, tx-explain, mint-scene-nft, nft-3d-import, forge-text-to-3d, forge-avatar, wallet-balances, token-gate-scene; the built-in wallet/agent/pump/payments tool schemas back them); every generated 3D model card carries "View in AR ↗" (`/ar?src=<glb>`), "Download GLB", and "Viewer ↗" actions; regenerate / edit / branch a message; share conversation (compressed link via `share.js`).
- **External calls / dependencies:** `/api/chat/models` (free model list, OpenRouter-proxied), `/api/chat/proxy` (built-in completions), `/api/chat/config`, `/api/mcp` + `/api/pump-fun-mcp` (skills marketplace / pump tools), `/api/agents` + `/api/marketplace/agents` (agent picker), `/api/auth/{me,logout,siwe/nonce,siwe/verify,siws/nonce,siws/verify}` (wallet auth), `/api/auth/{login,register}` (email/password auth), agent-library `index.en-US.json`. Direct provider APIs (api.anthropic.com, api.openai.com, api.groq.com, api.mistral.ai, openrouter.ai, local Ollama) when a user key is set.
- **Success state:** Streamed assistant message rendered; with voice enabled the reply is read aloud once per message (a repeated end-of-stream chunk cannot double-speak it), and a loaded agent mouths along with mood animation; conversation persisted to IndexedDB / optional E2E-encrypted sync.
- **Empty / error states:** Empty state with brand tagline + suggestion chips when no messages. Provider/network errors surface as inline notices: a request that never left the device is tagged `code: 'network'` in `convo.js` and renders "Could not reach the model. The request never left this device, so nothing was sent…" with a hover-refresh hint, and a stream that dies mid-reply renders "The reply stopped early because the connection dropped…" instead of the transport's own wording; the built-in proxy waits at most 25s for OpenRouter to start answering, rotates keys and models on a timeout, and reports a clean 504 when every route hangs. Abortable generation via `controller`. Missing API key → model marked unavailable in selector. Avatar GLB load failure falls back to default avatar; speech failure degrades silently to text.
- **Step count:** 6 required (+4 optional)
- **Voice path (resolved 2026-08-06):** there is exactly one speaker, browser `speechSynthesis`, gated on the voice-output toggle. The legacy standalone Talking Head component (a CDN build of met4citizen/TalkingHead pointed at the long-retired `/api/tts/google`) was imported but never rendered, and its dead `talkingHeadEnabled` flag suppressed `speechSynthesis` for anyone whose browser still carried the flag from an older build. Component, flag, and both dead branches are removed. `talkingHeadAvatarUrl` survives on purpose: it is the live store behind the Settings avatar picker, the sidebar logo, and the in-reply `<agent-3d>` viewer.

---

### Agent Profile / Directory — `/agent`
- **Source:** `/agent` is a **301 redirect to `/agents`** (`vercel.json`). The directory `/agents` → `/workspaces/three.ws/pages/agents/index.html`; a single agent `/agents/:id` → `/workspaces/three.ws/pages/agent-detail.html` → `/workspaces/three.ws/src/agent-detail.js`. Supporting: `src/shared/agent-3d.js` (`seeInWorldHref`, `agentAvatarGlb`), `src/shared/agent-wallet-chip.js`, `src/shared/agent-coin.js`, `src/agent-detail-market.js`. (`src/agent-home.js` is a related presence component used by `/app` + `/app-demo`, not by `/agents/:id`.)
- **Entry point:** `/agent` (redirect) → `/agents` directory grid → click an agent → `/agents/:id` profile.
- **Prerequisites / gates:** None to view. Editing (`/agents/:id/edit` → `agent-edit.html`; the older `/agent/:id/…` subroutes still resolve but every link now uses the canonical `/agents/:id/…` form) and owner actions require wallet/owner auth. No $THREE gate to browse.
- **Steps (4):**
  1. Hit `/agent` → 301 to `/agents`; directory of agents renders.
  2. Click an agent card → `/agents/:id` loads `agent-detail.js`.
  3. Profile renders: a live Three.js hero avatar (`mountIdleAvatar` retargets the canonical idle clip onto the rig with a procedural idle-life loop; no static `<model-viewer>`), identity, voice metadata (cloned provider or browser TTS pill), live $THREE/pump token chip (streamed via `/api/pump/by-agent`), skills (with dynamic price/promo state from `/api/marketplace/skill-promo?agent_id=…&skill=…`), history.
  4. Click "See in world" → routes to `/play?avatar=<glb>&coin=<THREE_MINT>` (the 3D world payoff); or "Edit" / wallet chip / coin-launch actions for owners.
- **Decision points / branches:** view vs edit (owner); "See in world" (→ /play) vs embed (`/agents/:id/embed`) vs wallet (`/agents/:id/wallet`); token chip present (launched coin) vs not; a `/agents/:id?skill=<name>#pricing` deep link (what the Buy CTA on `/conversions` sends) scrolls the pricing card to that skill row once it renders (`focusRequestedSkill` in `agent-detail-market.js`, honoured once per page load).
- **External calls / dependencies:** `/api/agents/:id`, `/api/marketplace/agents/:id`, `/api/pump/by-agent` (live market-cap stream), `/api/marketplace/skill-promo` (skill pricing/promo), `/api/agent-share` (share). Three.js idle-avatar mount for the 3D preview (falls back to a flat image when WebGL/GLB fails).
- **Success state:** Agent profile with interactive 3D avatar, live token data, and working navigation to world/embed/edit.
- **Empty / error states:** Avatar mount failure → flat-image fallback; enrich failure logged non-fatally; save errors surface inline in the edit flow.
- **Step count:** 4 required (+2 optional)
- **Note:** This route is a profile/directory surface, **not** a chat interface. The "talk to a 3D agent" experience lives at `/chat`. `/agents/:id` links *out* to `/play` ("See in world"), not to an inline chat.

---

### Brain — Persona Builder + Multi-LLM Playground — `/brain`
- **Source:** `/workspaces/three.ws/pages/brain.html` → `/workspaces/three.ws/src/brain.js`.
- **Entry point:** `/brain` → `brain.html` (H1 "Pick a vibe", sub-copy "One tap gives your agent a personality. No extra steps."; "Build Persona" is a sidebar button), two tabs: Persona + Playground.
- **Prerequisites / gates:** None to open the playground, but signed-out callers are limited to the free-model set (`ANON_BRAIN_PROVIDERS` in `api/brain/chat.js`: gpt-oss-120b plus the NVIDIA NIM family); every paid first-party model returns `401 "sign in to use this model"`, and anonymous traffic is rate limited. `GET /api/brain/chat` reports `requiresAuth` per model alongside `available`, so the page suffixes those chips "(sign in)" for a signed-out visitor and answers a click with the notice "<model> needs an account." plus a Sign in link (`/login?redirect=/brain`) instead of failing after Send. Freeform persona extraction (`POST /api/persona/extract`) also requires sign-in (`401 "Sign in to build your persona."`; the Persona tab shows a "Sign in to build your persona" gate that clears once you sign in and return) and is metered at 5 extractions per user per day. Saving a persona as a deployed agent requires sign-in (auth-hint check + `/api/agents` with credentials). No $THREE gate.
- **Steps (6):**
  1. Open `/brain`; Persona tab active, archetype presets rendered.
  2. (optional) Apply an archetype preset or type freeform persona text → `/api/persona/extract` structures it into a persona object (tone, vocabulary, interests, communication_style, dont_say, sample_greeting); the body is validated before the daily limiter is charged, and an empty model reply comes back as a retryable `502` rather than a blank card.
  3. Switch to the Playground tab; provider availability fetched from `GET /api/brain/chat` (each model carries `available` and `requiresAuth`), model chips/focus selector populated.
  4. Choose **Compare** mode (query several models at once) or **Focus** mode (one model); select active models.
  5. Type a prompt and run; `streamProvider()` POSTs to `/api/brain/chat` per model and streams responses side-by-side, each prefixed with the effective persona system prompt.
  6. (optional) Save the persona as an agent → POST `/api/agents` (or PATCH `/api/agents/:id`) with the built `system_prompt`.
- **Decision points / branches:** Compare (multi-model fan-out) vs Focus (single model); persona enabled/disabled (`personaEnabled` toggle injects/omits the system prompt); archetype preset vs freeform extraction; model availability (unavailable models disabled in selector); save-as-agent (gated by auth).
- **External calls / dependencies:** `GET /api/brain/chat` (provider availability), `POST /api/brain/chat` (per-model streaming completions), `/api/persona/extract` (structure persona), `/api/agents` + `/api/agents/:id` (load/save agent). Models span Anthropic (via Google Vertex), OpenAI (via OpenRouter), xAI Grok, DeepSeek, Qwen/DashScope, IBM watsonx, NVIDIA NIM, and Google Vertex Gemini tiers.
- **Success state:** Multiple model responses stream into the compare grid (or one in focus); persona optionally persisted locally and/or saved as a deployable agent.
- **Empty / error states:** "Select at least one model" notice; provider-availability fetch failure is non-fatal (all models treated available); upstream stream error surfaces per-model, and when every rung of a model's fallback chain fails the column shows a plain-language verdict (rate limited: try again or pick another model; no working route on this deployment; no longer served upstream; took too long) with the precise upstream reason alongside as `reason`; signed-out use of a paid model errors with a sign-in prompt; auth gate shown when saving while signed out; sessions/persona persisted to localStorage.
- **Step count:** 6 required (+2 optional)

---

### GLB Playground / Embed Generator — `/playground`
- **Source:** `/workspaces/three.ws/pages/playground.html` — **self-contained** (inline `<script>` IIFE, no `/src` module). Uses Google `<model-viewer>` (CDN) for rendering.
- **Entry point:** `/playground` → `playground.html` (H1 "Playground"), drag-drop GLB viewer + embed-code generator.
- **Prerequisites / gates:** None. No auth, no wallet, no $THREE. Files stay client-side.
- **Steps (5):**
  1. Open `/playground`; default avatar (`/avatars/default.glb`) loads into the `<model-viewer>`.
  2. Drag-and-drop or upload a `.glb`/`.gltf` file into the dropzone (or use the file picker).
  3. Model loads with a loading indicator; file info (name, size, animation count) populates.
  4. (optional) Pick an animation from the dropdown, play/pause it, adjust exposure slider, orbit/zoom the model.
  5. Copy the generated `<model-viewer>` embed code from the embed panel to use the model on any site.
- **Decision points / branches:** default avatar vs uploaded model; local file (embed note warns the URL must be hosted) vs hosted URL; animated vs static GLB (animation section only shows when clips exist); reset to default.
- **External calls / dependencies:** Google model-viewer CDN (`ajax.googleapis.com/.../model-viewer.min.js`). No backend API calls — all parsing is in-browser via model-viewer.
- **Success state:** Model renders interactively (rotate/zoom, optional animation playback) and a copyable embed snippet is produced.
- **Empty / error states:** Status line shows transient messages (auto-clears after 3s); invalid/failed file → status error and the viewer retains the prior/default model; embed note flags that local files need a hosted URL before the embed works.
- **Step count:** 5 required (+1 optional)
- **Note:** `src/api-playground.js` exists but is a different surface (API console), not wired into `/playground`.

---

### Labs — Feature Gallery — `/labs`
- **Source:** `/workspaces/three.ws/pages/labs.html` → `/workspaces/three.ws/src/labs.js`. Data: `/features.json` (generated by `scripts/build-page-index.mjs` from `data/pages.json`; `labs.js` flattens its `sections[].pages` and shows only pages flagged `showcase: true`).
- **Entry point:** `/labs` → `labs.html`; grid of "gem" cards.
- **Prerequisites / gates:** None. Pure discovery surface.
- **Steps (3):**
  1. Open `/labs`; skeleton placeholders render while `/features.json` is fetched.
  2. Cards render (category-colored: Voice / AI / 3D Live / Crypto / x402); each runs a `HEAD` liveness check (3s timeout) and shows a Live/Checking status, plus a lazy IntersectionObserver iframe preview of the route.
  3. Click a card's "Try it →" CTA → navigates to that feature's route (e.g. `/lipsync`, `/brain`, `/three-live`, `/voice`).
- **Decision points / branches:** category filtering (Voice/AI/3D/Crypto/x402); live vs unreachable (status badge from HEAD check); preview iframe lazy-loads only when scrolled into view.
- **External calls / dependencies:** `GET /features.json` (registry), `HEAD <route>` per card (liveness), iframe `src=<route>` (sandboxed previews).
- **Success state:** Populated gallery of feature cards with live previews and working "Try it" links into each experiment.
- **Empty / error states:** Skeleton loading state; per-card "Checking → Live/Offline" status; HEAD failure (or ≥500) marks a card not-live; registry fetch failure leaves skeletons / empty grid.
- **Step count:** 3 required (+1 optional)

---

### Launchpad Studio — `/launchpad`
- **Source:** `/workspaces/three.ws/pages/launchpad.html` → `mountLaunchpadLanding` from `/workspaces/three.ws/src/launchpad/landing.js` (a discovery front door), which lazy-imports `mountLaunchpadStudio` from `/workspaces/three.ws/src/editor/launchpad-studio.js` only when the URL deep-links the editor.
- **Entry point:** Bare `/launchpad` renders the landing page; a URL carrying `?slug=`, `?template=`, `?wallet=`, `?avatar=`, `?build`, or `?studio` mounts the studio into `#root` (3-pane: sidebar / live-preview stage / config rail).
- **Prerequisites / gates:** Building/previewing is open, and so is a first publish: anonymous publishing is allowed by design. **Publishing requires a payout wallet address** (throws "Add your payout wallet address." otherwise, validated against the selected chain server-side) and writes via `/api/launchpad/publish`; editing an existing published page (`?slug=`) hydrates via the public `/api/launchpad/get` read, and re-publishing it requires the `ownerSecret` the first publish stored in localStorage or a signed-in session matching the page's owner (anything else answers `409 slug_taken`). Templates include a Token Launchpad (one-click Pump.fun mint with creator-fee split; generic runtime mint, $THREE-compliant). No $THREE gate to use the editor.
- **Steps (6):**
  1. Open `/launchpad`; the landing renders. Enter the studio via a template/build CTA (or a deep-linked URL); the studio mounts with a default template (`token-launchpad`) and recent-projects from localStorage.
  2. Pick a template card (`token-launchpad`, `paid-concierge`, or `gated-showroom`).
  3. Fill the config form (slug, brand color, payout wallet, website, theme, avatar, monetization/chain) — live preview updates in the center stage.
  4. (optional) Attach a 3D avatar (agent-3d element) into the avatar-stage slot.
  5. Add the payout wallet address (required for publish).
  6. Click Publish → `POST /api/launchpad/publish`; on success the page is hosted at `/p/<slug>` and the returned `ownerSecret` is kept in localStorage for re-edits.
- **Decision points / branches:** landing browse vs studio deep-link; template choice (token-launchpad vs paid-concierge vs gated-showroom); new vs edit (`?slug=` hydration via `/api/launchpad/get`); chain/payout selection; signed-in owner vs anonymous (owner-only sections hidden on 401).
- **External calls / dependencies:** `POST /api/launchpad/publish`, `GET /api/launchpad/get` (hydrate existing), `/api/agents` (my-agents avatar picker), Pump.fun launch plumbing (runtime mint, creator-fee split). agent-3d / Three.js for the avatar preview.
- **Success state:** A live hosted page at `/p/<slug>` with the chosen template, brand, avatar, and (for token template) a one-click Pump.fun mint; editable later from the same browser.
- **Empty / error states:** Publish blocked with actionable message if no payout wallet; publish-status line shows ok/err; owner-only sections silently hidden when signed out (401); recent-projects empty on first visit.
- **Step count:** 6 required (+1 optional)

---

### Lip-Sync (TTS-driven) — `/lipsync`
- **Source:** `/workspaces/three.ws/public/demos/lipsync-tts.html` (vercel rewrite target `demos/lipsync-tts.html`; resolves under `public/demos/`). Inline `<script type="module">`; uses Three.js + GLTFLoader (importmap) and the `wawa-lipsync` library for viseme detection.
- **Entry point:** `/lipsync` → `lipsync-tts.html`; 3D avatar viewer (left) + text/voice controls (right).
- **Prerequisites / gates:** None client-side (no auth, wallet, mic, or $THREE). Requires WebGL; TTS is served by `/api/tts/speak`, which tries the free NVIDIA NIM Magpie lane first and falls back to OpenAI.
- **Steps (6):**
  1. Open `/lipsync`; avatar GLB (`/avatars/default.glb`) loads, viseme morphs wired, default text prefilled.
  2. (optional) Edit the text, pick a voice and speed.
  3. Click "Speak"; POST `/api/tts/speak` `{text, voice, speed, format:'mp3'}`.
  4. Server returns an MP3 blob; frontend plays it through an `<audio>` element connected to `wawa-lipsync`.
  5. Per animation frame, lipsync analyses the audio (FFT) → viseme code → mapped to avatar morph targets with EMA smoothing.
  6. Avatar mouth animates in sync; viseme bar chart updates live; "Speak" re-enables when playback ends.
- **Decision points / branches:** voice + speed selection; retry on TTS failure; avatar-load failure degrades (UI still works, morphs unavailable).
- **External calls / dependencies:** `POST /api/tts/speak` (lane 1 NVIDIA NIM Magpie, free, 30s budget; lane 2 OpenAI `/v1/audio/speech`, the paid backstop with its own 20s budget; `503 not_configured` when neither key is set), `GET /avatars/default.glb`, `wawa-lipsync` (client-side viseme analysis via Web Audio AnalyserNode), Three.js.
- **Success state:** Avatar speaks the text with synced lips; status log confirms playback + morphs wired.
- **Empty / error states:** Actionable errors for TTS unreachable / rejected text (400) / rate limit (429) / server error (5xx); autoplay-blocked → "needs a click to play"; avatar-load failure logged but non-blocking.
- **Step count:** 6 required (+1 optional)

---

### Lip-Sync (Microphone-driven) — `/lipsync/mic`
- **Source:** `/workspaces/three.ws/public/demos/lipsync-mic.html` → imports `/workspaces/three.ws/src/lip-sync-analyser.js` (`LipSyncAnalyser`). Three.js + GLTFLoader (importmap).
- **Entry point:** `/lipsync/mic` → `lipsync-mic.html`; avatar viewer + mic controls, meter bars, viseme readout.
- **Prerequisites / gates:** **Microphone permission** (getUserMedia) and a secure HTTPS context. No auth, wallet, or $THREE. Audio never leaves the browser.
- **Steps (6):**
  1. Open `/lipsync/mic`; avatar loads, controls idle.
  2. Click "Start mic".
  3. Browser prompts for microphone permission; user grants.
  4. AudioContext + MediaStreamSource + AnalyserNode wired; `LipSyncAnalyser.connect()` called.
  5. Per frame, `analyser.sample()` reads frequency bands → maps to 9 viseme weights (aa/O/E/I/nn/SS/FF/CH/PP) with EMA smoothing + silence fade → drives avatar morphs.
  6. Speak into the mic → avatar mouth follows live; meter bars + viseme readout update; "Stop" resets morphs to 0.
- **Decision points / branches:** start vs stop; permission granted vs denied; mic present/busy/secure-context branches.
- **External calls / dependencies:** Web Audio API (`getUserMedia`, AnalyserNode — all in-browser), `GET /avatars/default.glb`, Three.js. No server/TTS calls.
- **Success state:** Live mic-driven mouth animation with frequency meters and per-frame viseme weights.
- **Empty / error states:** Actionable errors for mic denied / not found / busy / insecure (non-HTTPS) context, each with a "Try again"; avatar-morph missing → readout shows n/a; Web Audio unsupported → silent no-op.
- **Step count:** 6 required (+0 optional)

---

### Club — 3D Pole-Stage Venue (x402) — `/club`
- **Source:** `/workspaces/three.ws/pages/club.html` → scripts: `/x402.js` (wallet/payment modal), `/workspaces/three.ws/src/club-entrance.js` (walk-in alley scene), `/workspaces/three.ws/src/club-gate.js` (cover-charge bouncer), `/workspaces/three.ws/src/club.js` (main pole stage). Supporting modules in `src/`: `club-venue.js`, `club-audio.js`, `club-camera.js`, `club-crowd.js`, `club-perf.js`, `club-sequence.js`, `animation-manager.js`.
- **Entry point:** `/club` → `club.html`; entrance scene + door gate + pole stage boot in parallel behind a loading screen.
- **Prerequisites / gates:** **x402 wallet payment** — a cover charge settled on-chain (USDC, via `/api/x402/club-cover`); wallet (Phantom / EVM) connected through `x402.js`. No $THREE gate (USDC-denominated x402). WebGL required.
- **Steps (7):**
  1. Open `/club`; loading screen with real GLB byte-count progress; avatar picker populates (bundled + gallery avatars via `/api/avatars/` and `/api/explore`).
  2. (optional) Select an avatar.
  3. Spawn in the entrance scene; move with WASD / touch joystick, look via drag.
  4. Walk to the neon door → "Enter the club" prompt; activate it.
  5. Door reveals the x402 cover screen; connect wallet and pay the cover → a paid `GET /api/x402/club-cover` (x402, `club-gate.js`) settles on-chain and checks the gate.
  6. On approval the rope drops; walk through to the pole stage — entrance fades, main `club.js` stage becomes active (dancers at poles, leaderboard, live tip feed).
  7. Select a pole + dance style and tip → `POST /api/x402/dance-tip`; on settlement the dancer performs the routine, leaderboard + live feed update, reactions float up.
- **Decision points / branches:** avatar choice; cover approved vs "not tonight"; wallet not connected / insufficient balance; tip per pole + dance style; back-out to alley while paying; entrance-GLB failure → drop straight to stage.
- **External calls / dependencies:** `GET /api/x402/club-cover` (the door; a `POST` to the same path is a separate paid read for agents, `mode: "snapshot"` for membership growth/churn or `mode: "revenue"` for the door + floor take over a `period` of 24h/7d/14d/30d/all, not part of the visitor flow), `POST /api/x402/dance-tip`, `GET /api/club/tips`, SSE `/api/club/tips/stream`, `GET /api/club/leaderboard`, `/api/avatars/`, `/api/explore`; club venue/prop GLBs under `/club/...`, `/avatars/default.glb`, animation manifest/clips; `x402.js` wallet modal (Solana web3 / EVM). Three.js + post-processing.
- **Success state:** User is inside the 3D club after paying cover; tipping plays dance routines and updates the live leaderboard/feed in real time.
- **Empty / error states:** Cover denied → "not tonight" card (with reason); wallet-not-connected / insufficient-balance errors in the x402 modal; tip/clip load failure falls back to a default clip or bind pose; tip-stream disconnect → paused-feed badge with retry; entrance-GLB failure skips the walk-in.
- **Step count:** 7 required (+1 optional)
- **Note:** Some entrance/tip detail above is reconstructed from `club*.js` + endpoint references; exact on-stage routine names and per-pole UI copy were not exhaustively read.

---

### Feature Landing — Play — `/features/play`
- **Source:** `/workspaces/three.ws/pages/features/play.html` (static marketing). Shared loaders: `public/nav.js`, `public/footer.js`; inline FAQ-accordion script.
- **Entry point:** `/features/play` → `features/play.html`.
- **Prerequisites / gates:** None — explicitly "No wallet needed to explore".
- **Steps (2):**
  1. Read the marketing content (hero, biome swatches, FAQ accordion).
  2. Click the primary CTA "Enter a world →" → **`/play`** (secondary: "All features" → `/features`, "Try Walk instead" → `/features/walk`).
- **Decision points / branches:** primary CTA (→ /play) vs cross-link to /features or /features/walk; FAQ expand/collapse.
- **External calls / dependencies:** None (nav/footer loaders only; no API, no 3D viewer).
- **Success state:** User clicks through to the `/play` 3D world.
- **Empty / error states:** Static page — no data states; FAQ accordion is the only interaction.
- **Step count:** 2 required (+0 optional) — primarily content/landing.

---

### Feature Landing — AR — `/features/ar`
- **Source:** `/workspaces/three.ws/pages/features/ar.html` (static marketing with an embedded `<model-viewer>` AR preview). Shared `nav.js`/`footer.js`; model-viewer via Google CDN; inline FAQ script.
- **Entry point:** `/features/ar` → `features/ar.html`.
- **Prerequisites / gates:** None to view. The embedded model-viewer offers WebXR / Scene Viewer / Quick Look AR (uses device camera if the user taps the AR button).
- **Steps (3):**
  1. Read content; an interactive `<model-viewer>` (model `/animations/robotexpressive.glb`) rotates in the hero.
  2. (optional) On a supported device, tap the model-viewer AR button to place the model in AR (camera permission requested by the browser/OS).
  3. Click the primary CTA "Browse avatars →" → **`/gallery`** (secondary: "Generate a model" → `/forge`; doc links → `/docs/ar`, `/docs/tutorials/view-in-ar`, `/docs/web-component`).
- **Decision points / branches:** view-in-AR vs browse CTA vs generate CTA vs docs; FAQ accordion.
- **External calls / dependencies:** Google model-viewer CDN; GLB asset `/animations/robotexpressive.glb`. No backend API.
- **Success state:** User previews/places a model in AR or clicks through to `/gallery`.
- **Empty / error states:** Static; AR button only appears on AR-capable devices.
- **Step count:** 3 required (+1 optional) — primarily content with an interactive AR preview.

---

### Feature Landing — Walk — `/features/walk`
- **Source:** `/workspaces/three.ws/pages/features/walk.html` (static marketing with `<model-viewer>` auto-rotate preview). Shared `nav.js`/`footer.js`; model-viewer CDN; inline FAQ script.
- **Entry point:** `/features/walk` → `features/walk.html`.
- **Prerequisites / gates:** None.
- **Steps (2):**
  1. Read content; a `<model-viewer>` (model `/avatars/cz.glb`) auto-rotates (no AR button here).
  2. Click the primary CTA "Start walking →" → **`/walk`** (secondary: "All features" → `/features`, "Try Play instead" → `/features/play`).
- **Decision points / branches:** primary CTA (→ /walk) vs cross-links; FAQ accordion.
- **External calls / dependencies:** Google model-viewer CDN; GLB `/avatars/cz.glb`. No backend API.
- **Success state:** User clicks through to the `/walk` experience.
- **Empty / error states:** Static page.
- **Step count:** 2 required (+0 optional) — primarily content.

---

### Feature Landing — Deploy — `/features/deploy`
- **Source:** `/workspaces/three.ws/pages/features/deploy.html` (static marketing; no 3D viewer). Shared `nav.js`/`footer.js`; inline FAQ + static deploy-chain visualization.
- **Entry point:** `/features/deploy` → `features/deploy.html`.
- **Prerequisites / gates:** Landing is public. The actual deploy action (on the destination `/deploy` page) requires a Solana wallet to sign the on-chain transaction — the page describes "the UI previews the transaction and metadata before you sign".
- **Steps (2):**
  1. Read content (deploy-chain explainer, ERC-8004 directory references, FAQ).
  2. Click the primary CTA "Deploy now →" → **`/deploy`** (secondary: "Browse deployed agents" → `/discover`; FAQ links → `/discover`, `/features/marketplace`, `/features/studio`).
- **Decision points / branches:** deploy CTA (→ /deploy, wallet-gated at action) vs browse (→ /discover) vs feature cross-links; FAQ accordion.
- **External calls / dependencies:** None on the landing page (nav/footer loaders only). Wallet/on-chain interaction happens later on `/deploy`.
- **Success state:** User clicks through to `/deploy`.
- **Empty / error states:** Static page; the wallet gate is on the destination, not here.
- **Step count:** 2 required (+0 optional) — primarily content with a wallet-gated downstream action.
