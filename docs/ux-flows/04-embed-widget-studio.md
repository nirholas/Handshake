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
| `/agents/<id>/embed` (the legacy `/agent/<id>/embed` still serves the same page), `/embed/avatar/<handle>`, `/a-embed.html` | embed iframe targets |
| `/embed` | **retired.** The standalone embed editor merged into the Widget Studio. The bare path 301s to `/studio`; a parameter-carrying form (`?mode=`, `?avatar=`, `?id=`) rewrites into `/studio/index.html`, which reads the same parameter names, so every saved `/embed?…` URL still lands on the configuration it described. `/embed/v1.js`, `/embed/avatar`, `/embed/walk/` and the other `/embed/*` runtimes are unaffected. |
| `/embed.js`, `/embed-sdk.js`, `/artifact.js`, `/dist-lib/agent-3d.js` | embed loader / SDK / web-component scripts |

> Naming note: the prompt's "avatar-studio embeddable AI widget builder" maps to the **Widget Studio** at `/studio` (the talking-agent widget type is the embeddable AI widget). `/avatar-studio` is the **appearance builder** — it produces the avatar that the Studio and embed panels then wrap. Both are documented below.

---

### Widget Studio — `/studio`
- **Source:** `public/studio/index.html`, `public/studio/studio.js`, `public/studio/studio.css`, `public/studio/launch-panel.js`, `public/studio/knowledge-panel.js`. Preview iframe loads `/widget` (slim `src/app.js` shell). APIs: `/api/auth/me`, `/api/avatars`, `/api/avatars/public`, `/api/avatars/:id`, `/api/widgets`.
- **Entry point:** Direct nav to `/studio`; "Create yours" / "Open the Studio" CTAs on `/widgets`; "Open Studio →" on `/features/studio`; "Open in Studio" links from gallery cards (`/studio?template=<id>`); the "Configure in wizard" links on avatar/agent pages and the dashboard; deep links `?edit=<id>`, `?type=<type>`, `?model=<url>`, `?avatar=<id>`, plus the inherited embed-editor form `?mode=static|idle|walking|chat` with `?avatar=`, `?controls=`, `?env=`, `?bg=`, `?width=`, `?height=`, `?autoplay=`, `?speed=`, `?ground=`, `?gestures=`, `?badge=`. Those same names are written back into `location.search` as you edit a URL-baked widget, so a configured studio URL is itself a shareable artifact.
- **Prerequisites / gates:** None to try, and for two widget types, none to finish. A built-in **demo avatar (CZ, `/avatars/cz.glb`)** is preloaded so an anonymous visitor can configure and preview. The **walking-avatar** and **agent-chat** types bake their whole configuration into the embed URL, so a signed-out visitor can configure, generate and copy a working snippet with no account and no database row (the modal hides the `/w/<id>` share URL and the script-tag snippet, which do need one, and says what signing in adds). Every other type stores config server-side, so **saving a draft or embedding with them requires sign-in** (`/login?next=/studio`) and an owned/public avatar. The demo avatar can generate an embed (pointing at a baked demo fixture, e.g. `wdgt_demo_talking`) but cannot save. No $THREE gate. ⚡ Launch tab can optionally launch the agent's coin via `launch-panel.js` (lane toggle: pump.fun or the three.ws curve; oversized token images are downscaled in-browser instead of rejected).
- **Steps (10):**
  1. Page boots → `fetchMe()` (`/api/auth/me`) resolves user; user menu renders (signed-out shows "Sign in"); 3-column layout unhides.
  2. System renders the **widget-type grid** (11 ready types: turntable, animation-gallery, talking-agent, passport, hotspot-tour, pumpfun-feed, kol-trades, live-trades-canvas, bonding-curve, walking-avatar, agent-chat) and **avatar list** (`loadAvatars()` → demo avatar + `/api/avatars?limit=100` for signed-in users, with skeleton cards while loading).
  3. **Pick avatar** (step-1 panel): click an avatar card → `selectAvatar()`; or `(optional)` search public avatars (`/api/avatars/public?q=`) and pick one; or `(optional)` paste a **model URL** you host yourself (`.glb`, `.gltf`, `.vrm`) and press Use, which previews it and points the snippet straight at that URL without uploading anything (if the URL happens to be one of your own stored models it is registered as a real avatar instead). Demo avatar is selected automatically if none chosen. The whole panel is hidden for **agent-chat**, which renders whatever avatar its agent already owns.
  4. **Pick widget type** (step-2 panel): click a type card → `selectType()` rebuilds the type-specific config fields, preserving brand settings.
  5. System loads the **live preview** in the `/widget` iframe (`updatePreview()` builds `#model=…&kiosk=true&type=…`), posts the config via `postMessage({type:'widget:config'})`; status flips to "Live preview".
  6. **Configure Brand** (step-3): name, background color, accent, optional caption, show-controls, auto-rotate, environment preset, public toggle — every input debounces (`schedulePreview`, 200 ms) and re-posts config to the preview.
  7. `(optional)` **Configure type fields**: e.g. talking-agent gets agent name/title, greeting, system prompt, LLM provider (Anthropic/OpenAI/watsonx/Groq/OpenRouter/custom proxy), skills, voice in/out, rate limits, and a **Knowledge panel** (RAG docs) once saved; passport gets chain/agentId/wallet; mint-based types get a Solana mint address.
  8. `(optional)` **Frame the camera**: drag in the preview, click "Use current view" → reads `previewIfr.contentWindow.VIEWER.viewer.activeCamera`, stores `cameraPosition`. `(optional)` switch device frame (desktop/tablet/mobile).
  9. `(optional)` **Save draft** → POST/PATCH `/api/widgets` (requires sign-in + name); URL gets `?edit=<id>`, "View live" (`/w/<id>`) + "Delete" actions appear.
  10. **Generate embed** → saves (or, for the demo avatar, resolves the baked fixture; or, for a URL-baked type with no account, skips the save entirely) then opens the **embed modal**: shareable URL `/w/<id>`, width/height inputs, per-type include toggles (animations / chat / controls), **iframe snippet**, a **script-tag snippet** (`<script async src="/embed.js" data-widget="<id>">`), and **platform paste instructions** (HTML, React, WordPress, Webflow, Shopify). Copy → paste on any site. Done.
