# Embed, Widget & Studio

UX Flow Atlas — Cluster 04. Traced end-to-end against real source in `/workspaces/three.ws`.

Routing recap (from `vercel.json`):

| Route | Serves |
|---|---|
| `/studio`, `/studio/` | `public/studio/index.html` (+ `studio.js`, `studio.css`, `launch-panel.js`, `knowledge-panel.js`) — **Widget Studio** |
| `/widgets`, `/widgets/` | `public/widgets-gallery/index.html` (+ `gallery.js`, `showcase.json`) — **Widgets Gallery** |
| `/features/studio` | `pages/features/studio.html` — marketing/feature landing for the Studio |
| `/artifact`, `/artifact/` | `public/artifact/index.html` — **Claude.ai Artifact builder** |
| `/avatar-studio`, `/create/studio` | `pages/avatar-studio.html` (+ `src/avatar-studio.js`) — **Avatar Studio** (appearance builder; feeds the embed flows) |
| `/w/<id>` | saved widget page (live widget) |
| `/widget`, `/widget.html` | slim viewer shell (`/src/app.js`) used as Studio/gallery preview iframe + script-tag embed target |
| `/agent/<id>/embed`, `/embed/avatar/<handle>`, `/embed`, `/a-embed.html` | embed iframe targets |
| `/embed.js`, `/embed-sdk.js`, `/artifact.js`, `/dist-lib/agent-3d.js` | embed loader / SDK / web-component scripts |

> Naming note: the prompt's "avatar-studio embeddable AI widget builder" maps to the **Widget Studio** at `/studio` (the talking-agent widget type is the embeddable AI widget). `/avatar-studio` is the **appearance builder** — it produces the avatar that the Studio and embed panels then wrap. Both are documented below.

---

### Widget Studio — `/studio`
- **Source:** `public/studio/index.html`, `public/studio/studio.js`, `public/studio/studio.css`, `public/studio/launch-panel.js`, `public/studio/knowledge-panel.js`. Preview iframe loads `/widget` (slim `src/app.js` shell). APIs: `/api/auth/me`, `/api/avatars`, `/api/avatars/public`, `/api/avatars/:id`, `/api/widgets`.
- **Entry point:** Direct nav to `/studio`; "Create yours" / "Open the Studio" CTAs on `/widgets`; "Open Studio →" on `/features/studio`; "Open in Studio" links from gallery cards (`/studio?template=<id>`); deep links `?edit=<id>`, `?type=<type>`, `?model=<url>`, `?avatar=<id>`.
- **Prerequisites / gates:** None to try — a built-in **demo avatar (CZ, `/avatars/cz.glb`)** is preloaded so an anonymous visitor can configure and preview. **Saving a draft / embedding a non-demo avatar requires sign-in** (`/login?next=/studio`) and an owned/public avatar. The demo avatar can generate an embed (pointing at a baked demo fixture, e.g. `wdgt_demo_talking`) but cannot save. No $THREE gate. ⚡ Launch tab can optionally launch the agent's coin via `launch-panel.js`.
- **Steps (10):**
  1. Page boots → `fetchMe()` (`/api/auth/me`) resolves user; user menu renders (signed-out shows "Sign in"); 3-column layout unhides.
  2. System renders the **widget-type grid** (9 ready types: turntable, animation-gallery, talking-agent, passport, hotspot-tour, pumpfun-feed, kol-trades, live-trades-canvas, bonding-curve) and **avatar list** (`loadAvatars()` → demo avatar + `/api/avatars?limit=100` for signed-in users, with skeleton cards while loading).
  3. **Pick avatar** (step-1 panel): click an avatar card → `selectAvatar()`; or `(optional)` search public avatars (`/api/avatars/public?q=`) and pick one; demo avatar is selected automatically if none chosen.
  4. **Pick widget type** (step-2 panel): click a type card → `selectType()` rebuilds the type-specific config fields, preserving brand settings.
  5. System loads the **live preview** in the `/widget` iframe (`updatePreview()` builds `#model=…&kiosk=true&type=…`), posts the config via `postMessage({type:'widget:config'})`; status flips to "Live preview".
  6. **Configure Brand** (step-3): name, background color, accent, optional caption, show-controls, auto-rotate, environment preset, public toggle — every input debounces (`schedulePreview`, 200 ms) and re-posts config to the preview.
  7. `(optional)` **Configure type fields**: e.g. talking-agent gets agent name/title, greeting, system prompt, LLM provider (Anthropic/OpenAI/watsonx/Groq/OpenRouter/custom proxy), skills, voice in/out, rate limits, and a **Knowledge panel** (RAG docs) once saved; passport gets chain/agentId/wallet; mint-based types get a Solana mint address.
  8. `(optional)` **Frame the camera**: drag in the preview, click "Use current view" → reads `previewIfr.contentWindow.VIEWER.viewer.activeCamera`, stores `cameraPosition`. `(optional)` switch device frame (desktop/tablet/mobile).
  9. `(optional)` **Save draft** → POST/PATCH `/api/widgets` (requires sign-in + name); URL gets `?edit=<id>`, "View live" (`/w/<id>`) + "Delete" actions appear.
  10. **Generate embed** → saves (or, for demo avatar, resolves the baked fixture) then opens the **embed modal**: shareable URL `/w/<id>`, width/height inputs, per-type include toggles (animations / chat / controls), **iframe snippet**, and a **script-tag snippet** (`<script async src="/embed.js" data-widget="<id>">`). Copy → paste on any site. Done.
