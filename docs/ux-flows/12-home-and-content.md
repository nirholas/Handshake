# Home & Content Pages

This atlas covers the landing page (`/`) in full and every content / read-only
page on three.ws. The home page is highly interactive (live 3D agents, embedded
Forge / pose / token widgets); the content pages are mostly read-only but several
carry real interactive bits (docs search, glossary filter, changelog tag filter,
status polling, copy-to-clipboard, countdown, newsletter signup, embedded 3D
viewers), all confirmed against source.

---

## Home — `/`

- **Source:**
  - Markup + inline modules: `pages/home.html` (~3800 lines; CSS extracted to `/home.css`; served via `vercel.json` `"/" → "/home.html"`)
  - Lazy-mounted widget modules: `src/home-forge.js` (+ `src/home-forge-controls.js`), `src/home-pose.js`, `src/home-live-token.js`, `src/home-bento.js`, `src/home-sniper.js`, `src/home-live-agents.js`, `src/economy-ticker.js`
  - Other lazy mounts referenced by inline scripts: `src/avatar-drop.js`, `src/walk-embed-preview.js`, `src/pump/homepage-launcher.js`, `src/api-playground.js`, `src/forge-embed-snippets.js`, `src/erc8004/qr.js`
  - Web component runtime: `<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js">` (near the top of `<head>`) + `/model-viewer-meshopt.js` (no `/embed.js` on this page)
  - Chrome: `/nav.js` + `/seasonal.js`; the footer is hardcoded inline in `home.html` (no `/footer.js` here)
- **Entry point:** Root route. No auth. The hero `<agent-3d>` and the capability/press strips render immediately (the capability strip is decorative: `aria-hidden` and unreachable by keyboard); every widget below the fold is lazy-loaded on `IntersectionObserver` to keep the initial payload light.
- **Prerequisites / gates:** None. Fully public, no wallet/login. The mini-Forge uses an anonymous device `forge:cid` handle (localStorage); no sign-up required to generate a model. **Progressive disclosure:** first-time visitors get the "lite" page (`tws-lite` class unless `localStorage['tws:tier'] === 'full'`); eight advanced sections (plus the hero "Earn" bullet) are tagged `data-tier="advanced"` and hidden behind an "advanced platform" gate section (`#advanced-gate`) that links each of them (sniper, capabilities, token economy, live economy, oracle, x402, dev platform, stack).
- **Steps (the landing flow is browse-and-branch, not linear; the "required" path is reach a CTA → click → leave to a product route):**
  1. Land on hero: headline "The 3D agent layer of the internet.", three hero bullets (the third, "Earn USDC per chat", is advanced-tier), a live `<agent-3d>` on stage, and the eyebrow link "New · Text → 3D is live…" → `/forge`.
  2. (Optional) Forge from the hero: `#hero-forge-form` is a live text-to-3D input ("describe anything…" + **"Forge it"** button + three Try chips: low-poly fox / sci-fi helmet / ceramic teapot) that types straight into the mini-Forge, which now sits directly under the hero. An "Open the full Forge →" note links `/forge`. A `<lang-switcher>` sits under the CTA row.
  3. (Optional) Trigger a hero animation chip (🎲 Random, 👋 Wave, 💃 Dance, 🤸 Capoeira, 🦘 Jump, 🧟 Thriller, 🙏 Pray); each chip drives the live agent, and a counter tracks triggers.
  4. Choose a primary CTA: **"Build your agent →"** → `/create`, **"See the embed"** → `#embed` anchor (in-page Playground), or **"▶ Take the tour"** → `/tour`. (The "Text → 3D" hero CTA is gone; that label now only appears in the closing section.)
  5. (Optional) Follow the "Start here · three steps, about five minutes" section: 01 Create a 3D avatar → `/create/prompt`, 02 Build an AI agent → `/create-agent`, 03 Publish anywhere → `#embed`, plus "Power user? Skip to the advanced platform ↓" → `#advanced-gate`.
  6. (Optional) Scroll through the page's ~25 sections, each demoing a capability with a live widget and its own CTA (see Decision points below).
  7. Click any CTA to leave for the target product route.