- **Decision points / branches:**
  - Demo avatar → embed allowed (baked fixture, tweaks not saved, modal shows "upload your own" note) but save blocked.
  - Signed-out + non-demo save/generate → redirect to `/login?next=…`.
  - `?edit=<id>` → `loadForEdit()` hydrates an existing widget (PATCH on save). `?template=<id>` → `cloneTemplate()` (config copied, avatar must be re-picked, POST creates new). `?model=<url>` / `?avatar=<id>` → preselect / auto-register R2 model (`autoRegisterAndSelect` HEADs the GLB then POSTs `/api/avatars`).
  - Embed-modal include toggles add `noAnimations=1` / `noChat=1` / `noControls=1` to the URL.
  - Right column tabs: **Brand** ↔ **⚡ Launch** (launch panel hides save/generate row).
- **External calls / dependencies:** `/api/auth/me`, `/api/auth/logout`, `/api/avatars`, `/api/avatars/public`, `/api/avatars/:id` (POST to register), `/api/widgets` (GET/POST/PATCH/DELETE), preview iframe `/widget#…`, embed loader `/embed.js`, share/live `/w/<id>`, `/api/widgets/:id/og` (poster). The page importmap pins `@solana/web3.js` + `@solana/spl-token` to esm.sh; `launch-panel.js` loads its own web3.js and `qrcode` copies through `/load-module.js` (esm.sh, then jsdelivr, then unpkg, each under a deadline) and, if all three miss, reports "<what> could not be loaded (<hosts> unreachable or blocked). Check your connection or ad blocker and try again."
- **Success state:** Embed modal open with a copyable iframe + script snippet and a live shareable `/w/<id>` URL; "View live" opens it in a new tab. Toast "Saved" on draft save.
- **Empty / error states:** No avatars → empty card with "Make one from a selfie →" / "browse every way to build one →". Avatar load failure → inline error card with **Retry**. Public search failure → status line shows reason. Save failure → `#form-error` text. Preview without a model → a note that the avatar has no public URL (make it public/unlisted to preview). Pre-selected avatar missing → toast + falls back to demo. Pending-status types show a "ships in a later prompt" banner (currently none: all 10 are `ready`).
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
  4. **Customize** `(optional)`: open the Customize `<details>` and adjust Size (S/M/L), Accent color, and per-type knobs (mint for kol-trades/live-trades-canvas/bonding-curve, kind for pumpfun-feed). Snippet + iframe update live (debounced 350 ms reload); "Reset" restores defaults.
  5. **Copy embed**: split-button copies the current snippet; `(optional)` use the format dropdown to switch **HTML iframe / JSX (React) / Share URL** before copying. Button flips to "Copied!".
  6. Paste the snippet on any site → renders the live widget. Done. (Or click **"Open in Studio"** → `/studio?template=<id>` to clone & customize fully — branches into the Widget Studio flow.)