- **Decision points / branches:**
  - Demo avatar → embed allowed (baked fixture, tweaks not saved, modal shows "upload your own" note) but save blocked.
  - Signed-out + non-demo save/generate → redirect to `/login?next=…`.
  - `?edit=<id>` → `loadForEdit()` hydrates an existing widget (PATCH on save). `?template=<id>` → `cloneTemplate()` (config copied, avatar must be re-picked, POST creates new). `?model=<url>` / `?avatar=<id>` → preselect / auto-register R2 model (`autoRegisterAndSelect` HEADs the GLB then POSTs `/api/avatars`).
  - Embed-modal include toggles add `noAnimations=1` / `noChat=1` / `noControls=1` to the URL.
  - Right column tabs: **Brand** ↔ **⚡ Launch** (launch panel hides save/generate row).
- **External calls / dependencies:** `/api/auth/me`, `/api/auth/logout`, `/api/avatars`, `/api/avatars/public`, `/api/avatars/:id` (POST to register), `/api/widgets` (GET/POST/PATCH/DELETE), preview iframe `/widget#…`, embed loader `/embed.js`, share/live `/w/<id>`, `/api/widgets/:id/og` (poster). Importmap loads `@solana/web3.js` + `@solana/spl-token` from esm.sh for the Launch tab.
- **Success state:** Embed modal open with a copyable iframe + script snippet and a live shareable `/w/<id>` URL; "View live" opens it in a new tab. Toast "Saved" on draft save.
- **Empty / error states:** No avatars → empty card with "Scan yourself to 3D →" / "AI selfie →". Avatar load failure → inline error card with **Retry**. Public search failure → status line shows reason. Save failure → `#form-error` text. Preview without a model → "Avatar has no public URL — make it public/unlisted to preview". Pre-selected avatar missing → toast + falls back to demo. Pending-status types show a "ships in a later prompt" banner (currently none — all 9 are `ready`).
- **Step count:** 10 required (+5 optional)

---