- **Decision points / branches (every body CTA → destination, exact labels):**
  - Hero / eyebrow: eyebrow → `/forge`; "Build your agent →" → `/create`; "See the embed" → `#embed`; "▶ Take the tour" → `/tour`; hero forge bar → in-page mini-Forge.
  - Press strip: news links → `/news/*` routes (MCP/x402 Bazaar, IBM collaboration, AWS Marketplace, Alibaba Cloud Marketplace, and one numeric X-article slug).
  - Three Doors: "Start building" → `/create`; "Read the docs" → `/docs`; "Set up monetization" → `/dashboard/monetize`.
  - What You Get cards: "Open viewer" → `/playground`; "Widget Studio" → `/widgets`; "Claim your subdomain" → `/dashboard/account`.
  - Community Forge: "Generate yours →" → `/forge`.
  - Autonomous trading (`#home-sniper`, via `src/home-sniper.js`): "Watch the arena →" → `/arena`; "Arm a strategy" → `/oracle/arm`. The engine pill is honest about solvency: a `starved` engine (no wallet can fund a trade) reads "Engine out of SOL" in the down style, and a degraded fleet shows "N/M wallets funded".
  - Pose Studio: "Pose Studio" → `/pose`; "Open this pose in the full studio →" → `/pose?…` (carries pose params).
  - Mini Forge: "open the full Forge →" → `/forge`.
  - AR: "Forge gallery"/"Generate your own model →" → `/forge`; "Open this model in AR →" → `/forge`; "Browse the avatar gallery →" → `/gallery`; "AR feature overview →" → `/features/ar`; "How AR works →" → `/blog/see-your-3d-in-ar`.
  - Capabilities Bento: "Continue in Avatar Studio →" → `/create/selfie`; a sign-language card → `/sign-language`.
  - Pump.fun token: "Explore token agents →" → `/launches`; "Trending tokens" → `/radar`; "Launch yours" → in-page launcher (`src/pump/homepage-launcher.js`).
  - Live economy: "Agent Galaxy" inline link → `/galaxy`.
  - Oracle: "Open Oracle →" / "View all conviction scores →" → `/oracle`; coin cards deep-link `/oracle/coin/<mint>`.
  - Pay-per-call: "Configure monetization →" → `/dashboard/monetize`.
  - Walk: "See walk mode →" → `/temporary` (the `/walk` route still exists but home points at `/temporary`).
  - Developer platform: "Get a key ↗"/"Get API key →" → `/dashboard/api`; "Docs" → `/docs`; "GitHub" → github.com/nirholas/three.ws; "OpenAPI" → `/openapi.json` (the routed spec; the handler is `api/openapi-json.js`); "MCP server" → `/docs/mcp`.
  - The Stack: Studio → `/studio`; Registry → `/discover`; Embed → `/docs`; Pay-per-call → `/dashboard/monetize`; Walk → `/temporary`; SDK → `/docs/sdk`.
  - Showcase 3D: "Browse all" → `/discover`; "Make your own" → `/create`.
  - Avatar Drop & Vclose: "Build your agent →" → `/create`; "Text → 3D" → `/forge`; "Read the docs" → `/docs`.
  - Footer (6 columns, inline in home.html): Product (`/create`, `/forge`, `/image-to-3d`, `/marketplace`, `/discover`, `/pricing`, `/dashboard` labeled "Console"), Explore (`/agents`, `/reputation`, `/characters`, `/gallery`, `/bazaar`), Developers (`/docs`, `/avatar-sdk`, `/dashboard/api`, `/artifact`, `/sitemap`), Integrations (`/galaxy`, `/x402`, `/aws`), Company (`/blog`, `/community`, `/support`, `/status`, X, GitHub, `mailto:support@three.ws`), Legal (`/legal/privacy`, `/legal/tos`), plus a "$THREE contract address" copy button.
- **Embedded interactive widgets (in-page, no navigation required):**
  - **Hero agent**: live `<agent-3d>` + 7 animation chips + the hero forge bar.
  - **Playground (`#embed`)**: editable embed-code textarea (HTML/React/Vue tabs), mode chips (inline/widget), background chips plus a custom color picker (`#pg-color-trigger`/`#pg-color-hex`), an avatar row (`#pg-avatars`), feature toggles (responsive/nameplate/chat/eager), live `<agent-3d>` preview, 7 animation test chips (idle/wave/dance/capoeira/jump/thriller/celebrate), copy-code button.
  - **Mini Forge (`#home-forge`, `src/home-forge.js`)**: real text-to-3D, now directly under the hero: prompt bar with typewriter suggestions (Tab to accept), example chips, POST `/api/forge` (tier `standard`, `backend: null` so the server's health-aware router picks the lane), poll `GET /api/forge?job=…`, live `<model-viewer>` result, session history rail (localStorage `forge:home:history`; a separate `forge:home:count` drives milestone nudges as the device's collection grows), result toolbar of 7 controls (auto-rotate toggle, Variation, Scene Studio → `/scene?model=…`, Embed sheet, Copy share link, GLB download, Clear), and an embed sheet (iframe/web-component snippets, size presets, copy, standalone link). Share copies a real OG-unfurling permalink `/forge/share/<creation_id>` for fresh forges, or a remix link `/?prompt=<encoded>&remix=1` for history-restored results; arriving with `?prompt=`/`&remix=1` auto-forges on load (the module boots eagerly when the URL carries a prompt). An "Options" disclosure (`src/home-forge-controls.js`) adds quality tiers (draft/standard/high, high gated behind $THREE holding), a live engine picker fed by `/api/forge?catalog` + `?health`, aspect ratio, and BYOK keys. Cancel/retry wired. Honest elapsed timer only.
  - **Pose Studio (`#home-pose`, `src/home-pose.js`)** — drag-to-orbit rig, joint sliders, preset chips, reset/snapshot/copy-link/open-studio buttons.
  - **AR (`#home-ar`)**: `<model-viewer>` with `ar` modes (webxr/scene-viewer/quick-look), desktop QR (lazy `src/erc8004/qr.js`), model cycling (fed by a top-sorted `/api/forge-gallery` fetch).
  - **Live token card (`#hlt-card`, `src/home-live-token.js`)** — real Pump.fun data; plus homepage launcher.
  - **Oracle feed**: `GET /api/oracle/feed?network=mainnet&limit=6&min_score=56`, renders top conviction coins ("Oracle is warming up…" empty state; error state renders an "Open Oracle →" button). During a database outage the endpoint answers `503` with `Retry-After` instead of a confident empty feed, so the section shows the error state rather than a dead market presented as fact.
  - **Community Forge gallery**: a live, sortable browse loop over `GET /api/forge-gallery?scope=community&…limit=24`: Fresh/Trending tabs (`sort=fresh` vs `sort=top&window=week`), a 25s background refresh that prepends genuinely-new models on Fresh (with a live chip), prompt-based dedupe, and a "Show more" button (12 shown initially, up to 24). Cards paint as poster images and upgrade to the live rotating mesh only as they near the viewport; community cards stay as posters.
  - **Showcase 3D grid**: `GET /api/explore?source=avatar&only3d=1&category=avatar,creature&limit=24&quality=high` (via `src/home-live-agents.js`), agent cards + CTA cards; each card links the item's `detailUrl` (the canonical `/avatars/<id>` detail page with chat, skills, embed and launch actions), not the bare GLB viewer.
  - **Other live agents** — What-You-Get viewer (50+ animation chips), Bento mini-agents, Vclose agent, Avatar Drop canvas, Walk preview canvas.