- **Decision points / branches:**
  - Format dropdown: iframe (HTML), JSX (React inline-style iframe), URL.
  - Customized state (size≠M, custom accent, non-default mint/kind) makes the "Share URL" output the `/widget#…` hash form (preserves overrides) instead of `/w/<id>`.
  - Filter chips show/hide cards by type and re-index for the stagger animation.
  - Preview iframe uses `reveal=interaction` + a `/api/widgets/<id>/og` poster to keep WebGL slots free on a dense page.
- **External calls / dependencies:** `/widgets-gallery/showcase.json`, preview iframes at `/widget#widget=<id>…`, `/api/widgets/<id>/og` (poster), model-viewer 4.0.0 (footer avatar, from googleapis CDN with SRI). Mints used in defaults are SOL wrapped-mint and the `$THREE` CA.
- **Success state:** Snippet copied to clipboard ("Copied!"); live preview rendered in card.
- **Empty / error states:** Showcase fetch failure → `role=alert` card "The widget showcase could not load. Check your connection and try again." with the detail, a **Try again** button that re-runs the load (replacing the filter bar instead of stacking a second one) and a "Read the widget docs" link (`/docs/widgets`). A manifest with zero widgets → "No showcase widgets yet" empty state with **Open the Studio**. Per-card iframe failure leaves the placeholder/play button. Hero count defaults to 15 in static HTML, overwritten by the real count (and re-written whenever the i18n runtime repaints the badge).
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
- **Prerequisites / gates:** None to use the builder. To produce a working artifact you need a valid **agent UUID** (a hand-typed handle is refused with `400 invalid_request`: "agent must be the agent UUID, copied from the agent profile page") or a whitelisted-CDN `model` URL. GLB must be **≤ 6 MB** (server returns 413 otherwise). No auth/$THREE gate on the page itself.
- **Steps (6):**
  1. Visitor lands; the page shows the vendored Claude sandbox CSP (`/claude-artifact-csp.txt`, the same bytes `tests/api/artifact.test.js` pins the endpoint against) in a `<details>`, and a **"Public agents you can embed"** picker loads `GET /api/agents/public?sort=popular&limit=12&avatar=1` (four skeleton tiles → a grid of avatar tiles; "Browse all" → `/agents`).
  2. **Configure**: click a picker tile (fills the ID and generates in one tap) or paste an agent UUID; `(optional)` set Theme (dark/light), Idle clip name, Background hex (six hex digits, validated live with an inline hint).
  3. Click **Generate** (or Enter) → `buildUrl()` assembles `/api/artifact?agent=…&theme=…&idle=…&bg=…`; overlay shows "Fetching artifact…"; the query string is synced to `?agentId=` plus any non-default theme/idle/bg so the address bar carries the whole configuration.
  4. System fetches the artifact HTML, measures size, fetch time and render time, checks the response CSP for `frame-ancestors *`, and renders it into a **sandboxed iframe** (`sandbox="allow-scripts"`, `srcdoc`). Stats panel fills in: Artifact (size, graded against the ~8.6 MB ceiling a 6 MB model produces once base64-inlined on top of the 565 KB viewer), Fetch, Render, Sandbox compliant/mismatch.
  5. **Copy** the result: **Copy URL** (the `/api/artifact?…` link), **Copy raw HTML** (the full self-contained doc), or **Open in tab**; `(optional)` expand the "Paste-into-Claude snippet" (`Here's my agent for this conversation:\n<url>`).
  6. Paste the URL into a Claude.ai conversation → Claude embeds the artifact and the 3D avatar renders inline (zero external fetches, CSP-compliant). Done.