### Widgets Gallery — `/widgets`
- **Source:** `public/widgets-gallery/index.html`, `public/widgets-gallery/gallery.js`, `public/widgets-gallery/gallery.css`, `public/widgets-gallery/showcase.json`. Card iframes load `/widget#widget=<id>&kiosk=true…`.
- **Entry point:** Direct nav to `/widgets`; nav links ("Widgets") across Studio/footer; `/features/studio`.
- **Prerequisites / gates:** None. Fully public, read-only browsing. No auth, no avatar, no $THREE gate.
- **Steps (6):**
  1. Page loads → 3 skeleton cards render (`showSkeleton`).
  2. `fetch('/widgets-gallery/showcase.json')` → builds **filter chips** (one per widget type + "All"), updates hero count, renders one **showcase card** per widget; cards fade in on scroll (IntersectionObserver).
  3. Each card auto-loads its preview iframe when 50% visible (or via the ▶ play button); `(optional)` toggle **Preview ↔ Code** tab to see the snippet in the frame area.
  4. **Customize** `(optional)`: open the Customize `<details>` and adjust Size (S/M/L), Accent color, and per-type knobs (mint for kol-trades/live-trades-canvas, kind for pumpfun-feed). Snippet + iframe update live (debounced 350 ms reload); "Reset" restores defaults.
  5. **Copy embed**: split-button copies the current snippet; `(optional)` use the format dropdown to switch **HTML iframe / JSX (React) / Share URL** before copying. Button flips to "Copied!".
  6. Paste the snippet on any site → renders the live widget. Done. (Or click **"Open in Studio"** → `/studio?template=<id>` to clone & customize fully — branches into the Widget Studio flow.)
- **Decision points / branches:**
  - Format dropdown: iframe (HTML), JSX (React inline-style iframe), URL.
  - Customized state (size≠M, custom accent, non-default mint/kind) makes the "Share URL" output the `/widget#…` hash form (preserves overrides) instead of `/w/<id>`.
  - Filter chips show/hide cards by type and re-index for the stagger animation.
  - Preview iframe uses `reveal=interaction` + a `/api/widgets/<id>/og` poster to keep WebGL slots free on a dense page.
- **External calls / dependencies:** `/widgets-gallery/showcase.json`, preview iframes at `/widget#widget=<id>…`, `/api/widgets/<id>/og` (poster), model-viewer 4.0.0 (footer avatar, from googleapis CDN with SRI). Mints used in defaults are SOL wrapped-mint and the `$THREE` CA.
- **Success state:** Snippet copied to clipboard ("Copied!"); live preview rendered in card.
- **Empty / error states:** Showcase fetch failure → error card "Could not load showcase config." with detail. Per-card iframe failure leaves the placeholder/play button. Hero count defaults to 8 in static HTML, overwritten by real count.
- **Step count:** 6 required (+3 optional)

---

### Studio feature landing — `/features/studio`
- **Source:** `pages/features/studio.html` (static marketing page; `style.css`, `nav.css`, `features-landing.css`). No JS module of its own.
- **Entry point:** `/features` hub, marketing links, search/SEO. Title: "Studio — Build an Embeddable 3D AI Widget".
- **Prerequisites / gates:** None (public marketing).
- **Steps (2):**
  1. Visitor reads the value prop ("One script tag. 3D AI on any site.") and feature copy (configure avatar, voice, knowledge, tools).
  2. Click a CTA — **"Open Studio →"** (→ `/studio`, two on the page) or **"Deploy on-chain instead"** (→ `/features/deploy`) or "All features" (→ `/features`). Branches into the Widget Studio flow.
- **Decision points / branches:** Open Studio vs. Deploy on-chain vs. browse all features.
- **External calls / dependencies:** None at runtime beyond static assets + `/api/feature-og` for OG image.
- **Success state:** User lands in `/studio`.
- **Empty / error states:** N/A (static).
- **Step count:** 2 required (+0 optional)

---