- **External calls / dependencies:** `POST/GET /api/forge` (+ `?catalog`/`?health` for the options panel), `GET /api/forge-gallery`, `GET /api/explore`, `GET /api/oracle/feed`; Pump.fun feed (live token card); `agent-3d` runtime + Google `model-viewer` CDN (lazy). Solana RPC indirectly via the launcher.
- **Success state:** User reaches and clicks a CTA into a product route, or completes an in-page demo (e.g. a forged model rendered with a working toolbar; an embed snippet copied).
- **Empty / error states:**
  - Mini Forge: 503/`unconfigured` → "The generator is offline right now" (with a try-again-in-a-bit tail); 429/`rate_limited` → "The forge is busy. Try again in about N seconds."; poll timeout → "Generation timed out" plus a try-a-simpler-single-subject-prompt hint; a high-tier request without the $THREE hold gets its own gate message; viewer load failure surfaced; explicit error state with **Try again** (re-runs `lastPrompt`) and **Cancel**.
  - API-fed sections (Oracle, Community Forge, Showcase) degrade gracefully if their fetch fails (sections render empty rather than break the page).
  - Reduced-motion respected throughout (typewriter, parallax, scanline disabled).
  - Clipboard blocked → fallback hidden input + `execCommand('copy')` with "Press ⌘/Ctrl-C" toast.
- **Step count:** ~3 required to leave via a CTA (land → optional browse → click) **(+ many optional)**: the page exposes ~40 distinct CTAs and ~13 self-contained interactive widgets, each an optional sub-flow.

---

## Content & Read-Only Pages

### What is three.ws — `/what-is`
- **Source:** `pages/what-is.html` (static; `<model-viewer>` v4.0.0 CDN).
- **Entry point:** `vercel.json` `/what-is → /what-is.html`.
- **Steps (4):** 1) Read hero/overview. 2) Expand/collapse FAQ accordion (4 questions: crypto, free-to-start, skills-needed, where-embed) via `.fl-faq-q` buttons. 3) Drag/orbit the embedded sample avatar (`/animations/soldier.glb`). 4) Follow a nav/CTA link (`#use-cases`, `/`, `/brain`, `/chat`, `/create`, `/create/selfie`, `/docs`, `/features`, `/forge`, `/overlay-control`, `/pay`, `/play`, `/studio`).
- **Notes:** Schema.org FAQPage + WebPage. No API calls. Interactive: FAQ accordion + 3D viewer.

### Features (index) — `/features`
- **Source:** `pages/features.html` (static + 3D widgets; `/footer-newsletter.js`).
- **Entry point:** `vercel.json` `/features → /features.html`. (Subpages `/features/*` covered elsewhere.)
- **Steps (7):** 1) Hero "Core" vs "Optional" pill nav scrolls to `#core`/`#optional`. 2) Animation showcase: ~31 pills swap a live `<model-viewer>` `src` (`/animations/*.glb`) with a "Now Playing" label. 3) Browse the **"New on three.ws"** strip (`#featNewGrid`): populated at runtime from `GET /changelog.json`, filtered to launches/feature-tagged entries, deduped, 6 newest rendered as cards (kind tag, date, title, summary) linking to the entry's page or `/changelog/<slug>`; skeletons while loading, and a fallback link to `/changelog` on fetch failure. 4) Copy embed snippet (`#embedCopyBtn` → clipboard, "Copied!" 2s). 5) Scroll-reveal cascade (IntersectionObserver). 6) Interact with multiple embedded `<model-viewer>` demos. 7) Newsletter signup (footer `data-newsletter-form` → `POST /api/newsletter/subscribe`).
- **Notes:** The only content fetch is `/changelog.json` for the newest strip; copy button + animation picker + newsletter form are the other real interactions.