- **Decision points / branches:**
  - `agent` vs. `model` source (README); theme/idle/bg are optional refinements.
  - Size thresholds: the stat grades the inlined HTML against the ceiling a legal 6 MB model produces (`ceil(6 MiB / 3) * 4 + 565 KB`): over 70% of it = warn, over 100% = bad; the server caps the model itself at 6 MB → 413. Fetch: >2s warn, >5s bad. Render: >3s warn, >8s bad, 30s timeout.
  - Two consumption paths: paste the **URL** directly, or paste the **raw HTML** / use the `/artifact.js` `<div data-agent-id>` snippet inside an existing artifact.
- **External calls / dependencies:** `GET /api/artifact` (the bundle; answers open CORS for GET/HEAD/OPTIONS so an embedder may fetch it as well as iframe it), `GET /api/agents/public` (the picker), `/claude-artifact-csp.txt` (same-origin vendored copy of Claude's sandbox CSP). Artifact bundle inlines three.js + GLTFLoader + GLB (~565 KB viewer overhead), no runtime fetch.
- **Success state:** Live preview renders in the CSP-mirrored sandbox; stats show "compliant"; URL/HTML copied.
- **Empty / error states:** No agent ID → overlay "Enter an agent ID first." with the hint to pick a public agent on the left or paste an ID from a profile, and focus returns to the field. Network error / non-OK → error overlay with the server's `error_description`, a per-code next step (`not_found` pick a public agent or paste an ID; `no_avatar` generate one at `/create`; `invalid_request` "Agent IDs are UUIDs…"; `upstream_error` retry or use a different avatar) and a **Retry** button. Picker feed failure → note in the picker with a retry. CSP file unreachable → "Could not load /claude-artifact-csp.txt. The locked-in copy is in specs/CLAUDE_ARTIFACT.md." Sandbox mismatch → stat shows "mismatch" (bad).
- **Step count:** 6 required (+2 optional)

---

### Agent embed snippet (studio page / `<agent-3d>`): share/embed panel flow
- **Source:** the canonical studio page `/agents/<id>` (`src/avatar-page.js`, `renderEmbedPanel`) and the long-form profile `/agents/<id>/profile` (`src/agent-detail.js` + `renderEmbed` in `src/agent-detail-market.js`, the `#ad-embed-card`). Both build their snippets inline; the **Share** button on those pages opens the lighter `showSharePanel` sheet from `src/shared/share.js` (Copy link, Share on X, Share on Farcaster, Remix, OG preview image). `src/share-panel.js` (`SharePanel` class) + `src/share-panel-builders.js` (`buildEmbedUrl`, `buildIframeSnippet`, `buildWebComponentSnippet`) remain in the tree as a tested library (`tests/share-panel.test.js`), but nothing mounts them since the `agent-home-orphans` helper was deleted on 2026-08-06. Embed targets: `/agents/<id>/embed` (CSP `frame-ancestors *`; the legacy `/agent/<id>/embed` serves the same page), web component `/dist-lib/agent-3d.js`.
- **Entry point:** the **Embed** view in the studio page's action bar (`?view=embed`, alongside 3D · Chat · AR · Profile) reveals the embed panel; on the profile, `?view=embed` scrolls to and flashes the embed card (`focusEmbedSection`).
- **Prerequisites / gates:** Must be on an **existing agent** with a public GLB. No sign-in required to copy snippets; embedding is free (no wallet or on-chain deployment required). No $THREE gate. An owner who switched embedding off in the embed policy (`/api/agents/<id>/embed-policy`) hides the profile card (`data-embed-disabled`).
- **Steps (4):**
  1. Open the agent's studio page → switch to the **Embed** view (or open the profile and scroll to "Embed").
  2. Read the intro ("Drop this <agent|avatar> on any website. Use the wizard for a live preview and platform instructions.") and, `(optional)`, click **Configure in wizard ↗** → `/studio?…` in a new tab (an agent opens the Agent Chat widget type, an avatar opens the walking-avatar embed).
  3. Choose a snippet and **Copy** (button flips to "Copied ✓", reverting after ~1.8s): **Web component** (`<script type="module" src="https://three.ws/dist-lib/agent-3d.js">` + `<agent-3d src="<glb>" agent-id="…">`), **iframe** (studio page: `<iframe src="/agents/<id>?embed=1">`, the page hides its chrome in embed mode; profile card: `<iframe src="/agents/<id>/embed" width="480" height="640">`), the **page link**, or (studio page) the **Terminal** snippet that runs the avatar in any terminal with no browser or GPU (see `/docs/tty-avatar`).
  4. Paste the iframe or `<agent-3d>` snippet on any third-party site → the agent renders inline (`/agents/<id>/embed` runs `src/avatar-embed.js` / the element runtime, exposing the `v1.avatar.*` postMessage bridge). Done.
- **Decision points / branches:**
  - iframe vs. web-component snippet (the web component observes `agent-id`, `background`, `name-plate` attrs).
  - Studio page (`?embed=1`, full studio inside the frame) vs. profile card (`/agents/<id>/embed`, the chat-style embed).
  - Separate, simpler embed entry points exist: the legacy **Agent Home** page (`public/agent/index.html`, only reachable at its literal `/agent/index.html` path now that `/agent/<id>` 301s to `/agents/<id>`) mounts `src/agent-hub-actions.js`, whose "Embed" button opens `AgentEmbedModal` (`src/agent-embed-modal.js`); **Dashboard** avatar/agent "Embed" → `openAvatarEmbedModal` (`src/dashboard/dashboard.js`, `/a-embed.html?avatar=<id>` with size/bg/name presets). See variants below.
- **External calls / dependencies:** `/agents/<id>/embed` and `/agents/<id>?embed=1` (final), `/dist-lib/agent-3d.js` (web component), the agent's GLB URL, `/embed` (wizard), `/api/agents/<id>/embed-policy` (profile card gate).
- **Success state:** Snippet copied ("Copied ✓"); the pasted snippet renders the agent inline on the host page.
- **Empty / error states:** Agent without a 3D avatar → the profile card's web-component snippet reads `<!-- No 3D avatar attached yet -->`; embedding switched off by the owner → profile card hidden; a clipboard write that throws leaves the button reading "Copy" (the snippet stays selectable in its `<pre>`).
- **Step count:** 4 required (+1 optional)

#### Variant — Agent Hub embed modal (`AgentEmbedModal`)
- **Source:** `src/agent-embed-modal.js`, triggered from `src/agent-hub-actions.js` (hub "Embed" button) and `src/dashboard/dashboard.js` (`openAgentEmbedModal`).
- **Steps (4):** (1) Click "Embed" on the agent hub → modal opens (default 420×520). (2) `(optional)` adjust Width/Height. (3) Switch tab: **iframe** (`/agents/<id>/embed`), **`<agent-3d>`** (`/dist-lib/agent-3d.js` web component), **SDK** (`/embed-sdk.js` + `Agent3D.connect()` bridge example), or **walking avatar** (a live `/walk-embed` preview iframe that reloads as the options change). (4) **Copy** → paste on site. Snippets are pure-string built from `origin` + `id` + `w` + `h`; note: "Free to embed : no wallet or on-chain deployment required."
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
  1. Page boots → loads `BASE_GLB_URL` (`/avatars/default.glb`) into a `TalkScene` viewport with idle breathing/blinking; accessory presets load. In create mode a **Base switcher** offers Stylized (the default stylized humanoid body) or Parametric (`/avatars/parametric-base.glb`, a CC0 MakeHuman-derived base with ~120 identity morph sliders); Color/Layers panels adapt to the loaded base (dead slots hide).
  2. `(optional)` In **edit mode** (`?edit=<id>`) the saved appearance (colors/morphs/accessories/hidden layers) is hydrated onto the model.
  3. **Customize**: switch tabs: Color (skin/hair/outfit swatches + hex), Hats, Glasses, Earrings (accessory presets from the catalog, each tab with its own loading / error / populated state), Sculpt (morphs), Animate. On narrow viewports the tab bar collapses to icons. Each change applies live to the scene graph; an accessory is recorded in the appearance only once it is actually on the rig, and the tap that adds one shows busy feedback while the GLB fetches. `(optional)` undo/redo (history up to 50; each step is stamped so a press superseded while its accessories were still loading is dropped rather than applied late).
  4. `(optional)` Show/hide garment layers; `(optional)` search accessories.
  5. **Save** → exports the live scene via GLTFExporter (colors/morphs/accessories already baked), optimizes/validates the GLB (`avatar-studio-optimize.js`), uploads via `account.js` (`/api/avatars`), and PATCHes the appearance JSON so it stays re-editable; uploads a snapshot thumbnail.
  6. The saved avatar now appears in the avatar library used by **Widget Studio** (`/studio` step 3) and the **embed/share panels**.
  7. Continue into an embed flow: open Widget Studio, the agent SharePanel, or a dashboard embed modal to generate the snippet. Done.
- **Decision points / branches:** Create (from default) vs. Edit (`?edit=<id>`). Single-select tabs (hat/glasses) vs. multi (earrings). Save requires auth → otherwise prompts sign-in.
- **External calls / dependencies:** `/avatars/default.glb`, accessory preset assets, `/api/avatars` (save/PATCH), avatar-snapshot upload, GLTFExporter. Hands off to `/studio`, the agent studio page's Embed view (`/agents/<id>/embed`), or `/a-embed.html`.
- **Success state:** Avatar saved to account, re-editable, and selectable in the embed/Studio flows.
- **Empty / error states:** Boot failure → "Avatar Studio couldn't load. Check your connection and try again." (a model that fails to load gets the same stage error with a retry). The accessory catalog is a separate fetch from the model: while it loads the three accessory tabs show "Loading hats…" etc.; if it fails they show a retryable error ("We couldn't load the hats catalog … Colors, sculpt and animation still work, and you can save your avatar without accessories") while Color, Sculpt, Animate and Save keep working. A single accessory that fails to load → status "Couldn't load <name>: … Tap it again to retry", and it is not written into the appearance. Queued ops hand their outcome back to the caller (`runQueued` → `{ ok, error }`) instead of swallowing it; GLB validation/optimize failures surface in the save path; signed-out save routes to login. Unsaved-changes tracking via `appearanceEqual`.
- **Step count:** 7 required (+4 optional)

---

## Cross-flow notes
- **`/widget` shell** is the shared render surface: Studio + gallery previews and the `/embed.js` script-tag embed all point at `/widget#widget=<id>&kiosk=true`.
- **`embed.js`** (`public/embed.js`) is the script-tag loader: reads `data-widget` / `data-widget-url`, `data-width/height/radius/border`, `data-reveal`, `data-poster`, `data-priority`, `data-motion`, mounts a sandboxed iframe at the script position, and supports multiple embeds per page.
- **Web component `<agent-3d>`** (`/dist-lib/agent-3d.js`) is the first-class embedding primitive surfaced by SharePanel and AgentEmbedModal; it observes `agent-id`, `background`, `name-plate` attributes.
- **avatar-embed runtime** (`src/avatar-embed.js`) backs `/embed/avatar/<handle>`, `/a-embed.html`, and the agent embed; exposes the `v1.avatar.*` postMessage bridge (speak, emote, morphs, lookAt, mocap, idle, hotkeys, mic, state) plus third-party-compatible event aliases and a same-origin BroadcastChannel control surface.