### Claude.ai Artifact builder — `/artifact`
- **Source:** `public/artifact/index.html` (self-contained, inline module script), `public/artifact/README.md`, `public/artifact/snippet.html`. Backend: `GET /api/artifact` (returns one self-contained HTML doc; see `specs/CLAUDE_ARTIFACT.md`). Also a `/artifact.js` loader script for in-artifact `<div data-agent-id>` mounting.
- **Entry point:** Direct nav to `/artifact`; deep link `?agentId=<id>` (auto-generates on load).
- **Prerequisites / gates:** None to use the builder. To produce a working artifact you need a valid **agent ID/handle** (or whitelisted-CDN `model` URL). GLB must be **≤ 6 MB** (server returns 413 otherwise). No auth/$THREE gate on the page itself.
- **Steps (6):**
  1. Visitor lands; the page fetches and shows the live Claude sandbox CSP (`raw.githubusercontent.com/simonw/scrape-claude-artifacts/…`) in a `<details>`.
  2. **Configure**: enter Agent ID; `(optional)` set Theme (dark/light), Idle clip name, Background hex.
  3. Click **Generate** (or Enter) → `buildUrl()` assembles `/api/artifact?agent=…&theme=…&idle=…&bg=…`; overlay shows "Fetching artifact…"; `history.replaceState` adds `?agentId=`.
  4. System fetches the artifact HTML, measures size + first-paint, checks the response CSP for `frame-ancestors *`, and renders it into a **sandboxed iframe** (`sandbox="allow-scripts"`, `srcdoc`). Stats panel fills in (Artifact size ok/warn/bad, First paint, Sandbox compliant/mismatch).
  5. **Copy** the result: **Copy URL** (the `/api/artifact?…` link), **Copy raw HTML** (the full self-contained doc), or **Open in tab**; `(optional)` expand the "Paste-into-Claude snippet" (`Here's my agent for this conversation:\n<url>`).
  6. Paste the URL into a Claude.ai conversation → Claude embeds the artifact and the 3D avatar renders inline (zero external fetches, CSP-compliant). Done.
- **Decision points / branches:**
  - `agent` vs. `model` source (README); theme/idle/bg are optional refinements.
  - Size thresholds: >5 MB = warn, >8 MB = bad (server caps at 6 MB → 413).
  - Two consumption paths: paste the **URL** directly, or paste the **raw HTML** / use the `/artifact.js` `<div data-agent-id>` snippet inside an existing artifact.
- **External calls / dependencies:** `GET /api/artifact` (the bundle), Claude CSP mirror at `raw.githubusercontent.com/simonw/scrape-claude-artifacts/main/content-security-policy.txt`. Artifact bundle inlines three.js + GLTFLoader + GLB (~565 KB viewer overhead) — no runtime fetch.
- **Success state:** Live preview renders in the CSP-mirrored sandbox; stats show "compliant"; URL/HTML copied.
- **Empty / error states:** No agent ID → overlay "Enter an agent ID first." Network error / non-OK → overlay shows `error_description`/HTTP status. CSP mirror unreachable → falls back to a note pointing at `specs/CLAUDE_ARTIFACT.md`. Sandbox mismatch → stat shows "mismatch" (bad).
- **Step count:** 6 required (+2 optional)

---

### Agent embed snippet (SharePanel / `<agent-3d>`) — share/embed panel flow
- **Source:** `src/share-panel.js` (`SharePanel` class) + `src/share-panel-builders.js` (`buildEmbedUrl`, `buildIframeSnippet`, `buildWebComponentSnippet`) + `src/share-panel.css`. Mounted on the agent home page via `src/agent-home-orphans.js`; also referenced from `src/agent-detail.js` and `src/forge.js`. Embed targets: `/agent/<id>/embed` (CSP `frame-ancestors *`), web component `/dist-lib/agent-3d.js`. Preview iframe = same `/agent/<id>/embed?preview=1`.
- **Entry point:** **Share** button on an agent profile/home page (`agent-home-orphans.js` injects it next to the title) → `new SharePanel({ agent }).open()`.
- **Prerequisites / gates:** Must be on an **existing agent** (an `agent.id`/`slug`). No sign-in required to copy snippets — embedding is free ("no wallet or on-chain deployment required"). No $THREE gate.
- **Steps (6):**
  1. Click **Share** → modal opens with the agent's permalink `/a/<slug|id>`, a live preview iframe, and pre-rendered snippets.
  2. `(optional)` **Copy link** or **Open ↗** the agent permalink.
  3. **Customise embed** `(optional)`: Background (transparent/dark/light), Name plate (on/off), Size (small 320×420 / medium 420×520 / large 520×680). Each toggle re-renders the snippets and reloads the live preview (`?preview=1` bypasses the embed origin allow-list).
  4. Choose a format and **Copy**: **iframe embed** (`<iframe src="/agent/<id>/embed?…">`) or **Web component** (`<script src="/dist-lib/agent-3d.js">` + `<agent-3d agent-id="…" background=… name-plate=off>`). Button flips to "Copied ✓".
  5. `(optional)` **OG preview** + copy the `/api/a-og?id=<id>` card URL; **QR code** of the permalink is rendered (canvas, SVG fallback).
  6. Paste the iframe or `<agent-3d>` snippet on any third-party site → the agent renders inline (the `/agent/<id>/embed` page runs `src/avatar-embed.js` / element runtime, exposing the `v1.avatar.*` postMessage bridge). Done.