### Status — `/status`
- **Source:** `pages/status.html` (dynamic).
- **Entry point:** `vercel.json` `/status → /status.html`.
- **Prerequisites / gates:** None.
- **Steps (4):** 1) On load, fetch `GET /api/status` and render service cards (status dot, uptime %, avg latency, 90-day history bar); a subsystem that publishes structured `metrics` (today the agent index) also renders metric pills beside its sentence: Solana lag, Solana agents, EVM lag, Events indexed (`subMetrics`). 2) Auto-poll every 5 min (`setInterval`, 300000 ms) updating the `aria-live` banner ("All systems operational" ↔ "X of Y services disrupted"). 3) Hover/focus a 90-day history cell for per-day tooltip. 4) Read the live build stamp: a `GET /api/version` fetch fills `#st-build` with the live commit (linked to GitHub), version, Cloud Run revision, and build time; it stays hidden if the endpoint is unreachable. A "Last check …" stamp (`#st-checked`) sits beside the cadence sentence. Footer links to the SVG status badge (`/api/status?format=svg`) and `/changelog`.
- **External calls:** `GET /api/status`, `GET /api/version`.
- **Success state:** Live service grid rendered with current operational status + "last check" timestamp.
- **Empty / error states:** Skeleton loaders on first paint; on fetch failure renders an error message with retry guidance.
- **Step count:** 1 required (page loads + auto-fetches) (+2 optional: re-poll happens automatically; hover cells).

### Glossary — `/glossary`
- **Source:** `pages/glossary.html` + `src/glossary/page.js`; term data inline in `public/glossary.js` (`window.twsGlossary.terms`, injected site-wide by `nav.js`).
- **Entry point:** `vercel.json` `/glossary → /glossary.html`.
- **Steps (4):** 1) Type in `#glos-q` search (rAF-debounced `applyFilter`, case-insensitive, filters cards). 2) Result count updates (`#glos-count` aria-live: "X terms" / "Y of X terms" / "No terms match '…'"). 3) Deep-link `#<term>` scrolls + flash-highlights a card (`highlightFromHash`). 4) Read a term card.
- **Notes:** No external API; terms are a static inline object (36 terms: usdc, sol, solana, evm, wallet, x402, pay-per-call, on-chain, mint, bonding curve, pump.fun, gas, mainnet, testnet, base, nft, ipfs, mcp, a2a, erc-8004, agent reputation, identity registry, reputation registry, validation registry, attestation, vouch, stake, sybil attack, metaplex core, agenc, trust grade, memo attestation, graduation, skills, brain, rig). page.js polls up to 6s for the injected glossary data (self-injecting `/glossary.js` if nav.js didn't).

### Support — `/support`
- **Source:** `pages/support.html` (static).
- **Entry point:** `vercel.json` `/support → /support.html`.
- **Steps (5):** 1) Read intro/channels. 2) Copy a contact email via `.copy-btn` (support, security, partnerships, privacy, legal, dmca, abuse @three.ws) → clipboard, "Copied ✓" 1600ms; clipboard-blocked fallback opens `mailto:`. 3) Open a channel card in a new tab: GitHub Issues for bugs and feature requests, or "Questions & help", which opens a question issue template (`issues/new?template=question.yml`) in the same tracker; Discussions is no longer a channel. 4) Use a `mailto:` link. 5) Hover channel cards (border/translate/arrow microinteractions).
- **Notes:** No contact form / no backend submission — email links + copy buttons only. No API.

### Events — Build 3D Agents Live — `/events/build-3d-agents-live`
- **Source:** `pages/events/build-3d-agents-live.html` (static + realtime; `/embed.js`, `/footer-newsletter.js`).
- **Entry point:** `vercel.json` `/events/([a-z0-9-]+) → /events/$1.html`.
- **Steps (5):** 1) The countdown block reflects event phase (event was 2026-06-23 18:00 MT, 60 min, online; rAF tick → days/hrs/min/sec pre-event; "LIVE NOW" during; since EVENT_END passed it now renders the post-event headline "Thanks for joining" with the sub-label "this session has aired"; no replay link exists). Past-event mode also swaps the eyebrow to "Past event · hosted by three.ws" and strips the upcoming-event i18n hooks so the translation pass cannot paint the old copy back. 2) Add to calendar (`#add-cal`/`#add-cal-2` build a Google Calendar render URL from EVENT_START/END, re-applied on every `i18n:change`); both calendar controls are hidden once the event has passed, since adding a past event is a dead path. 3) RSVP email signup (`#rsvp-form`, `data-newsletter-form` → `POST /api/newsletter/subscribe`, aria-live result); after the event the section reads "Next session" / "Hear about the next live build" and asks for an email for the next scheduled session. 4) Interact with the lazy-loaded hero `<agent-3d>` (deferred via `requestIdleCallback` → `/embed.js`). 5) Scroll-reveal sections.
- **Notes:** Schema.org Event. Countdown is local (no API); only newsletter POSTs.

### Legal hub and policy documents - `/legal`, `/legal/privacy`, `/legal/tos`, `/legal/eula`, `/legal/content-policy`, `/legal/risk`
- **Source:** `public/legal/index.html` (hub) plus one hand-authored static file per document: `privacy.html`, `tos.html`, `eula.html`, `content-policy.html`, `risk.html`, and `aws-marketplace-eula.html`.
- **Entry point:** `vercel.json` maps each with an optional trailing slash: `/legal/? → /legal/index.html`, `/legal/privacy/?`, `/legal/tos/?`, `/legal/eula/?`, `/legal/content-policy/?`, `/legal/risk/?`. `aws-marketplace-eula` has **no extensionless route**; the hub links it as `/legal/aws-marketplace-eula.html`, which resolves through the filesystem phase.
- **Steps (2):** 1) Land on the hub (h1 "Legal", three groups: Policies, Reporting something, Publishers) and pick a document. 2) Read it; follow cross-links (the documents reference each other, the hub links `/docs/news-rights`, and every page ends in `mailto:` contacts: legal@, privacy@, abuse@, dmca@, support@three.ws).
- **The six documents:**

  | Path | Effective | Shape |
  |---|---|---|
  | `/legal/privacy` | 2026-07-16, v2 | 16 h2 sections (through MCP Connectors / AI Processing, Free 3D Actions, Changes, Contact) |
  | `/legal/tos` | 2026-07-16, v2 | 20 numbered sections (through Dispute Resolution with arbitration + class-action waiver, Governing Law, Termination, Changes, Miscellaneous, Contact) |
  | `/legal/eula` | 2026-05-30, v1 | 16 numbered sections (License Grant, Restrictions, IP, Camera & Device Permissions, Customer Content, Blockchain & On-Chain Transactions, Third-Party Services, Confidentiality, warranties, liability, indemnification, term, export, governing law, entire agreement, contact) |
  | `/legal/content-policy` | 2026-06-21 | 10 numbered sections (Scope, ownership warranty, Prohibited content, Agents/personas/AI output, Tokens & financial content, Marketplace & monetisation, Embedded agents, Reporting & enforcement, Changes, Contact) |
  | `/legal/risk` | 2026-07-03 | 10 numbered sections covering every real-funds surface (agent wallets, trading, sniping, autopilot, launches, swaps, withdrawals, x402, fiat onramps) |
  | `/legal/aws-marketplace-eula.html` | static | AWS Marketplace standard EULA; reachable only from the hub |

- **Notes:** No TOC, no anchors, no API. The pages run the standard chrome (theme boot, `/nav.js`, `/footer.js`, `/i18n.js` runtime translation; most also load `/brand.js`) but every legal body is hand-authored static HTML. **`/legal/risk` is the one document wired into product flow:** section 9 documents that acceptance is versioned and recorded once per browser before a user's first real-funds action, that a material revision bumps the version and re-prompts, and that declining leaves the account usable for everything except real-funds actions. Treat that page as the human-readable spec for the acknowledgment gate, not as inert copy.

### Tutorials index — `/tutorials`
- **Source:** `pages/tutorials.html` (client-rendered from `public/tutorials-manifest.js` → `window.TUTORIALS`, 69 entries, 3 tiers).
- **Entry point:** `vercel.json` `/tutorials → /tutorials.html`.
- **Steps (4):** 1) Use hero jump-links (`.tut-jump`, 3 tiers) to scroll. 2) Browse 69 tutorial cards (Easy 21 / Middle 25 / Advanced 23), grouped with section headers. 3) Click a card → `/tutorials/<slug>`. 4) Bottom CTA: "Open docs →" → `/docs`; "Read source on GitHub" (new tab).
- **Notes:** Dynamic render from the manifest `<script>`, no fetch. Hover: translateY + accent-bar.

### Tutorial article template — `/tutorials/prompts-for-3d`, `/tutorials/generate-3d-api`
- **Source:** `pages/tutorial.html` (route `/tutorials/([a-z0-9-]+) → /tutorial.html`); content markdown in `docs/tutorials/<slug>.md` (`docs/tutorials/prompts-for-3d.md`, `docs/tutorials/generate-3d-api.md`); metadata from `public/tutorials-manifest.js`.
- **Entry point:** Slug parsed from URL via regex, metadata via `window.tutorialBySlug(slug)`.
- **Steps (5):** 1) Read hero (title/meta from manifest). 2) Hero CTA (manifest-driven, e.g. "Open the Forge"). 3) Read article: markdown fetched `GET /docs/tutorials/<slug>.md`, parsed with marked + highlight.js; per-`<pre>` **copy code** buttons ("Copy" → "Copied" 1700ms); `figure:` directives in the markdown resolve to real captured images via `/tutorial-figures.js` + `/tutorial-figures.css` (pipeline shared with the cookbook recipe viewer). 4) Use the sticky TOC (scroll-spy) and heading anchors. 5) Prev/Next pager (adjacent manifest entries); back-to-top button + top progress bar.
- **External calls:** `GET /docs/tutorials/<slug>.md`.
- **Success state:** Rendered article with working TOC, copy buttons, and pager.
- **Empty / error states:** "Tutorial not found" on an unknown slug or failed markdown fetch.
- **Step count:** 1 required (read) (+4 optional: CTA, copy, TOC nav, pager).
- **Notes:** text-to-3d & image-to-3d tutorials use this same template (covered elsewhere).