- **Decision points / branches:**
  - iframe vs. web-component snippet (web component observes `background` / `name-plate` attrs).
  - Default options (transparent bg, name on, medium) are omitted from the URL to keep it canonical/short.
  - Separate, simpler embed entry points exist: **Agent Hub** "Embed" button → `AgentEmbedModal` (`src/agent-embed-modal.js`, iframe / `<agent-3d>` / SDK tabs with width×height); **Dashboard** avatar/agent "Embed" → `openAvatarEmbedModal` (`src/dashboard/dashboard.js`, `/a-embed.html?avatar=<id>` with size/bg/name presets). See variants below.
- **External calls / dependencies:** `/agent/<id>/embed` (preview + final), `/dist-lib/agent-3d.js` (web component), `/api/a-og?id=<id>` (OG image), `/a/<slug|id>` (permalink). QR rendered locally (`src/erc8004/qr.js`).
- **Success state:** Snippet copied ("Copied ✓"); live preview shows the agent in the chosen size/bg.
- **Empty / error states:** Preview iframe failure leaves the framed area blank with the chosen bg color visible; OG image alt text shown if it fails to load; QR falls back canvas → SVG → plain link text.
- **Step count:** 6 required (+3 optional)

#### Variant — Agent Hub embed modal (`AgentEmbedModal`)
- **Source:** `src/agent-embed-modal.js`, triggered from `src/agent-hub-actions.js` (hub "Embed" button) and `src/dashboard/dashboard.js` (`openAgentEmbedModal`).
- **Steps (4):** (1) Click "Embed" on the agent hub → modal opens (default 420×520). (2) `(optional)` adjust Width/Height. (3) Switch tab: **iframe** (`/agent/<id>/embed`), **`<agent-3d>`** (`/dist-lib/agent-3d.js` web component), or **SDK** (`/embed-sdk.js` + `Agent3D.connect()` bridge example). (4) **Copy** → paste on site. Snippets are pure-string built from `origin` + `id` + `w` + `h`; note: "Free to embed — no wallet or on-chain deployment required."
- **Step count:** 4 required (+1 optional)

#### Variant — Dashboard avatar embed (`openAvatarEmbedModal`)
- **Source:** `src/dashboard/dashboard.js` (`openAvatarEmbedModal`), embed target `/a-embed.html?avatar=<id>` (runtime `src/avatar-embed.js`).
- **Steps (4):** (1) From the dashboard avatar/agent list click "Embed" (agent path requires a linked `avatar_id`, else toast "Link an avatar to the agent first"). (2) Pick a size preset (Square 480² / Portrait 360×540 / Banner 1200×400 / Custom W×H). (3) Set Background (transparent/dark/light) + name-plate + open-link toggles. (4) Copy the generated `/a-embed.html?avatar=…` iframe → paste. Builds `?bg=…&name=0&open-link=0` deviations from defaults.
- **Step count:** 4 required (+0 optional)

---