### Docs (index + all subpages) — `/docs`, `/docs/start-here`, `/docs/make-your-agent`, `/docs/share-and-embed`, `/docs/do-i-need-crypto`, `/docs/quick-start`, `/docs/agent-system`, `/docs/erc8004`, `/docs/embedding`, `/docs/web-component`, `/docs/mcp`, `/docs/skills`, `/docs/api-reference`, `/docs/sdk`, `/docs/listings` (and ~50 more)
- **Source:** Single SPA shell `docs/index.html` (served for `/docs`, `/docs/`, and `/docs/<slug>` per `vercel.json`); markdown content in `docs/*.md` and `docs/tutorials/*.md`. Marked + highlight.js via CDN.
- **Entry point:** `vercel.json` `/docs → /docs/index.html`, `/docs/([^./]+) → /docs/index.html` (the slug becomes a hash route). `currentPath()` reads `location.hash` (or `/docs/<slug>`), defaulting to `start-here`.
- **Steps (4):** 1) Land: the sidebar NAV is loaded from `GET /docs/nav.json` (currently 14 sections / ~286 links, with a designed failure state if the manifest 404s) + `start-here.md` fetched & rendered. 2) Sidebar **search** live-filters the nav by label AND surfaces a full-text results panel fed by the docs search index (with a Clear search control). 3) Click a sidebar link → hash route → `GET /docs/<slug>.md` rendered (headings get anchor IDs; internal `.md` links rewritten to hash routes; code highlighted). 4) Per-page tools: "Copy page" (markdown to clipboard), "View as Markdown" (`/docs/<slug>.md` new tab), "Open in Claude" (`claude.ai/new?q=…`); Prev/Next pager; mobile sidebar FAB/overlay; a lazy doc-freshness banner (`/doc-freshness.js`, backed by `public/docs-freshness*.json`).
- **External calls:** `GET /docs/nav.json`; `GET /docs/<slug>.md` per page (e.g. `do-i-need-crypto.md`, `quick-start.md`, `agent-system.md`, `erc8004.md`, `embedding.md`, `web-component.md`, `mcp.md`, `skills.md`, `api-reference.md`, `sdk.md`, `listings.md`, `make-your-agent.md`, `start-here.md`); marked + highlight.js CDNs.
- **Empty / error states:** Loading dots during fetch; "Page not found." on a missing slug; a designed nav-manifest failure state.
- **Notes:** Nearly all `/docs/*` slugs share this one SPA; the route is one repeated pattern: navigate (hash/sidebar/search) → fetch markdown → render, with copy-page + pager + TOC behaviors. Real steps per page = 1 required (read) +3 optional (search, copy-page, pager). **Exceptions mapped before the generic rule:** `/docs/widgets` (standalone page, below), `/docs/3d-api` → `/3d.html`, `/docs/agent-3d` → 308 → `/docs/web-component`, and the `/docs/walk*` family.

### Docs — Widgets (standalone) — `/docs/widgets`
- **Source:** `public/docs-widgets.html` (static; `vercel.json` `/docs/widgets → /docs-widgets.html`, mapped *before* the generic `/docs/*` rule).
- **Steps (4):** 1) TOC anchor nav (`#quick-start`, `#widget-types`, `#urls`, `#embedding`, `#postmessage-api`, `#og-oembed`, `#csp-cors`, `#privacy`, `#faq`). 2) Read code blocks (iframe/script/oEmbed/postMessage). 3) Review reference tables (widget types, URL schemes, hash params, postMessage events, OG/oEmbed). 4) Follow links (`/studio`, `/widgets`, `/docs/deployment`, oembed.com). The former footer `<model-viewer>` demo is gone; the page loads the model-viewer runtime but renders no demo of its own.
- **Notes:** Pure static docs, no API. Distinct from the docs SPA.

### Blog index — `/blog`
- **Source:** `blog/index.html` (static; `vercel.json` `/blog → /blog/index.html`).
- **Entry point:** `/blog`.
- **Prerequisites / gates:** None.
- **Steps (2):** 1) Scan the hardcoded list of 35 post cards (each shows title, date, informational tag). 2) Click a post → `/blog/<slug>`. (Also: RSS link `/rss/announcements.xml`; X/GitHub external links.)
- **Decision points / branches:** 35 indexed posts → individual article routes (38 post files exist; three are routable but unlinked from the index); RSS / social out.
- **External calls:** None — fully static list (no fetch, no pagination, no filter/search). Tags are display-only, not filterable.
- **Success state:** User opens an article.
- **Empty / error states:** N/A (static).
- **Step count:** 1 required (click a post) (+ optional RSS/social).

### Blog posts (38): `/blog/<slug>`
- **Source:** `blog/<slug>.html`: 38 routable static HTML files, all on **one shared template** (`.post-wrap`, `.post-meta`, `.post-tag`, shared nav/footer containers). Routed via `vercel.json` `/blog/([a-z0-9-]+) → /blog/$1.html`. One legacy slug redirects: `/blog/all-90-trades` 308s to `/blog/autonomous-trading-experiment`.
- **Slugs:** the routable set is exactly the `blog/*.html` filenames (38 today; enumerate with `ls blog/*.html`), which rots less than restating the list here. (`three-ws-alibaba-cloud-partnership`, `three-ws-play-coin-communities` and `ibm-user-group-first-in-world-meetup-recap` are routable but not linked from the index.)
- **Steps (1):** Read the article; follow the "← Blog" back link, inline links, and the occasional primary CTA (e.g. text-to-3d post → "Try Forge — type a prompt →" → `/forge`).
- **Notes:** Repeated "read article" pattern. No embedded 3D demos / share / TOC / newsletter inside the post body in the sampled pages; copy-button CSS exists in the template but the sampled posts have no code blocks. No API.
- **Source not exposed:** Several `.md` files under `blog/` (drafts and source material such as `decision-optimization-3d-ai-crypto.md`, `internets-second-species.md`, `we-are-the-provider.md`, the autonomous-trading X drafts, plus `README.md`) are NOT routed (no rule maps `.md` blog slugs) and are not in the index; source material only, not live pages.

### Changelog - `/changelog`, `/changelog/<slug>`
- **Source:** `public/changelog/index.html` (list) and `public/changelog/entry/index.html` (detail). Both are client-rendered from the generated feed; `data/changelog.json` is the authored source and `npm run build:pages` regenerates `public/changelog.json`, `public/changelog.xml`, and `CHANGELOG.md` from it.
- **Entry point:** `vercel.json` `/changelog → /changelog/index.html`, `/changelog/([^.]+) → /changelog/entry/index.html` (one shell serves every entry; the slug is read from the URL), plus `/changelog.json` and `/changelog.xml` for the feeds.
- **Prerequisites / gates:** None. Public, no auth.
- **Steps (4):** 1) Land: `GET /changelog.json`, entries grouped by date newest-first, each day headed by its formatted date and badged **new** when it is inside the 14-day `RECENT_DAYS` window. 2) Filter with the chip row (`all`, `launch`, `feature`, `improvement`, `fix`, `sdk`, `security`, `infra`, `docs`; `aria-pressed` tracks the active chip, and a `launch` entry also renders the page path it shipped). 3) Click an entry card → `/changelog/<date>-<slugified-title>`. 4) On the detail page the same feed is re-fetched and the entry matched by re-deriving that slug, then rendered with a Share row (X intent link + a copy-link button).
- **External calls:** `GET /changelog.json` (both pages).
- **Success state:** Filtered, dated list of shipped work; an entry page a holder can link to directly.
- **Empty / error states:** A filter matching nothing renders a "nothing here for this filter yet, try another one" line rather than a blank column; a failed feed fetch renders an error that links the raw `/changelog.json`; an unmatched slug renders "Entry not found." with a back link to `/changelog`.
- **Step count:** 1 required (read) (+3 optional: filter, open an entry, share).
- **Notes:** The header carries the subscribe row (`/changelog.xml` RSS, `/changelog.json`, `/llms.txt`, `/sitemap`). Delivery to the holders' Telegram channel is handled by the `changelog-push` cron off the same feed, not by this page.

### News index and articles - `/news`, `/news/<slug>`
- **Source:** `public/news/index.html` plus 112 static article files `public/news/<slug>.html`.
- **Entry point:** `vercel.json` `/news → /news/index.html`, `/news/([a-z0-9_-]+)/? → /news/$1.html`. The home page's press strip links straight into individual `/news/*` slugs, so most arrivals skip the index.
- **Steps (2):** 1) Scan the index: 112 hardcoded `post-link` cards, newest first, each with a `<time>` date, headline, summary paragraph, and a display-only tag list. 2) Click through to an article and read it; a "News" breadcrumb returns to the index, and inline links point at product routes.
- **External calls:** None. Fully static: no fetch, no pagination, no search, and the tags are not filterable.
- **Success state:** User reads the announcement and follows its product link.
- **Empty / error states:** N/A (static).
- **Step count:** 1 required (read) (+1 optional: back to the index).
- **Notes:** Slug shapes are mixed: readable slugs (`text-to-3d-is-live`, `quicknode-startup-program`) alongside numeric X-article ids (`2061713039624405062`). Enumerate with `ls public/news/*.html` rather than trusting a list here. Distinct from `/blog` (essays) and from `/markets/news` (the live market-news reader, covered in the trading walkthrough).