### Avatar Studio (appearance builder) — `/avatar-studio` · `/create/studio`
- **Source:** `pages/avatar-studio.html`, `src/avatar-studio.js` (+ `avatar-studio-utils.js`, `avatar-studio-optimize.js`, `avatar-sculpt.js`, `voice/talk-scene.js`, `agent-accessories.js`, `idle-animation.js`, `account.js`). Title: "Avatar Studio". Save path: `account.js` → `/api/avatars` (+ GLTFExporter snapshot upload).
- **Entry point:** `/avatar-studio` or `/create/studio` (create from `default.glb`); `?edit=<id>` reloads a saved avatar.
- **Prerequisites / gates:** Anyone can build/preview from the base template. **Saving requires sign-in** (so it persists to the account). No $THREE gate. This is the *upstream* builder — the avatar it produces becomes selectable in Widget Studio and embeddable via the SharePanel/embed modals.
- **Steps (7):**
  1. Page boots → loads `BASE_GLB_URL` (`/avatars/default.glb`) into a `TalkScene` viewport with idle breathing/blinking; accessory presets load.
  2. `(optional)` In **edit mode** (`?edit=<id>`) the saved appearance (colors/morphs/accessories/hidden layers) is hydrated onto the model.
  3. **Customize**: switch tabs — Color (skin/hair/outfit swatches + hex), Hats, Glasses, Earrings (accessory presets), Face (sculpt morphs). Each change applies live to the scene graph; `(optional)` undo/redo (history up to 50).
  4. `(optional)` Show/hide garment layers; `(optional)` search accessories.
  5. **Save** → exports the live scene via GLTFExporter (colors/morphs/accessories already baked), optimizes/validates the GLB (`avatar-studio-optimize.js`), uploads via `account.js` (`/api/avatars`), and PATCHes the appearance JSON so it stays re-editable; uploads a snapshot thumbnail.
  6. The saved avatar now appears in the avatar library used by **Widget Studio** (`/studio` step 3) and the **embed/share panels**.
  7. Continue into an embed flow: open Widget Studio, the agent SharePanel, or a dashboard embed modal to generate the snippet. Done.
- **Decision points / branches:** Create (from default) vs. Edit (`?edit=<id>`). Single-select tabs (hat/glasses) vs. multi (earrings). Save requires auth → otherwise prompts sign-in.
- **External calls / dependencies:** `/avatars/default.glb`, accessory preset assets, `/api/avatars` (save/PATCH), avatar-snapshot upload, GLTFExporter. Hands off to `/studio`, SharePanel (`/agent/<id>/embed`), or `/a-embed.html`.
- **Success state:** Avatar saved to account, re-editable, and selectable in the embed/Studio flows.
- **Empty / error states:** Queued ops swallow + log failures (`queueOp`); GLB validation/optimize failures surface in the save path; signed-out save routes to login. Unsaved-changes tracking via `appearanceEqual`.
- **Step count:** 7 required (+4 optional)

---

## Cross-flow notes
- **`/widget` shell** is the shared render surface: Studio + gallery previews and the `/embed.js` script-tag embed all point at `/widget#widget=<id>&kiosk=true`.
- **`embed.js`** (`public/embed.js`) is the script-tag loader: reads `data-widget` / `data-widget-url`, `data-width/height/radius/border`, `data-reveal`, `data-poster`, `data-priority`, `data-motion`, mounts a sandboxed iframe at the script position, and supports multiple embeds per page.
- **Web component `<agent-3d>`** (`/dist-lib/agent-3d.js`) is the first-class embedding primitive surfaced by SharePanel and AgentEmbedModal; it observes `agent-id`, `background`, `name-plate` attributes.
- **avatar-embed runtime** (`src/avatar-embed.js`) backs `/embed/avatar/<handle>`, `/a-embed.html`, and the agent embed; exposes the `v1.avatar.*` postMessage bridge (speak, emote, morphs, lookAt, mocap, idle, hotkeys, mic, state) plus third-party-compatible event aliases and a same-origin BroadcastChannel control surface.