### Press kit - `/press`
- **Source:** `pages/press/index.html` (static; `vercel.json` `/press → /press/index.html`).
- **Entry point:** `/press`. Written for journalists: every asset is downloadable without asking permission.
- **Steps (5):** 1) Download the whole kit (`/brand/three-ws-press-kit.zip`). 2) Grab individual marks from **The marks** (`#prs-marks`): mark PNG, lockup on dark, lockup on light, stacked on dark, stacked on light, and the PWA icon SVG, each an anchor with `download`. 3) **OpenAI Partner Network** (`#prs-openai`): two announcement social cards plus a link to `/openai`. 4) **Boilerplate** (`#prs-boiler`): four copy buttons, one delegated click listener, label flips "Copy" to "Copied" for 1600 ms. 5) **Fast facts** (`#prs-facts-h`) table and **Contact** (`#prs-contact-h`), linking `/partners`, `/changelog`, GitHub, and X.
- **External calls:** None. Static assets served from `/brand/*` and `/partners/openai/*`.
- **Success state:** A writer leaves with correct marks, current boilerplate, and a contact address.
- **Empty / error states:** N/A (static). **Known gap:** the copy handler returns early when `navigator.clipboard` is unavailable, so on a blocked-clipboard browser the button silently does nothing; `/support` handles the same case with a `execCommand('copy')` fallback and a toast.
- **Step count:** 1 required (download or copy something) (+4 optional).

---

## Machine-Readable Endpoints

Agent/crawler endpoints — not user UX (0 user steps). All resolve via `vercel.json` rewrites.

| Endpoint | Route | Served by | Purpose |
|---|---|---|---|
| Sitemap | `/sitemap.xml` | `/api/sitemap` (function) | XML sitemap for crawlers (sub-sitemaps at `/sitemap/{core,agents,avatars,widgets,profiles,news}.xml`) |
| LLMs index | `/llms.txt` | `public/llms.txt` (static) | LLM site index |
| LLMs full | `/llms-full.txt` | `public/llms-full.txt` (static) | Full LLM corpus dump |
| Robots | `/robots.txt` | `public/robots.txt` (static) | Crawler directives |
| OpenAPI | `/openapi.json` | `/api/openapi-json` (function) | OpenAPI spec for the REST API (domain specs also at `/api/crypto/openapi.json`, `/api/3d/openapi.json`) |
| x402 discovery | `/.well-known/x402` | `/api/wk?name=x402` | x402 micropayment service discovery (`/.well-known/x402.json` → `name=x402-discovery`) |
| Agent attestation schemas | `/.well-known/agent-attestation-schemas` | `/api/wk?name=agent-attestation-schemas` | ERC-8004 attestation schema descriptors |
| OAuth AS metadata | `/.well-known/oauth-authorization-server` | `/api/wk?name=oauth-authorization-server` | OAuth 2.0 Authorization Server metadata |
| OAuth protected resource | `/.well-known/oauth-protected-resource` (also under `/api/mcp/`) | `/api/wk?name=oauth-protected-resource` | OAuth 2.0 Protected Resource metadata |
| Chat plugin manifest | `/.well-known/chat-plugin.json` | `/api/wk?name=chat-plugin` | AI chat-plugin manifest (the real LobeChat manifest) |
| Sperax plugin manifest | `/.well-known/sperax-plugin.json` | `/api/wk?name=sperax-plugin` | Sperax plugin manifest |
| Apple app-site association | `/.well-known/apple-app-site-association` | `/api/wk?name=apple-app-site-association` | iOS universal-link association for the App Store shell |
| Vanity metadata | `/.well-known/three-vanity.json` | `/api/wk?name=three-vanity` | Vanity-wallet discovery metadata |
| JWKS | `/.well-known/jwks.json` | `/api/auth/persona/[action]?action=jwks` | Signing keys |
| DID document | `/.well-known/did.json` | `/api/x402/did` | x402 DID document |
| Solana Actions | `/.well-known/solana/actions.json` | static | Solana Actions registry |
| Agent card (per asset) | `/a/sol/<asset>/.well-known/agent-card.json` | `/api/agents/solana/[action]?action=card` | Per-agent A2A card |

All `/.well-known/*` and `/openapi.json` / `/sitemap.xml` responses are JSON/XML for machines (agents, wallets, crawlers, OAuth/MCP clients), not rendered UI. The dynamic `/.well-known/*` family is handled centrally by `api/wk.js` (its `DISPATCH` map is the source of truth; public-discovery names get `Access-Control-Allow-Origin: *`, OAuth metadata stays origin-restricted, unknown names 404). A generic `/.well-known/(.*)` fallthrough additionally serves the static manifests in `public/.well-known/` (agent cards, `ai-plugin.json`, `mcp.json`, `security.txt`, `openapi.yaml`, and similar).
