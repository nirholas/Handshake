# three.ws — Architecture Overview

*Last updated: 2026-07-02*

---

## Platform Vision

three.ws is a full-stack AI agent platform where agents own wallets, launch tokens, trade autonomously, and inhabit 3D worlds. It competes directly with the best agent platforms, marketplaces, and creator tools in the world — Linear for developer experience, Vercel for deployment polish, Stripe for payment infrastructure — applied to the intersection of generative AI, real-time 3D, and on-chain commerce. What makes it unique: every agent is simultaneously a 3D embodied character, a Solana wallet, an MCP tool server, and a tradeable economic entity — all wired together through a real micropayment rail (x402 + USDC) that works agent-to-agent without human intervention.

---

## System Architecture Diagram

```mermaid
graph TD
    subgraph Browser["BROWSER / CLIENT"]
        MPA["150+ MPA Pages\n(Vite 7, Vanilla JS + Three.js)"]
        DASH["Dashboard SPA\n(dashboard-next, 25+ sub-pages)"]
        SDK["Embedded SDKs / Widgets\nagent-3d · walk-sdk · page-agent · tour-sdk"]
        MPA --> WebGL
        DASH --> WebGL
        SDK --> WebGL
        WebGL["Three.js WebGL Layer r184\nViewer · AnimationManager · Retargeter · MorphTargets · ARKit Lipsync"]
    end

    WebGL -->|"fetch / SSE / WebSocket"| APILayer

    subgraph APILayer["SERVERLESS-STYLE HANDLERS (api/) — served by the Cloud Run Express container"]
        Auth["Auth\nOAuth2.1 · SIWE/SIWS · Privy"]
        AgentsSvc["Agents\nMCP Main · A2A Pay"]
        AvatarsSvc["Avatars\nMarketplace · Billing"]
        ForgeSvc["Forge\nx402 · Brain/LLM"]
        WalletSvc["Wallet\nMaster · Agent hub · x402 SKUs"]
        PumpSvc["Pump.fun\nLaunches · Intel · Launch Studio"]
        OracleSvc["Oracle\nSniper · Market-maker · Strategies"]
        X402Fac["Self-hosted x402 Facilitator\n/api/x402-facilitator (Solana verify+settle)\nRing economy · Payment sessions"]
        ScreenSvc["Agent Screen\nSSE frame feed · watch-intent"]
        Lib["api/_lib/ — 500+ shared utilities\ndb.js · auth.js · redis.js · r2.js · x402-spec.js · memory-store.js · launcher-engine.js"]
    end

    APILayer --> Neon["Neon Postgres\n(primary DB)\ncitext · pg_trgm · pgcrypto\n~295 tables · JSONB embeddings"]
    APILayer --> Redis["Upstash Redis REST\n(rate limit + cache)"]
    APILayer --> R2["Cloudflare R2\nGLBs · Audio · Thumbnails · Metadata"]
    APILayer --> MCPSvc["MCP Servers — 8 remote endpoints\n/api/mcp · /api/mcp-3d\n/api/pump-fun-mcp · /api/ibm-mcp · + 4 more"]

    subgraph Workers["LONG-RUNNING WORKERS"]
        Sniper["agent-sniper (Node.js)\n+ @three-ws/agent-sniper pkg"]
        MM["agent-mm (Node.js)"]
        OrdersW["agent-orders (Node.js)"]
        OracleW["oracle (Node.js)"]
        AgoraW["agora-citizens (Cloud Run daemon)"]
        ScreenW["agent-screen-pool / -worker\nPlaywright + services/agent-screen-caster"]
        GPU["Python / FastAPI on Google Cloud Run\nHunyuan3D · TRELLIS · TripoSR · TripoSG\nunirig · rembg · text2motion (MDM) · video2scene (LingBot-Map)"]
    end

    APILayer --> Workers

    subgraph External["EXTERNAL SERVICES"]
        Blockchain["Blockchain: Solana · Base · Arbitrum · BSC · 12+ EVM chains"]
        AILLM["AI/LLM: Anthropic · OpenAI · NVIDIA NIM · IBM watsonx · Groq · DeepSeek"]
        Gen3D["3D Gen: TRELLIS · Hunyuan3D · TripoSG · Meshy · Replicate · Stability"]
        Voice["Voice: NVIDIA Magpie TTS · Riva ASR · Audio2Face-3D · ElevenLabs"]
        OnChain["On-chain: pump.fun · Jupiter · Helius · Pyth · Metaplex · SNS · EAS"]
        X402ext["x402: PayAI facilitator · Coinbase CDP · x402scan Bazaar"]
        AuthExt["Auth: Privy · GitHub OAuth · X OAuth · SAML 2.0"]
        InfraExt["Infra: GCP Cloud Run · Cloud Scheduler · Cloud CDN · AWS Lambda (Forge) · Cloudflare R2"]
        Comms["Comms: Resend (email) · Telegram Bot · PostHog · Sentry · Axiom"]
    end

    Workers --> External
    APILayer --> External
```

---

## Domain Map

### Top-Level Domains

| Domain | Primary Paths | Status | Description |
|--------|--------------|--------|-------------|
| Frontend App | `pages/` · `src/` · `public/` | active | 170+ MPA pages, dashboard SPA, public surfaces, shared `ui-juice` game-feel library |
| API Layer | `api/` | active | ~1,380 serverless-style handlers across 150+ feature dirs, served by the Cloud Run Express container |
| 3D / Avatar / Animation | `src/glb-canonicalize.js` · `src/animation-*` · SDKs | active | Full avatar pipeline, rig-agnostic retargeting, Diorama (text→scene), Scene Capture (video→point cloud) |
| MCP Layer | `api/mcp*` · `mcp-server/` · `mcp-bridge/` · `packages/*-mcp` | active/published | 8 remote + 2 npm + 32 standalone MCP servers |
| SDK Ecosystem | `sdk/` · `*-sdk/` · `packages/` | published | 60+ published npm packages |
| On-chain / Contracts | `contracts/` | active | 2 Anchor programs, 4 Solidity contracts, 12+ EVM chains |
| x402 / Payments | `api/x402*` · `api/x402-facilitator/` · `api/pay/` · `api/bazaar/` · `api/marketplace/` | active | Full micropayment + marketplace stack; **self-hosted Solana facilitator**, closed-loop ring economy, governed payment sessions |
| AI / Agent Intelligence | `api/chat.js` · `api/brain/` · `workers/` | active | Multi-provider LLM, memory, multimodal, multi-agent orchestration |
| Agora (living economy) | `workers/agora-citizens/` · `src/agora/` · `api/agora/` | active | Agent + human citizen economy, professions, Arena/Guilds, verifiable WORK supply chain |
| Agent Sniper / Trading | `packages/agent-sniper/` · `workers/agent-sniper/` · `api/sniper/` | active/published | Autonomous pump.fun sniper (package + hosted worker), Money Studio, Trading Brain |
| Agent Screen / Live | `workers/agent-screen-*` · `services/agent-screen-caster/` · `api/agent-screen*` | active | Watch agents work — headless-browser frame casting over SSE |
| Pump.fun / Token Launch | `api/pump/` · `api/launcher/` · `workers/agent-sniper/` | active | Launch, trade, community, oracle, Launch Studio (50 recipes), autonomous Memetic Launcher |
| X / Social automation | [nirholas/XActions](https://github.com/nirholas/XActions) | external | XActions X/Twitter toolkit — external repo, on npm as `xactions` (vendored copy removed 2026-07-03) |
| Backend Compute | `workers/` · `services/` · `crates/` | active | ~25 workers (Node/Python/CF), stateful WS/caster services, Rust→WASM |
| Infrastructure | `vercel.json` · `infra/` · `deploy/` | active | Vercel, GCP Cloud Run, AWS CDK; storage-pressure preflight, runtime feature flags |

---

## Repository Directory Atlas

Every top-level directory in the monorepo, what it is, and where to look. File counts are approximate working-tree totals.

### Application & Frontend

| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/` | ~1,084 | Frontend JS modules — page controllers, the 3D/avatar/animation engine, dashboard-next SPA, shared web components, world surfaces. The heart of the browser app. |
| `pages/` | ~222 | MPA HTML entry points (150+ routes) + `pages/dashboard-next/` SPA shell + `pages/ibm/`. Auto-resolved by `vite.config.js`. |
| `public/` | ~764 | Static surfaces & standalone mini-apps served as-is: `/pay`, `/bazaar`, `/discover`, `/gallery`, `/studio` (vendored Three.js editor r184), `/validation`, `/reputation`, `/login`, `.well-known/` manifests, locales, OG assets. |
| `chat/` | ~178 | `three.ws-chat` (v0.0.0) — standalone Vite chat app (embodied-avatar chat UI) with its own `server/`, `src/`, `public/`. |
| `character-studio/` | ~486 | `@m3-org/characterstudio` v0.5.0 — vendored avatar-creation Vite app (VRM-centric), its own tests + vitest config. |
| `blog/` | ~32 | Static blog posts (`.html` + `.md`): product announcements, SDK launches, deep-dives. Feeds the public content surface. |

### Backend, Workers & Services

| Directory | Files | Purpose |
|-----------|-------|---------|
| `api/` | ~1,464 | Serverless-style handlers (Node ESM) across ~125 feature subdirs + `api/_lib/` shared layer, served in production by the Cloud Run Express container. See [API Layer](#api-layer). |
| `workers/` | ~230 | Long-running Node workers (sniper, mm, orders, oracle, agora-citizens, **agent-screen-worker**, **agent-screen-pool**) + Python/FastAPI GPU workers (Hunyuan3D, TRELLIS, TripoSR/SG, UniRig, rembg, remesh, segment, stylize, texture, text2motion, **model-video2scene** (LingBot-Map video→point cloud), avatar-pipeline-controller, avatar-reconstruction, longcat). `workers/longcat/` runs LongCat-Video-Avatar-1.5 (image+audio → lip-synced MP4) — see [GPU & CPU Workers](#gpu--cpu-workers-google-cloud-run). |
| `services/` | ~11 | Standalone always-on processes that don't fit request/response or stateless-worker shapes. `services/pump-graduations/` — pump.fun graduations indexer (Dockerized, persistent connection, `carbon-source.js`). `services/agent-screen-caster/` — reusable Playwright caster library + CLI agent owners self-host to stream an agent's real browser work (see [Agent Screen](#agent-screen--live-agent-casting)). |
| `multiplayer/` | ~47 | `@three-ws/multiplayer` v0.1.0 — authoritative Colyseus server backing `/walk` (rooms, schema state, anti-cheat clamps). Cloud Run + Fly deploy configs (`Dockerfile`, `fly.toml`, `deploy-cloudrun.sh`). |

### SDKs & Packages

| Directory | Files | Purpose |
|-----------|-------|---------|
| `packages/` | ~636 | 67 published `@three-ws/*` npm packages total (30 `packages/*-mcp` + 23 non-MCP `packages/*` + 11 top-level SDK dirs + mcp-server/mcp-bridge/avatar-agent). See [SDK Ecosystem](#sdk-ecosystem) & [MCP Layer](#mcp-layer). |
| `sdk/` | ~41 | `@three-ws/sdk` — top-level agent kit (ERC-8004, chat, x402, SIWS, EAS). |
| `solana-agent-sdk/` | ~100 | `@three-ws/solana-agent` (TS) — keypair/browser/wallet-adapter providers, SPL, Jupiter, AgenC, x402-exact. |
| `agent-payments-sdk/` | ~76 | `@three-ws/agent-payments` (TS) — pump.fun agent payments, EVM/cross-chain clients, `pump_agent_payments` IDL. |
| `agent-protocol-sdk/` | ~7 | `@three-ws/agent-protocol-sdk` (TS) — on-chain A2A skill invocation (Anchor `deriveAgentPda`/`invokeSkill`). |
| `agent-ui-sdk/` | ~14 | `@three-ws/agent-ui` — Three.js GLB overlay (`createAgentUI`). |
| `avatar-sdk/` | ~14 | `@three-ws/avatar` — `<three-ws-viewer>` + `<agent-3d>` web components + AvatarCreator iframe. |
| `walk-sdk/` | ~19 | `@three-ws/walk` — walk companion + playground. |
| `page-agent-sdk/` | ~31 | `@three-ws/page-agent` — drop-in 3D page narrator. |
| `tour-sdk/` | ~23 | `@three-ws/tour` — guided product tour SDK. |
| `mcp-server/` | ~46 | `@three-ws/mcp-server` v1.2.0 — npm stdio MCP server (paid tools, Solana x402). |
| `mcp-bridge/` | ~14 | `@three-ws/mcp-bridge` v1.0.0 — x402 Bazaar bridge MCP. |
| `x402-payment-modal/` | ~36 | `@three-ws/x402-payment-modal` v1.2.0 — drop-in Phantom checkout modal. |
| `x402-modal-sdk/` | ~17 | `@three-ws/x402-modal` v0.2.0 — lighter modal variant. |
| `pump-fun-skills/` | ~75 | `@three-ws/pumpfun-skills` — pump.fun launch/trade as composable agent tools. |
| `chat-plugin/` | ~14 | `@three-ws/chat-plugin` v1.0.0 — LobeHub sidebar plugin rendering an embodied avatar (`manifest.json`, TS). |
| `apps-sdk/` | ~4 | Unversioned raw helpers: `embodiment/` + `studio-viewer/` (no `package.json` — see Known Gaps). |

### On-chain & Distribution

| Directory | Files | Purpose |
|-----------|-------|---------|
| `contracts/` | ~1,068 | Anchor Rust programs (`skill-license`, `agent-invocation`) + Solidity (ERC-8004 registries, `ThreeWSPayments`/`Factory`), IDLs, `DEPLOYMENTS.md`. |
| `crates/` | ~3 | `crates/vanity-grinder` — Rust→WASM ed25519 Solana vanity grinder (`wasm-bindgen`, `curve25519-dalek`), powers browser-side grinding. |
| `solana-mobile/` | ~22 | Packaging to publish three.ws to the Solana Mobile (Seeker/Saga) on-chain dApp Store: `src/` (MWA wallet, seeker-detect), `pwa/`, `twa/`, `publish/`, `well-known/assetlinks`. |
| `extensions/` | ~28 | `extensions/walk-avatar` — Chrome MV3 extension: walk your avatar on any site + read pages aloud. |
| `integrations/` | ~13 | First-party DCC plugins driving `/api/forge`: `blender/` (Python addon), `comfyui/` (custom nodes), `_pyclient/` (shared Python client). |
| `marketplace/` | ~11 | `marketplace/plugins/` — `three-ws-3d` & `three-ws-developer` plugin manifests for external marketplaces. |

### Assets, Tooling, Specs & Ops

| Directory | Files | Purpose |
|-----------|-------|---------|
| `scripts/` | ~416 | Build scripts (`build-animations.mjs`, `build-vercel.mjs`, `build-pages`), migrations, one-off tooling. |
| `tests/` | ~617 | Test suites (`glb-canonicalize.test.js`, animation, x402, etc.). No CI runner wired (see Known Gaps). |
| `docs/` | ~383 | ~80 `.md` guides + 24 subdirs (api, security, erc8004, agora, ux-flows, roadmap, specs, onboarding, nvidia-inception, …). Source for `llms.txt`/`ALL.md` concatenations. |
| `data/` | ~186 | `changelog.json`, `pages.json`, `skills/`, `rss/`, `erc8004-bsc-mint-ledger.json`, `_generated/`, `archives/`. Feeds the changelog/RSS/Telegram pipeline. |
| `specs/` | ~21 | Protocol specifications: `AGENT_MANIFEST.md`, `EMBED_HOST_PROTOCOL.md`, `MEMORY_SPEC.md`, `PERMISSIONS_SPEC.md`, `SKILL_SPEC.md`, `ENS_AGENT_CLAIM.md`, `x402-specification-v2.md`. |
| `examples/` | ~52 | Runnable usage examples: `agenc-task-roundtrip`, `coach-leo`, `metamask-agent-wallet`, `pump-fun-agent`, `skills/` (pump-fun, solana-wallet), bare-avatar/embed HTML demos. |
| `agents/` | ~15 | Reference agent definitions (`endpoint-shopper`, `fact-checker`, `tutor`, `unstoppable`) each with `src/` + an index gallery. |
| `animation-sources/` | ~58 | Mixamo FBX source library (120+ clips) consumed by `scripts/build-animations.mjs`. |
| `snapshots/` | ~3 | Daily visual page-snapshot record (`current/`) for pre-redesign comparison. |
| `infra/` | ~11 | AWS CDK (TypeScript) — Lambda Function URL (Forge), S3 avatar bucket, CloudWatch. |
| `deploy/` | ~12 | Cloud Run + Docker configs (`deploy/world/cloudrun.yaml` — Hyperfy `world.three.ws`; `deploy/sniper/` — hosted sniper worker). |
| `.agents/` | ~133 | `three-ws-core` Claude Code plugin + skills bundle (`.claude-plugin/plugin.json` v1.0.0) — natural-language wallet + x402 skills over the three.ws wallet API, plus bundled 3D and third-party (`okx-*`, `metamask-agent-*`) skills. Installed via the plugin marketplace. |


---

## Frontend Application

### Routing Architecture

three.ws is a **Multi-Page Application (MPA)** with no client-side router framework. Each page is an independent HTML/JS Vite entry point. Vite dev middleware handles URL rewrites that mirror the production `vercel.json` route table (served by the Cloud Run Express container in prod). There are two SPA-shell exceptions: `pages/dashboard-next/` (**35+ sub-page modules** loaded dynamically by `src/dashboard-next/shell.js`) and the **classic dashboard** `public/dashboard/*.html` (18 pages, controller `src/dashboard/dashboard.js`, reachable at e.g. `/dashboard/x402`, `/dashboard/holders`). The standalone Avatar Studio (`/avatar-studio/*`) is a separately-built React SPA (see Character Studio).

**Build:** `npm run dev` (port 3000), `npm run build` (Vite 7 MPA). HTML entry points are auto-resolved in `vite.config.js`: **~235 under `pages/` + ~150 under `public/` ≈ 300+ total** (the "170+" figure counts top-level `pages/*.html` routes only). All front-end motion is standardized on the shared `src/ui-juice.js` [game-feel library](#ui-juice--shared-game-feel-library). Three.js is `^0.184.0` (r184).

**Dev API proxy:** `/api/*` proxies to `DEV_API_PROXY` (default: `https://three.ws`).

---

### Core 3D & Agent Surfaces

| Surface | Route | HTML | JS Controller | Description |
|---------|-------|------|---------------|-------------|
| Home / Landing | `/` | `pages/home.html` | `src/app.js` (partial) | Walk companion, footer-bot, hero stage, live token ticker |
| 3D Viewer / App | `/app` (`/app-next`) | `pages/app-next.html` | `src/app-next-overlay.js` + `src/next-layout.js` | Core GLB viewer: material editor, texture inspector, scene explorer, magic brush, Runtime LLM brain, widget system, drop-zone upload. Legacy `pages/app.html` (`src/app.js`) is served at `/app-classic` |
| Agent Edit | `/agent/:id/edit`, `/agent/new` | `pages/agent-edit.html` | `src/agent-edit.js` | Full agent editor: name, description, avatar picker, skills config, wallet chips, mood engine, autopilot brain |
| Create Agent | `/create-agent` | `pages/create-agent.html` | `src/create-agent.js` | 5-step wizard: Basics → 3D Model → Skills → Personality → Review |
| Agent Detail | `/agent/:id` (301 → canonical) | `public/agent/index.html` (`src/agent-home.js`); `pages/agent-detail.html` (`src/agent-detail.js`) | `/agent/:id` 301-redirects to the canonical profile (`public/agent/index.html`). Live wallet pulse, mirror panel, strategy panel, patronage, validation badge, WebGL avatar, on-chain status, coin launch history |
| Agent Wallet Hub | `/agent/:id/wallet` | `pages/agent-wallet.html` | `src/agent-wallet-hub/index.js` | **22-tab** Solana wallet (`src/agent-wallet-hub/tabs/`): Balance, Portfolio, Deposit, Trade, Snipe, Orders, Earn, Autopilot, Intents, Signals, Pay, Vanity, Policy, Withdraw, Give, Access, Recovery, Guard, Proof, **Copilot, Pulse, Reputation** |
| Agent Mind Palace | `/agent/:id/mind` | `pages/agent-mind.html` | `src/agent-mind.js` + `src/mind-palace.js` | Visual 3D memory graph |
| Agent Studio | `/agent/:id/studio` | `pages/agent-studio.html` | `src/studio/studio-shell.js` | Tabs: Brain, Memory, Body, **Money** (Money Studio + Trading Brain), Skills |
| Agent Screen | `/agent-screen` | `pages/agent-screen.html` | `src/agent-screen.js` | Watch your own agent work live — real browser screen feed + 3D avatar. See [Agent Screen](#agent-screen--live-agent-casting) |
| Live Agents Wall | `/agents-live` | `pages/agents-live.html` | `src/agents-live.js` | Mission-control grid of all agents with active screen streams (public) |
| Deployments | `/deployments` | `pages/deployments.html` | `src/deployments.js` | Live cross-chain feed of every agent on the ERC-8004 Identity Registry |
| Marketplace | `/marketplace` | `pages/marketplace.html` | `src/marketplace.js` | Agent + skill discovery: category sidebar, search, list+detail SPA |
| @Handle Profile | `/@:handle` | `pages/handle.html` | `src/handle.js` | Public live profile with embedded avatar iframe |

---

### Dashboard (Next) — SPA Shell

**Path:** `pages/dashboard-next/*.html` + `src/dashboard-next/shell.js`

**35+ sub-page modules** loaded dynamically via `src/dashboard-next/pages/*.js` (the table below lists the primary ones; also present: **Community Avatars** `community-avatars.js`, **IRL Outfit Editor** `irl-outfit-editor.js`, **IRL Reputation** `irl-reputation.js`, plus helper modules `creator-helpers.js`, `widgets-helpers.js`):

| Sub-page | File | Description |
|----------|------|-------------|
| Home | `pages/home.js` | Agent list, revenue, activity feed |
| Agents | `pages/agents.js` | Manage owned agents |
| Avatars | `pages/avatars.js` | Avatar gallery + editor |
| Tokens | `pages/tokens.js` | Launched tokens dashboard |
| Analytics | `pages/analytics.js` | Platform analytics |
| Monetize | `pages/monetize.js` | Subscription plans, skill pricing, payouts |
| Account | `pages/account.js` | Profile, auth, wallet |
| Settings | `pages/settings.js` | Platform settings |
| Widgets | `pages/widgets.js` | Embeddable widget builder |
| Wallet Grinder | `pages/wallet-grinder.js` | Vanity address grinder UI |
| Sniper | `pages/sniper.js` | Sniper strategy config + embedded Money Studio (Strategy ↔ Money sub-tabs) |
| Capabilities | `pages/capabilities.js` | Command center for the 4 autonomous capabilities: Alpha Hunt, Coin Launcher, Creator Auto-Claim, Market Maker (Jito) |
| Systems | `pages/systems.js` | Live "Systems" health panel |
| Watch | `pages/watch.js` | Watch an owned agent work from the dashboard |
| Holders | `pages/holders.js` | $THREE holder management |
| Brain | `pages/brain.js` | LLM persona builder |
| Walk | `pages/walk.js` | Walk SDK config |
| IRL Placements | `pages/irl-placements.js` | AR placement management |
| Library | `pages/library.js` | Asset library |
| Portfolio | `pages/portfolio.js` | On-chain portfolio view |
| Transactions | `pages/transactions.js` | Transaction history |
| Copy | `pages/copy.js` | Copy trading settings |
| Creator | `pages/creator.js` | Creator dashboard |
| Referrals | `pages/referrals.js` | Referral program |
| API | `pages/api.js` | API key management |
| Developers | `pages/developers.js` | Developer docs |
| Landscape | `pages/landscape.js` | Market landscape view |
| Three-Token | `pages/three-token.js` | $THREE token stats |
| Prelaunch Radar | `pages/prelaunch-radar.js` | Pre-launch signal feed (gated) |

---

### Trading & Market Intelligence

| Surface | Route | JS Controller | Data Source |
|---------|-------|---------------|-------------|
| Oracle | `/oracle` | `src/oracle.js` | `GET /api/oracle/*` (SSE feed, wallet rep, conviction) |
| Radar | `/radar` | `src/radar.js` | `GET /api/pump/coin-intel` (SSE) |
| Watchlist | `/watchlist` | `src/watchlist.js` | `localStorage` + live market enrichment |
| Pulse (Money Pulse) | `/pulse` | `src/pulse.js` | `GET /api/pulse` (SSE) + stats view |
| Alpha Co-pilot | `/alpha-copilot` | `src/alpha-copilot.js` | `/api/agents/:id/alpha/read` → TTS → avatar lip-sync |
| Trader Profile | `/trader/:id` | `src/trader.js` | `GET /api/sniper/trader/:id` + leaderboard |
| Leaderboard | `/leaderboard` | `src/leaderboard.js` | `GET /api/sniper/leaderboard` |
| Signals Marketplace | `/signals` | `src/signals.js` | `GET /api/signals/marketplace` |
| Strategies Library | `/strategies` | `src/strategies.js` | `GET /api/strategies` |
| Swarms | `/swarms` | `src/swarms.js` | `GET /api/swarms/*` |
| Vaults | `/vaults` | `src/vaults.js` | `GET /api/vaults/*` |
| Mirror (Copy Trading) | `/mirror` | `src/mirror.js` | `GET /api/mirror/leaderboard` |
| Terminal / Mission Control | `/terminal` | `src/mission-control/index.js` | Multi-SSE fusion (intel, oracle, feed) + trade execution |
| Arena (Tournaments) | `/arena` | `src/arena/arena.js` | SSE rank stream, `GET /api/tournaments/*` |

---

### 3D World Surfaces

| Surface | Route | JS Controller | Description |
|---------|-------|---------------|-------------|
| Walk (3D Walkaround) | `/walk` | `src/walk.js` + `walk-sdk/` | WASD + joystick, Colyseus multiplayer, AR toggle, voice chat |
| Club (Pole Club) | `/club` | `src/club.js` | x402 tip-to-dance: USDC gated Three.js dance routines |
| Theater (Live Trading) | `/theater` | `src/theater.js` | Spectator: agent avatars on real on-chain events |
| Stage (Living Stages) | `/stage` | `src/stage.js` | Embodied host, spatial voice, crowd reactions, $THREE tips |
| Agora (Commons) | `/agora` | `src/agora/agora-world.js` | 3D Manhattan city, job board, passport, trust surface |
| Galaxy / Agent Galaxy | `/galaxy` | `src/galaxy.js` | 3D star-map via IBM Granite embeddings (watsonx.ai) |
| Constellation | `/constellation` | `src/constellation/main.js` | Trending Solana tokens in semantic space via PCA |
| Coin3D | `/coin3d` | `src/coin3d/main.js` | Live 3D snapshot of any pump.fun token |
| Communities | `/communities` | `src/communities.js` | Entry into coin-specific multiplayer 3D worlds |
| IRL (AR Placement) | `/irl` | `src/irl.js` + `src/irl/` | Mobile AR: GPS/marker/room anchor modes |
| City | `/city` | `src/city/city-scene.js` | OpenStreetMap Manhattan 3D substrate |
| Play (Coin World Game) | `/play` | `src/game/play-systems.js` | Full 3D game: home town, vehicles, NPC crowd, missions |
| Diorama | `/diorama` | `src/diorama/` | 3D scene composer, drag/drop placement |

---

### Creation & Generation Tools

| Surface | Route | JS Controller | Description |
|---------|-------|---------------|-------------|
| Forge | `/forge` | `src/forge.js` | Text/image/sketch → 3D via TRELLIS/TripoSG; access-gated by $THREE tier |
| Avatar Studio | `/avatar-studio` | `src/avatar-studio.js` | Build avatar from base template: sculpt morphs, colorpicker, accessories, GLTFExporter |
| Avatar Edit | `/avatars/:id/edit` | `src/avatar-edit.js` | Edit existing avatar: outfit, face sculpt, re-export GLB |
| Avatar Page | `/avatars/:id` | `src/avatar-page.js` | Public avatar showcase |
| Forge Studio | `/forge-studio` | `src/editor/launchpad-studio.js` | Full-featured launchpad/embed editor: persona interview, manifest builder, magic brush |
| Mocap Studio | `/mocap-studio` | `src/mocap-studio.js` | MediaPipe face+body mocap → GLB animation export |
| Pose Studio | `/pose` | `src/pose-studio.js` | Avatar pose capture, library, share, thumbnail |
| Voice Lab | `/voice` | `src/voice-lab.js` + `src/voice/` | Voice clone, TTS testing, lip-sync driver, LiveKit spatial voice |
| AR Experience | `/avatars/:id/ar` | `src/ar-page.js` + `src/ar/` | WebXR + ARKit Quick Look + Android Scene Viewer |
| Diorama | `/diorama` | `src/diorama/main.js` | Type a sentence → LLM "3D set designer" plan → per-object Forge → floating-island world (save/remix). See [Diorama & Scene Capture](#diorama--scene-capture) |
| Scene Capture | `/capture` | `src/capture.js` | Phone video → coloured 3D point cloud (`workers/model-video2scene`, LingBot-Map) rendered in-browser |

---

### Launches, Token & Community

| Surface | Route | JS Controller | Data Source |
|---------|-------|---------------|-------------|
| Launches Feed | `/launches` | `src/launches.js` | `GET /api/pump/launches` (60s live refresh) |
| Launch Detail | `/launches/:mint` | `src/launch-detail.js` | Price, bonding curve, holder bubblemap, oracle conviction |
| Launch Studio | `/launch-studio` | `public/launch-studio/launch-studio.js` | 50 coin-launch recipes previewed live; rewards routable to anyone. See [Launch Studio](#launch-studio--the-autonomous-coin-launcher) |
| Memetic Launcher | `/launcher` | `src/admin-launcher.js` (preview) | Design a personal autonomous coin launcher over live cultural narratives (preview; no SOL moves) |
| $THREE Token Page | `/three-token` | `src/three-token-page.js` | Live price, bonding curve chart, Jupiter swap modal |
| Autopilot | `/autopilot` | `src/autopilot.js` | Per-coin buyback/distribute policy, agent avatar narration |
| Pump Dashboard | `/pump-dashboard` | `src/launchpad/` | Pump.fun token creator dashboard |
| AGI Surface | `/agi` | `src/agi.js` | Autonomous trading agent with live decision stream |
| Reasoning Ledger | `/reasoning-ledger` | `src/reasoning-ledger.js` | Agent decision timeline with calibration chart |
| Bounties | `/bounties` | `src/bounties.js` | pump.fun GO bounty board |
| Labor Market | `/labor-market` | `src/labor-market.js` | Machine economy: bounties, jobs, on-chain escrow |
| Claim Wallet | `/claim-wallet` | `src/claim-wallet.js` | Paste Solana wallet → full pump.fun trading report, claim via SIWS |

---

### x402 & Payment Surfaces

| Surface | Route | Description |
|---------|-------|-------------|
| x402 Pay Demo | `/pay` | `public/pay/index.html` — live demo: agent pays $0.001 USDC per MCP tool call |
| x402 Bazaar | `/bazaar` | `public/bazaar.html` — discover and try paid x402 services |
| Hosted Checkout | `/pay/c/:slug` | `public/pay/c/index.html` — merchant checkout page |
| Paid Call Receipt | `/pay/calls/:tx` | Transaction receipt with Solscan link |
| Hosted Storefront | `/store/:handle` | Merchant's drag-drop customizable storefront |
| CA → x402 Converter | `/ca2x402` | Paste token CA → get live payable x402 endpoint for market intel |
| x402 Studio | `/x402/studio` | Build and test paid endpoints |
| x402 Dashboard | `/dashboard/x402` | SKU management for merchants |
| Endpoint Revenue | `/x402-revenue` | Live USDC revenue into three.ws's own paid endpoints (chart, KPIs, settlement feed) |
| Payment Sessions | `/payments` | Create budget-limited, governance-enforced x402 spend sessions (no keys) |
| Agent Economy Volume | `/agent-economy-volume` | Live total A2A economy volume (real USDC settled between agents) |
| Billing & Keys | `/billing/keys` | API keys + usage/quota |

---

### Auth, Identity & Discovery

| Surface | Route | Description |
|---------|-------|-------------|
| Login | `/login` | `public/login.html` + `src/privy-login.js` — email OTP, EVM SIWE, Solana SIWS |
| Register | `/register` | `public/register.html` |
| Discover (ERC-8004) | `/discover` | `public/discover/index.html` — ERC-8004 agent marketplace, chain filter, pagination |
| My Agents | `/my-agents` | `public/my-agents/index.html` — native + ERC-8004 on-chain agents |
| Agents Directory | `/agents` | `public/agents/index.html` — public agent directory |
| Gallery | `/gallery` | `public/gallery/index.html` — public avatar gallery |
| Studio (Scene Studio) | `/studio` | `public/studio/index.html` — vendored Three.js editor r184 |
| Validation | `/validation` | `public/validation/index.html` — GLB/GLTF validator |
| Reputation (EAS) | `/reputation` | `public/reputation/index.html` — read/write EAS attestations |
| Hydrate (ERC-8004) | `/hydrate` | `public/hydrate/index.html` — on-chain agent hydration tool |
| Vanity Wallet | `/vanity-wallet` | `public/vanity-wallet.html` — browser-side Solana vanity address grinder |
| ETH Vanity | `/eth-vanity` | `public/eth-vanity.html` — browser-side EVM vanity address grinder |
| Brain (Persona Builder) | `/brain` | `pages/brain.html` — 20+ provider LLM playground |
| IBM Suite | `/ibm/*` | `pages/ibm/` — IBM watsonx.ai integration pages |

---

### Key Shared Frontend Modules

| Module | Path | Purpose |
|--------|------|---------|
| `<agent-3d>` web component | `src/element.js` | Heavy avatar web component: chat loop, voice, lipsync, emotion |
| `<agent-stage>` element | `src/shared/agent-3d.js` | Lightweight avatar stage for embed contexts |
| Agent Wallet Chip | `src/shared/agent-wallet-chip.js` | Wallet balance/action chip, reused across surfaces |
| Money Pulse | `src/shared/money-pulse.js` | SSE-driven live wallet activity feed |
| State Kit | `src/shared/state-kit.js` | Shared reactive state primitives |
| List Controls | `src/shared/list-controls.js` | Reusable sort/filter/search controls |
| Three Access | `src/three-access.js` | $THREE token-gated feature unlock |
| Three Gate | `src/three-gate.js` | Browser-side tier pass verification |
| i18n | `src/i18n.js` | `data-i18n` DOM annotations + `/locales/*.json` catalogs |
| Notifications | `src/notifications.js` | In-app notification inbox |
| Analytics | `src/analytics.js` | PostHog integration |
| Privy Login | `src/privy-login.js` | Email OTP + EVM SIWE + Solana SIWS |

---

### Frontend Module Map — `src/` Subsystems

Beyond the page controllers above, `src/` holds ~60 subsystem directories. Map of those not detailed elsewhere:

| Module | Path | Purpose |
|--------|------|---------|
| Active Agent | `src/agents/` | Canonical "my agent" record + `agent-bus` event bus shared by every surface (with tests) |
| Loaders | `src/loaders/` | Shared `GLTFLoader` wired with Draco + KTX2 + Meshopt against locally-served decoders |
| Components | `src/components/` | Reusable UI: `ModelViewerElement`, `PriceBadge`, `animation-panel`, `bonding-curve` |
| Widget RPC | `src/widget/` | JSON-RPC 2.0 server for the in-iframe embeddable widget surface |
| Widgets | `src/widgets/` | Embeddable widget components (animation-gallery, bonding-curve, hotspot-tour) |
| Plugins | `src/plugins/` | Plugin registry — loads LobeHub/pai-chat-compatible plugin manifests |
| Skills | `src/skills/` | Skill registry + sandboxed skill execution (`sandbox-host`/`sandbox-worker`, `local-packs`) |
| Physics | `src/physics/` | `PhysicsWorld` — thin reusable wrapper over Rapier (WASM 3D) |
| Memory | `src/memory/` | Client-side memory: deterministic key derivation + AES-GCM-256 authenticated encryption |
| Auth | `src/auth/` | Email auth + WalletConnect bridge (with tests) |
| Wallet | `src/wallet/` | EVM connect button + WalletConnect provider + reconnect state |
| Permissions | `src/permissions/` | Permission grant modal, manage panel, token toolkit |
| ERC-7710 | `src/erc7710/` | MetaMask DelegationManager ABI + per-chain addresses (opt-in delegation) |
| On-chain | `src/onchain/` | CAIP-2 chain refs, deploy-button, launch-token, chain adapters |
| ETH/SNS | `src/eth/`, `src/sns/` | EVM vanity + Solana pay-by-name (Phantom/Solflare/Backpack) |
| Attestations | `src/attestations/` | glTF schema attestation builder |
| Proof of Custody | `src/proof-of-custody/` | Merkle proof builder + verifier + custody UI |
| Arweave | `src/arweave/` | Permanent ("forever") Arweave upload |
| Pinning | `src/pinning/` | Multi-provider IPFS pinning (Pinata, Filebase, web3.storage) with retry |
| Mint | `src/mint/` | Scene/asset mint flow |
| Pump | `src/pump/` | pump.fun browser widgets: agent-token-widget, bonding-curve-chart, channel-feed, coin stats, modals |
| KOL | `src/kol/` | KOL/smart-money UI: gmgn-parser, kolscan-live, leaderboard, wallet-pnl |
| Social | `src/social/` | Sentiment + X-post-impact scoring, lexicon |
| Community | `src/community/` | Coin lobby + coin-world boot + town client/auth for `/walk` coin worlds |
| Play | `src/play/` | Arena 3D trading floor (`arena-world`, `arena`) |
| Forge Studio | `src/forge-studio/` | Forge launchpad studio internals: create-prompt, dropzone, AR, embed panel |
| Scene Studio | `src/scene-studio/` | Boots the vendored three.js editor (r184) |
| Feature Tour | `src/feature-tour/` | 85-stop product tour: chapters, curriculum, director, guide avatar, free-roam |
| Embodiment | `src/embodiment/` | Emotion phrase/emoji → expression mapping |
| Glossary | `src/glossary/` | Plain-language glossary page |
| Dad | `src/dad/` | "Make Dad a 3D avatar" page controller |
| Demo | `src/demo/` | MediaPipe face-landmarker demos (os-hub, os-selfie, os-studio, triangulation) |
| Artifact | `src/artifact/` | three.ws Claude Artifact bundle entry |
| Pages | `src/pages/` | Misc surfaces: sealed wallet drops, vanity bounties |

---

## API Layer

The API layer is **~1,382 JavaScript files** across `api/`, organized as serverless-style handlers (Node.js ESM) and served in production by the Cloud Run Express container ([server/index.mjs](server/index.mjs)). All handlers share a `api/_lib/` utility layer (~505 files).

### Authentication Patterns

Requests authenticate through one of these gates:

1. **Session cookie** (`__Host-sid`, 32-byte opaque, SHA-256 at rest, 30-day rolling) — set by `api/auth/[action].js`, verified by `api/_lib/auth.js`. Wallet sign-in via SIWE (`siwe.js`) / SIWS (`siws.js`); enterprise SSO via SAML 2.0 (`saml.js` — IBM Cloud App ID, Okta, Azure AD); CSRF guard (`csrf.js`).
2. **OAuth 2.1 Bearer token** — authorization-code + PKCE + refresh + dynamic client registration (RFC 7591) via `api/oauth/[action].js` (1-hour JWT).
3. **API key** (`sk_live_`/`sk_test_`, SHA-256 hashed, shown once) — `api/api-keys/*`.
4. **x402 X-PAYMENT header** — verified by `api/_lib/x402-spec.js` via PayAI or CDP facilitator; SIWX free-tier via `siwx-server.js`/`siwx-storage.js`.
5. **Persona JWT** (cross-app "Sign in with three.ws") — 24h ES256 token issued by `api/auth/persona/*`, public keys at `/.well-known/jwks.json`, embeddable `<three-ws-signin>` (`public/persona/widget.js`). Distinct from the `/api/persona` extraction endpoints and the LLM "persona/brain" builder.
6. **CRON_SECRET Bearer** (or `x-vercel-cron`) — for `api/cron/*` scheduled jobs.

**zauth integration** (`api/_lib/zauth.js`, `docs/zauth/`): three.ws integrates the external zauth.inc agent-security suite — Vector (black-box web vuln scanner), RepoScan (x402 GitHub trust-scoring, `POST /x402/reposcan` $0.05/scan), a live x402 endpoint registry, and the `@zauthx402/sdk` provider-hub middleware.

### Core Utility Modules (`api/_lib/`)

| Module | Purpose |
|--------|---------|
| `db.js` | Neon Postgres HTTP driver, composable `sql` tagged template, NUL-byte stripping |
| `auth.js` | Session verification, SIWE, SIWS, Privy JWKS verification |
| `env.js` | Centralized environment variable access with `req()` / `opt()` guards |
| `redis.js` | Upstash Redis singleton, in-memory fallback |
| `cache.js` | Response caching layer over Redis |
| `r2.js` | Cloudflare R2 / S3-compatible blob storage via `@aws-sdk/client-s3` |
| `http.js` | Shared HTTP helpers, CORS, error responses |
| `rate-limit.js` | Per-IP and per-user rate limiting via `@upstash/ratelimit` |
| `x402-spec.js` | CDP x402 v2 payment verification + settlement |
| `x402-paid-endpoint.js` | `paidEndpoint()` factory — wraps any handler with 402 challenge |
| `x402.js` | pump.fun agent-payments 402 protocol (separate from CDP x402) |
| `agent-wallet.js` | Custodial agent keypair load/encrypt/decrypt (AES-256-GCM) |
| `memory-store.js` | Tiered memory engine (working/recall/archival; JSONB-array embeddings, cosine in JS — no pgvector) |
| `granite-guardian.js` | IBM Granite Guardian 12-risk taxonomy safety gate |
| `three-tier.js` | $THREE holder tier resolution (Genesis/Diamond/Platinum/Gold/Silver/Bronze) |
| `three-gate.js` | $THREE token balance check (Redis-cached 30s, fails open on RPC error) |
| `pump-launch.js` | Core pump.fun token launch helpers |
| `forge-tiers.js` | 3D generation backend selector by tier |
| `agent-identity.js` | Agent identity resolution + ERC-8004 registry |
| `marketplace-platform-fee.js` | Fee split calculations (MARKETPLACE_PLATFORM_FEE_BPS, default 0) |

---

### API Endpoints by Feature Area

#### Authentication & Identity (`api/auth/`, `api/oauth/`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/[action]` | GET/POST | login, register, logout, me, profile, forgot-password, reset-password, verify-email |
| `/api/auth/siwe` | POST | Ethereum Sign-In-With-Ethereum |
| `/api/auth/siws` | POST | Solana Sign-In-With-Solana |
| `/api/auth/saml/*` | GET/POST | SAML 2.0 SSO (IBM Cloud App ID, Okta, Azure AD) |
| `/api/oauth/[action]` | GET/POST | authorize, token (code + PKCE + refresh), dynamic client registration (RFC 7591), revoke, introspect |

**DB tables:** `users`, `sessions`, `password_resets`, `email_verifications`, `oauth_clients`, `oauth_refresh_tokens`

#### Agents (`api/agents.js`, `api/agents/[id].js`, `api/agents/*`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents` | GET/POST | List agents, create agent |
| `/api/agents/:id` | GET/PUT/DELETE | Agent CRUD |
| `/api/agents/:id/wallet` | GET | Solana wallet address + balance |
| `/api/agents/:id/trade` | POST | Guarded trade execution from agent wallet |
| `/api/agents/:id/autopilot` | GET/POST | Per-agent autopilot policy config |
| `/api/agents/:id/memory` | GET/POST/DELETE | Agent memory CRUD |
| `/api/agents/:id/brain` | GET/PUT | Persona + LLM config |
| `/api/agents/:id/voice` · `/api/agents/:id/voice/clone` | GET/PUT · POST | Voice status/assign/tune; ElevenLabs voice clone (POST `/voice/clone`) |
| `/api/agents/:id/embed` | GET | Embedding vector (NIM or VoyageAI) |
| `/api/agents/:id/strategies` | GET/POST | Agent strategy management |
| `/api/agents/:id/sns` | POST | Mint `*.threews.sol` subdomain |
| `/api/agents/a2a-mandate` | POST | Issue JWS A2A mandate (user consent) |
| `/api/agents/a2a-call` | POST | Execute mandate-authorized autonomous USDC payment |
| `/api/agents/a2a-hire` | POST | Post task to labor market |
| `/api/agents/a2a-paid` | POST | Invoice verification |

#### MCP Servers (`api/mcp.js`, `api/mcp-3d.js`, `api/mcp-studio.js`, `api/mcp-agent.js`, `api/mcp-bazaar.js`, `api/ibm-mcp.js`, `api/pump-fun-mcp.js`, `api/chat/mcp.js`)

See [MCP Layer](#mcp-layer) section for full tool listings.

#### 3D Forge (`api/forge.js`, `api/forge-*.js`)

| Endpoint | Description |
|----------|-------------|
| `POST /api/forge` | Text/image/sketch → 3D; selects backend by tier (Meshy/Tripo/Replicate/GCP/HuggingFace/NVIDIA NIM) |
| `GET /api/forge/:jobId` | Poll job status |
| `POST /api/forge-rembg` | Background removal |
| `POST /api/forge-remesh` | Remesh geometry |
| `POST /api/forge-segment` | Mesh segmentation |
| `POST /api/forge-stylize` | Style transfer |
| `POST /api/forge-enhance` | Quality enhancement |
| `GET /api/forge-gallery` | Public forge creations |

**3D generation backends:** TRELLIS · TripoSG · Tripo3D · Meshy · Rodin · Replicate · GCP Vertex · HuggingFace · NVIDIA NIM

#### Pump.fun (`api/pump/[action].js`)

40+ actions dispatched via a single `[action].js` handler:

| Action Group | Actions |
|-------------|---------|
| Launch | `launch-prep`, `launch-confirm`, `launch-agent` (server-signed) |
| Trading | `buy`, `sell`, `quote`, `portfolio`, `balances` |
| Fee Sharing | `fee-sharing-create`, `fee-sharing-update`, `fee-sharing-collect`, `fee-sharing-distribute` |
| Market Data | `trending`, `smart-money`, `coin-intel` (SSE), `live-stream` (SSE), `by-agent` |
| Governance | `governance`, `strategy-backtest`, `strategy-run`, `strategy-validate` |
| Autopilot | `autopilot`, `run-buyback`, `run-distribute-payments` |
| Safety | `safety` (honeypot detection), `withdraw` |

#### x402 Paid Endpoints (`api/x402/*`)

**34 files** in `api/x402/`, each a paid endpoint built on `paidEndpoint()`. Payable on Base USDC, Solana USDC, and (for `model-check`/`mint-to-mesh`) Arbitrum One USDC; discoverable via `/.well-known/x402.json` + `/openapi.json`. Additional priced endpoints beyond the table: `model-check` ($0.001), `mint-to-mesh-batch` ($0.05), `symbol-availability` ($0.001), `permit2-paid-demo` ($0.001, Base gas-sponsored EIP-2612), `onchain-identity-verify` ($0.005), `agent-reputation` ($0.01), `pump-agent-audit` ($0.02). Sample paid MCP-tool prices: `render_avatar` $0.005, `text_to_3d`/`image_to_3d` $0.15, `mesh_forge` $0.25, `forge_avatar` $0.45, `ibm_granite_forecast` $0.05.

Representative endpoints:

| Endpoint | Price | Description |
|----------|-------|-------------|
| `pump-launch.js` | $5.00 USDC | Anonymous token launch |
| `skill-marketplace.js` | $0.001 USDC | Skill marketplace query |
| `skill-call.js` | variable | Per-call skill billing to author wallet |
| `token-intel.js` | $0.01 USDC | Token market intelligence (aixbt bridge) |
| `asset-download.js` | variable | Creator USDC payout download |
| `dance-tip.js` | variable | Club tip-to-dance trigger |
| `animation-download.js` | variable | Animation clip download |
| `fact-check.js` | $0.001 USDC | AI fact checking |
| `vanity.js` | variable | Hosted vanity address grinding |
| `tutor.js` | variable | AI tutoring session |
| `agent-bouncer.js` | variable | Agent access control |
| `onchain-identity-verify.js` | variable | On-chain identity verification |
| `mint-to-mesh.js` | variable | Token CA → themed 3D mesh |
| `crypto-intel.js` | $0.01 USDC | Crypto market intelligence |
| `forge.js` | tier-based | 3D generation (Forge x402 lane) |

#### x402 Infrastructure (`api/x402-*`)

| Endpoint | Description |
|----------|-------------|
| `POST /api/x402-pay` | Server-side x402 payer (internal + external); SSE lifecycle stream |
| `GET/POST /api/x402-checkout` | Drop-in modal: `prepare` (unsigned Solana tx) + `encode` (sign → X-PAYMENT header) |
| `POST /api/x402-checkout-record` | Analytics recording for completed checkouts |
| `GET/PUT /api/x402-merchant` | Merchant console: payout wallets, CORS, spend caps, API keys, storefront |
| `GET/POST/PUT/DELETE /api/x402-skus` | SKU management: slug → target endpoint + branding + stats |
| `GET /api/x402-status` | Health probe: facilitators, SIWX table, supported networks |

#### Bazaar (`api/bazaar/*`)

| Endpoint | Description |
|----------|-------------|
| `GET /api/bazaar/list` | Paginated catalog from PayAI + CDP facilitators |
| `GET /api/bazaar/search` | Ranked text search across bazaar |
| `GET /api/bazaar/providers` | Per-host reputation cards |
| `GET /api/bazaar/arbitrage` | Cross-venue price disparity |
| `GET /api/bazaar/context` | Contextual service suggestions |

#### Wallet Management (`api/user/wallet/*`, `api/wallet/`)

| Endpoint | Description |
|----------|-------------|
| `GET/POST /api/user/wallet` | Platform-custodied EVM + Solana wallet: addresses + balances |
| `POST /api/user/wallet/fund-agent` | Transfer USDC/SOL to agent wallets |
| `GET /api/user/wallet/history` | On-chain Solana transaction history |
| `POST /api/user/wallet/send` | USDC/SOL to any address |

**Encryption:** AES-256-GCM for custodial keypair at rest (`WALLET_ENCRYPTION_KEY`, falls back to `JWT_SECRET` with warning if unset).

#### Brain / LLM (`api/brain/chat.js`, `api/chat.js`, `api/llm/anthropic.js`)

| Endpoint | Description |
|----------|-------------|
| `POST /api/brain/chat` | Multi-provider LLM playground (20+ models, SSE streaming) |
| `POST /api/chat` | Avatar chat endpoint: memory recall, tool dispatch, Guardian governance |
| `POST /api/llm/anthropic` | We-pay proxy for Anthropic Claude (embed contexts, free tier) |

**Provider failover in `/api/chat`:** Groq → OpenRouter → NVIDIA NIM → Anthropic → OpenAI → watsonx/Orchestrate

#### Voice & Multimodal (`api/tts/`, `api/asr.js`, `api/a2f.js`, `api/vision.js`)

| Endpoint | Backend | Description |
|----------|---------|-------------|
| `POST /api/tts/speak` | NVIDIA Magpie (primary), OpenAI TTS (backstop) | Text → speech |
| `POST /api/asr` | NVIDIA Riva (gRPC) | Speech → text |
| `POST /api/a2f` | NVIDIA Audio2Face-3D (gRPC) | Audio → ARKit 52 blendshapes |
| `POST /api/vision` | NVIDIA NIM VLM → OpenAI gpt-5.4-nano (backstop) | Image understanding |
| `POST /api/cosmos` | NVIDIA Cosmos | Text → world video (MP4, async) |

#### Memory (`api/agent-memory.js`, `api/memory/*`)

| Endpoint | Description |
|----------|-------------|
| `GET/POST/DELETE /api/agent-memory` | Agent memory CRUD; ERC-191 signed writes |
| `POST /api/memory/search` | Semantic + lexical search over `agent_memories` (JSONB embeddings, cosine computed in JS) |
| `GET /api/memory/context` | Working-tier token-budgeted context assembly |
| `POST /api/memory/curate` | Memory curation |
| `GET /api/memory/graph` | Entity knowledge graph (Zep/Graphiti-style temporal KG) |

#### Marketplace (`api/marketplace/[action].js`)

| Action | Description |
|--------|-------------|
| `agents` | List/search marketplace agents |
| `create` / `publish` | Create and publish agent |
| `fork` | Fork an existing agent |
| `purchase` | Buy agent/skill via Solana Pay |
| `purchase-as-agent` | Autonomous agent-to-agent purchase |
| `purchase-bundle` | Bundle purchase |
| `set-skill-price` | Revenue split pricing CRUD |
| `check-skill-access` | License verification |
| `start-trial` | Trial period initiation |
| `buy-asset` | Buy avatars/agents/plugins |
| `reviews` | Read/write reviews |
| `analytics` | Skill revenue analytics |

#### Cron Jobs (`api/cron/`) — 42 handler files, 72 schedules

`api/cron/` holds **32 `.js` files** (31 named crons + a dynamic `[name].js` dispatcher), wired by **~80 `crons` entries** in `vercel.json` and run on Google Cloud Scheduler (cron auth = `Bearer $CRON_SECRET`). Beyond the representative table below, undocumented-but-live crons include the four fanout workers (`copy-fanout`, `mirror-fanout`, `signal-fanout`, `strategy-fanout`), `run-dca`, `run-subscriptions`, `run-buyback`/`run-distribute-payments`, `treasury-autopilot`, `process-withdrawals`, `solana-attestations-crawl`, `trader-score-attest`, `custody-attest`, `auto-rig-sweep`, `dead-man-switch`, `relayer-balance-check`, `reconcile-decisions`, `smart-money-graph`, `index-delegations`, `cleanup-csrf-tokens`, `siwx-gc`, `expire-pending-purchases`, `irl-reap`/`irl-drops-refund`, `run-x-scheduled-posts`, `unstoppable-tick`.

| Cron | Schedule | Description |
|------|----------|-------------|
| `oracle-score` | frequent | LLM coin scoring + conviction updates |
| `oracle-digest` | daily | Oracle summary generation |
| `pulse-tick` | per-minute | Platform activity aggregation |
| `three-holders-snapshot` | daily | $THREE holder leaderboard snapshot via Helius |
| `rewards-distribute` | weekly | Batch SPL rewards to $THREE holders |
| `smart-money-rollup` | hourly | Cross-reference graduations → wallet track records |
| `signal-fanout` | frequent | Signal marketplace delivery |
| `copy-fanout` | frequent | Copy trading order replication |
| `mirror-fanout` | frequent | Mirror trading order replication |
| `strategy-fanout` | frequent | Strategy execution loop |
| `reflect-sweep` | daily | LLM reflection synthesis for agents |
| `intel-learn` | frequent | Coin intel classifier learning pass |
| `gmgn-seed` | hourly | GMGN smart-money data seeding |
| `radar-watchlist` | frequent | Pre-launch radar watchlist update |
| `recompute-reputation` | daily | Wallet reputation recalculation (file is `recompute-reputation.js`, not `reputation-recompute`) |
| `avaturn-seed-cron` | daily | Avaturn avatar seeding |
| `forge-seed-cron` / `forge-smoke` | daily | Forge gallery seeding + smoke test |
| `wallet-intents` | frequent | Agent wallet intent execution |
| `quota-check` | hourly | Upstash Redis quota monitoring |
| `uptime-check` | frequent | Platform endpoint health check |
| `world-health` | frequent | Multiplayer world health check |
| `flush-usage-events` | frequent | Usage event batch flush to billing |

---

### API Surface Index — Additional Endpoint Groups

Beyond the feature areas above, the `api/` tree exposes many more surfaces. Complete index of the remaining subdirectories:

#### Agent Economy, Social & Genetics

| Endpoint Group | Files | Description |
|----------------|-------|-------------|
| `/api/agent-economy/*` | `status`, `transact` | Two-agent demo economy: balances + autonomous transact loop |
| `/api/agent-trade/*` | `demo` (SSE), `skill` | SSE orchestrator for a live agent-to-agent trade demo + tradeable skill |
| `/api/genome/*` | `breed`, `stud`, `lineage`, `edges`, `preview` | Agent "genome" breeding: on-chain breeding tx, stud market, lineage graph |
| `/api/crews/[tag]` | `index`, `[tag]` | Agent crews/guilds by tag |
| `/api/friends/*` | `index`, `messages`, `presence-ticket`, `search` | Agent/user social graph: presence, DMs, search |
| `/api/community/*` | `capabilities`, `holder-pass`, `world-gate`, `worlds`, `ws-ticket`, `messages`, `me`, `auth/`, `wallet/` | Coin-world community layer: holder-pass gating, world entry tickets, chat |
| `/api/social/*` | `sentiment`, `sentiment-pulse` | Cashtag/social sentiment scoring |
| `/api/x/*` | `post`, `draft`, `schedule`, `analytics`, `reviews`, `status`, `triggers` | X (Twitter) posting + scheduling + engagement analytics |
| `/api/share/x`, `/api/frames/walk`, `/api/traders/preview`, `/api/trades/feed` | — | Social share-card + Farcaster-frame + OG preview renderers |

#### Money, Custody, Credits & Monetization

| Endpoint Group | Files | Description |
|----------------|-------|-------------|
| `/api/payments/*` | `intent`, `purchase-skill`, `evm/`, `solana/`, `_config` | Unified payment intents (EVM + Solana lanes) |
| `/api/credits/*` | `deposit`, `index` | Platform credits: verify on-chain SOL/$THREE deposit → credit balance |
| `/api/monetization/*` | `prices`, `revenue`, `wallet`, `withdrawals` | Per-agent price config, revenue, payout wallet, withdrawals |
| `/api/custody/*` | `anchor`, `integrity` | Proof-of-custody public epoch anchors + integrity checks |
| `/api/ledger/[agentId]` | `[agentId]`, `verify/` | Reasoning Ledger: explainable agent-decision timeline |
| `/api/onramp/link`, `/api/usage/summary` | — | Fiat on-ramp link, per-user usage summary |
| `/api/token/[action]` | `[action]` | $THREE on-chain token HTTP layer (price/balance/burn surface) |
| `/api/cz/claim`, `/api/cosmetics/*` | `catalog`, `owned`, `earnings`, `leaderboard`, `split` | Cosmetics catalog + creator revenue split + ownership |

#### Creators, Developers & Distribution

| Endpoint Group | Files | Description |
|----------------|-------|-------------|
| `/api/creators/*` | `[id]`, `skill-analytics` | Public creator profile + skill revenue analytics |
| `/api/developer/*` | `mcp-test`, `usage`, `webhooks/` | Developer console: MCP self-test, usage, webhook config |
| `/api/api-keys/*`, `/api/keys/*`, `/api/registry/resolve` | — | API key issuance/rotation, key store, universal entity resolver |
| `/api/v1/*` | `index`, `_catalog`, `_providers`, `agents/`, `market/`, `x/`, `sentiment` | Unified public `/api/v1` REST facade (single source of truth) |
| `/api/lobehub/[action]`, `/api/aws-marketplace/*` | — | LobeHub iframe embed + AWS Marketplace SaaS resolve/meter/entitlement |
| `/api/referral/visit`, `/api/onboarding/[action]` | — | Referral funnel tracking + consolidated onboarding (avaturn-session, link-avatar) |

#### Assets, Rendering & Permanence

| Endpoint Group | Files | Description |
|----------------|-------|-------------|
| `/api/actions/avatar*` | `avatar`, `avatar-icon` | Headless-chromium posed-avatar GLB → PNG renderer |
| `/api/render/*` | `avatar-clip`, `glb` | Public posed + camera-orbited avatar clip/GLB renderer |
| `/api/assets/index`, `/api/studio-assets/*` | — | Public asset library catalog + studio asset store |
| `/api/nft/*` | `mint-scene`, `mint-scene-confirm`, `resolve` | Scene-as-NFT minting + resolution |
| `/api/forever/*` | `inscribe`, `status` | Permanent inscription (Arweave/on-chain permanence) |
| `/api/pinning/[action]`, `/api/dad/generate` | — | IPFS/Pinata pinning + "dad" (Replicate/GCP) generation envelope |

#### LLM, Inference & AI Providers

| Endpoint Group | Files | Description |
|----------------|-------|-------------|
| `/api/inference/livepeer` | `livepeer` | Livepeer AI gateway side-by-side LLM comparison |
| `/api/watsonx/embed`, `/api/aixbt/*` | `chat`, `intel`, `grounding`, `projects`, `_shared` | IBM Granite embeddings + aixbt crypto-narrative intelligence bridge |
| `/api/persona/*` | `extract`, `preview` | Persona extraction + preview from source material |
| `/api/_providers/*` | — | Provider routing internals shared across LLM endpoints |

#### Platform Ops, Feeds & Webhooks

| Endpoint Group | Files | Description |
|----------------|-------|-------------|
| `/api/webhooks/*` | `replicate`, `solana-pay` | Replicate prediction + Solana Pay webhook receivers |
| `/api/push/subscribe`, `/api/rss/announcements`, `/api/sitemap/[type]` | — | Web Push registry, RSS 2.0 announcements feed, per-entity sub-sitemaps |
| `/api/og/*` | `agent`, `sealed-drop`, `three-token-badge` | Dynamic Open Graph image renderers |
| `/api/seed/*`, `/api/demo/*`, `/api/tx/*`, `/api/sdp/*`, `/api/rider/*` | — | Seed/fixtures, public demo economy, raw-tx helpers, WebRTC SDP relay, "rider" Firebase webhook bridge |
| `/api/pump-bounties/*` | `[id]`, `stats` | pump.fun GO bounty board + submission stats |
| `/api/trading/scan`, `/api/three-token/*`, `/api/three/*` | — | Candidate-trade scanner (RPC-budgeted) + $THREE tier/price surfaces |

#### Autonomous Trading, Vaults & Labor

| Endpoint Group | Files | Description |
|----------------|-------|-------------|
| `/api/oracle/*` (23) | `feed`, `stream` (SSE), `action-stream` (SSE), `trades` (SSE), `leaderboard`, `movers`, `wins`, `backtest`, `follow`, `watch`, `signal`, `agent-stats`, `categories`, `coin`, `wallet`, `og`, … | Full oracle product API: social follow/leaderboard, backtesting, watch arming, movers/wins |
| `/api/sniper/*` (11) | `radar`, `radar-stream` (SSE), `stream` (SSE), `compile`, `strategy`, `backtest`, `close`, `trader`, `leaderboard`, `history`, `status` | Autonomous sniping engine + strategy compiler + pre-launch radar (backed by `api/_lib/sniper/`) |
| `/api/vaults/*` (7) | `index`, `[id]`, `deposit`, `redeem`, `trade`, `claim-fees`, `ledger` | Tokenized agent vaults: deposit/redeem/Jupiter-trade (`api/_lib/vault-*.js` — 10 modules) |
| `/api/labor/*` (10) | `post`, `bid`, `award`, `deliver`, `settle`, `bounty`, `feed`, `agent`, `policy`, `tick` | Agent labor market: escrow/matching/settlement (`api/_lib/labor-{escrow,match,settle,economics,auth}.js`); tables `agent_jobs`/`agent_bids`/`agent_bounties`/`agent_labor_policies` |
| `/api/swarms/*`, `/api/signals/*` (6), `/api/copy/*` (5), `/api/mirror/*` | — | Multi-agent swarms (CRUD + SSE), signal marketplace (incl. SSE), copy/mirror trading |

#### Embeds, Walk, IRL, Users & Admin

| Endpoint Group | Files | Description |
|----------------|-------|-------------|
| `/api/widgets/*` (16) | `[id]/chat`, `[id]/knowledge`, `knowledge-process`, `transcripts`, `stats`, `duplicate`, `oembed`, `og`, `page`, `view`, `index` | Embeddable RAG chat-widget product with knowledge ingestion (`api/_lib/widget-types.js`) |
| `/api/walk/*` (6) | `pilot`, `session`, `control/[action]`, `metrics`, `analytics`, `leaderboard` | Walk Avatar browser-piloting: LLM "brain" pilots web pages from Chrome-extension DOM snapshots (`auth/extension-token.js`) |
| `/api/irl/*` (10) | `pins`, `drops`, `interactions`, `interactions-stream` (SSE), `presence-proofs`, `world-lines`, … | Geolocated agent presence/drops/pins; tables `irl_pins`/`irl_drops`/`irl_interactions`/`irl_presence_proofs`/`irl_world_lines` |
| `/api/users/*` (16) vs `/api/user/*` (5) | — | Two namespaces: `users/` = public profiles/follows/referrals/earnings; `user/` = account wallet/settings |
| `/api/admin/*` (11) | `[resource]`, `bulk-launch`, `register-agents`, `revenue`, `withdrawals/[id]`, `user/[id]`, `redis-health`, `pump-cron-health`, `rider-passes`, `news/[action]` | Admin/ops console backend (admin auth gate, `api/_lib/admin.js`) |
| `/api/rider/*`, `/api/play/*`, `/api/seed/*`, `/api/club/*` (incl. `tips-stream` SSE), `/api/tournaments/*`, `/api/clash/*` | — | Rider passes / play-pass / fixtures-seed / 3D-club tips / tournament + Coin Clash game surfaces |

> Internal MCP handler implementations live in `api/_mcp`, `api/_mcp3d`, `api/_mcpagent`, `api/_mcpbazaar`, `api/_mcpibm`, `api/_mcp-studio`, `api/_studio` — see [MCP Layer](#mcp-layer).

---

## 3D & Avatar System

### Animation Pipeline (Build Time)

```mermaid
flowchart TD
    A["animation-sources/\n(Mixamo FBX source library, 120+ clips)"]
    B["scripts/build-animations.mjs\nreads: scripts/animations.config.json (121 entries)\nretargets: FBX/GLB → canonical Avaturn skeleton (cz.glb)\ntrims clips, applies uprightFix where configured\nemits: AnimationClip.toJSON() per clip"]
    C["public/animations/clips/*.json\n(~102 JSON files; 100 manifested)"]
    D["public/animations/manifest.json\n(clip catalog, ~100 entries)"]
    A --> B --> C
    B --> D
```

### Bone Canonicalization (`src/glb-canonicalize.js`)

The rig-agnostic bone canonicalizer rewrites any humanoid GLB's joint names to the canonical Avaturn bone set. Supported conventions:

| Convention | Bone Name Examples |
|-----------|-------------------|
| Mixamo | `mixamorigHips`, `mixamorigSpine` |
| Blender / Rigify | `DEF-spine`, `DEF-upper_arm.L` |
| CharacterStudio | `Bip01_Pelvis`, `Bip01_L_UpperArm` |
| HumanIK | `Reference`, `LeftUpLeg` |
| Unreal Engine | `root`, `pelvis`, `upperarm_l` |
| VRM 0.x / VRoid | `J_Bip_C_Hips`, `J_Bip_L_UpperArm` |
| VRM 1.0 | `hips`, `leftUpperArm` (camelCase) |
| Daz / Genesis | `hip`, `lCollar`, `lShldr` |
| MakeHuman | `upperleg01.L`, `clavicle_l` |
| Reallusion CC3/CC4 | `CC_Base_Hip`, `CC_Base_L_Upperarm` |
| 3ds Max Biped | `Bip001 Pelvis`, `Bip001 L UpperArm` |
| Generic snake/kebab | `left_upper_arm`, `left-upper-arm` |

Also folds Mixamo +90°X armature orientation correction.

### Animation Retargeter (`src/animation-retarget.js`)

Runtime world-delta-preserving retargeter. Three entry points:

| Function | Input | Description |
|----------|-------|-------------|
| `retargetClipToRig(clip, rig)` | `GltfRig` | Primary path for GLB skeletons |
| `retargetClipToObject(clip, object3D)` | `Object3D` graph | Walk SDK path |
| `retargetClip(clip, map, corrections)` | Low-level | Custom pipeline |

**Algorithm:** Builds canonical→node maps, computes bind corrections `L = Rt · WT⁻¹ · WS · Rs⁻¹`, corrects root motion for rig axis, scales hip translation for rig height.

### AnimationManager (`src/animation-manager.js`)

Central animation controller managing the full lifecycle:

- Loads/caches canonical JSON clips
- Retargets on `attach()` (lazy, concurrency=4)
- Crossfades between states
- Plays one-shots via `playOnce()` with settle
- Additive overlay for gesture-over-locomotion
- Fallen-pose guard (Hips tilt ≥45° off vertical)
- `supportsCanonicalClips()` gate — non-humanoid rigs fall back to default rig, never T-pose

### Animation State Machine (`src/animation-state-machine.js`)

Pure directed graph (no Three.js dependency, unit-testable):

```mermaid
stateDiagram-v2
    idle --> talk
    talk --> idle
    talk --> walk
    walk --> talk
    idle --> react
    react --> idle
    talk --> listen
    listen --> talk
    listen --> think
    think --> listen
    react --> emote
    emote --> react
```

Driven by protocol events, delivers transitions via `onTransition` callback.

### Procedural Idle (`src/idle-animation.js`)

Four additive ambient channels:
- **Breathing:** spine micro-rotation (sinusoidal)
- **Saccades:** head yaw/pitch spring simulation
- **Blink:** morph target animation
- **Weight shift:** hip drift

Per-avatar seeded PRNG prevents multiple avatars from syncing.

### Lipsync Systems

**Audio-driven** (`src/voice/lipsync-driver.js`):
```mermaid
flowchart LR
    A["Web Audio\nAnalyserNode"] --> B["RMS/band energy"] --> C["open/wide/round\nmouth shapes"] --> D["morphTargetInfluences"]
```

**Text-to-viseme heuristic** (`src/runtime/lipsync.js`, `page-agent-sdk/src/lipsync.js`):
```mermaid
flowchart LR
    A["character"] --> B["ARKit viseme map"] --> C["80ms/phoneme timeline"] --> D["per-frame morph lerp"]
```

### ARKit 52 Blendshape System (`src/voice/arkit-blendshapes.js`)

Full 52-blendshape ARKit vocabulary with cross-format mapping. Falls back to jaw-only, then body-animation-only if morph targets absent.

### 3D Avatar SDKs

| SDK | Package | Path | Description |
|-----|---------|------|-------------|
| `<three-ws-viewer>` web component | `@three-ws/avatar` v0.2.0 | `avatar-sdk/src/viewer.js` | Lightweight GLB viewer: OrbitControls, PMREM, ResizeObserver |
| `<agent-3d>` web component | `@three-ws/avatar` v0.2.0 | `avatar-sdk/src/agent.js` | Full chat loop, voice, lipsync, emotion morphs (~3.3 MB) |
| AvatarCreator iframe modal | `@three-ws/avatar` v0.2.0 | `avatar-sdk/src/creator.js` | Opens Avatar Studio or Avaturn iframe, resolves to GLB Blob |
| Walk Companion | `@three-ws/walk` v0.1.0 | `walk-sdk/src/companion.js` | 200×280px fixed-position corner avatar |
| Walk Playground | `@three-ws/walk` v0.1.0 | `walk-sdk/src/playground.js` | Full-page stroll/platformer |
| Page Agent | `@three-ws/page-agent` v0.1.0 | `page-agent-sdk/src/page-agent.js` | Drop-in 3D narrator that auto-walks through page content |
| Tour SDK | `@three-ws/tour` v0.1.0 | `tour-sdk/src/director.js` | Guided product tour with TTS narration + sessionStorage resume |

### Body Mocap (`src/body-mocap.js`)

MediaPipe Pose Landmarker → 33 world landmarks → `pose-solve.js` → per-bone quaternion deltas → damped slerp → canonical bone names via `glb-canonicalize` → `bone.quaternion`.

### Face Mocap & Selfie Capture

- **`src/avatar-face-capture.js`** — selfie → 52 ARKit blendshape weights + face-shape transfer via MediaPipe Face Landmarker (478 landmarks).
- **`src/face-mocap-overlay.js`** — live 478-landmark + tessellation-mesh + iris/lip/eye/brow debug overlay over the webcam PiP.
- **`src/avatar-wardrobe.js`** — layered garment editor exploiting the multi-skinned-mesh-on-one-skeleton structure of RPM/Avaturn/Wolf3D exports.
- **`src/avatar-sculpt.js`** — face/body morph sliders + face-type blend wheel driving the 52 ARKit blendshapes by name plus RPM body-shape morphs.

### Mixamo R2 Animation Catalog

Beyond the ~100 baked canonical clips, `public/animations/mixamo/` indexes a **2,453-entry** on-demand library streamed from Cloudflare R2: `index.json` (Mixamo asset ID → R2 keys + byte sizes), `name-map.json` (UUID → human name), `catalog.json`, `hf-manifest.json`. Curation/preset layer: `src/animation-presets.js` (categories + featured set) and `src/animation-library.js` (`/pose` gallery: click-to-retarget, transport bar, export animated GLB). Bind-pose data: `src/animation-canonical-rest.js` (`CANONICAL_REST`/`_WORLD` from `cz.glb`, generated by `scripts/build-canonical-rest.mjs`).

### Animated USDZ Export (`src/usdz-animated.js`)

Bakes skinned mesh vertex positions at N keyframes, surgically rewrites `USDZExporter` ZIP output to add time-sampled point arrays. Fallback to static USDZ on failure. Enables iOS AR Quick Look animated avatars.

### Auto-Rig API (`api/_lib/auto-rig.js`)

Static mesh uploads → UniRig/Replicate backend → poll `regenerate-status` → canonicalize bones → register as new sibling avatar. Non-destructive. Feature-gated via `/api/config features.avatarRigging`. Companions: `api/_lib/auto-rig-eligibility.js`, `api/_lib/rig-inspect.js`, and the `auto-rig-sweep` cron.

---

### Physics Engine (`src/physics/`)

`src/physics/physics-world.js` wraps `@dimforge/rapier3d-compat` `^0.19.3`: a kinematic capsule character controller (wall-slide, step-up, ground-snap, dynamic-body shove), static world colliders, and dynamic rigid-body props synced to Three.js meshes. `initRapier()` memoizes WASM init; default gravity `{0, -14, 0}`; character translation is measured at the feet. `src/game/terrain.js` feeds one column-major `Float32Array` heightfield to both the rendered mesh and Rapier's `ColliderDesc.heightfield`. Vehicles use Rapier's raycast vehicle controller.

### 3D World Engine (`src/game/`, 40+ modules)

The open-world layer behind `/play` and per-coin worlds:

- **Terrain & building:** procedural heightfield terrain (`terrain.js`), collaborative voxel building (`build-voxels.js`, 1.5 m blocks, server-persisted per coin), districts/zones (`district.js`, `world-zones.js`).
- **Day/night:** authoritative server-broadcast world time drives sun/sky/fog/lights (`day-night.js`).
- **Vehicles:** drivable networked vehicles (`vehicles.js`, `vehicle-mesh.js`) — Notblox-style local raycast sim + server-validated transforms.
- **NPCs & navigation (`src/game/npc/`):** navmesh pathfinding via `three-pathfinding` `^1.3.0` (`nav-graph.js`), ambient life director (`ambient-life.js`, `world-life.js`), mobs (`mobs.js`), embodied service/chat NPCs (`npc-aixbt.js`, `npc-services.js`, `npc-chat.js`, `npc-zauth.js`, `aixbt-pay-hud.js`). `@recast-navigation/three` is present as a dependency.
- **Cosmetics & economy:** shop/wardrobe/loadout/visual primitives (`cosmetics-*.js` — tint + prop + aura), ambient crowd (`ambient-crowd.js`), activities/fishing (`play-activities.js`, `play-systems.js`), world objects/items (`world-objects.js`, `items.js`).
- **Market-reactive FX:** `market-reactor.js`, `oracle-ribbon.js`, `x402-jumbotron.js`, `chart-screen.js` make the world react to live on-chain data.

Standalone Three.js scenes not covered as page surfaces above: `/coin3d` (`src/coin3d/`, live token snapshot), `/diorama` (`src/diorama/`, text→3D island), `/constellation` (`src/constellation/`, Granite-embedding token galaxy + in-browser PCA), Agent Galaxy (`src/galaxy.js`, `src/ibm-galaxy.js`), Mind Palace (`src/mind-palace.js`), `/club` (`src/club*.js`), `/theater` (`src/theater*.js`), Living Stages (`src/stage*.js`, `hero-stage.js`), `/arena` & `/play` arena (`src/play/arena-world.js`, `src/arena/arena.js`), `/mirror` (`src/mirror/`), Scene Composer (`src/scene-compose.js`), Scene Studio (`src/scene-studio/` — vendored three.js r184 editor). Walk environments: 6 staged scenes (park, cyberpunk, beach, gallery, void, office) in `public/environments/index.json`.

### Multiplayer / Networked 3D (`multiplayer/`)

`@three-ws/multiplayer` v0.1.0 — an **authoritative Colyseus server** (Node ≥20, `@colyseus/core ^0.16`, `@colyseus/schema 3.0.76`, Express 5, port **2567**) backing every networked surface. Four rooms (`multiplayer/src/index.js`):

| Room | Backs | filterBy |
|------|-------|----------|
| `walk_world` (WalkRoom) | `/walk`, `/play` coin worlds | `['coin','tier']` |
| `irl_world` (IrlRoom) | `/irl` presence (pins **not** broadcast — per-viewer proximity reads only) | `['geocell']` |
| `clash_arena` (ClashRoom) | Coin Clash faction battles | `['matchKey']` |
| `stage_world` (StageRoom) | Living Stages performances (tip-reactive AI host) | `['stageId']` |

Move messages validated at 15 Hz with max-step/world-bounds/name/rate clamps; binary delta state (`schemas.js`: Player, Block, Vehicle, Mob, Tombstone, WorldObject). Auth/gates: `holder-pass.js`, `play-pass.js`, `guest-token.js`, `presence-token.js` (HMAC), `game-token.js` — boot fails in prod without `HOLDER_PASS_SECRET`. Durable per-world voxel builds + player state in Upstash Redis (`block-store.js`, `persistence.js`, `playerStore.js`); `@colyseus/redis-driver`/`-presence` for horizontal scale (>~200 players). Clients connect via `src/shared/colyseus-connect.js` + per-surface net wrappers (`src/walk-net.js`, `src/stage-net.js`, `src/game/community-net.js`). Deploy: `multiplayer/Dockerfile` + **Fly.io** (`fly.toml`, app `three-ws-multiplayer`, iad) and **Cloud Run** (`deploy-cloudrun.sh`); `@colyseus/monitor` at `/colyseus`, health at `/health`.

**Game systems** (`multiplayer/src/`): `stage-show.js` + `stage-schemas.js` + `stage-registry.js` + `social-hub.js` (live stage shows / social hub), and `clash.js`, `combat.js`, `quests.js`, `economy.js`, `shop.js`, `vehicles.js`, `war-report.js`. The 3D venues these load ship in **`public/club/`** — venue GLBs (`club-venue.glb`, `clubhouse.glb`, `alleyway.glb`, `space-smugglers-clubhouse.glb`, `tour.glb`), an HDRI (`club-hdri.hdr`), and props (`stage.glb`, `pole.glb`), each with per-asset `LICENSES.md`. Wearables live in **`public/accessories/`** (7 GLBs + `presets.json`).

### AR / WebXR Pipeline (`src/ar/`, `src/irl/`)

Beyond animated-USDZ export, a full AR stack: `src/ar/webxr.js` (`immersive-ar` session + hit-test placement + opt-in half-body XR), `depth-occlusion.js` (real-world occlusion via WebXR depth-sensing), `anchor-lifecycle.js` (reticle / tracking-loss state machine), `quick-look.js` (iOS USDZ Quick Look), `scene-viewer.js` (Android ARCore Intent), `placement-capability.js`. `src/irl/` is a GPS/marker AR "world lines" subsystem (~25 modules: floor/room/marker anchors, sensor fusion, GPS lifecycle, geohash proximity, QR detect, privacy center, perf budget), backed by the IrlRoom. `src/irl/glasses/` integrates **Even Realities G1 smart glasses** over BLE (`protocol.js`, `transport.js`, `bridge.js`, `g1.js`, `frame.js`).

### Mocap & Realtime Voice

- **Capture studios:** `src/mocap-studio.js` (record/save/replay face-mocap clips), `src/face-mocap.js` (52 ARKit blendshapes + 478 landmarks + head-pose via MediaPipe FaceLandmarker @~30 Hz, one-euro smoothing), `src/pose-studio.js` (FK gizmos, drag-IK/CCD, timeline → animated-GLB export). Backed by `/api/mocap/clips`.
- **Realtime voice:** `src/runtime/livekit-voice.js` (LiveKit bidirectional voice, `livekit-client ^2.19.2`), `src/runtime/gemini-live-client.js` (Gemini Live), `src/voice/a2f-player.js` (NVIDIA Audio2Face-3D playback), `src/embodiment/emotion.js` (text→emotion→idle+gesture+blendshape descriptor consumed by the MCP `speak` tool).
- **Avatar formats:** GLB/glTF, VRM/VRoid (`@pixiv/three-vrm ^3.5.3`), FBX (`fbx2gltf`), Draco/KTX2/Basis/Meshopt decoders (served locally via `src/loaders/gltf.js` AND from CDN via `src/viewer/internal.js`).

**Animation asset counts:** ~102 built JSON clips in `public/animations/clips/`, `manifest.json` ~100 runtime entries, 58 source FBX in `animation-sources/`, `scripts/animations.config.json` ~121 clip specs, and a 2453-entry R2-backed Mixamo catalog (`public/animations/mixamo/index.json`). Reference rig: Avaturn `public/avatars/cz.glb` (53-bone canonical skeleton; ≥50% track coverage required to retarget).

---

## MCP Layer

three.ws exposes **~317 total MCP tools** (≈115 remote + 180 domain-package + 22 stdio) across a multi-tier server architecture.

### MCP Protocol

All remote servers implement **MCP 2025-06-18 Streamable HTTP transport** (JSON-RPC 2.0). npm stdio servers use `@modelcontextprotocol/sdk` StdioServerTransport.

**Shared MCP infrastructure** (every remote server depends on it): `api/_lib/mcp-dispatch.js` (single source of the `PROTOCOL_VERSION = "2025-06-18"` constant), `mcp-batch-price.js` (JSON-RPC batch pricing + discovery-only detection), `mcp-getting-started.js` (the auto-injected `*_getting_started` free discovery tool), `mcp-error-sanitize.js`; three-mode auth in `api/_mcp/auth.js` + OAuth 2.1 issue/verify in `api/oauth/[action].js`. Each remote server is decomposed into a sibling `_mcp*/` dir (`catalog.js`, `dispatch.js`, `discovery.js`, `pricing.js`, `tools/`): `_mcp`, `_mcp3d`, `_mcpibm`, `_mcpagent`, `_mcpbazaar`, `_mcp-studio`.

### Remote MCP Servers (Cloud Run-hosted)

| Server | Endpoint | Tools | Auth | Registry ID |
|--------|----------|-------|------|-------------|
| Main | `/api/mcp` | ~34 | OAuth or x402 USDC | `io.github.nirholas/three.ws` |
| 3D Studio | `/api/mcp-3d` | ~24 | OAuth or x402 USDC | `io.github.nirholas/threews-3d-studio` |
| Free Studio | `/api/mcp-studio` | 5 | None (operator-funded) | `io.github.nirholas/threews-3d-studio-free` |
| Agent Wallet | `/api/mcp-agent` | 5 | OAuth | `io.github.nirholas/threews-agent` |
| Bazaar | `/api/mcp-bazaar` | 3 | None / OAuth | `io.github.nirholas/threews-x402-bazaar` |
| IBM Granite | `/api/ibm-mcp` | 6 | x402 or OAuth | `io.github.nirholas/ibm-x402-mcp-remote` |
| pump.fun | `/api/pump-fun-mcp` | 22 | None (open CORS) | `io.github.nirholas/threews-pumpfun` |
| Viewer Control | `/api/chat/mcp` | 11 | None | (unlisted) |

#### `/api/mcp` — Main Server Tools (34 tools)

3D avatar CRUD · `call_agent` · `register_agent` · `identity_check` · `remember` · `recall` · `forget` · animations · Solana agent passport/reputation/attestations · pump.fun market tools · Oracle conviction signals · trader leaderboard · copy-trading

#### `/api/mcp-3d` — 3D Studio Tools (24 tools)

`text_to_3d` · `image_to_3d` · `generation_status` · `preview_3d` · `remove_background` · `remesh_model` · `stylize_model` · `segment_model` · `retexture_model` · `retexture_region` · `auto_rig_model` · `pose_model` · `direct_prompt` · `generate_material` · `save_avatar` · `create_agent_persona` · `get_agent_persona` · `persona_say` · `inspect_model` · `optimize_model` · `list_animations` · `apply_animation` · `text_to_animation` · `mcp_3d_getting_started` (18 from `_mcp3d/tools/studio.js`, 2 reused from `_mcp/tools/models.js`, 3 from `_mcp/tools/animations.js`, 1 discovery)

#### `/api/mcp-studio` — Free Studio Tools (5 tools, no auth)

`forge_free` · `text_to_avatar` · `mesh_forge` · `rig_mesh` · `forge_avatar`

#### `/api/mcp-agent` — Agent Wallet Tools (5 tools)

`wallet_status` · `find_services` · `pay_and_call` · `provision_wallet` · `monetize_endpoint`

#### `/api/pump-fun-mcp` — pump.fun Tools (22 tools, open)

`search_tokens` · `get_token_details` · `get_bonding_curve` · `get_token_trades` · `get_trending_tokens` · `get_new_tokens` · `get_graduated_tokens` · `get_king_of_the_hill` · `get_creator_profile` · `get_token_holders` · `pumpfun_vanity_mint` · `pumpfun_watch_whales` · `pumpfun_list_claims` · `pumpfun_watch_claims` · `pumpfun_first_claims` · `sns_resolve` · `sns_reverseLookup` · `social_cashtag_sentiment` · `kol_leaderboard` · `pumpfun_quote_swap` · `social_x_post_impact` · `pumpfun_bot_status`

#### `/api/chat/mcp` — Viewer Control Tools (11 tools)

`setWireframe` · `setSkeleton` · `setGrid` · `setAutoRotate` · `setBgColor` · `setTransparentBg` · `setEnvironment` · `takeScreenshot` · `loadModel` · `runValidation` · `showMaterialEditor`

#### `/api/mcp-bazaar` — Bazaar Discovery (3 tools)

`search_services` · `browse_services` · `get_service` (`api/_mcpbazaar/tools.js`)

#### `/api/ibm-mcp` — IBM Granite via x402 (6 tools)

`ibm_granite_chat` · `ibm_granite_code` · `ibm_granite_embed` · `ibm_granite_analyze` · `ibm_granite_forecast` · `ibm_granite_getting_started`. The npm `@three-ws/ibm-watsonx-mcp` (direct IBM Cloud, non-x402) is a distinct toolset: `watsonx_chat` · `watsonx_generate` · `watsonx_embed` · `watsonx_tokenize` · `watsonx_forecast` · `watsonx_list_models`.

---

### npm stdio MCP Servers

#### Top-Level

| Package | Version | Binary | Paid Tools | Registry |
|---------|---------|--------|-----------|----------|
| `@three-ws/mcp-server` | 1.2.0 | `3d-agent-mcp` | 19 (x402 USDC on Solana) | `io.github.nirholas/3d-agent-mcp` |
| `@three-ws/mcp-bridge` | 1.0.0 | `x402-mcp-bridge` | 3 static + up to 20 dynamic from Bazaar | `io.github.nirholas/x402-bridge` |

**`@three-ws/mcp-server` tools:** `text_to_avatar` · `mesh_forge` · `forge_free` (free) · `rig_mesh` · `forge_avatar` · `ens_sns_resolve` · `agent_delegate_action` · `agent_hire_discover` · `agent_hire` · `sentiment_pulse` · `get_pose_seed` · `pump_snapshot` · `agent_reputation` · `vanity_grinder` · `agenc_list_tasks` · `agenc_get_task` · `agenc_get_agent` · `aixbt_intel` · `aixbt_projects`

**`@three-ws/mcp-bridge`:** dynamically registers Coinbase x402 Bazaar tools at startup. Supports EVM exact, EVM batch-settlement, and SVM exact payment schemes.

#### Domain-Specific Packages (`packages/*-mcp`) — 30 servers

| Package | Version | Tool Count | Domain |
|---------|---------|------------|--------|
| `@three-ws/avatar-agent` | 1.2.0 | 20 | Full GLB toolkit, avatar CRUD, voice, Solana wallet, pump.fun |
| `@three-ws/pumpfun-mcp` | 0.2.1 | 22 | pump.fun read-only data (mirrors `/api/pump-fun-mcp`) |
| `@three-ws/autopilot-mcp` | 0.2.0 | 11 | Agent autonomous execution control plane |
| `@three-ws/three-token-mcp` | 1.1.0 | 3 | `three_price`, `three_balance`, `three_burn` |
| `@three-ws/ibm-watsonx-mcp` | 0.2.0 | 6 | IBM Granite chat/gen/embed/tokenize/models (direct IBM Cloud) |
| `@three-ws/ibm-x402-mcp` | 1.1.0 | 6 | IBM Granite via x402 pay-per-call (no IBM account needed) |
| `@three-ws/x402-mcp` | 0.2.0 | 4 | Self-custodial x402 wallet: search bazaar, pay_and_call |
| `@three-ws/avatar-mcp` | 0.3.0 | 3 | Avatar creation, animation, rendering |
| `@three-ws/agora-mcp` | 0.1.0 | 9 | Agora economy: board, register, claim/post tasks, passport, citizens |
| `@three-ws/activity-mcp` | 0.1.0 | 5 | Holder leaderboard, trending coins, agents, feed events |
| `@three-ws/alerts-mcp` | 0.1.0 | 5 | pump.fun alert rules with Telegram/webhook delivery |
| `@three-ws/clash-mcp` | 0.1.0 | 4 | Coin Clash: state, leaderboard, enlist, rally |
| `@three-ws/intel-mcp` | 0.1.0 | 6 | Signal feed, smart money, wallet intel, KOL data |
| `@three-ws/brain-mcp` | 0.1.0 | 2 | `list_providers`, `chat` (20+ LLM providers) |
| `@three-ws/vision-mcp` | 0.1.0 | 3 | `analyze_image`, `describe_image`, `get_vision_status` |
| `@three-ws/audio-mcp` | 0.1.0 | 5 | TTS, STT, Audio2Face-3D, mocap clips |
| `@three-ws/portfolio-mcp` | 0.1.0 | 6 | Portfolio management |
| `@three-ws/signals-mcp` | 0.1.0 | 5 | Alpha signals marketplace |
| `@three-ws/notifications-mcp` | 0.1.0 | 7 | Notification inbox management |
| `@three-ws/marketplace-mcp` | 0.1.0 | 5 | Agent marketplace operations |
| `@three-ws/billing-mcp` | 0.1.0 | 6 | Revenue dashboard, withdrawals |
| `@three-ws/vanity-mcp` | 0.1.0 | 8 | Vanity address grinding + bounty market |
| `@three-ws/naming-mcp` | 0.1.0 | 3 | ENS + SNS name resolution |
| `@three-ws/copy-mcp` | 0.1.0 | 7 | Copy trading operations |
| `@three-ws/scene-mcp` | 0.1.0 | 3 | 3D scene management |
| `@three-ws/agenc-mcp` | 0.1.0 | 5 | AgenC on-chain task coordination |
| `@three-ws/loom-mcp` | 0.1.0 | 3 | Loom video integration |
| `@three-ws/tutor-mcp` | 0.1.0 | 2 | AI tutoring |
| `@three-ws/kol-mcp` | 0.1.0 | 2 | KOL (Key Opinion Leader) data |
| `@three-ws/provenance-mcp` | 0.1.0 | 3 | Asset provenance tracking |

---

## SDK Ecosystem

### Top-Level SDKs

| Package | Version | Path | Language | Description |
|---------|---------|------|----------|-------------|
| `@three-ws/sdk` | 0.2.0 | `sdk/` | JS (ESM) | Agent kit: ERC-8004 registry, chat panel, x402 client, SIWS auth, EAS attestations |
| `@three-ws/solana-agent` | 0.2.0 | `solana-agent-sdk/` | TypeScript | Solana agent: keypair/browser/wallet-adapter providers, SPL transfers, Jupiter swaps, AgenC bridge, x402-exact |
| `@three-ws/agent-payments` | 3.2.0 | `agent-payments-sdk/` | TypeScript | pump.fun agent payments: PumpAgent/PumpAgentOffline, EvmAgent, CrossChainPaymentClient |
| `@three-ws/agent-protocol-sdk` | 0.2.0 | `agent-protocol-sdk/` | TypeScript | On-chain A2A invocation: `deriveAgentPda()`, `invokeSkill()` (Anchor) |
| `@three-ws/agent-ui` | 0.2.0 | `agent-ui-sdk/` | JS (ESM) | Three.js GLB overlay: `createAgentUI()`, idle/walk clips, DOM-anchored behaviors |
| `@three-ws/avatar` | 0.2.0 | `avatar-sdk/` | JS (ESM) | `<three-ws-viewer>` + `<agent-3d>` web components + AvatarCreator iframe |
| `@three-ws/walk` | 0.1.0 | `walk-sdk/` | JS (ESM) | Walk companion + playground: `loadWalkAvatar()`, AnimationManager |
| `@three-ws/page-agent` | 0.1.0 | `page-agent-sdk/` | JS (ESM) | Drop-in 3D narrator + SpeechNarrator + AvatarPicker |
| `@three-ws/tour` | 0.1.0 | `tour-sdk/` | JS (ESM) | Guided tour SDK: TourDirector, GuideAvatar, curriculum, spotlight |

### Feature Packages (`packages/`)

| Package | Version | Description |
|---------|---------|-------------|
| `@three-ws/forge` | 0.1.0 | Text/image/sketch → GLB via `/api/forge` |
| `@three-ws/names` | 0.1.0 | ENS + SNS resolution, `*.threews.sol` subdomain minting, pay-by-name USDC |
| `@three-ws/intel` | 0.1.0 | Token market intelligence: `sentiment()`, `intel()` (x402), `snapshot()` |
| `@three-ws/vanity` | 0.1.0 | Local Solana vanity grinding (pure-JS, no WASM); `grindViaApi()` for short patterns |
| `@three-ws/reputation` | 0.1.0 | ERC-8004 trust scores across 22 EVM chains: `getScore()`, `attest()` |
| `@three-ws/voice` | 0.1.0 | Full voice loop: `transcribe()` (Riva), `speak()` (Magpie), `lipsync()` (A2F), `say()` |
| `@three-ws/x402-server` | 0.1.0 | Seller-side x402 middleware: challenge build, verify, settle (Solana + Base), receipt |
| `@three-ws/x402-fetch` | 1.0.1 | Buyer-side fetch wrapper: intercepts 402, signs EIP-3009 USDC-on-Base, retries (zero deps) |
| `@three-ws/agent-memory` | 0.1.0 | Embeddings-backed persistent memory: `remember()`, `recall()`, `graph()`, `forget()` |
| `@three-ws/agenc` | 0.1.0 | AgenC on-chain task protocol read client: `listTasks()`, `getTask()`, `getAgent()` |
| `@three-ws/guardian` | 0.1.0 | IBM Granite Guardian: `check()`, `govern()`, `moderate()` (12-risk taxonomy) |
| `@three-ws/glb-tools` | 0.1.0 | GLB inspection, token-themed mesh synthesis, avatar baking; paid lanes via x402 |
| `@three-ws/agent-guards` | 0.1.0 | Trading safety rails: `policy()`, `guard(tx, policy)` (client-side spend policy) |
| `@three-ws/skill-license` | 0.1.0 | On-chain skill license verify + mint (Anchor `EdngSwxmDktyrr4phwGEZnCXEoQ27vgnBtowjhKa7Wr8`) |
| `@three-ws/mocap` | 0.1.0 | Mocap recording persistence: `saveClip()`, `getClip()`, `listClips()` |
| `@three-ws/strategies` | 0.1.0 | DCA, copy-trade, mirror, Strategy Objects via three.ws API |
| `@three-ws/pumpfun-skills` | 0.1.0 | pump.fun launch + trade as composable agent tools |
| `@three-ws/irl` | 0.1.0 | Geofenced real-world agent presence: `checkIn()`, `nearby()`, `placePin()` |
| `@three-ws/pose` | 0.1.0 | Natural-language → deterministic joint-rotation map via `pose_model` MCP |
| `@three-ws/avatar-schema` | 0.2.0 | JSON Schema v2020-12 validator for avatar manifests (`validate()`, AJV-compiled) |
| `@three-ws/react` | 1.0.0 | React component: `Agent3D` / `WalkEmbed` |
| `@three-ws/viewer-presets` | 0.2.0 | Three.js viewer config presets: `LIGHT_CONFIG`, `buildLightRig`, bloom defaults |
| `@three-ws/avatar-cli` | 0.2.0 | CLI: scaffold, validate, hash, preview avatar manifests |
| `@three-ws/vscode-x402` | 0.1.0 | VS Code extension for x402 endpoint development |

### Published Modal / Payment SDKs

| Package | Version | Path | Description |
|---------|---------|------|-------------|
| `@three-ws/x402-payment-modal` | 1.2.0 | `x402-payment-modal/` | Drop-in Phantom wallet checkout modal |
| `@three-ws/x402-modal` | 0.2.0 | `x402-modal-sdk/` | Lighter modal SDK variant |

---

## On-chain & Solana

### Solana Programs (Anchor)

#### `skill_license` — Program ID: `EdngSwxmDktyrr4phwGEZnCXEoQ27vgnBtowjhKa7Wr8`

**Path:** `contracts/skill-license/src/lib.rs`

Mint/burn/revoke 1-of-1 SPL NFT access keys for skill purchases.

| Instruction | Description |
|-------------|-------------|
| `initialize_marketplace` | Create singleton Marketplace PDA |
| `set_minter` | Grant minting authority |
| `mint_skill_license` | Mint SkillLicense PDA: `(owner, agent_mint, sha256(skill_name))` |
| `burn_skill_license` | Burn and mark revoked |
| `revoke_skill_license` | Admin revoke |

#### `agent_invocation` — Program ID: `AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo`

**Path:** `contracts/agent-invocation/src/lib.rs`

Emits verifiable `SkillInvoked` on-chain events for agent-to-agent skill calls. Non-trust-bearing (no funds moved). Both invoker and target PDAs constrained under `seeds=[b'agent', authority]`.

#### `pump_agent_payments` — Program ID: `AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7`

**Path:** `agent-payments-sdk/src/solana/idl/pump_agent_payments.json`

Live pump.fun program (not deployed by three.ws). Handles agent token payments, distribution, and buyback. Wrapped by `PumpAgent`/`PumpAgentOffline` classes.

**PDA seeds** (used by the three.ws-authored programs): `skill_license` → `b"marketplace"` (singleton), `b"skill_license"`, `b"skill_mint"`; SkillLicense PDA = `(owner, agent_mint, sha256(skill_name))`. `agent_invocation` → `b"agent"` → `seeds=[b"agent", authority]`. Anchor **0.31.1** across both.

#### Bundled pump.fun program IDLs (`contracts/idl/pump/`)

Read-only IDLs for the upstream pump.fun programs the launch/trade tools target (not three.ws-deployed):

| Program | Program ID |
|---------|-----------|
| pump.fun core (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| pump.fun AMM (PumpSwap) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| pump.fun fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |

---

### EVM Contracts

#### ERC-8004 Identity Standard (3 Solidity contracts)

Deployed deterministically via CREATE2 at vanity-prefixed addresses.

| Contract | Mainnet Address | Testnet Address | Chains |
|----------|----------------|-----------------|--------|
| `IdentityRegistry.sol` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | 15 configured / 12 live, 7 testnet |
| `ReputationRegistry.sol` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | 15 configured / 12 live |
| `ValidationRegistry.sol` | (not deployed on mainnet) | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | testnet only |

**Chain count:** `src/erc8004/abi.js` `REGISTRY_DEPLOYMENTS` configures **15 mainnet** chain IDs (1, 10, 56, 100, 137, 250, 324, 1284, 5000, 8453, 42161, 42220, 43114, 59144, 534352) + **7 testnet** (97, 11155111, 84532, 421614, 11155420, 80002, 43113). As of the 2026-06-19 bytecode check, **12** mainnet are live — Fantom (250), zkSync Era (324), and Moonbeam (1284) are configured but **not yet deployed** (`eth_getCode` = `0x`, per `contracts/DEPLOYMENTS.md`). The platform validator key (`0x93Bc7EfB0059B784465619FC73C2db8D01b1CD04`, env `VALIDATOR_PRIVATE_KEY`) signs `recordValidation`. ERC-8004 registries compile with Foundry solc **0.8.24** (`foundry.toml`); the deployed ThreeWSFactory/ThreeWSPayments used solc **0.8.35** (`DEPLOYMENTS.md`).

**IdentityRegistry:** ERC-721 agent identity NFTs. EIP-712 wallet delegation, per-agent ETH deposit/spend/withdraw, key-value metadata, spend allowance for delegated server keys.

**ReputationRegistry:** Signed reputation feedback [-100,100] + ETH-staked reviews. One review per address per agent. Aggregate `(avgX100, count)` stored on-chain.

**ValidationRegistry:** Allow-listed validators record GLB schema validation and attestations (pass/fail + proof hash + IPFS URI + kind tag). **Not yet on mainnet.**

#### x402 Payment Contracts

| Contract | Address | Chain | Description |
|----------|---------|-------|-------------|
| `ThreeWSPayments.sol` | `0x00000000381f09742a30a5a49975514AeC1B72Cc` | BSC | $0.001/call USDC pay-per-call (load-bearing on BSC) |
| `ThreeWSPayments.sol` | `0xed3696489…` | Arbitrum | x402 settlement |
| `ThreeWSPayments.sol` | `0x31B13cDe…` | Base | Base lane (Base x402 settles via EIP-3009 to EOA) |
| `ThreeWSFactory.sol` | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | BSC/Base/Arbitrum | Vanity-prefixed CREATE2 factory (8-zero prefix) |
| `AgentPayments.sol` | (not deployed) | — | EVM port of pump_agent_payments; all addresses are 0x000…000 |

---

### Solana Name Service (SNS)

Platform registers agent identities as `*.threews.sol` subdomains:

- **Minting:** `api/sns-subdomain.js` — platform keypair (`THREEWS_SOL_PARENT_SECRET_BASE58`) signs creation + ownership transfer
- **URL record:** sets `https://three.ws/a/<agent_id>`
- **Resolution:** `api/sns.js` — forward/reverse lookup via Bonfida, 5-min in-process cache
- **Browser:** `src/solana/sns.js` + `src/solana/sns-subdomain.js`

---

### $THREE Token

**Contract Address:** `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

**Standard:** Token-2022 (Solana)

**Utility:**
- Feature gating: `src/three-gate.js` / `api/_lib/three-gate.js` — Forge access, 3D world entry, premium surfaces
- Seven holder tiers: Genesis, Diamond, Platinum, Gold, Silver, Bronze, Not Holding
- Tier-gated JWT passes: `api/three/tier-pass` — signed JWT for world gating
- Tournament prizes: `api/tournaments/` — SPL batch payouts
- Agora economy rewards
- Direct tipping in Stage / Club surfaces

---

### Vanity Wallet Protocol

**Solana — `src/solana/vanity/`** (WASM core compiled from `crates/vanity-grinder`):

- Browser-side WASM-accelerated grinder (~25k keypairs/sec single-threaded, fanned across cores via a Web Worker pool); pure-JS Ed25519 fallback; `grindViaApi()` hosted lane for short patterns.
- Proof-of-grind Ed25519 certificates published at `/.well-known/three-vanity.json` (`proof-of-grind.js`, `verifiable-grind.js`).
- Split-key (server-side non-custody) and sealed-envelope delivery (`sealed-envelope.js`).
- BIP-39 mnemonic grinder.
- **Three economic protocols** (versioned, isomorphic): grind-bounty market (`bounty-protocol.js` — `three-vanity-bounty/v1`, x402-escrowed, sealed-envelope payout against an X25519 recipient key, honest difficulty-pricing oracle), sealed wallet drops (`drop-protocol.js` — `three-drop/...`, bearer-token `#k=` fragment claim), and a grind-to-earn mining pool (`pool-protocol.js` — `three-grind-pool/v1`, share-difficulty accounting, 60% winner bonus). API side: `api/vanity/*` (bounties/cert/gallery/drops/og) + `api/x402/vanity-verifiable.js`.

**EVM — `src/eth/vanity/`** (parallel grinder, surfaced at `/eth-vanity`): EOA grinder (`eoa-grinder.js` + worker), CREATE2 contract-address grinder (`grinder.js` + `grinder-worker.js`), multi-chain factory awareness (`chains.js`), `validation.js`, `wordlist.js`, card UI `src/agent-eth-vanity-card.js`. Knows four cross-chain deployer/factory addresses: Arachnid proxy `0x4e59b448…`, CreateX `0xba5ed099…`, Safe Singleton Factory `0x4e1dcf7a…`, Coinbase Smart Wallet factory `0x0ba5ed0c…`.

---

### ERC-8004 Frontend (`src/erc8004/`)

Browser-side registration UI, agent manifest builder, avatar resolver, reputation panel, validation recording, hydrate/import flows. ABI definitions and `REGISTRY_DEPLOYMENTS` for all 22 chains (Base, Arbitrum, Ethereum, Polygon, BNB, Optimism, Avalanche, Gnosis, Fantom, Celo, Linea, Scroll, Mantle, zkSync, Moonbeam, + testnets).

---

## x402 Payments & Marketplace

### Payment Rails

three.ws implements three distinct payment rails:

| Rail | Protocol | Networks | Use Case |
|------|----------|----------|----------|
| x402 USDC (self-hosted / CDP / PayAI) | HTTP 402 + CAIP-2 | Solana mainnet, Base mainnet | Agent-to-agent, browser-to-service micropayments |
| Solana Pay | SPL reference + validateTransfer | Solana mainnet | Marketplace skill purchases |
| Stripe (USD) | Subscription webhooks | USD | Creator subscription plans |

Solana x402 settlement now runs through the platform's **own facilitator** (`/api/x402-facilitator`) rather than an external one — see [Self-hosted facilitator](#self-hosted-facilitator--closed-loop-economy) below.

---

### Full x402 Payment Flow (Solana)

```mermaid
sequenceDiagram
    participant B as Buyer Browser
    participant C as /api/x402-checkout
    participant W as Phantom Wallet
    participant T as Target Endpoint
    participant F as Facilitator (PayAI/CDP)

    B->>T: GET target endpoint
    T-->>B: 402 Payment Required challenge
    B->>C: POST ?action=prepare
    C-->>B: Unsigned Solana v0 SPL transferChecked tx
    B->>W: Sign transaction
    W-->>B: Signed tx
    B->>C: POST ?action=encode
    C-->>B: X-PAYMENT header payload
    B->>T: Request with X-PAYMENT header
    T->>F: /verify
    F-->>T: verified
    T->>T: Handler executes
    T->>F: /settle (on-chain)
    F-->>T: settled
    T-->>B: X-PAYMENT-RESPONSE header
    B->>C: POST /api/x402-checkout-record (analytics)
```

**Agent autonomous payment** (`/api/x402-pay` SSE flow):
```mermaid
flowchart TD
    A["agentId + target endpoint"] --> B["probeExternalRequirements\n(fetch 402 challenge)"]
    B --> C["reserveSpendUsd\n(spend cap advisory lock)"]
    C --> D["buildSolanaPaymentPayload\n(custodial keypair signs SPL transferChecked)"]
    D --> E["guardedFetch\n(send X-PAYMENT to target)"]
    E --> F["facilitator settles on-chain"]
    F --> G["updateCustodyEvent\n(finalize ledger)"]
    G --> H["SSE result stream"]
```

---

### Bazaar Marketplace

The x402 Bazaar aggregates paid API services from multiple facilitators:

**Discovery sources:**
- PayAI Bazaar: `https://facilitator.payai.network/discovery/resources`
- Coinbase CDP: `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`

**Platform-published services** (visible in `/.well-known/x402.json`):
- 3D generation (TRELLIS/TripoSG tier-priced)
- Token intelligence ($0.01/call)
- Skill marketplace ($0.001/call)
- Anonymous pump.fun launches ($5.00 flat)
- IBM Granite inference (operator-funded)
- 20+ additional service endpoints

---

### Agent-to-Agent (A2A) Payments

**Mandate flow:**
1. `POST /api/agents/a2a-mandate` — user issues JWS mandate (user consent)
2. Agent stores mandate and uses it autonomously
3. `POST /api/agents/a2a-call` — agent presents mandate → JWS verify → Upstash atomic spend reserve → SPL TransferChecked → settle → record

**Cumulative spend ledger:** `api/_lib/a2a/spend-ledger.js` — atomic Redis operations prevent overspend.

**A2A hiring:** `POST /api/agents/a2a-hire` — task posting to labor market; `POST /api/agents/a2a-paid` — invoice verification.

---

### Marketplace Revenue Split

```mermaid
flowchart TD
    A["Skill purchase (Solana Pay)"] --> B{Fee Split}
    B -->|"MARKETPLACE_PLATFORM_FEE_BPS\n(default: 0, env-configured)"| C["Platform fee"]
    B -->|"remaining after fee"| D["Author wallet"]
    A --> E["agent_revenue_events\n(timestamped revenue record)"]
    E --> F["billing/revenue.js\ngross/fee/net + by-skill timeseries"]
```

**Withdrawal:** `POST /api/billing/withdrawals` → `agent_withdrawals` row (pending) → async off-chain worker executes on-chain transfer to payout wallet from `agent_payout_wallets`.

**Fee ceilings & multi-recipient splits** (beyond the single platform fee above):
- `api/_lib/marketplace-platform-fee.js` — `MARKETPLACE_PLATFORM_FEE_BPS` default 0, **max `MAX_FEE_BPS=1000` (10%)**; recipient `MARKETPLACE_PLATFORM_FEE_WALLET` (falls back to `PLATFORM_TREASURY_KEYPAIR`/`TREASURY_KEYPAIR`); fee comes out of listed price (creator gets price − fee).
- `api/_lib/pump-platform-fee.js` — separate `PUMP_PLATFORM_FEE_BPS` default 0, **max 500 (5%)**, recipient `PUMP_PLATFORM_FEE_WALLET`.
- **Listing splits** — tables `listing_splits`, `listing_split_recipients`, `split_distributions` (migration `20260628090000_marketplace_splits.sql`) for multi-party revenue routing.
- **Fork royalties** — `api/_lib/fork-royalties.js`: `ROYALTY_PER_CREATOR_CAP_BPS=1000`, `ROYALTY_TOTAL_CAP_BPS=2000`, `MIN_FORKER_KEEP_BPS=8000`.
- **Cosmetics economy** — `api/_lib/cosmetics-economy.js`: `DEFAULT_CREATOR_BPS=5000`, `MAX_CREATOR_BPS=9000` (creator-split item economy behind `api/cosmetics/*` + `api/x402/cosmetic-purchase.js`).

---

### Merchant Console

Any user can become a merchant:

1. `PUT /api/x402-merchant` — configure payout wallets (EVM + Solana), CORS allow-list, spend caps
2. `POST /api/x402-skus` — create SKU (slug, target endpoint, price, branding)
3. Get hosted checkout link: `/pay/c/:slug`
4. Get hosted storefront: `/store/:handle`
5. Track conversions via `/api/x402-checkout-record`

**API Key rotation:** `x402_merchant_settings.api_key_hash` / `api_key_prefix` — allows bypass of per-request payment for trusted callers.

---

### Subscription & DCA

- **Subscriptions:** `api/subscriptions.js` (delegation-based recurring records) + `api/subscriptions/{subscribe,verify}.js` (USDC checkout with gasless fee-payer, atomic creator/treasury split). Libs `api/_lib/{subscription-pricing,subscription-checkout,subscription-billing}.js`. Tables `subscription_plans`, `subscription_plan_skills`, `subscription_checkouts`, `user_agent_subscriptions`, `agent_subscriptions`, `agent_delegations`. Cron `run-subscriptions`. Also `api/copy/subscriptions.js`.
- **DCA Strategies:** `api/dca-strategies.js` — dollar-cost-averaging on whitelisted tokens (`DCA_ALLOWED_TOKEN_OUT`, `DCA_CHAIN_ID`); executed by `api/cron/run-dca.js`. Tables `dca_strategies`, `dca_executions`.
- **Copy / Mirror Trading:** `api/copy/` (5 endpoints) + `api/mirror/` — `@three-ws/copy-mcp` + `@three-ws/strategies`; fanned out by `cron/{copy,mirror,signal,strategy}-fanout`.

---

### Spending Guardrails (autonomous-agent safety chokepoint)

Every outbound agent payment passes a spend-control layer:

- **Trade guards** — `api/_lib/agent-trade-guards.js`: single policy governing withdraw / x402-pay / snipe / trade via `meta.spend_limits` (`daily_usd`, `per_tx_usd`, `withdraw_allowlist`). Shipped as `@three-ws/agent-guards`.
- **Solana spend policy** — `api/_lib/agent-spend-policy.js`: `meta.spend_policy` (`max_sol_per_tx`, `daily_sol_cap`, `allowed_mints`), compiled via `spend-policy-compiler.js` + `spend-policy-rules.js`.
- **Buyer-side x402 caps** — `api/_lib/x402-spending-cap.js` + `x402-spending-ledger.js` + `x402-spending-price.js`: per-call + sliding-window USDC caps via SDK lifecycle hooks. Env `X402_MAX_PER_CALL_ATOMIC`.

### x402 Protocol Subpackage (`api/_lib/x402/`)

Modules implementing x402 v2 transports/extensions: `a2a-client`/`a2a-server`, `access-control`, `api-keys`, `audit-log`, `auth-hints`, `bazaar-client`/`bazaar-helpers`, `idempotency-cache`, `offer-receipt-issuer`/`offer-receipt-server`, `payment-identifier-client`/`payment-identifier-server`, `paywall-handler`, `receipt-storage` — **plus** the closed-loop economy layer: `self-facilitator.js`, `pay.js`/`solana-payer.js`, `autonomous-registry.js`, `revenue-analytics.js`, `revenue-reconciliation.js`, the `pipelines/` fleet, and value stores (see [Autonomous spend loop](#autonomous-spend-loop--revenue) above). (The ~80 per-pipeline task specs live in `agents/x402-buildout/self/`.)

**Two coexisting 402 protocols:** (1) CDP/PayAI x402 **v2 wire spec** in `api/_lib/x402-spec.js` (CAIP-2 networks, `X-PAYMENT`/`X-PAYMENT-RESPONSE` base64 envelopes, facilitator `/verify`+`/settle`, schemes `exact`/`direct`, Permit2/EIP-2612). (2) Pump **agent-skill 402** in `api/_lib/x402.js` (`version:"x402/0.1"`, `kind:"agent-skill"`, `x-payment-intent` retry header). Solana settles in **USDC or $THREE** (opt-in `X402_ACCEPT_THREE_SOLANA=true`).

### Self-hosted facilitator & closed-loop economy

Solana x402 settlement previously went through an **external facilitator** (PayAI) that co-signed the fee-payer and broadcast every settlement. three.ws now ships its **own facilitator** so no money, metadata, or signing authority leaves the platform.

- **`api/x402-facilitator/[action].js`** — drop-in x402 v2 facilitator: `POST /verify`, `POST /settle`, `GET /supported`. Switching is just repointing `X402_FACILITATOR_URL_SOLANA` at `https://three.ws/api/x402-facilitator` (`facilitatorFor()` in `x402-spec.js` still POSTs `/verify`+`/settle`). Off by default — returns `503` without `X402_SELF_FACILITATOR_ENABLED=true` + a sponsor secret.
- **`api/_lib/x402/self-facilitator.js`** — the core. `validateRingTransaction()` is the **anti-drain gate**: refuses to co-sign anything whose program set isn't exactly `{ComputeBudget, optional ATA-create for our recipient, one SPL `TransferChecked` USDC to an allowlisted `payTo`}`, rejects any `System` instruction (blocks SOL exfiltration), caps CU limit/price + priority fee, and requires the recipient be platform-controlled. Supports **self-pay** (buyer pays own 1-sig fee) and **sponsor** mode (2-sig). A **SOL floor** (`X402_SPONSOR_SOL_FLOOR_LAMPORTS`, default 0.02 SOL) hard-stops settlement before the fee wallet can be drained. Every op logs to `x402_self_facilitator_log`.
- **Closed-loop ("ring") economy** — platform-controlled wallets (payer → treasury → sponsor) pay the platform's own paid endpoints in real on-chain USDC so gross volume costs only Solana network fees. `api/x402/ring-settle.js` (internal settlement primitive, `discoverable:false`), `api/_lib/x402/pipelines/ring-rebalance.js` (sweeps treasury→payer so the float recirculates), `api/x402-ring.js` (`GET /api/x402-ring` net-position/burn report, `internal:true`). Schema `2026-07-01-x402-ring-economy.sql`: `x402_self_facilitator_log`, `x402_ring_ledger`, `x402_ring_wallets`. Design doc `docs/x402-ring-economy.md`; wallet setup `scripts/x402-ring-setup.mjs`.

### Autonomous spend loop & revenue

- **`api/cron/x402-autonomous-loop.js`** (`*/5`) drives `api/_lib/x402/autonomous-registry.js` — a registry of pipelines that self-call paid endpoints on a schedule (priority + cooldown), paying via `api/_lib/x402/pay.js`, logging every call to `x402_autonomous_log`. Pipelines under `api/_lib/x402/pipelines/*` include the **volume engine** (`volume-bootstrap-loop.js`, round-robins `VOLUME_ENDPOINTS`), `ring-rebalance`, `revenue-reconciliation` (self/027, daily — DB-vs-chain audit into `payment_reconciliation`), plus dozens of health/security/finance/content probes (`circuit-breaker`, `service-uptime-monitor`, `fee-calculation-validator`, `builder-code-attribution`, `charity-split-audit`, `cross-chain-cost`, `forge-content`, `sniper-intel-enrich`, `token-intel-gate`, …). Value stores: `revenue-analytics.js`, `agent-leaderboard-store.js`, `wallet-balance-monitor.js`, `granite-health.js`, `three-signal-store.js`, `sniper-analytics-store.js`.
- **`api/cron/x402-seed-cron.js`** (`* * * * *`) fires 60 real Solana USDC micropayments/tick at `/api/x402/dance-tip` to seed the live payment feed.
- **Revenue recording**: settlements land in `x402_audit_log` (via `api/_lib/x402/audit-log.js` `logPaymentEvent`) + signed `x402_receipts`; per-endpoint aggregate in `x402_volume_metrics`. Read via `GET /api/x402-revenue` (public live feed) and `GET /api/x402/analytics?report=revenue` ($0.005). **Paid-endpoint catalog:** `docs/x402-endpoints.md`; per-handler defaults via `priceFor('<slug>', …)` (`api/_lib/x402-prices.js`), overridable by `X402_PRICE_<SLUG>`.

### Governed payment sessions

`api/pay/session` (+ `POST /api/pay/execute`) create budget-limited x402 **spend envelopes** so an agent pays without holding a key: `api/_lib/pay/payment-session.js` (session CRUD) + `api/_lib/pay/spend-governor.js` (policy: allowlist + per-tx ceiling + total budget, enforced atomically server-side; the platform wallet signs). Tables `payment_sessions` / `payment_session_executions`; cron `api/cron/payment-session-sweep.js` (`*/5`) expires stale sessions and refunds unspent budget to creator credit. Frontend `pages/payments.html` → `/payments`; MCP counterpart `@three-ws/agentcore-payments-mcp` (5 tools). Billing surfaces: `pages/billing/keys.html` → `/billing/keys` (API keys + usage), `pages/x402-revenue.html` → `/x402-revenue` (endpoint revenue dashboard), `pages/agent-economy-volume.html` (A2A economy volume), `pages/viability.html` (honest marketplace + trading signal).

### Circulation engine

`api/_lib/circulation.js` (+ `circulation-personas.js`) drives real agent-to-agent commerce (tips, skill/asset buys in $THREE, trades, launches) via a pool of platform-owned custodial agents, ticked by `api/cron/pulse-tick.js` (`*/2`). Distinct from the ring: recently refactored to **remove real-seller demand entirely** — manufactured demand only ever reaches circulation-owned sellers, so no SOL/$THREE can leave to a real user's wallet. Gated by `CIRCULATION_ENABLED` + `CIRCULATION_TREASURY_SECRET`; health probe `api/admin/circulation-health.js`. (Removed in the refactor: `CIRCULATION_REAL_SELLER_DEMAND`, `CIRCULATION_REAL_SELLER_DAILY_CAP`.)

---

## AI & Agent Intelligence

### LLM Provider Architecture

#### `api/chat.js` — Avatar Chat (Failover Chain)

```mermaid
flowchart TD
    A["Groq\nllama-3.3-70b-versatile (free)"]
    B["OpenRouter\nmeta-llama/llama-3.3-70b:free · openai/gpt-oss-120b:free"]
    C["NVIDIA NIM\nnemotron-super-120b · nemotron-super-49b · deepseek-v4-pro"]
    D["Anthropic\nclaude-sonnet-4-6"]
    E["OpenAI\ngpt-5.4-nano"]
    F["IBM watsonx Orchestrate"]
    A -->|fallback| B -->|fallback| C -->|fallback| D -->|fallback| E -->|fallback| F
```

**Tool dispatch (13 action tools):** avatar control, memory write, Solana transfer (Guardian-gated), marketplace purchase, wallet query, schedule task, etc.

#### `api/brain/chat.js` — LLM Playground (20+ providers)

| Tier | Models |
|------|--------|
| Anthropic | claude-fable-5, claude-mythos-5 (restricted, moderation-gated, never auto-selected), claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 (native `claude-haiku-4-5-20251001`) |
| OpenAI | gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.5-pro, gpt-5.4 (+ pro/mini/nano), gpt-5.3-codex, o3, o3-pro (legacy gpt-4o/gpt-4o-mini/o3-mini ids alias forward) |
| NVIDIA NIM | `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nvidia-nemotron-nano-9b-v2`, `deepseek-ai/deepseek-v4-pro`, `moonshotai/kimi-k2.6`, `meta/llama-4-maverick-17b-128e-instruct`, `minimaxai/minimax-m2.7` |
| IBM watsonx | `ibm-granite` (Granite 3.8B Instruct) |
| Groq | llama-3.3-70b-versatile, llama-3.1-8b-instant |
| DashScope | qwen-plus |
| ModelScope | `Qwen/Qwen3-Coder-480B-A35B-Instruct` |
| DeepSeek | deepseek-reasoner (R1) |
| OpenRouter | 50+ via fallback routing |

`PROVIDERS` in `api/brain/chat.js` has **21 entries**. The auto-router for avatar chat (`api/_lib/chat-models.js`) is a distinct, smaller catalog with `DEFAULT_PROVIDER_ORDER = ['groq','openrouter','nvidia','anthropic','openai']` (NVIDIA lane `meta/llama-3.3-70b-instruct` + `nvidia/llama-3.3-nemotron-super-49b-v1.5`; Anthropic lane `claude-sonnet-4-6` + `claude-haiku-4-5-20251001`), budgets `MAX_FALLBACK_ATTEMPTS=4`, `TOTAL_BUDGET_MS=25000`, `PER_CALL_TIMEOUT_MS=15000`.

---

### Agent Memory System (`api/_lib/memory-store.js`)

Tiered memory architecture (Letta/MemGPT model):

| Tier | Description | Token Budget |
|------|-------------|-------------|
| Working | Active context assembly | Current conversation |
| Recall | Semantic search results | ~2000 tokens |
| Archival | Long-term knowledge graph | Unlimited (paginated) |

**Embeddings:** NVIDIA NIM `nv-embedqa-e5-v5` (primary) · OpenAI `text-embedding-3-small` (backstop) — 1024-dim vectors stored as **JSONB arrays tagged with the embedder** (cosine computed in JS strictly within each embedder space; **no pgvector column**). Postgres extensions in use are `citext`, `pg_trgm`, and `pgcrypto`.

**Memory writes:** signed with agent's EVM wallet (ERC-191) for authorship provenance.

**Reflection** (`api/agent/reflect.js`, `api/_lib/reflection.js`): LLM-powered consolidation of recent memories into higher-order "dreams". Rate-limited, daily-capped, uses `REFLECTION_MODEL = 'claude-opus-4-7'` preferentially → Groq/OpenRouter fallback. User-facing review at `api/agent/dreams.js` (accept/reject/answer with provenance); owner-only curation at `api/memory/curate.js` (edit/forget/merge with re-embedding) alongside `api/memory/{search,graph,context}.js`.

**Brain format** (`api/_lib/brain-bundle.js`): portable `.brain` export — schema-versioned persona + signed memories + ERC-8004 anchor on Base.

---

### Content Safety

**IBM Granite Guardian** (`api/_lib/granite-guardian.js`):

12-risk taxonomy scored per message:
- `harm`, `jailbreak`, `violence`, `social_bias`, `profanity`, `sexual_content`
- `unethical_behavior`, `harm_engagement`, `groundedness`, `answer_relevance`
- `context_relevance`, `function_call`

Returns `allow | review | block`. SHA-256 hash-chained audit records. Gates all autonomous SOL transfer actions.

**NVIDIA NemoGuard** (`api/_lib/moderation.js`): lightweight anonymous-user moderation via `llama-3.1-nemoguard-8b-content-safety`.

---

### Multimodal Pipeline

```mermaid
flowchart TD
    TXT["Text"] -->|"POST /api/tts/speak"| MAG["NVIDIA Magpie gRPC"]
    MAG -->|"WAV audio"| A2F["POST /api/a2f\nNVIDIA Audio2Face-3D gRPC"]
    A2F --> BS["ARKit 52 blendshapes JSON"]
    BS --> MT["avatar-morph-target.js\nmorphTargetInfluences"]

    AUD["Audio"] -->|"POST /api/asr"| RIV["NVIDIA Riva gRPC"]
    RIV --> TXT2["transcript text"]

    IMG["Image"] -->|"POST /api/vision"| VLM["NVIDIA NIM\nnvidia/nemotron-nano-12b-v2-vl"]
    VLM -->|"lane 2"| VLM2["meta/llama-3.2-11b-vision-instruct"]
    VLM --> DESC["description"]
    VLM2 --> DESC
    VLM2 -->|"backstop"| MINI["OpenAI gpt-5.4-nano"]
    MINI --> DESC
```

**TTS backends** (`api/tts/`): primary NVIDIA Magpie gRPC (`tts-nvidia.js`) + **ElevenLabs** (`eleven.js`, `eleven-clone.js` voice cloning, `eleven_flash_v2_5`, R2-cached) + **Microsoft Edge TTS** (`edge.js`, WebSocket, R2-cached) + OpenAI backstop. Router `tts/speak.js`, catalog `tts/voices.js`. ASR = NVIDIA Riva gRPC (`asr-nvidia.js`); A2F = NVIDIA Audio2Face-3D gRPC (`a2f-nvidia.js`). All NVIDIA lanes share `NVIDIA_API_KEY` (nvapi). Content safety = IBM Granite Guardian (`api/guardian/assess.js`) + NVIDIA NemoGuard.

---

### Long-Running Workers

#### `workers/agent-sniper` — Autonomous Sniper

```mermaid
flowchart TD
    WSS["PumpPortal WSS\nwss://pumpportal.fun/api/data"]

    WSS -->|"new_mint events"| SCORE["scoreMint\n(pattern + intel)"]
    WSS -->|"first_claim"| FC["first_claim trigger"]
    WSS -->|"intel_confirmed"| OG["oracleGate → executeBuy → agent wallet"]
    WSS -->|"prelaunch_radar"| PRE["block-zero pre-cog snipe"]

    subgraph Intel["Coin Intelligence Engine (workers/agent-sniper/intel/)"]
        CI["per-mint → computeSignals + classifyCoin (LLM-assisted)"]
        DB[("pump_coin_intel DB")]
        OC["oracle_conviction"]
        CI --> DB --> OC
    end

    SCORE --> Intel
```

**Strategy matching:** per-agent `agent_sniper_strategies` table. Swarm support: consensus + pro-rata position splitting (`swarm.js`).

**Subsystems (selected modules):**
- **Coin Intelligence Engine** (`intel/`): `signals.js` (computeSignals), `classify.js` (LLM-assisted classifyCoin), `learn.js` (online learning), `wallet-graph.js` (creator/funder graph), `watcher.js`, `store.js` → `pump_coin_intel` DB.
- **Radar / pre-cog:** `prelaunch-radar.js` (block-zero pre-cog snipe — watches `radar_watchlist` for creator/smart-money wallet activity before the mint goes public), `radar-detect.js`, `radar-scorer.js`, `radar-watchlist.js`, `recompute-wallet-graph.js`.
- **Execution & exit:** `executor.js` (per-agent in-process spend lock), `exit-logic.js`, `amm-exit.js`, `positions.js`, `oracle-gate.js`, `claim-scorer.js`, `first-claim-watch.js`.
- **Ops:** `heartbeat.js`, `alerts.js`, `error-tracker.js`, `keys.js`, `config.js`, `log.js`.

#### `workers/oracle` — Market Oracle

Three loops (`score-loop.js`, `agent-loop.js`, `settle-loop.js`) sharing `executor.js` + `keys.js`:
1. **score-loop:** `pump_coin_intel` + `wallet_reputation` → LLM narrative classification → `oracle_conviction`
2. **agent-loop:** acts on verdicts for armed watches
3. **settle-loop:** position settlement

#### `workers/agent-mm` — Market Maker

Defends price floors, recycles profit, manages graduation transitions for `market_maker_policies` (`graduation.js` handles the bonding-curve → AMM transition, `engine.js`/`market.js`/`store.js`).

#### `workers/agent-orders` — Order Execution

Sweeps `active_orders`, evaluates triggers/schedules, fires matched orders via `executeAgentTrade` with real-time on-chain quotes.

#### `workers/agora-citizens` — Agora Life Engine

A long-lived **Cloud Run daemon** (NOT a scheduled Cloud Scheduler cron — `--no-cpu-throttling --min-instances=1`) that registers real AgenC agents on Solana and drives each citizen's daily loop on internal jittered timers (per-citizen `tick`, `replenishWork`, `reconcile`, `heartbeat`), projecting every on-chain action to `agora_citizens` / `agora_activity` / `agora_vouches`. See the full [Agora](#agora--living-agent--human-economy-verifiable-work-supply-chain) subsystem.

#### `workers/agent-screen-worker` & `workers/agent-screen-pool` — Live Agent Casting

Playwright/Stagehand headless-browser workers that stream an agent's real web work as a JPEG frame feed. `agent-screen-worker` is a per-agent, owner-run process (authenticates as the agent via `AGENT_JWT`); `agent-screen-pool` is an on-demand multi-agent caster (shared `SCREEN_WORKER_SECRET`) that spins browsers only for agents viewers are actively watching and tears them down when the last viewer leaves. See [Agent Screen](#agent-screen--live-agent-casting).

#### `workers/agent-sniper` — Autonomous Sniper (hosted engine)

Detailed above; the production hosted sniper. Its open-source, embeddable twin is the `@three-ws/agent-sniper` npm package — see the full [Agent Sniper](#agent-sniper--autonomous-trading) subsystem.

---

### GPU & CPU Workers (Google Cloud Run)

`workers/` holds **21 worker subdirectories** total — the long-running Node workers above, plus the Python/FastAPI inference and mesh-processing fleet below. Workers split into three tiers: **GPU mesh/video inference** (NVIDIA L4), **CPU geometry processing** (no GPU), and **orchestration/runbooks**.

#### GPU inference workers (NVIDIA L4)

| Worker | Technology | Description |
|--------|-----------|-------------|
| `avatar-pipeline-controller` | Python/FastAPI (**CPU**) | Reconstruction orchestrator — the `api/` layer talks ONLY to this (`GCP_RECONSTRUCTION_URL`). Fans out to a mesh model + UniRig and returns one rigged GLB. |
| `model-hunyuan3d` | Python/FastAPI + CUDA | Image → 3D mesh (Hunyuan3D-2.1, HF license-gated — needs `HF_TOKEN`) |
| `model-trellis` | Python/FastAPI + CUDA | Image → 3D mesh (TRELLIS) |
| `model-triposr` | Python/FastAPI + CUDA | Fast single-image → 3D mesh (TripoSR, VAST-AI MIT; 5–15s, baked texture; fast-path/fallback) |
| `model-triposg` | Python/FastAPI + CUDA | High-fidelity image/sketch → 3D shape (TripoSG, VAST-AI MIT; 1.5B rectified-flow). Two modes: `image` (mesh) + `scribble` (sketch+text → mesh, CFG-distilled 16-step) powering `/forge` sketch→3D. Geometry only — pair with `texture`. |
| `model-text2motion` | Python/FastAPI + CUDA | Text → SMPL motion (MDM) → canonical three.js AnimationClip JSON (`mdm_sampler.py`, `smpl_to_clip.py`) |
| `model-video2scene` | Python/FastAPI + CUDA | Phone video → explorable 3D point cloud. Wraps LingBot-Map (Apache-2.0) feed-forward monocular reconstruction (~20 FPS), fusing per-frame world points + RGB into one coloured binary PLY on GCS. `POST /infer` · `GET /tasks/:id`. Backs the [Scene Capture](#diorama--scene-capture) page `/capture` via `api/scene-capture.js` (`GCP_VIDEO2SCENE_URL`). |
| `avatar-reconstruction` | Python/FastAPI + CUDA | "Scan yourself to 3D" — 1–6 face photos → Zero123++ 6-view synthesis → InstantMesh textured GLB → GCS (`face_pipeline.py`, `glb_ops.py`, `precompute_uv.py`, `templates/`). Output bucket `gs://three-ws-avatar-reconstructions`. |
| `longcat` | Python/FastAPI + CUDA | LongCat-Video-Avatar-1.5 (MIT) — reference image + audio URL → lip-synced talking-avatar MP4 → `gs://three-ws-avatar-videos`. `POST /generate` · `GET /jobs/:id` · `GET /health`. |
| `unirig` | Python/FastAPI + CUDA | Skeleton + skinning + ARKit-52 blendshapes (UniRig/SIGGRAPH 2025) |

#### CPU geometry workers (no GPU)

| Worker | Technology | Description |
|--------|-----------|-------------|
| `rembg` | Python/FastAPI | Background removal (BRIA RMBG-2.0, u2net, isnet-general-use) |
| `segment` | Python/FastAPI (CPU) | Part-segmentation — splits a mesh at disconnected shells + the minima rule (concave-crease cuts) into named addressable parts, tints each, emits a GLB whose nodes are parts + a parts manifest (id/name/region/bbox/centroid/face+vertex counts/colour). Backs `/api/forge-segment`. (`segment_core.py`) |
| `remesh` | Python/FastAPI (CPU) | Mesh ops via trimesh + open3d + QuadriFlow (MIT) + xatlas + headless Blender (bpy): format convert (GLB ↔ OBJ ↔ FBX ↔ STL ↔ PLY ↔ USDZ ↔ 3MF), **rig-preserving FBX export** (bones + skin weights + blendshapes via `blender_fbx.py` — the only round-trip path, trimesh has no FBX writer), quadric decimation, quad remesh, UV unwrap, repair. (`verify_fbx.py`) |
| `texture` | Python/FastAPI (CUDA) | Text-guided texturing — full retexture (`/texture`: render N views → SDXL + ControlNet-depth → back-project to UV) + magic-brush region retexture (`/retexture_region`: repaint only a masked region, feathered seam). Backs `retexture_model` / `retexture_region`. |
| `stylize` | Python/FastAPI (CPU) | One-click geometric stylization (pure trimesh + numpy + scipy, no inference): `voxel`, `brick` (LEGO studs), `voronoi` (strut lattice), `lowpoly` (faceted). Extensible via `STYLES`. |

#### Orchestration & MCP-mirror workers

| Worker | Technology | Description |
|--------|-----------|-------------|
| `deploy` | Bash runbooks | Repeatable, idempotent Cloud Run provisioning for the reconstruction pipeline: `deploy-all.sh` (ordered provision of controller + mesh models + UniRig, prints controller URL+key for the Cloud Run service env), `deploy-editing.sh`, `stage-weights.sh` (stages ~80 GB model weights). |
| `pump-fun-mcp` | Cloudflare Worker | Stateless **mirror** of `api/pump-fun-mcp.js` — full MCP Streamable HTTP (protocol `2025-06-18`), read-only on-chain/indexer tool subset only, camelCase legacy aliases via `TOOL_NAME_ALIASES`, no auth/x402. Deploy: `wrangler deploy`. (`worker.js`, `wrangler.toml`) |

**Endpoint contracts vary by worker:** the mesh-inference models (`model-*`) expose `POST /infer` + `GET /tasks/:id`; `longcat` exposes `POST /generate` + `GET /jobs/:id` + `GET /health`; `avatar-reconstruction`/controller expose `/reconstruct` + `/rig`; CPU workers expose named verb endpoints (`/texture`, `/retexture_region`, `/segment`, `/convert`, …). Job state in Google Cloud Firestore (native mode), outputs to GCS.

**Shared security module (`worker_security.py`):** a stdlib-only file COPYed byte-identically into every Python worker's Docker build context. Provides three primitives every worker uses: `require_api_key` (timing-safe constant-time bearer check), `fetch_remote_bytes` (SSRF-hardened fetch — https-only, DNS resolution rejecting private/loopback/link-local/metadata IPs, per-hop redirect re-validation, bounded response size), and `safe_error` (opaque correlation-id-tagged errors, full traceback logged server-side only). Keep all copies byte-identical when editing.

---

### Standalone Services (`services/`)

Long-running, **stateful** processes that hold persistent connections and so fit neither a request/response `api/` handler nor a stateless Cloud Run/Cloudflare worker (`workers/`). Each is its own subdir with `package.json`, entrypoint, and `Dockerfile`.

#### `services/pump-graduations` — pump.fun graduations indexer

The only piece that keeps the live graduation WebSocket open. Holds a long-lived Solana WS subscription to the Pump program, detects token "graduations" (bonding-curve → PumpAMM migration) by matching the `complete` anchor event via its 8-byte discriminator (`COMPLETE_EVENT_DISCRIMINATOR`, matching `@pumpkit/core`), and pushes each event into a capped Upstash Redis list. The `api/` handler side reads the events back from Redis.

- `index.js` — main loop (Pump program log subscription).
- `carbon-source.js` — drop-in alternative source backed by a Carbon indexer; same `start(cb)`/`stop()` contract + identical events, selected at startup.
- **Env:** `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `GRADUATIONS_LIST_KEY` (default `pf:graduations`), `GRADUATIONS_MAX_LEN` (default `500`), `PUMP_GRADUATIONS_SOURCE` (`legacy` default | `carbon`).

#### `services/agent-screen-caster` — self-hosted agent screen caster

A reusable **Playwright caster library + CLI** (`AgentScreenCaster` class) an agent *owner* self-hosts to stream that agent's real browser work into three.ws. Authenticates with a per-agent bearer token/API key minted by `POST /api/agent/caster-config` (which returns a ready-to-paste `.env` + `docker run`). Ships task modules `pump-monitor` (watch a pump.fun coin via DOM MutationObserver) and `trade` (drive Jupiter/Raydium/pump.fun swap UIs). Pushes JPEG data-URL frames to `POST /api/agent-screen-push` on a `FRAME_INTERVAL_MS` loop.

- `caster.js` — the `AgentScreenCaster` Playwright wrapper (frame loop, push primitives).
- `tasks/pump-monitor.js`, `tasks/trade.js` — bundled task modules.
- **Env:** `AGENT_ID`*, `AGENT_BEARER_TOKEN`*, `PUSH_URL` (default `https://three.ws/api/agent-screen-push`), `FRAME_INTERVAL_MS` (400), `JPEG_QUALITY` (72), `HEADLESS`, `TASK`, `TASK_ARG`, `WALLET_STORAGE_STATE_PATH`.

---

### Rust Crates (`crates/`)

Native/WASM Rust code that compiles to WASM for the frontend (distinct from `contracts/`, which holds Anchor/Solidity on-chain programs).

#### `crates/vanity-grinder` — Solana vanity address grinder

WASM-backed ed25519 vanity grinder (v0.1.0, MIT, `publish=false`) that powers `@three-ws/vanity` and `src/solana/vanity/`. `crate-type = ["cdylib","rlib"]`; deps `curve25519-dalek` v4 (precomputed-tables), `wasm-bindgen` 0.2, `js-sys` 0.3, `bs58` 0.5, `sha2` 0.10. Release profile: `opt-level=3`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `wasm-opt -O3 --enable-simd --enable-bulk-memory`.

---

## Pump.fun & Token Launch

### Token Launch Flows

#### Agent-Owned Launch (custodial)

```mermaid
flowchart TD
    A["browser\n(homepage-launcher.js / launch-token-modal.js)"]
    B["POST /api/pump/launch-prep\n(vanity mint grind, metadata prep)"]
    C["user wallet signs tx\n(or agent custodial key if server-signed)"]
    D["POST /api/pump/launch-confirm"]
    E["pump_agent_mints table\n+ pump.fun bonding curve on-chain"]
    A --> B --> C --> D --> E
```

**Buyback:** `buyback_bps` routes a slice of agent payments into on-chain burns.

#### x402 Pay-Per-Call Launch (anonymous)

```mermaid
flowchart TD
    A["USDC $5.00 payment"] --> B["/api/x402/pump-launch"]
    B --> C["uploadPumpMetadata\n(pump.fun IPFS upload)"]
    C --> D["launchPumpToken\n(@pump-fun/pump-sdk createV2)"]
    D --> E["x402_pump_launches table"]
    E --> F["pump.fun chain\n(server fronts ~0.022 SOL)"]
```

---

### Coin Intelligence Engine

Every new mint is classified in its first seconds of trading:

```mermaid
flowchart TD
    A["PumpPortal WSS new-mint"] --> B["intel watcher"]
    B --> C["classify: meme/ai/political/nsfw/utility/gaming/…"]
    B --> D["score: bundle_risk, organic_activity,\nsnipe_ratio, smart_money_concentration"]
    B --> E["news_match: cryptocurrency.cv headlines"]
    C --> F[("pump_coin_intel table")]
    D --> F
    E --> F
    F --> G["oracle_conviction\nLLM narrative + 0-100 conviction score"]
```

**Firewall** (`api/pump/safety.js`): SPL authority audit + simulated buy→sell round-trip (honeypot detection). Returns `allow | warn | block`. Logs to `firewall_decisions`.

---

### Community Features

#### Coin Clash (`api/clash/[action].js`)

Token-gated faction battle arena. Each pump.fun token = one faction. Holders prove on-chain holding via HMAC war pass. Epoch-based matchmaking. Full MCP integration: `@three-ws/clash-mcp`.

#### CoinCommunities (3D Token Worlds)

Every pump.fun coin is an enterable 3D world. `@coin-communities/sdk/node` provides the social layer. Holder pass (HMAC token) gates entry — server verifies on-chain balance via Helius DAS.

#### Agora — Agent & Human Economy (`api/agora/[action].js`)

AgenC on-chain task marketplace overlaid with a 3D city world. Agents and humans register, claim/complete tasks, earn $THREE. The `[action]` router exposes 4 GET reads (`citizens`, `board`, `pulse`, `passport`); the agent-action/task-execution write path lives in `api/agora/act.js`. Tables: `agora_citizens`, `agora_activity`, `agora_vouches`, `agora_idempotency`. Full MCP: `@three-ws/agora-mcp`. The platform's live narrow-AGI cognitive state is exposed at `api/agi/state.js`.

#### Creator-Fee & Social-Fee Sharing (`api/pump/[action].js`)

Revenue routing to coin creators and GitHub contributors: `collect-creator-fee`, `distribute-creator-fees`, `create-fee-sharing`, `update-fee-shares`, `fee-info`, `create-social-fee-pda`, `social-fee-claim-status`, `resolve-github-shareholder`/`github-resolve` (prep/agent variants). Tables `pump_buyback_runs`, `pump_distribute_runs`.

#### Coin Autopilot & Holder Cohorts

- **`api/pump/autopilot.js`** — per-coin autonomous policy engine (`pump_autopilot` table) gating the `run-buyback` and `run-distribute-payments` crons; owner-tunable buyback/distribution automation.
- **`api/coin/[mint]/cohorts.js`** — named holder audience slices (whales, etc.) backing `/go` bounty targeting, with creator-only paginated member export.
- **`api/pump/intel-enrich.js`** (+ `api/_lib/pump-intel/enrich.js`) — funder-resolution pass lighting up the bubble-map (writes `pump_coin_wallets.funder` + funder-derived signals on `pump_coin_intel`).

#### $THREE Leaderboard (`api/leaderboard.js`)

Paginated $THREE holder board ranked by on-chain balance. Seven tiers with per-wallet badges. Backed by `three-holders-snapshot` cron + Helius DAS API.

---

### Smart Money & Oracle

```mermaid
flowchart LR
    A["pump.fun coin data\n+ wallet_reputation\n+ coin_smart_money"] --> B["oracle score-loop\n(workers/oracle)"]
    B --> C["oracle_conviction\n(0-100 score + LLM narrative)"]
    C --> D["/api/oracle/feed SSE"]
    D --> E["browser\n(real-time tier chips on launches feed)"]
```

**Smart Money Rollup** (`cron/smart-money-rollup`): cross-references `pumpfun_graduations` with wallet history to build proven track records.

**Pre-launch Radar** (`workers/agent-sniper/prelaunch-radar.js`): block-zero pre-cog snipe. Watches `radar_watchlist` for creator/smart-money wallet activity before the mint appears publicly.

---

## Infrastructure & Deployment

### Monorepo Structure

```
three.ws/                        (root package v1.5.2, Node 24.x)
├── api/                         (~1,382 serverless-style handlers, served by Cloud Run)
│   └── _lib/                    (413 shared utilities)
├── src/                         (frontend JS modules)
├── pages/                       (150+ HTML entry points)
├── public/                      (static surfaces)
├── packages/                    (feature packages + MCP servers)
├── sdk/                         (top-level agent SDK)
├── solana-agent-sdk/            (TypeScript Solana SDK)
├── agent-payments-sdk/          (TypeScript payments SDK)
├── agent-protocol-sdk/          (TypeScript A2A protocol)
├── agent-ui-sdk/                (Three.js UI overlay SDK)
├── avatar-sdk/                  (web components)
├── walk-sdk/                    (walk companion SDK)
├── page-agent-sdk/              (page narrator SDK)
├── tour-sdk/                    (guided tour SDK)
├── mcp-server/                  (npm stdio MCP server)
├── mcp-bridge/                  (npm x402 bridge MCP)
├── character-studio/            (avatar creation Vite app)
├── multiplayer/                 (Colyseus room server)
├── workers/                     (21 long-running Node/Python/CF workers — sniper, oracle, mm, orders, agora, GPU/CPU mesh fleet, MCP mirror)
├── services/                    (stateful long-lived services — pump-graduations WS indexer)
├── crates/                      (Rust → WASM — vanity-grinder)
├── contracts/                   (Rust Anchor + Solidity)
├── infra/                       (AWS CDK TypeScript)
├── deploy/                      (Cloud Run + Docker configs — world, sniper)
├── data/                        (changelog.json, pages.json)
└── scripts/                     (build scripts, migrations)
```

**npm workspaces:** 43 packages declared in root `package.json` (30 under `packages/*` + 13 top-level SDKs/apps).

---

### Production Deployment (Google Cloud Run)

Production runs on **Google Cloud Run** (`three-ws-api`, region `us-central1`), migrated off Vercel on 2026-07-07. One Express container ([server/index.mjs](server/index.mjs)) serves the static `dist/` frontend, the `vercel.json` route table, and every `api/**` handler with Vercel-parity routing, fronted by a global HTTPS load balancer + Cloud CDN. Full ops runbook: [docs/ops/gcp-production.md](docs/ops/gcp-production.md).

**Config:** `vercel.json` is still the live route/cron config the server reads at runtime — **~1,079 entries** in the `routes` array mapping URL patterns to `api/*.js` handlers and static assets, plus a `functions` block and **~80 `crons`**. Not legacy, not deleted.

**Deploy:** `npm run deploy:gcp` (`check:dist` → `db:check` → `gcloud builds submit --config server/cloudbuild.yaml` → CDN purge). Frontend changes need `npm run build` first.

**Crons:** the ~80 `vercel.json` cron schedules run on **Google Cloud Scheduler** (provisioned by `scripts/create-gcp-scheduler.mjs`), which calls each `GET /api/cron/*` endpoint on its schedule.

**Function runtime:** Node.js ESM (required for gRPC, Puppeteer, `node:crypto`).

**⚠️ Warning:** `npx vercel build` overwrites `api/*.js` source files with esbuild bundles. Never commit `api/` after a local Vercel build. Recover with `git restore -- api/ public/`.

---

### Vite Frontend Build

**Config:** `vite.config.js`

| Setting | Value |
|---------|-------|
| Build targets | `TARGET=app` (default MPA) · `TARGET=lib` (CDN bundle) |
| HTML entry points | 150+ auto-resolved from `pages/` + `public/` |
| Dev server port | 3000 |
| API proxy | `/api/*` → `DEV_API_PROXY` (default: `https://three.ws`) |
| Manual chunks | `three-core`, `three-addons`, `ethers`, `solana`, `mediapipe`, `node-polyfills` |
| PWA | `vite-plugin-pwa` (Workbox), stripped from embed pages |
| Codespace HMR | supported |

---

### Database (Neon Postgres)

**Driver:** `@neondatabase/serverless` HTTP driver (tagged-template `sql` with composable fragments)

**Schema:** `api/_lib/schema.sql` — ~295 tables (full list in [Database Schema — Complete Table Index](#database-schema--complete-table-index))

**Migrations:** `api/_lib/migrations/` — 259 dated migration files (2026-04-29 through 2026-07-02)

Key table groups:

| Group | Tables |
|-------|--------|
| Identity | `users`, `sessions`, `agent_identities`, `erc8004_agents_index` |
| Wallets | `master_wallets`, `agent_wallets`, `agent_revenue_events`, `agent_payout_wallets` |
| Payments | `skill_purchases`, `purchase_receipts`, `x402_payments`, `x402_merchant_settings`, `x402_skus`, `siwx_payments` |
| Agents | `agent_memories`, `agent_strategies`, `agent_sniper_strategies`, `agent_sniper_positions` |
| Pump.fun | `pump_agent_mints`, `pump_coin_intel`, `oracle_conviction`, `oracle_narrative`, `wallet_reputation`, `coin_smart_money` |
| Market | `market_maker_policies`, `dca_strategies`, `copy_subscriptions`/`copy_executions`, `agent_mirror_follows`/`agent_mirror_fills`, `swarms`, `agent_vaults` |
| Community | `agora_citizens`, `agora_activity`, `clash_battles`, `tournaments`/`tournament_entries`, `agent_bounties`/`agent_jobs` |
| x402 | `x402_pump_launches`, `x402_checkout_records`, `bsc_consumed_tx` |
| Infrastructure | `radar_watchlist`, `radar_events`, `firewall_decisions`, `bot_heartbeat` |

---

### Upstash Redis

**Config:** `api/_lib/redis.js` + `api/_lib/cache.js`

Two logical stores:
- **Rate-limit store:** `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (aliases: `three_KV_REST_API_URL`, `KV_REST_API_URL`)
- **Cache store:** `UPSTASH_CACHE_REST_URL` / `UPSTASH_CACHE_REST_TOKEN`

In-memory fallback when unset.

**⚠️ Known issue:** Free plan hit 500k/month command ceiling in June 2026, causing rate limiter fail-closed outage. Quota monitoring requires optional `UPSTASH_EMAIL` + `UPSTASH_MANAGEMENT_API_KEY`.

---

### Cloudflare R2

**Config:** `api/_lib/r2.js` — `@aws-sdk/client-s3` pointing at `S3_ENDPOINT`

Public CDN: `S3_PUBLIC_DOMAIN`

Route: `/cdn/<key>` → `/api/cdn-object?key=<key>` (`vercel.json` route rewrite)

Stores: GLBs · audio clips · thumbnails · manifests · OG images · validation reports

---

### Other Infrastructure

| Service | Config | Description |
|---------|--------|-------------|
| AWS CDK | `infra/lib/three-ws-stack.ts` | Account `155407237916`, `us-east-1`. `ThreeWsStack`: S3 bucket `3d-agent-avatars` (RETAIN, `tmp/` 1-day lifecycle, CORS), Forge Lambda `three-ws-forge` (NODEJS_22_X, ARM_64, 1536 MB, 20s, public Function URL GET-only), log groups `/three-ws/api` + `/aws/lambda/three-ws-forge`, AppRegistry MyApplications association. CfnOutputs: `ForgeUrl`, `AvatarBucketName`, `AvatarBucketArn`. |
| GCP Cloud Run (world) | `deploy/world/cloudrun.yaml` | Hyperfy world (`world.three.ws`), SQLite + GCS volume. SA `hyperfy-world-sa@…`, secret `hyperfy-admin-code` (in-world `/admin <code>` claims build rights). Project `aerial-vehicle-466722-p5`, us-central1. |
| GCP Cloud Run (sniper) | `deploy/sniper/cloudrun.yaml` | `agent-sniper` long-lived worker. **`minScale=maxScale=1` is load-bearing** — the in-process per-agent spend lock (`executor.js`) makes a second instance double-spend. `SNIPER_MODE` defaults to `simulate` (real quotes, no broadcast); `live` is a deliberate separate cutover. SA `agent-sniper-sa@…`, deploy via `scripts/deploy-sniper.mjs`, status at `/api/sniper/status`. |
| GCP Cloud Run (GPU/CPU fleet) | `workers/*/cloudbuild.yaml` + `workers/deploy/` | Avatar pipeline (controller + mesh models + UniRig + reconstruction/longcat/texture/etc.) on NVIDIA L4. Quota `nvidia_l4_gpu_allocation_no_zonal_redundancy`. Buckets `gs://three-ws-avatar-reconstructions`, `gs://three-ws-avatar-videos`; job state in Firestore. |
| Colyseus | `multiplayer/` | Authoritative real-time room server (:2567), 4 rooms, HMAC-gated — see [Multiplayer / Networked 3D](#multiplayer--networked-3d-multiplayer). Deploys to Fly.io + Cloud Run |
| Sentry | `api/_lib/sentry.js` | Error capture via raw envelope API (no SDK weight) |
| Axiom | `api/_lib/axiom.js` | x402 payment metrics (`AXIOM_TOKEN`, `AXIOM_DATASET`) |
| Resend | `api/_lib/email.js` | Transactional email (`RESEND_API_KEY`) |
| Telegram | `api/_lib/alert-delivery.js` | Oracle alerts + changelog push |
| PostHog | `vite.config.js` (ingest proxy) | Analytics + session recording |
| Renovate | `renovate.json` | Automated weekly dependency updates |

---

### Critical Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | required | Neon Postgres connection |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` | required | Redis rate limiting |
| `S3_ENDPOINT` + `S3_BUCKET` + `S3_PUBLIC_DOMAIN` | required | Cloudflare R2 |
| `JWT_SECRET` | required | Session token signing |
| `WALLET_ENCRYPTION_KEY` | critical | Custodial keypair encryption — dedicated key, AES-256-GCM `v2:` scheme with per-record salt (`api/_lib/secret-box.js`). `JWT_SECRET` is **legacy v1 read-only** fallback for pre-2026-06-19 records, not the active encryptor |
| `SOLANA_RPC_URL` | required | Solana mainnet RPC |
| `ANTHROPIC_API_KEY` | critical | Claude models |
| `OPENAI_API_KEY` | critical | OpenAI TTS + GPT models |
| `NVIDIA_API_KEY` | required | NVIDIA NIM (Magpie, Riva, A2F, free LLMs) |
| `WATSONX_API_KEY` + `WATSONX_PROJECT_ID` | required | IBM watsonx.ai Granite |
| `GROQ_API_KEY` | required | Groq fast inference (free tier primary) |
| `PUMPFUN_BOT_URL` | required | pump.fun indexer backend |
| `THREEWS_SOL_PARENT_SECRET_BASE58` | required | SNS subdomain minting keypair |
| `THREE_TREASURY_WALLET` + `THREE_REWARDS_WALLET` | required | $THREE token distribution |
| `HELIUS_API_KEY` | required | Enhanced Solana data + holder snapshots |
| `PRIVY_APP_ID` + `PRIVY_APP_SECRET` | required | Privy auth |
| `ELEVENLABS_API_KEY` | optional | Voice cloning + premium TTS |
| `AIXTBT_API_KEY` | optional | aixbt market intelligence |
| `OPENROUTER_API_KEY` | optional | Multi-model fallback routing |
| `CRON_SECRET` | optional | Cron job auth (unauthenticated if unset) |
| `AGENT_RELAYER_KEY` | declared req() | ERC-7710 delegation relayer (hard-required in env.js, breaks cold starts if unset) |
| `SENTRY_DSN` | optional | Error reporting |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHANGELOG_CHAT_ID` | optional | Alert delivery + changelog push |

---

### Repository Directory Reference

The complete top-level directory map — every directory, its purpose, file counts, and where it is documented in depth — lives in [Repository Directory Atlas](#repository-directory-atlas).

---

### Testing & QA

Full test-suite layout (runners, per-directory counts, heaviest-tested subsystems) is documented under [Testing & Quality Assurance](#testing--quality-assurance) and [Build, Test & Release Pipeline](#build-test--release-pipeline).

---

### Build, Migration & Audit Scripts (`scripts/`)

400+ Node scripts (`.mjs`/`.js`) backing the build and ops surface:

| Group | Examples | Purpose |
|-------|----------|---------|
| Build | `build-animations.mjs`, `build-vercel.mjs`, `build-pages.mjs`, `build-cache.mjs`, `build-apps-sdk-viewer.mjs` | Asset/clip baking, Vercel function bundling, changelog/pages generation |
| Schema & migration | `apply-migrations.mjs`, `apply-schema.mjs`, `apply-siwx-migration.mjs`, `apply-delegations-schema.js` | Apply `api/_lib/migrations/` to Neon |
| Backfill | `backfill-agent-wallets.mjs`, `backfill-erc8004.mjs`, `backfill-avatar-thumbnails.mjs`, `backfill-rig-meta.mjs` | One-shot data repair / hydration |
| Audit | `audit-links.mjs`, `audit-console.mjs`, `audit-deploy-artifacts.mjs`, `audit-mcp-manifests.mjs`, `audit-page-index.mjs` | Automated hygiene checks |
| Mint / on-chain | `batch-mint-agents.mjs`, `agent-invocation-smoke.mjs` | Bulk agent minting, program smoke tests |
| Publish | `publish-packages.mjs` | Idempotent npm publish of `@three-ws/*` packages |
| Asset baking | `build:club-{props,venue,hdri,audio,entrance-venue,assets}`, `build:walk-environments`, `bake:mannequin`, `build:wasm`, `build:canonical-rest`, `convert:fbx`, `extract:animations` | Club venue/prop/HDRI GLBs, walk environments, mannequin/rest-pose bake, WASM grinder build |
| i18n & verify | `i18n`/`i18n:{extract,translate,lint}`, `verify:{solana,onchain,x402}`, `smoke:{onchain,agent-wallet,mcp}` | Localization pipeline + on-chain/x402 verification + smoke tests |

**`npm run gate`** is the de-facto pre-push composite check (no GitHub Actions runner exists): `test:gate && audit:mcp && audit:routes && audit:handlers && audit:pages && audit:hidden-guard`. `package.json` defines **118 scripts** total.

---

### Specifications & Protocol Documents (`specs/`)

Authoritative format/protocol specs that the code implements:

| Spec | Defines |
|------|---------|
| `AGENT_MANIFEST.md` · `3D_AGENT_CARD.md` | Agent identity + manifest schema (ERC-8004 / agent card) |
| `EMBED_SPEC.md` · `EMBED_HOST_PROTOCOL.md` | `<agent-3d>` embed contract + host↔iframe message protocol |
| `EDITOR_SPEC.md` | Scene/avatar editor contract |
| `MEMORY_SPEC.md` | Tiered memory + `.brain` export format |
| `SKILL_SPEC.md` | Skill definition, pricing, licensing |
| `PERMISSIONS_SPEC.md` | ERC-7710 delegation & permission model |
| `ENS_AGENT_CLAIM.md` | ENS / SNS agent name claim flow |
| `STAGE_SPEC.md` | Stage/scene (live show) contract |
| `VALIDATORS.md` | Validator definitions (ERC-8004 ValidationRegistry) |
| `SECURITY.md` · `CLAUDE_ARTIFACT.md` | Security model + Claude artifact contract |

`specs/schema/` holds 6 canonical SQL DDL files defining spec-level table contracts (`agent_delegations`, `agent_subscriptions`, `dca_strategies`, `embed-policy`, `indexer_state`, `voice-cloning`) + a README. (Note: the x402 v2 spec lives in `docs/x402.md`, not `specs/`.)

---

### Mobile, Embeds & Integrations

| Surface | Path | Description |
|---------|------|-------------|
| Solana Mobile (Seeker) | `solana-mobile/` | dApp Store submission: Trusted Web Activity + PWA wrapper, `publish/` config, `.well-known/` association |
| LobeHub chat plugin | `chat-plugin/` | `@three-ws/chat-plugin` — sidebar plugin rendering an embodied avatar |
| Standalone chat UI | `chat/` | `three.ws-chat` — fast, light, BYOK multi-provider chat (own Vite app) |
| OpenAI Apps SDK | `apps-sdk/` | `embodiment/` helpers + `studio-viewer/` for ChatGPT-app embedding |
| Browser extension | `extensions/walk-avatar/` | Walk-companion avatar as a browser extension |
| Blender bridge | `integrations/blender/` | `three_ws` Blender add-on |
| ComfyUI nodes | `integrations/comfyui/` | `three_ws_nodes` custom nodes |
| Python client | `integrations/_pyclient/` | `three_ws_client.py` reference client + drift tests |

---

### Reference Agents & Skills (`examples/`)

Runnable reference implementations that exercise the live platform:

- **`agents/`** — standalone agents: `endpoint-shopper` (x402 service shopper), `fact-checker`, `tutor`, `unstoppable`.
- **`pump-fun-skills/`** — composable pump.fun skill modules: `create-coin`, `swap`, `coin-fees`, `reactive`, `tokenized-agents`.
- **`examples/`** — embed & integration demos: `coach-leo` (VR), `agenc-task-roundtrip`, `pump-fun-agent`, `metamask-agent-wallet`, `three-concierge` (concierge agent with `SKILL.md`/`agent-card.json`/`manifest.json`), plus runnable HTML: `bare-avatar`, `minimal`, `web-component`, `agent-presence`, `agent-wallet-embed`, `widget-rpc`, `two-agents`, `one-line-demo`, `embed-test`.
- **`examples/skills/`** — `pump-fun`, `pump-fun-compose`, `pump-fun-strategy`, `pump-fun-trade`, `solana-wallet`, `wave`.

---

## Data Flows

### 1. User Creates an Avatar

```mermaid
flowchart TD
    A["Avatar Studio (browser)\nsrc/avatar-studio.js"]
    R2[("Cloudflare R2")]
    A -->|"load base template GLB"| R2
    A --> B["User sculpts morphs, picks colors, adds accessories"]
    B --> C["GLTFExporter serializes to GLB Blob"]
    C -->|"POST /api/avatar/presign-glb"| D["Presigned R2 upload URL"]
    D -->|"PUT to R2"| R2
    R2 -->|"api/_lib/avatars.js"| E["canonicalizeGLBBones()\nsrc/glb-canonicalize.js\nrewrites joint names to canonical Avaturn set"]
    E -->|"canonical GLB"| R2
    E -->|"POST /api/avatars"| DB[("Neon DB")]
    DB --> AM["AnimationManager.attach()\nretargetClip() per clip against uploaded skeleton\nAnimationMixer drives runtime animation"]
```

### 2. Agent Pays for a Service (A2A x402)

```mermaid
sequenceDiagram
    participant A as Agent (MCP client/worker)
    participant X as /api/x402-pay
    participant T as Target Endpoint
    participant F as PayAI Facilitator
    participant N as Neon DB

    A->>T: GET target endpoint
    T-->>A: 402 Payment Required
    A->>X: POST { url, agentId }
    X->>X: probeExternalRequirements (parse 402 challenge)
    X->>X: reserveSpendUsd (Upstash atomic spend cap check)
    X->>X: loadAgentKeypair (decrypt AES-256-GCM)
    X->>X: buildSolanaPaymentPayload (sign SPL transferChecked)
    X->>T: guardedFetch with X-PAYMENT header
    T->>F: POST /verify
    F-->>T: verified
    T->>T: handler executes
    T->>F: POST /settle (on-chain)
    F-->>T: settled
    T-->>X: response
    X->>N: updateCustodyEvent (finalize ledger)
    X-->>A: SSE stream: challenge → built → verified → settled → result
```

### 3. User Launches a Pump.fun Token

```mermaid
sequenceDiagram
    participant B as Browser (launch-token-modal.js)
    participant A as /api/pump/
    participant W as Phantom Wallet
    participant S as Solana mainnet
    participant P as PumpPortal WSS
    participant O as Oracle

    B->>A: POST /launch-prep { metadata, imageUrl }
    A->>A: upload image to pump.fun IPFS
    A->>A: optional WASM vanity mint grind
    A-->>B: unsigned createV2 tx + metadata URI
    B->>W: Sign transaction
    W-->>B: Signed tx
    B->>A: POST /launch-confirm { signedTx }
    A->>S: submit to Solana mainnet
    S-->>A: confirmation
    A->>A: INSERT pump_agent_mints
    P->>A: intel watcher picks up mint from PumpPortal WSS
    A->>A: classify + score → pump_coin_intel
    A->>O: oracle score-loop → oracle_conviction
    O-->>B: /launches feed shows coin with real-time conviction chip
```

### 4. MCP Client Calls a Paid 3D Tool

```mermaid
sequenceDiagram
    participant C as Claude Desktop / Cursor
    participant M as @three-ws/mcp-server (stdio)
    participant X as x402 Facilitator
    participant A as /api/forge
    participant G as GPU Worker (TRELLIS/TripoSG)
    participant R as Cloudflare R2

    C->>M: tool: mesh_forge { prompt: "a dragon" }
    M-->>C: @x402/mcp PaymentRequired challenge
    C->>X: user approves USDC payment on Solana
    X-->>M: payment verified
    M->>A: POST /api/forge { prompt, tier: "standard" }
    A->>A: forge-tiers.js selects backend
    A->>G: submit job
    G-->>A: GLB ready
    A->>R: write GLB to R2
    A-->>M: { glb_url, preview_url, mint_address }
    M-->>C: receipt returned to MCP client
```

### 5. Agent Memory Write and Recall

```mermaid
flowchart TD
    A["agent runtime (chat turn)"] --> B["message arrives at /api/chat"]
    B --> C["recallForChat()"]
    C --> D["api/_lib/memory-store.js computeContext()"]
    D --> E["embedQuery\n(NVIDIA NIM nv-embedqa-e5-v5)"]
    E --> F["cosine similarity in JS\n(JSONB embeddings on agent_memories)"]
    F --> G["top-k working + recall tier memories\ninjected into system prompt"]
    G --> H["LLM generates response"]
    H --> I["POST /api/agent-memory { content, type }"]
    I --> J["ERC-191 sign with agent's EVM wallet"]
    J --> K["INSERT agent_memories"]
    K --> L["lazy: embed content → JSONB embedding update"]

    subgraph Reflect["reflect-sweep cron (daily)"]
        R1["gatherReflectionContext\n(recent memories)"]
        R2["llmComplete\n(claude-opus-4-7 → Groq fallback)"]
        R3["INSERT 'dream' memory\nwith provenance citations"]
        R1 --> R2 --> R3
    end

    K --> Reflect
```

### 6. User Buys a Skill from the Marketplace

```mermaid
sequenceDiagram
    participant B as Browser (marketplace-detail.js)
    participant A as /api/marketplace/
    participant W as Buyer Wallet (Solana Pay)
    participant S as Solana mainnet
    participant M as Metaplex Core

    B->>A: POST /purchase { agentId, skillName, price }
    A->>A: create pending skill_purchases row + Solana Pay reference
    A-->>B: Solana Pay reference
    B->>W: Sign Solana Pay transaction
    W->>S: Submit transaction
    B->>A: POST /purchase/:ref/confirm
    A->>S: findReference (on-chain tx lookup)
    A->>S: validateTransfer (SPL amount + recipient check)
    A->>A: confirmSkillPurchase()
    A->>A: agent_revenue_events (fee split: platform fee + author)
    A->>A: purchase_receipts (signed receipt)
    A->>M: POST /api/skills/mint → mintSkillNft()
    M->>M: lazy-create Metaplex Core collection on first sale
    M->>S: mint 1-of-1 NFT to buyer wallet
    A->>A: skill_purchases.nft_mint updated
    A-->>B: buyer gains skill access (check-skill-access gate)
```

### 7. Browser Streams Live Market Intelligence

```mermaid
sequenceDiagram
    participant B as Browser (radar.html)
    participant S as /api/pump/coin-intel SSE
    participant DB as pump_coin_intel DB
    participant W as WebGL Coin3D

    B->>S: EventSource('/api/pump/coin-intel?stream=1')
    loop SSE polling
        S->>DB: poll pump_coin_intel
        DB-->>S: { mint, name, symbol, category, riskScore, conviction }
        S-->>B: SSE event
        B->>B: render coin cards with real-time tier chips
    end
    B->>S: GET /api/pump/coin-intel?mint=:mint (on card click)
    S->>DB: aggregate: pump.fun API + oracle_conviction + wallet_reputation
    DB-->>S: detailed coin data
    S-->>B: detailed coin data
    B->>W: render spinning medallion + holder galaxy + bonding-curve ring
```

---

## External Integrations

### Blockchain

| Service | Usage |
|---------|-------|
| Solana mainnet/devnet | Agent wallets, token launches, SPL transfers, program calls |
| Base mainnet | EIP-3009 USDC x402 settlement, ERC-8004 registry |
| Arbitrum | ERC-8004 registry, ThreeWSPayments |
| BSC | ThreeWSPayments (load-bearing), ThreeWSFactory |
| Polygon | ERC-8004 registry |
| Ethereum + 8 more EVM chains | ERC-8004 IdentityRegistry/ReputationRegistry deployments |
| pump.fun | Bonding-curve launches, buy/sell, fee sharing, agent payments |
| Jupiter Aggregator | Token swaps (solana-agent-sdk, pumpfun-skills) |
| Pyth Network | SOL/USD price oracle |
| Helius | Enhanced Solana RPC, DAS API, holder snapshots, webhooks |
| Metaplex (mpl-core) | NFT minting for skill licenses |
| Bonfida SNS | `.sol` domain resolution, `threews.sol` subdomain minting |
| AgenC / @tetsuo-ai/sdk | On-chain task coordination (Agora) |
| Ethereum Attestation Service (EAS) | On-chain attestations |
| ERC-7710 DelegationManager | MetaMask delegation framework (opt-in, disabled by default) |
| Coinbase CDP / PayAI | x402 facilitator (verify + settle) |

### AI / LLM

| Service | Models / Usage |
|---------|---------------|
| Anthropic | claude-fable-5, claude-mythos-5, claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 (chat, brain, reflect) |
| OpenAI | GPT-5.6 family (sol/terra/luna), GPT-5.5 + GPT-5.4 tiers, gpt-5.3-codex, o3/o3-pro, text-embedding-3-small, TTS |
| NVIDIA NIM | Nemotron-super-120b, DeepSeek-v4-pro, Kimi-k2.6, Llama-4-Maverick, MiniMax-M2.7, nv-embedqa-e5-v5 |
| NVIDIA NIM Vision | Nemotron-nano-12B-v2-VL, Llama-3.2-11B-vision |
| NVIDIA Magpie TTS | gRPC/NVCF, multilingual TTS |
| NVIDIA Riva ASR | gRPC, speech-to-text |
| NVIDIA Audio2Face-3D | bidirectional gRPC, ARKit-52 blendshapes |
| NVIDIA NemoGuard | llama-3.1-nemoguard-8b-content-safety |
| NVIDIA Cosmos | text-to-world video (async MP4) |
| IBM watsonx.ai | Granite-3.8B Instruct (chat, embed, tokenize), Granite Guardian (safety), watsonx Orchestrate |
| Groq | llama-3.3-70b-versatile, llama-3.1-8b-instant (fast inference, free tier) |
| OpenRouter | 50+ models via fallback routing |
| DashScope / Qwen | qwen-plus |
| DeepSeek | deepseek-reasoner (R1) |
| ElevenLabs | Voice cloning, premium TTS |
| Livepeer | AI gateway LLM inference alternative |
| aixbt (indigo) | Crypto market narrative intelligence, REST v2 |

### 3D Generation

| Service | Usage |
|---------|-------|
| TRELLIS (NVIDIA) | Text/image → 3D mesh (free tier primary) |
| Hunyuan3D (GCP Cloud Run) | Image → 3D mesh |
| TripoSR / TripoSG (GCP Cloud Run) | Image → 3D mesh |
| Meshy | Text/image → 3D (BYOK) |
| Rodin (Hyperhuman) | Avatar generation |
| Replicate | Auto-rig, 3D generation |
| Stability AI | Image generation |
| UniRig (SIGGRAPH 2025) | Auto-rig: skeleton + skinning + ARKit blendshapes |
| Avaturn | Photo-to-avatar pipeline |

### Infrastructure & Observability

| Service | Usage |
|---------|-------|
| Google Cloud Run | **Primary production host** (`three-ws-api`, `us-central1`) — the Express container serving the frontend + all `api/**` handlers; also the Python GPU workers and `world.three.ws` Hyperfy |
| Google Cloud Scheduler | Executes the ~80 `vercel.json` cron schedules against `/api/cron/*` |
| Google Cloud Load Balancing + CDN | Global HTTPS front door + edge cache for `three.ws` |
| Google Cloud Firestore | Avatar pipeline job state |
| Google Cloud Storage (GCS) | Model output GLBs, motion clips |
| AWS Lambda (CDK) | Forge sculptor renderer, S3 avatar bucket |
| Cloudflare R2 | Primary blob storage (GLBs, audio, thumbnails) |
| Neon (Postgres) | Primary relational database (serverless HTTP) |
| Upstash Redis | Rate limiting, response caching, spend ledger |
| Upstash QStash | Durable job queue for crons |
| Sentry | Error capture |
| Axiom | Payment metrics |
| PostHog | Analytics, session recording |
| Resend | Transactional email |
| Telegram Bot API | Alerts + changelog publishing |
| Renovate | Automated dependency updates |

### Auth & Identity

| Service | Usage |
|---------|-------|
| Privy | Email OTP, EVM SIWE, embedded wallet |
| GitHub OAuth | Memory seeding from repository activity |
| X/Twitter OAuth 2.0 | Memory seeding from tweet history |
| SAML 2.0 (node-saml) | Enterprise SSO (IBM Cloud App ID, Okta, Azure AD) |
| WalletConnect | EVM wallet connectivity |
| Phantom | Solana wallet (primary) |
| Farcaster / Neynar | Social graph, memory seeding from casts |
| IPFS / Pinata | Agent metadata pinning |
| web3.storage | ERC-8004 manifest IPFS pinning |
| AWS Marketplace | SaaS subscription resolve/meter/entitlement |

### Market Data

| Service | Usage |
|---------|-------|
| PumpPortal WebSocket | Live new-mint + trade feeds |
| pump.fun frontend REST | Coin metadata, creator profiles, trending |
| Birdeye | Trending token prices (circuit-breaker primary) |
| CoinGecko | SOL/USD price (1-min cache) |
| CoinCommunities SDK | Social layer for coin worlds |
| cryptocurrency.cv | Real-time news headlines (oracle intel) |

---

## Documentation Map (`docs/`)

`docs/` holds 100+ public Markdown docs plus themed subdirectories. This is the canonical narrative documentation that ARCHITECTURE.md summarizes; consult it for depth on any subsystem.

### Core guides

| Doc | Covers |
|-----|--------|
| `introduction.md` · `how-it-works.md` · `start-here.md` · `quick-start.md` | Platform onboarding |
| `architecture.md` · `layers.md` | Narrative architecture (companion to this file) |
| `api-reference.md` · `api/` · `js-api.md` | REST + JS API reference |
| `sdk.md` | SDK usage |
| `mcp.md` · `mcp-3d-studio.md` · `mcp-agent.md` · `mcp-studio.md` · `mcp-x402-bazaar.md` · `ibm-x402-mcp.md` | MCP server catalogs |
| `x402.md` · `aws-builder-center-marketplace-x402.md` | x402 payment rail |
| `smart-contracts.md` · `solana.md` · `solana-pumpfun.md` · `solana-reputation.md` · `onchain-agents.md` · `erc8004.md` | On-chain systems |
| `memory.md` · `multi-agent.md` · `persona-hub.md` · `agent-system.md` · `agent-manifest.md` · `agent-reputation.md` | Agent intelligence |

### 3D, avatar & creation

`3d-asset-pipeline.md` · `animations.md` · `avatar-creation.md` · `character-studio.md` · `editor.md` · `viewer.md` · `validation.md` · `web-component.md` · `embedding.md` · `widgets.md` · `widget-api.md` · `widget-studio.md` · `ar.md` · `share-and-embed.md` · `nvidia-models.md` · `voice` (see `js-api.md`).

### Surfaces, identity & ops

`agora.md` · `irl/` · `reputation.md` · `sas-attestations.md` · `authentication.md` · `permissions.md` · `hold-to-access.md` · `i18n.md` · `do-i-need-crypto.md` · `make-your-agent.md` · `configuration.md` · `deployment.md` · `build.md` · `troubleshooting.md` · `contributing.md` · `security.md` · `security/`.

### Themed subdirectories

| Subdir | Contents |
|--------|----------|
| `docs/tutorials/` | 43 step-by-step tutorials |
| `docs/internal/` | 26 internal specs & proposals (e.g. SNS partnership) |
| `docs/ux-flows/` | 12 UX flow walkthroughs |
| `docs/audits/` · `docs/audit/` | 16 audit reports |
| `docs/improvement-plans/` | 11 improvement plans |
| `docs/x402-offer-receipt/` | 7 x402 offer/receipt protocol docs |
| `docs/pumpfun-program/` | 6 pump.fun program references |
| `docs/zauth/` | 5 auth/identity protocol docs |
| `docs/ops/` · `docs/security/` | Operational + security runbooks |
| `docs/ibm.md` · `docs/aws-*` · `docs/nvidia-inception/` | Partner integration kits (IBM watsonx, AWS Marketplace, NVIDIA Inception) |

> `docs/ALL.md` (3.4 MB) is a generated concatenation of the entire docs tree; `docs/llms.txt` / `docs/llms-full.txt` are the LLM-discovery indexes.

> **Prompt / work-order collections** (agent-dispatch task files and campaign runbooks — not product docs) live under the top-level [`prompts/`](prompts) directory, not `docs/`: `store-submissions/`, `agent-briefs/`, and `roadmap/` (moved out of `docs/`), alongside `gcp-credits/`, `okx-ai/`, `x402-catalog/`, and `x402-overhaul/`.

---

## Exhaustive Subsystem Reference

This section enumerates the full internal surface area that the higher-level sections summarize — the complete `api/` feature tree, the `api/_lib/` utility layer, every `src/` subsystem, the agent-discovery files, and the public static apps.

### API Feature Directory Index (`api/`)

The serverless tree holds **146 feature directories + 115 top-level handler files**. Beyond the feature areas detailed under [API Endpoints by Feature Area](#api-endpoints-by-feature-area), the complete directory map is:

| Group | `api/` directories |
|-------|--------------------|
| Identity & auth | `auth/` · `oauth/` · `users/` · `user/` · `api-keys/` · `keys/` · `permissions/` · `custody/` · `registry/` · `erc8004/` · `onboarding/` |
| Agents & brain | `agents/` · `agent/` · `agent-3d/` · `agent-economy/` · `agent-trade/` · `autopilot/` · `genome/` · `dad/` · `persona/` · `brain/` · `memory/` · `seed/` · `agi/` |
| Avatars & 3D | `avatar/` · `avatars/` · `animations/` · `mocap/` · `render/` · `scene/` · `studio/` · `studio-assets/` · `cz/` · `frames/` · `forever/` |
| Pump.fun & markets | `pump/` · `pump-bounties/` · `oracle/` · `sniper/` · `signals/` · `intel/` · `aixbt/` · `kol/` · `traders/` · `trades/` · `trading/` · `insights/` · `portfolio/` · `token/` · `three-token/` · `launch/` · `launchpad/` |
| Strategies & social trading | `mirror/` · `copy/` · `swarms/` · `vaults/` |
| x402 & payments | `x402/` · `x402-pay/` · `pay/` · `payments/` · `bazaar/` · `ca2x402/` · `billing/` · `credits/` · `onramp/` · `purchase/` · `subscriptions/` · `monetization/` · `ledger/` · `tx/` · `usage/` |
| Marketplace & assets | `marketplace/` · `creators/` · `skills/` · `plugins/` · `assets/` · `cosmetics/` · `rider/` · `referral/` |
| Community & worlds | `agora/` · `agenc/` · `clash/` · `club/` · `community/` · `crews/` · `friends/` · `social/` · `stage/` · `play/` · `world/` · `galaxy/` · `irl/` · `share/` · `tournaments/` · `bounties/` · `labor/` |
| MCP servers | `_mcp/` · `_mcp3d/` · `_mcp-studio/` · `_mcpagent/` · `_mcpbazaar/` · `_mcpibm/` · `_studio/` · `_providers/` |
| AI / voice / LLM | `chat/` · `llm/` · `tts/` · `watsonx/` · `ibm/` · `guardian/` · `inference/` · `tutor/` |
| Naming & on-chain | `threews/` · `three/` · `nft/` · `pinning/` · `reputation/` · `sdp/` |
| Infra, SEO & ops | `cron/` · `sitemap/` · `rss/` · `og/` · `webhooks/` · `push/` · `notifications/` · `developer/` · `platform/` · `admin/` · `jobs/` · `embed/` · `widgets/` · `dashboard/` · `demo/` · `actions/` · `v1/` · `api/` |
| Partner / distribution | `aws-marketplace/` · `lobehub/` · `chat-plugin/` |
| Social (X) | `x/` |
| Vanity | `vanity/` |

### `api/_lib/` — Full Utility Catalog

The shared library is **~370 modules + 19 subpackages**. Beyond the core modules already listed under [Core Utility Modules](#core-utility-modules-api_lib), they group as:

| Domain | Representative modules |
|--------|------------------------|
| Auth & identity | `account-auth.js` · `account-tier.js` · `siwe.js` · `siws.js` · `siwx-server.js` · `siwx-storage.js` · `saml.js` · `privy.js` · `csrf.js` · `zauth.js` · `agent-identity.js` · `agent-registry.js` · `identity-integrity.js` · `agent-recovery.js` |
| Wallet & custody | `agent-wallet.js` · `avatar-wallet.js` · `solana-wallet.js` · `agent-usdc-transfer.js` · `solana-transfer.js` · `evm-transfer.js` · `balances.js` · `custody-proof.js` · `wallet-anomaly.js` · `wallet-capabilities.js` · `wallet-intents.js` · `secret-box.js` · `crypto.js` · `resolve-recipient.js` |
| x402 & payments | `x402.js` · `x402-spec.js` · `x402-paid-endpoint.js` · `x402-buyer-fetch.js` · `x402-buyer-axios.js` · `x402-user-payer.js` · `x402-bsc-direct.js` · `x402-solana-confirm.js` · `x402-spending-cap.js` · `x402-spending-ledger.js` · `x402-spending-price.js` · `x402-prices.js` · `x402-errors.js` · `x402-builder-code.js` · `evm-payment-verify.js` · `fee.js` · `splits.js` · `payout.js` · `credits.js` · `credit-deposit.js` · `metering.js` · `usage.js` · subdir `x402/` |
| Agent runtime & economy | `agent-economy.js` · `agent-delegate.js` · `agent-spend-policy.js` · `spend-policy-compiler.js` · `spend-policy-rules.js` · `agent-trade-guards.js` · `agent-strategy-runtime.js` · `agent-paid-services.js` · `agent-pumpfun.js` · `agent-mirror.js` · `agent-labor.js` · `genome.js` · `genome-agent.js` · `networth-model.js` · `patronage.js` · `monetization.js` · `treasury-autopilot.js` · subdir `a2a/` |
| Memory & AI | `memory-store.js` · `memory-entities.js` · `embeddings.js` · `embedding-math.js` · `agent-embeddings.js` · `chunker.js` · `rerank.js` · `reflection.js` · `brain-bundle.js` · `brain-anchor.js` · `brain-sign.js` · `llm.js` · `llm-health.js` · `llm-pricing.js` · `chat-models.js` · `provider-health.js` · `provider-keys.js` · `orchestrate.js` · `watsonx.js` · `watsonx-forecast.js` · `granite-guardian.js` · `moderation.js` · `vision.js` · `text-extract.js` · `strip-reasoning.js` · `reasoning-ledger.js` · `circulation.js` · `circulation-personas.js` · `persona-store.js` |
| Voice & 3D media | `tts-nvidia.js` · `tts-voices.js` · `asr-nvidia.js` · `a2f-nvidia.js` · `elevenlabs.js` · `render-clip.js` · `render-glb.js` · `glb-compress.js` · `glb-inspect.js` · `glb-quality.js` · `glb-themer.js` · `bake.js` · `model-inspect.js` · `rig-inspect.js` · `auto-rig.js` · `auto-rig-eligibility.js` · `avatars.js` · `avatar-render.js` · `avatar-agent.js` · `avatar-alt-text.js` · `accessories.js` · `cosmetics.js` · `cosmetics-economy.js` · `cosmetics-ownership.js` · `avaturn-headless.js` · `avaturn-seed.js` · `fetch-model.js` · subdirs `a2f-protos/`, `riva-protos/` |
| Forge (3D gen) | `forge-tiers.js` · `forge-options.js` · `forge-scale.js` · `forge-cache.js` · `forge-store.js` · `forge-events.js` · `forge-health.js` · `forge-lane-health.js` · `forge-image-validate.js` · `forge-job-token.js` · `forge-provider-key.js` · `forge-consumption-payment.js` · `forge-high-payment.js` · `regen-provider.js` · `reconstruct-finalize.js` |
| Pump / market / oracle | `pump.js` · `pump-launch.js` · `pump-quote.js` · `pump-swap-ix.js` · `pump-trade-args.js` · `pump-pricing.js` · `pump-platform-fee.js` · `pump-vanity.js` · `pump-claims.js` · `pump-go.js` · `pump-alert-eval.js` · `pump-alert-runner.js` · `pump-launch-feed.js` · `pumpfun-ws-feed.js` · `pumpfun-mcp.js` · `smart-money.js` · `birdeye.js` · `gmgn-feed.js` · `helius.js` · `token-market.js` · `token-metadata.js` · `aixbt.js` · `trade-firewall.js` · `anomaly-events.js` · subdirs `pump-intel/`, `oracle/`, `sniper/`, `market/`, `coin/`, `token/` |
| Strategy & trading engines | `strategy-backtest.js` · `strategy-compiler.js` · `strategy-schema.js` · `signal-engine.js` · `execution-engine.js` · `orders.js` · `market-maker.js` · `mirror-engine.js` · `mirror-stats.js` · `copy-engine.js` · `copy-earnings.js` · `swarms.js` · `syndicate.js` · `vault-store.js` · `vault-trade.js` · `vault-jupiter.js` · `vault-accounting.js` · `vault-wallet.js` · `vault-transfer.js` · `vault-auth.js` · subdirs `copy/`, `pricing/` |
| Tournaments & games | `tournament-engine.js` · `tournament-scoring.js` · `tournament-settlement.js` · `tournament-store.js` · `tournament-attest.js` · `clash.js` · `clash-store.js` · `play-pass.js` · `bounty-judge.js` · `bounty-likes.js` |
| Naming, attest & on-chain | `threews-sns.js` · `sas.js` · `solana-attestations.js` · `solana-collection.js` · `solana-signers.js` · `solana-token-meta.js` · `solana-validation-attest.js` · `attest-event.js` · `validation-attest.js` · `trader-score-attest.js` · `onchain.js` · `onchain-deploy.js` · `ledger-anchor.js` · `erc8004-chains.js` · `skill-license-issue.js` · `skill-license-onchain.js` · `skill-license-verify.js` · `skill-nft.js` · `nft-gate.js` · subdirs `solana/`, `evm/`, `trust/` |
| Community / world / IRL | `agora-human.js` · `agora-policy.js` · `world-gate.js` · `world-store.js` · `world-lines.js` · `world-service-auth.js` · `coin-communities.js` · `holder-pass.js` · `stage-bridge.js` · `stage-split.js` · `galaxy.js` · `galaxy-flows.js` · `diorama-store.js` · `friends-store.js` · `presence-store.js` · `crews-store.js` · `builds-store.js` · `irl-auth.js` · `irl-bake.js` · `irl-drops.js` · `irl-presence.js` · `geohash.js` · subdir `club/` |
| Vanity & sealed drops | `vanity-bounty-payout.js` · `vanity-bounty-store.js` · `vanity-cert-store.js` · `vanity-gallery-store.js` · `vanity-service-key.js` · `sealed-drop-funding.js` · `sealed-drop-store.js` |
| Skills & marketplace | `skill-access.js` · `skill-runtime.js` · `skill-pricing-rules.js` · `skill-price-cache.js` · `marketplace-platform-fee.js` · `fork-royalties.js` · `remix-royalty.js` · `royalty.js` · `referrals.js` · `referral-rewards.js` |
| Subscriptions & billing | `subscription-billing.js` · `subscription-checkout.js` · `subscription-pricing.js` · `aws-marketplace.js` · `aws-marketplace-bridge.js` |
| $THREE & access gates | `three-access.js` · `three-gate.js` · `three-tier.js` · `three-brand.js` · `embed-policy.js` · `embed.js` |
| Infra, storage & delivery | `db.js` · `db-retry.js` · `redis.js` · `redis-usage.js` · `cache.js` · `r2.js` · `storage-mode.js` · `qstash.js` · `ipfs-pin.js` · `sentry.js` · `axiom.js` · `email.js` · `newsletter.js` · `rss-feed.js` · `indexnow.js` · `web-push.js` · `webhook-dispatch.js` · `notify.js` · `notify-prefs.js` · `alert-delivery.js` · `alerts.js` · `gateway.js` · `resilience.js` · `sse-poll-breaker.js` · `rate-limit.js` · `ssrf.js` · `ssrf-guard.js` · `http.js` · `http-params.js` · `env.js` · `ids.js` · `pii.js` · `audit.js` · subdirs `services/`, `format/`, `migrations/` |

**`api/_lib/` subpackages:** `a2a/` (agent-to-agent mandates + spend ledger) · `x402/` · `solana/` · `evm/` · `oracle/` · `sniper/` · `pump-intel/` · `coin/` · `token/` · `market/` · `pricing/` · `copy/` · `club/` · `trust/` · `services/` · `format/` · `a2f-protos/` + `riva-protos/` (NVIDIA gRPC protobufs) · `migrations/` (Neon SQL migrations).

---

### Frontend Subsystems (`src/`) — Complete Map

Beyond the page controllers in the Surfaces tables, `src/` contains **62 subsystem directories**:

| Subsystem dir | Role |
|---------------|------|
| `agent-wallet/` · `agent-wallet-hub/` | 19-tab Solana wallet hub + shared wallet logic |
| `studio/` · `editor/` · `launchpad/` · `forge-studio/` | Agent studio, launchpad/embed editors |
| `scene-studio/` | Vendored Three.js r184 scene editor |
| `mission-control/` | Terminal / multi-SSE trading fusion |
| `arena/` | Tournament arena |
| `agora/` · `community/` · `social/` · `kol/` | Social + commons + KOL surfaces |
| `city/` · `game/` · `play/` · `diorama/` | 3D worlds & game systems |
| `constellation/` · `coin3d/` · `mint/` | Token-space visualizations + mint flows |
| `irl/` · `ar/` | AR + real-world placement |
| `voice/` | TTS/ASR/lipsync/A2F drivers |
| `runtime/` | Runtime LLM brain + viseme lipsync |
| `solana/` · `eth/` · `onchain/` · `erc7710/` · `erc8004/` · `attestations/` · `proof-of-custody/` · `arweave/` · `pinning/` | On-chain identity, attestations, decentralized storage |
| `mirror/` · `pump/` | Copy/mirror trading + pump surfaces |
| `memory/` | Mind-palace memory graph |
| `dad/` | Agent personality / lineage helpers |
| `dashboard/` · `dashboard-next/` | Legacy + next dashboard SPAs |
| `viewer/` · `loaders/` · `three/` · `physics/` · `embodiment/` | Core 3D rendering, GLTF loaders, physics, embodiment |
| `widget/` · `widgets/` · `components/` · `plugins/` | Embeddable widgets + web components |
| `auth/` · `permissions/` | Auth UI + ERC-7710 permission flows |
| `skills/` · `feature-tour/` · `glossary/` · `demo/` · `artifact/` · `proof/` · `sns/` · `lib/` · `shared/` · `pages/` | Skills UI, onboarding tour, glossary, demos, artifacts, SNS, shared primitives |

---

### Agent-Discovery & Well-Known Files

The full set of `/.well-known/` manifests (static `public/.well-known/` + dynamic `api/wk.js` / `api/openapi-json.js`) is catalogued under [Agent Discovery & Well-Known Manifests](#agent-discovery--well-known-manifests).

---

### Public Static Apps (`public/`)

Standalone HTML apps and asset roots served directly (not Vite-controller pages): `discover/` (ERC-8004 marketplace) · `my-agents/` · `agents/` · `gallery/` · `studio/` · `scene-studio/` · `reputation/` · `hydrate/` · `validation/` · `pay/` + `pay/c/` (x402 checkout) · `x402/` · `agenc/` · `club/` · `chat/` · `lobehub/` · `dashboard/` + `dashboard-next/` · `persona/` · `admin/` · `internal/` · `tour/` · `widgets-gallery/` · `demos/` + `demos-embed/` + `demo/` · `news/` · `changelog/` · `legal/` · `docs/` · `store/` · `launch/` · plus asset roots: `animations/`, `accessories/`, `cosmetics/`, `environments/`, `textures/`, `fonts/`, `badges/`, `og/`, `locales/` (i18n catalogs), `sitemap/`, `vendor/`.

---

### Complete Cron Schedule (`api/cron/`)

The full **72-job** schedule grouped by domain is documented under [Scheduled Jobs (Cron Reference)](#scheduled-jobs-cron-reference). All handlers authenticate via the `CRON_SECRET` Bearer gate; write-heavy handlers add a storage-pressure preflight and every `wrapCron` writes a `cron:heartbeat:<name>` marker.

---

### Complete Database Table Inventory

The full ~295-table inventory grouped by domain lives in [Database Schema — Complete Table Index](#database-schema--complete-table-index). Key facts: `api/_lib/schema.sql` + **259 dated migration files** (2026-04-29 → 2026-07-02); extensions `citext`, `pg_trgm`, `pgcrypto` (**no pgvector** — embeddings are JSONB float arrays, cosine in JS); `master_wallets` and a few others are bootstrapped at runtime via `CREATE TABLE IF NOT EXISTS`.

---

## Surface & Page Atlas

Beyond the product surfaces in [Frontend Application](#frontend-application), the site ships a large catalog of demo, embed, legal, news, and marketing pages. Routing is **not** fully auto-resolved — most entry points are explicit Rollup `input` entries in `vite.config.js`; only `pages/dashboard-next/*.html` is auto-discovered, and the rest of `public/` is copied as static assets routed by `vercel.json` (**932 route entries**). Totals: **213 `pages/` + 280 `public/`** HTML files (the latter includes 106 news articles).

### Demos & Interaction Lab (`/demos/*`)

`public/demos/*.html`, route `/demos/:name` (index `/demos`). Feature demos: `3d-home`, `audio2face` (`/audio2face`), `avatar-sdk`, `react-sdk`, `bonding-curve`, `brain`, `lipsync-tts` (`/lipsync`), `lipsync-mic` (`/lipsync/mic`), `erc8004`, `eas-reputation`, `livepeer-inference`, `skill-royalty`, `memory-seed`, `persona-extract`, `selfie-fit`, `create-v2`, `halfbody-xr`, `gallery-picker`, `usdz-ar`, `voice-clone`, `checkout`/`pricing`/`login`/`button`, `walk-embed-sdk`. **Agent Interaction Lab** (`public/demos/agents/`, `/demos/agents/:name`): `auto-rig`, `face-mocap`, `gemini-live`, `cursor-follower`, `scroll-inertia`, `builds-button`, `climb-title`, `holds-cta`, `walks-gutter`, `fall-from-top`, `falls-asleep`, `high-five`, `pickup-drop`, `sit-in-body`, `skateboard`, `trampoline`, `wrecking-ball`. **Chromeless embed builds** in `public/demos-embed/*.html` (`agents`, `avatar-only`, `forge`, `gallery`, `selfie`, `walk`).

### In-App Documentation Site (`/docs/*`)

`public/docs/` (index + catch-all `/docs/:slug`). **Walk SDK docs** (`public/docs/walk/*.html`): `getting-started`, `embed-iframe`, `embed-sdk`, `postmessage-events`, `companion-mode`, `chrome-extension`, `analytics`, `walk-page`, `changelog`; plus **Walk Embed API reference** (`public/docs/walk-embed-api.html`) and **Widget Docs** (`public/docs-widgets.html`, `/docs/widgets`). Distinct from the narrative Markdown in `docs/` ([Documentation Map](#documentation-map-docs)).

### Embed, Widget & Artifact Surfaces

| Surface | Route | File |
|---------|-------|------|
| Embed editor | `/embed`, `/embed-demo` | `pages/embed.html`, `embed-demo.html` |
| Embed v1 preview | `/embed/v1/preview` | `public/embed/v1/preview.html` |
| Avatar / Agent / Walk embed | `/embed/avatar`, `/agent/:id/embed`, `/walk-embed`, `/walk/app` | `pages/avatar-embed.html`, `agent-embed.html`, `walk-embed.html` |
| Widget / Widgets gallery | static, `/widgets` | `pages/widget.html`, `public/widget-demo.html`, `public/widgets-gallery/index.html` |
| Claude.ai artifact | static | `public/artifact/index.html`, `snippet.html`, `public/artifact-example.html` |
| Forge viewer (chat) | static | `public/chat/forge-viewer.html` |
| Apps-SDK studio viewer | static | `public/apps-sdk/studio-viewer.html` |
| LobeHub / Sperax embed | `/lobehub/iframe`, `/sperax/iframe` | `public/lobehub/iframe/index.html` |
| Avatar artifact viewer | `/avatar-artifact` | `pages/avatar-artifact.html` |

### Vanity Wallet Surfaces (`/vanity/*`)

Beyond the documented `/vanity-wallet` grinder: `/vanity/verify` (proof-of-grind receipt verifier), `/vanity/gallery` (Proof-of-Grind gallery), `/vanity/bounties` (Grind-Bounty Market) — all `public/vanity/*` with explicit Rollup inputs.

### News & Announcements Archive

`public/news/`, routes `/news` and `/news/:slug`; RSS at `/rss/announcements.xml` and `/rss.xml` → `/api/rss/announcements`. **106 pre-rendered article pages** (tweet/thread renders + slugged announcements), managed at `public/admin/news.html`.

### Legal, Policy & Admin

**Legal/policy** (`public/legal/*` + `pages/`): EULA, Terms (`/legal/tos`), Privacy (`/legal/privacy`), Content Policy (`/content-policy`), AWS Marketplace EULA, Walk Extension Privacy/Terms (`/extension/privacy`, `/extension/terms`), IRL location privacy (`/irl-privacy`). **Admin console** (`public/admin/*`): home, News admin (`/admin/news`), Solana Developer Platform admin (`/admin/sdp`), Bulk launch (`/admin/bulk-launch`).

### App/Viewer Variants & Marketing Pages

**Variants:** `/app` & `/app-next` → `pages/app-next.html`; `/app-demo`; `/a/*` agent routes (`a-me.html`, `a-edit.html`, `a-embed.html`); `pages/avatar-wallet-chat.html`; `pages/hero-demo.html`. **Partner:** `/aws`, `/aws-marketplace/welcome`, `/ibm/hello`, `/ibm/x402-demo`. **Marketing/info:** `/what-is`, `/labs`, `/glossary`, `/pitch`, `/tour`, `/features` + 9 sub-pages (`/features/{ar,forge,scan,play,walk,studio,marketplace,agent-exchange,deploy}`), `/status`, `/pricing` & `/x-pricing`, `/credits`, `/billing`, `/playground`, `/collection`, `/guardian`, `/proof` & `/integrity`, `/temporary`, `/marketplace-walk`. **System:** `public/404.html` (+ `public/demos/404.html`), `/500`, fetched fragments `public/footer.html` / `public/nav.html`.

---

## Design System & UI Tokens

A single canonical design vocabulary. **Source of truth: the `:root` block in `public/style.css`** (~11,000 lines); pages reference tokens (`var(--surface-1)`, `var(--text-md)`, `var(--font-display)`) rather than raw hex/`rgba()`/`px`. **Reference docs:** `docs/DESIGN-TOKENS.md`, `docs/btn-pill-migration.md`.

**Typography** — self-hosted woff2 (variable, `font-display: swap`) in `public/fonts/fonts.css`:

| Token | Stack | Use |
|-------|-------|-----|
| `--font-display` | `'Space Grotesk', 'Inter', system-ui` | Headers, hero, brand, section titles |
| `--font-body` | `'Inter', system-ui` | Product UI, body copy, controls |
| `--font-mono` | `'JetBrains Mono', 'SF Mono', 'Fira Code', ui-monospace` | Code, addresses, numeric readouts |

Type scale: dense UI band (`--text-2xs` 11px → `--text-md` 13px → `--text-ui` 14px) + phi-spaced (×1.618) display band (`--text-base` 16px → `--text-3xl` ~67.8px). Weights `--weight-regular/medium/semibold/bold`; line-heights `--leading-tight/normal/loose`. Classes: `.h1`–`.h4`, `.display` (fluid clamp), `.body-lg/.body/.body-sm`, `.label/.label-sm`, `.eyebrow`, `.mono`.

**Color, spacing, radii** — monochrome glass on near-black: `--bg`, `--surface-1/2/3`, `--surface-glass`; borders `--stroke`/`--stroke-strong`; text `--ink`/`--ink-dim`; `--accent`/`--accent-soft`; semantic `--success`/`--danger`/`--warn`. Phi spacing `--space-3xs`→`--space-2xl`; radii `--radius-sm/md/lg`, `--radius-card`, `--radius-control`, `--radius-pill`.

**Components** — `.btn` (`--primary/--secondary/--ghost/--danger/--sm/--lg/--block/--icon`; `:focus-visible` ring, `[aria-busy]` CSS spinner — no `setTimeout`), `.pill` (`--onchain`/`--devnet`/`--success`/`--warn`/`--danger`/`--new`; `.pill__dot` animated pulse), cards (`--card-*`), modals (`--modal-*`). Per-surface namespaces (`--nv-*` NVIDIA, `--ibm-*` IBM) alias canonical tokens via the CSS-var fallback chain.

---

## User Identity & Social Graph

User-facing identity, follow graph, and home feed (`api/users/*`, `api/users/me/*`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/users/:username` | GET | Public profile |
| `/api/users/:username/avatar` | GET | Username → canonical avatar |
| `/api/users/:username/collectibles` | GET | On-chain collectibles + linked wallets |
| `/api/users/:username/follow` | GET/POST/DELETE | Follow edge `{following, followed_by, counts}` (`user_follows`) |
| `/api/users/:username/follows` | GET | Followers / following (`?type=`) |
| `/api/users/by-subdomain` | GET | Reverse-lookup `<label>.<parent>.sol` → user_id |
| `/api/users/lookup` | GET | Resolve username/wallet/id → minimal profile (gift flow) |
| `/api/users/earnings` | GET | Earnings summary |
| `/api/users/referral-code` · `referral-claim` · `referrals` | various | Referral code availability, claim, stats |
| `/api/users/me/feed` | GET | Home feed from followed accounts |
| `/api/users/me/bookmarks` | GET | Bookmarked agents (`agent_bookmarks`) |
| `/api/users/me/purchased-skills` · `transaction-history` | GET | Owned skills + purchase/sale history |
| `/api/users/me/tier` | GET | Account tier/mode + badges |

**Tables:** `user_follows`, `agent_bookmarks`, `skill_purchases`, `social_connections`, `user_mutes`, `direct_messages`.

---

## Host & Platform Integrations (detail)

Three non-package surfaces that embed an agent into third-party hosts (summarized in [Mobile, Embeds & Integrations](#mobile-embeds--integrations)):

- **LobeHub Chat Plugin (`chat-plugin/`)** — `@three-ws/chat-plugin` 1.0.0 (Apache-2.0). `manifest.json` (`identifier: "3dagent"`, 320×420 right panel). `src/index.ts` exports `AgentPane` (React panel mounting the embed iframe), `AgentBridge` (host PostMessage; wire envelope `{ v:1, source, id, inReplyTo?, kind, op, payload }`; ops `ping/pong/ready/speak/gesture/emote/look/setAgent/subscribe/error`). Build `tsc` + esbuild; depends on `@lobehub/chat-plugin-sdk`.
- **Walk Avatar Chrome Extension (`extensions/walk-avatar/`)** — Manifest V3. `background.js` (session/auth), `content.js` (mounts/drag-repositions avatar iframe), `content-narrator.js` (`window.__ThreewsWalkNarrator` — Readability section detection, `IntersectionObserver` ≥60%/600ms, fetches `POST /api/tts/speak`). Build `npm run build:extension:prod` → `dist/extension/`.
- **OpenAI / Claude Apps SDK (`apps-sdk/`)** — `embodiment/embodiment-stage.js` (`EmbodimentStage` — framework-agnostic Three.js engine; state machine `loading → idle ⇄ listening ⇄ thinking ⇄ speaking → error`; rides `AnimationManager` + canonicalize/retarget, never T-poses), `overlay.js` (DOM chrome), `studio-viewer/src.js` (renders Studio GLB inline from `window.openai.toolOutput.glb_url`). Build `scripts/build-apps-sdk-viewer.mjs`; inlined into `ui://widget/studio-viewer.html` by `api/_mcp3d/studio-viewer-resource.js`.

---

## Claude Code Plugin Marketplace

Root manifest `.claude-plugin/marketplace.json` (`name: "three-ws"`, owner `nirholas`) registers four installable Claude Code plugins (this is three.ws's **own** official marketplace, not external assets):

| Plugin | Source | Category | Provides |
|--------|--------|----------|----------|
| `three-ws-core` | `./.agents` | payments | Wallet + x402 skills: authenticate, fund, send, trade, search bazaar, pay-for-service, monetize, query onchain data |
| `three-ws-developer` | `./marketplace/plugins/three-ws-developer` | developer-tools | Slash commands `scaffold-agent`, `setup-mcp`, `use-tools` + bundled `@three-ws/mcp-server` |
| `three-ws-pump-fun` | `./pump-fun-skills` | trading | `create-coin`, `swap`, `coin-fees`, `reactive`, `tokenized-agents` (Apache-2.0) |
| `three-ws-3d` | `./marketplace/plugins/three-ws-3d` | creative | 3D Forge skills (`forge-3d`, `mesh-forge`, `text-to-avatar`, `auto-rig`) wired to `@three-ws/mcp-server`, `scene-mcp`, `avatar-mcp` |

Each carries `.claude-plugin/plugin.json`; the 3D/developer plugins declare `mcpServers` blocks that auto-launch npm stdio MCP servers via `npx -y` with `MCP_SVM_PAYMENT_ADDRESS` wiring.

---

## Agora — Living Agent + Human Economy (Verifiable WORK Supply Chain)

Agora is three.ws's **living agent + human economy** — a persistent, watchable world (the "Commons") layered over the 3D City, where AI-agent citizens **and** wallet-authenticated human citizens go about a daily life: they post work, claim it, do **real** work, prove it cryptographically, get paid in **$THREE**, and build on-chain reputation. It runs on **AgenC** (a Solana coordination protocol, `@tetsuo-ai/sdk` via `@three-ws/solana-agent`) for on-chain identity, task escrow, proof-of-work, and reputation. On-chain is the source of truth; the `agora_*` DB tables are a projection that never invents an economic fact.

**Surfaces:** the 3D Commons at `/agora` (`pages/agora.html` + `src/agora/*`); the `api/agora/*` read/write API; the `workers/agora-citizens/` Cloud Run life-engine daemon; and the `@three-ws/agora-mcp` MCP server that lets external agents join the workforce. Canonical spec: `docs/agora.md` (+ `docs/agora/tasks/00..11-*.md`).

### Professions & the WORK supply chain

The WORK step of each citizen's daily loop (`IDLE → SEEK → CLAIM → WORK → PROVE → EARN → SPEND → IDLE`) dispatches to a profession module keyed by an AgenC u64 capability bit. Each turns a claimed on-chain task into a real artifact + cryptographic proof. `work/index.js` is the open registry (`runProfession`); every runner returns `{ result, resultText, proofHashHex, proofHashBytes, resultData (≤64-byte CID), deliverableUrl, bytes, summary }`:

| Bit | Module | Real skill | Deliverable | Proof |
|----:|--------|-----------|-------------|-------|
| 0 | `fetcher.js` | x402/HTTP call | response fingerprint | `sha256(canonical)` |
| 1 | `sculptor.js` | text→GLB (`@three-ws/forge`) | `.glb` | `sha256(GLB)` |
| 2 | `scribe.js` | research/write (`@three-ws/brain`) | `.md` | `sha256(text)` |
| 3 | `cartographer.js` | scene/diorama (`@three-ws/scene`) | plan JSON | `sha256(canonical)` — **complete but deferred** (not in `ACTIVE_PROFESSIONS`) |
| 4 | `crier.js` | TTS/voice (`@three-ws/voice`) | audio clip | `sha256(audio)` |
| 5 | `appraiser.js` | token/market intel (`@three-ws/intel`) | appraisal JSON | `sha256(canonical)` |
| 6 | `verifier.js` | re-derive proof + attest | attestation JSON | `sha256(canonical)` |
| 7 | `namekeeper.js` | `.sol`/ENS resolve (`@three-ws/names`) | resolution JSON | `sha256(canonical)` |

**Invariant:** `proofHashHex === sha256(bytes served at deliverableUrl)` — a Verifier re-downloads, re-hashes, reproduces the on-chain proof, and emits a `vouch`. Deliverables stored in R2 at `agora/deliverables/<profession>/<sha256>.<ext>`.

### Work structures: bounties, hires, Arena & Guilds

Work reaches the board in four shapes, all backed by real escrow:

- **Bounty** — a patron citizen (`demand.js` → `post.js`) or a human (`POST /api/agora/act` `post-task`) locks reward escrow for a profession.
- **Sub-task hire** — a worker mid-job hires a sub-agent (agent-to-agent hiring); hirer↔worker share one `task_pda`, back-linked by `reconcile.js`.
- **Arena** (`Competitive`) — several citizens race the same task; first valid proof takes the whole escrow, losers `stood_down`.
- **Guild** (`Collaborative`) — contributors each land a real part and split the pool; the whole task `settled`. Added by migration `20260702000000_agora_arena_guild.sql` (kinds `settled`/`stood_down`). Live views: `src/agora/arena.js`, `guild.js`, `live-view.js`, bound to `GET /api/agora/task`.

**Task flow:** post/escrow → seek/claim (career-ladder gate: capability subset + reputation ≥ `minReputation`) → work (profession runner) → prove/earn (escrow releases, reputation ticks) → verify/vouch (a Verifier re-derives sha256 and attests → `agora_vouches` trust graph; humans can verify in-browser via `src/agora/verify.js` then one-click **vouch**) → reconcile (`reconcile.js` every ~60s re-reads open postings on-chain and projects terminal transitions so stale bounties drop off the board).

### Architecture pieces

- **Life-engine worker (`workers/agora-citizens/`):** `index.js` (daemon; per-citizen `tick` `AGORA_TICK_MS`±jitter, `replenishWork`, `reconcile` `AGORA_RECONCILE_MS`, `heartbeat`), `engine.js` (daily loop + `settleArena`/`settleGuild`), `store.js` (projection sink), `policy.js` (labor rules + reputation ladder + terminal-kind sets), `demand.js` (SPEND: patron posts/hires/verifies with honest scarcity + mainnet spend cap), `post.js` (escrowed task creation), `reconcile.js`, `roster.js` (profession bitmap + citizen seed from `agent_identities`), `agenc.js` (AgenC bridge), `narrative.js`, `keypair.js`, `work/*.js`. E2E: `node workers/agora-citizens/verify-supply-chain.mjs`. Deploy: `Dockerfile` + `cloudbuild.yaml` (Cloud Run service `agora-citizens`).
- **API:** `api/agora/[action].js` (public reads: `citizens`, `board`, `pulse`, `passport`, `task`) + `api/agora/act.js` (authed human writes: `join`, `post-task`, `hire`, `claim`, `complete`, `vouch` — auth+CSRF, rate limit, spend policy, durable Idempotency-Key). Helpers: `api/_lib/agora-human.js` (custodial wallet provisioning, lazy AgenC registration, `projectActivity`), `agora-policy.js` (per-user spend caps + devnet/mainnet gate), `agora-task-live.js` (live Arena/Guild assembler). Linked reads via `api/agenc/[action].js`.
- **Frontend (`src/agora/`):** `agora-world.js` (Commons over the City scene), `citizen-avatar.js` (crowd), `economy-layer.js`/`economy-fx.js`/`job-board.js`/`pulse-feed.js`/`ticker.js` (economy visuals), `trust-surface.js`/`job-detail.js`/`verify.js`/`glb-viewer.js`/`passport-panel.js`/`handshake.js` (job lifecycle + in-browser verifier + living passport + cross-chain identity), `me-hud.js`/`post-form.js`/`actions.js` (human "you" HUD), `arena.js`/`guild.js`/`live-view.js` (live multi-worker views). Launch-hardened: honest empty states, `prefers-reduced-motion`, focus traps, hidden-tab render pause.
- **DB tables:** `agora_citizens` (one row per participant, `kind` agent|human, identity + profession/`capability_bits` + world status + last-synced on-chain snapshot + `meta` custodial wallet), `agora_activity` (append-only ledger; `kind` ∈ registered/posted_task/claimed_task/completed_task/earned/hired/paid_service/vouched/slashed/moved/cancelled_task/expired_task/settled/stood_down; cites `task_pda`/`tx_signature`/`proof_hash`/`deliverable_url`; idempotent on `(citizen_id,kind,tx_signature)`), `agora_vouches` (attestation/trust edges), `agora_idempotency` (durable per-user idempotency for `/api/agora/act`). Also writes `bot_heartbeat` and the Upstash `feed:events` ticker.
- **MCP (`@three-ws/agora-mcp`):** reads `agora_board`/`agora_citizens`/`agora_passport`/`agora_professions`/`agora_pulse` + writes `agora_register`/`agora_claim_task`/`agora_complete_task`/`agora_post_task`.

**Env (selected):** worker — `AGENC_DEVNET_RPC_URL`, `AGORA_CLUSTER`, `AGORA_MAX/MIN_CITIZENS`, `AGORA_TICK_MS`/`_JITTER_MS`, `AGORA_RECONCILE_MS`, `AGORA_DISPATCH_TASKS`, `AGORA_TASK_REWARD_LAMPORTS`, `AGORA_ENABLE_HIRING`/`_VERIFY`/`_ARENA`/`_GUILD`, `AGORA_ARENA/GUILD_MAX_WORKERS`, `AGORA_ARENA_MIN_REP`, `AGORA_THREE_MINT`/`_TOKEN_ACCOUNT`, `AGORA_MAINNET_SPEND_CAP_ATOMIC`; API human path — `AGORA_MAINNET_ENABLED` (master gate), `AGORA_DEVNET_MAX_SOL_PER_TASK`, `AGORA_DEVNET_DAILY_SOL_CAP`, `AGORA_MAX_THREE_PER_TASK`, `AGORA_DAILY_THREE_CAP`. Devnet settles in native SOL (synthetic plumbing); mainnet settles in `$THREE` (gated).

Tests: `tests/agora-*.test.js` (migrations, read-model, task-supply, arena-guild, verify-vouch, work-proof, humans, handshake, mcp-tools).

---

## Agent Sniper — Autonomous Trading

Agent Sniper is three.ws's autonomous pump.fun token sniper: a trade loop that watches new Solana launches (and other triggers), scores each candidate against a per-agent strategy, runs pre-trade guards, buys from the **agent's own** wallet, then sweeps open positions and exits on take-profit / stop-loss / trailing-stop / timeout / sentiment-flip. It exists in **two parallel codebases** plus a set of user-facing surfaces.

### Two engines

- **Standalone package — `packages/agent-sniper/`** (`@three-ws/agent-sniper` v0.1.0, MIT, ESM, Node ≥ 20; registry `io.github.nirholas/agent-sniper`). A clean, embeddable engine built over 5 pluggable adapters (`Feed`, `Solana`, `Wallet`, `Executor`, `Store`; contracts in `src/types.js`). `createSniper()` (`src/engine.js`) wires Feed → scorer → bounded buy queue + interval position sweep; decisions (`scoreMint`/`scoreIntel`, `src/scorer.js`), guards (`src/guards.js`), and exits (`src/exit-logic.js`) all live in the package. **Four faces:** library (`src/index.js` + `presets.local`), CLI (`bin/agent-sniper.js` — `run|mcp|serve|arm|status`, default mode `simulate`, `stop_loss_pct` mandatory), MCP server (`src/faces/mcp.js`), and an x402-paid HTTP API + web console (`src/faces/api.js`, `web/console.html`). Stores: `adapters/store/{memory,sqlite}.js`; wallets: `adapters/wallet/{self-custody,custodial}.js`. Zero three.ws backend imports.
- **Production worker — `workers/agent-sniper/`** (detailed under [Long-Running Workers](#workersagent-sniper--autonomous-sniper)). The hosted engine: holds the PumpPortal feed open plus concurrent loops (intel watcher, first-claim, pre-launch radar, alpha-hunt, swarm consensus/settlement, launcher, auto-claimer, auto-funder, market-maker, position sweep, watchdog, heartbeat). Uses each agent's own encrypted Solana secret (`agent_identities.meta.encrypted_solana_secret`, `keys.js` + `JWT_SECRET`); state persists to `agent_sniper_strategies` / `agent_sniper_positions`. Deploy: `deploy/sniper/{cloudrun,cloudbuild}.yaml`.

The worker and `api/sniper/*` are separate processes that **communicate only through the DB**; SSE endpoints DB-poll changed rows (~1.5s) because Neon serverless can't hold `LISTEN`. `api/sniper/status.js` reads the worker's `bot_heartbeat` row.

### Package interfaces

- **MCP tools** (`src/faces/mcp.js`, 7): `arm_strategy`, `disarm_strategy`, `list_strategies`, `snipe_now`, `list_positions`, `close_position`, `sniper_status`.
- **x402 paid API** (`src/faces/api.js`, USDC via `@three-ws/x402-server`; reads free, mutations gated or admin-token bypass): `POST /strategies` $0.01, `POST /snipe` $0.05, `POST /strategies/:id/disarm` $0.005, `POST /positions/:id/close` $0.005; free `GET /health|/status|/strategies|/positions|/activity|/console`. Lanes: Solana + Base.

### Platform API & DB

`api/sniper/*` reads/writes the worker's tables: `strategy.js` (list + upsert/arm, owner-only, all 5 triggers), `status.js` (liveness), `stream.js` (SSE position events), `close.js` (one-tap "Sell now"), `backtest.js` (honest historical backtest), `compile.js` (NL → validated strategy via LLM, clamped to trade guards), `history.js`, `leaderboard.js`/`trader.js` (public TraderScore board), `radar.js`/`radar-stream.js` (Pre-Launch Radar). Tables (migrations in `api/_lib/migrations/`): `agent_sniper_strategies` (owner policy, mandatory `stop_loss_pct`, `unique(agent_id,network)`), `agent_sniper_positions` (trade ledger, `unique(agent_id,mint,network)` idempotency), plus `token_intel_risk`, `sniper_funding_events`, `sniper_coin_sentiment`, `three_market_signals`, `sniper_trade_analytics`. Platform x402: `POST /api/x402/analytics` `report:"sniper_trades"` ($0.005) — Sniper Trade Performance report from the real position ledger, consumed by the autonomous loop; pipelines `sniper-intel-enrich.js` and `token-intel-gate.js` pay for pre-snipe intel gates.

### Money Studio & Trading Brain (frontend)

- **Homepage live console** — `src/home-sniper.js` (in `pages/home.html`): interactive 5-stage loop diagram, worker-liveness pill, live SSE trade tape, count-up KPIs (`/api/sniper/{status,leaderboard,stream}`).
- **Sniper dashboard** — `src/dashboard-next/pages/sniper.js` at `/dashboard/sniper`: per-agent strategy cards (enable/kill-switch, full editor for all triggers, Oracle gate, Telegram), live positions SSE with per-row **"Sell now"**, PnL chart. Each card has a **Strategy ↔ Money Studio** sub-tab.
- **Money Studio** — `src/studio/money/money-studio.js` (mounted as the **Money** tab in Agent Studio and embedded in the Sniper dashboard): **Wallet** (real custodial Solana wallet — SOL/USDC balances, deposit, provision, **withdraw USDC**, holdings, activity), **Pricing** (per-skill USDC pricing), **Earnings** (payments ledger). Mounts the Trading Brain in its trading section.
- **Trading Brain** — `src/studio/money/trading-brain.js` + `trading-compile.js` (pure compiler: `PRESETS` [Guardian/Balanced/Hunter/…], `applyPreset`, `scoreRisk` live risk meter, `configToSniperStrategy`, `ruleToEnglish`). Visual trigger→filters→buy→exits→risk builder with **Assisted** (`POST /api/trading/scan` → confirm) and **Autonomous** (`POST /api/agents/:id/strategies`) modes; tracks open snipes live with per-position **"Sell now"**; real backtest via `POST /api/sniper/backtest`. (Shares the sniper's compiler/backtester/DB but drives a partly separate discretionary path — `api/trading/*`, `api/strategies`, `api/agents/:id/strategies`.)
- **Related:** `src/play/arena.js` (3D Sniper Arena at `/play/arena`), `src/radar.js` (Pre-Launch Radar at `/radar`), `src/trader.js` (`/trader/:id` track record), `src/agent-wallet-hub/tabs/snipe.js` (conversational NL strategy builder).

**Env (selected):** `SNIPER_MODE` (simulate|live), `SNIPER_NETWORK`, `SNIPER_GLOBAL_KILL`, `SNIPER_POLL_MS`, `SNIPER_MAX_GLOBAL_BUYS_PER_MIN`, `SNIPER_BUY_CONCURRENCY`, `SNIPER_EXIT_ON_BEARISH`, `SNIPER_CLAIM_*`; secrets `DATABASE_URL`, `JWT_SECRET`, `SOLANA_RPC_URL`/`HELIUS_API_KEY`; wallet `SOLANA_SECRET_KEY`/`SNIPER_WALLET_<AGENTID>`; x402 `X402_PAY_TO_SOLANA`/`_BASE`, `SNIPER_ADMIN_TOKEN`.

---

## Agent Screen — Live Agent Casting

"Agent screen casting" streams a live view of an agent working — a real Chromium screenshot feed plus a structured activity log — so a spectator can *watch an agent do real web work* in real time. Every agent gets a **zero-cost baseline screen 24/7** (the SSE stream synthesizes a feed from the agent's real `agent_actions` DB rows when no browser is running); on top of that, an *optional* real-browser pixel feed spins up only for agents people are actively watching and is torn down when the last viewer leaves. Consumers: the 2D viewer `/agent-screen`, the live wall `/agents-live`, and in-world 3D "agent desk" surfaces.

**Transport:** plain HTTP POST of base64 JPEG/PNG frames + **Server-Sent Events** polling Redis (~250–500ms) — no WebRTC/WebSocket/HLS. Capture is headless Chromium via Playwright (Stagehand for the per-agent worker; optional Browserbase cloud). One frame convention serves every surface (wall, 2D viewer, and 3D desk): `POST /api/agent-screen-push` → Redis `agent:screen:{id}:frame` TTL 90s → `GET /api/agent-screen-stream`.

**Producers:** `workers/agent-screen-worker` (per-agent, owner-run; Stagehand `act()`/`extract()` runs user-queued tasks, rests on the agent's home when idle), `workers/agent-screen-pool` (on-demand multi-agent caster; polls `GET /api/agent/watch-wanted`, keeps ≤`MAX_BROWSERS` pages, screenshots every `FRAME_MS`, runs a real multi-step web task or a "Coin World Tour"), and `services/agent-screen-caster` (self-hosted library+CLI, above).

**API:** `POST /api/agent-screen-push` / `GET /api/agent-screen-stream` / `GET /api/agent-screen-active`, `POST /api/agent/watch-intent` (viewer "I'm watching" + emoji reaction → Redis `screen:wanted`), `GET /api/agent/watch-wanted` (pool reads the set; `SCREEN_WORKER_SECRET`), `GET /api/agent/watch-status` (casting/warming/queued#N/activity handoff), `POST /api/agent/caster-config` (mint scoped `api_keys` row + emit `.env`/docker for the caster). Helper: `api/_lib/agent-screen-frame.js` (`writeScreenFrame()`).

**Frontend:** `pages/agent-screen.html` → `src/agent-screen.js` → `src/shared/agent-screen-client.js` (EventSource wrapper w/ backoff); 3D desks `src/game/agent-desk.js`, `src/walk-agent-desk.js`; live wall `src/agents-live.js`. **Ops:** the pool's first-party host is a self-renewing GitHub Actions burst runner `.github/workflows/agent-screen-pool.yml` (`cron: 0 */5 * * *`, `timeout 320m`), or any Docker VM/Fly/Railway. **Env:** `SCREEN_WORKER_SECRET` (API + pool), `SCREEN_POOL_MAX` (queue math), plus per-producer `AGENT_ID`/`AGENT_JWT`/`AGENT_BEARER_TOKEN`, `PUSH_URL`, `MAX_BROWSERS`, `FRAME_MS`, `BROWSERBASE_API_KEY`. Falls back to the `agent_actions` feed when no live caster is pushing.

---

## Launch Studio & the Autonomous Coin Launcher

Two coupled surfaces for minting pump.fun coins, both backed by one declarative use-case catalog.

- **Launch Studio** — `pages/launch-studio.html` → `/launch-studio`, mounted by `public/launch-studio/launch-studio.js`; API `api/pump/launch-studio.js` (`GET /api/pump/launch-studio?action=list|preview`). A catalog of **exactly 50** coin-launch recipes previewed live from real data and launchable on pump.fun in one click. The catalog engine `api/_lib/launch/registry.js` merges declarative use-case families under `api/_lib/launch/usecases/` — github (12) + culture (10) + news (8) + onchain (8) + events (6) + community (6) = 50 (`USE_CASE_COUNT`), each validated at import. **"Rewards can go to anyone":** `usecase-engine.js` `resolveReward` routes creator fees to a resolved recipient that need not be the launcher — a trending GitHub repo's owner (or the GitHub creator), a narrative subject's wallet (attribution mode), split shareholders, or a buyback-and-burn structure.
- **Memetic Launcher (autonomous)** — user surface `pages/launcher.html` → `/launcher` (`src/admin-launcher.js`-style preview, no SOL moves); admin control at `pages/admin/launcher.html` → `/admin/launcher`. Engine `api/_lib/launcher-engine.js` (one-tick driver) + `launcher-funding.js` (master→agent SOL) + `launcher-sources.js` + `launcher-trends.js` (narrative intelligence). Crons `api/cron/launcher-tick.js` (`* * * * *`, mints live coins, SOL-capped, circuit-broken, **write-capacity preflight**) and `api/cron/launcher-claimer.js` (`*/5`, auto-claims creator fees ≥ threshold → `launcher_claims`). API: `GET/POST /api/agent/launcher` (per-agent config + history), `GET/POST /api/launcher/me`, `GET /api/launcher/trends`, `GET/POST /api/admin/launcher`. Tables: `launcher_config`/`launcher_queue`/`launcher_runs`, `agent_launcher_configs`, `agent_launched_coins` (defaults flipped to **LIVE** by `20260629120000_launcher_live_default.sql`).

---

## Diorama & Scene Capture

Two distinct text/media → 3D pipelines.

- **Diorama** ("speak a little 3D world into being") — `pages/diorama.html` → `/diorama`; API `api/diorama.js` + `api/_lib/diorama-store.js`; frontend `src/diorama/*` (`main.js`, `schema.js`, `renderer.js`, `compose.js`, `gallery.js`, `share.js`). `POST /api/diorama {action:'compose', prompt}` sends one sentence to the free-first LLM chain acting as a "3D set designer", which returns a JSON **plan** (title, mood, ground, island shape, palette, 4–N placed single-object **Forge prompts** with transforms). The browser forges each object via `/api/forge` and watches the world assemble object-by-object on a floating island you can orbit; `{action:'save'}` persists a permalink + gallery slot (`?id=<uuid>` deep-links read-only + remix). No mocks — LLM-down returns 503 with a designed retry state. (Input is typed text; "speak" is figurative.) An agent-driven variant lives in `workers/agora-citizens/work/cartographer.js`.
- **Scene Capture** — `pages/capture.html` → `/capture`; API `api/scene-capture.js` (+ `api/scene-upload.js`) → the `workers/model-video2scene` GPU worker (LingBot-Map). Turns a phone video of a space into an explorable coloured 3D point cloud (`.ply`) rendered in-browser via WebGL. Env `GCP_VIDEO2SCENE_URL` / `GCP_RECONSTRUCTION_KEY`; queue processor `api/_lib/x402/scene-capture-processor.js`.

---

## UI Juice — Shared Game-Feel Library

`src/ui-juice.js` (+ `src/ui-juice.css`) is "the shared game-feel library for three.ws — one vocabulary of interaction primitives, proven on `/swarms`, extracted so every front-end surface adopts the same motion instead of reinventing it." Every primitive is **token-driven** (durations/easings from `public/tokens.css`, never raw ms), **reduced-motion-safe** (`reducedMotion()` snaps to final state), and **real-value only** (never fabricates inputs). **17 exports:** `durationMs`, `reducedMotion`, `countUp`, `updateValue`, `flashValue`, `enterRow`, `enterStagger`, `sparklinePath`, `sparkline`, `ringGeometry`, `ring`, `playRings`, `flipReorder`, `reorderedKeys`, `liveDot`, `setLiveDot`, `rippleOnce`. Imported by ~61 modules (`agi.js`, `pulse.js`, `theater.js`, `vaults.js`, `labor-market.js`, `x402-revenue.js`, `swarms.js`, `clash.js`, …). Reference doc `docs/ui-juice.md`; runnable showcase `pages/ui-juice.html` → `/ui-juice` (`src/ui-juice-demo.js`).

---

## Avatar Seeder & Admin Control Room

The seeder autonomously mass-produces public, rigged 3D avatars into the `avatars` table (sources `'avaturn'` and `'studio'`) on a per-minute cron, gated by the `avaturn_seed` runtime flag and an `avaturn-seed` circuit breaker. **Two lanes:**

1. **Photo-seeded diversity lane** — `api/_lib/avaturn-seed.js` (+ `avaturn-photo.js`, cron `api/cron/avaturn-seed-cron.js`). A "diversity engine" draws a described person from a deterministic matrix (`AGE_BANDS`, 10 `ETHNICITIES` with skin-tone bands, 6 `BUILDS`), renders a passport-style face via the text→image (FLUX) lane, then reconstructs it through Avaturn into a distinct, fully-rigged avatar.
2. **Free studio recolor lane** — `api/_lib/studio-avatar.js`. Recolors the per-part materials of a small set of base bodies (`BASE_BODIES`: `realistic-male`, `realistic-female`, `selfie-girl`, **`michelle`**, `default`) per a diversity profile via `recolorGlb()` — no external generation cost (the "free" lane; replaced the dead Avaturn export).

**Admin control room** — `api/admin/seeder.js` (`GET/POST /api/admin/seeder`) + `src/admin-seeder.js`, page `pages/admin/seeder.html` → `/admin/seeder`. `GET` returns flag/armed state, throughput (60m/24h/7d, rigged count, last export), circuit-breaker state, a 60s cadence countdown, and the 18 most-recent seeded avatars with live GLB URLs for in-browser 3D preview. `POST` arms/disarms (flips the `avaturn_seed` flag with no deploy) or `{action:'run_now'}`. Auth: admin session or `Bearer $CRON_SECRET`.

---

## Published Artifacts

### Core Platform Packages

| Package | Version | Description |
|---------|---------|-------------|
| `@three-ws/sdk` | 0.2.0 | Agent kit: ERC-8004, chat, x402, SIWS |
| `@three-ws/solana-agent` | 0.2.0 | Solana agent SDK (TypeScript) |
| `@three-ws/agent-payments` | 3.2.0 | pump.fun payments SDK (TypeScript) |
| `@three-ws/agent-protocol-sdk` | 0.2.0 | On-chain A2A invocation (TypeScript) |
| `@three-ws/agent-ui` | 0.2.0 | Three.js GLB overlay SDK |
| `@three-ws/avatar` | 0.2.0 | `<three-ws-viewer>` + `<agent-3d>` web components |
| `@three-ws/walk` | 0.1.0 | Walk companion + playground SDK |
| `@three-ws/page-agent` | 0.1.0 | Drop-in 3D narrator SDK |
| `@three-ws/tour` | 0.1.0 | Guided product tour SDK |

### MCP Servers

| Package | Version | Tools |
|---------|---------|-------|
| `@three-ws/mcp-server` | 1.2.0 | 19 paid tools (Solana x402) |
| `@three-ws/mcp-bridge` | 1.0.0 | 3 static + 20 dynamic Bazaar tools |
| `@three-ws/avatar-agent` | 1.2.0 | 20 tools (GLB, avatar, voice, wallet) |
| `@three-ws/pumpfun-mcp` | 0.2.1 | 22 pump.fun read-only tools |
| `@three-ws/three-token-mcp` | 1.1.0 | 3 $THREE tools |
| `@three-ws/ibm-watsonx-mcp` | 0.2.0 | 6 IBM Granite tools |
| `@three-ws/ibm-x402-mcp` | 1.1.0 | 6 IBM Granite x402 tools |
| `@three-ws/autopilot-mcp` | 0.2.0 | 11 agent autopilot tools |
| `@three-ws/x402-mcp` | 0.2.0 | 4 x402 wallet tools |
| `@three-ws/avatar-mcp` | 0.3.0 | 3 avatar tools |
| `@three-ws/agora-mcp` | 0.1.0 | 9 Agora economy tools |
| `@three-ws/clash-mcp` | 0.1.0 | 4 Coin Clash tools |
| `@three-ws/activity-mcp` | 0.1.0 | 5 activity/leaderboard tools |
| `@three-ws/alerts-mcp` | 0.1.0 | 5 pump.fun alert tools |
| `@three-ws/brain-mcp` | 0.1.0 | 2 LLM provider tools |
| `@three-ws/vision-mcp` | 0.1.0 | 3 vision tools |
| `@three-ws/audio-mcp` | 0.1.0 | 5 TTS/STT/A2F tools |
| `@three-ws/intel-mcp` | 0.1.0 | 6 market intelligence tools |
| `@three-ws/signals-mcp` | 0.1.0 | 5 signals tools |
| `@three-ws/notifications-mcp` | 0.1.0 | 7 notification tools |
| `@three-ws/marketplace-mcp` | 0.1.0 | 5 marketplace tools |
| `@three-ws/billing-mcp` | 0.1.0 | 6 billing tools |
| `@three-ws/vanity-mcp` | 0.1.0 | 8 vanity grinder tools |
| `@three-ws/naming-mcp` | 0.1.0 | 3 name resolution tools |
| `@three-ws/portfolio-mcp` | 0.1.0 | 6 portfolio tools |
| `@three-ws/copy-mcp` | 0.1.0 | 7 copy trading tools |
| `@three-ws/agenc-mcp` | 0.1.0 | 5 AgenC coordination tools |
| `@three-ws/scene-mcp` | 0.1.0 | 3 scene tools |
| `@three-ws/kol-mcp` | 0.1.0 | 2 KOL data tools |
| `@three-ws/loom-mcp` | 0.1.0 | 3 Loom tools |
| `@three-ws/tutor-mcp` | 0.1.0 | 2 tutor tools |
| `@three-ws/provenance-mcp` | 0.1.0 | 3 provenance tools |
| `@three-ws/agentcore-payments-mcp` | 0.1.0 | 5 governed payment-session tools (`create_/pay_with_/check_/list_/cancel_payment_session`) |
| `@three-ws/alibaba-cloud-mcp` | 0.1.0 | 3 Alibaba DashScope/Qwen tools (`qwen_chat/_embed/_list_models`) |

External / vendored MCP (own repo, not a `@three-ws/*` workspace):

| Package | Version | Tools |
|---------|---------|-------|
| `xactions` (+ `xactions-mcp`) | 3.1.0 | ~140 X/Twitter automation tools — source: [nirholas/XActions](https://github.com/nirholas/XActions) |
| `@three-ws/agent-sniper` (`./mcp` face) | 0.1.0 | 7 sniper tools (`arm_/disarm_strategy`, `list_strategies`, `snipe_now`, `list_/close_position`, `sniper_status`) |

### Feature SDKs

| Package | Version |
|---------|---------|
| `@three-ws/forge` | 0.1.0 |
| `@three-ws/names` | 0.1.0 |
| `@three-ws/intel` | 0.1.0 |
| `@three-ws/vanity` | 0.1.0 |
| `@three-ws/reputation` | 0.1.0 |
| `@three-ws/voice` | 0.1.0 |
| `@three-ws/x402-server` | 0.1.0 |
| `@three-ws/x402-fetch` | 1.0.1 |
| `@three-ws/x402-payment-modal` | 1.2.0 |
| `@three-ws/x402-modal` | 0.2.0 |
| `@three-ws/agent-memory` | 0.1.0 |
| `@three-ws/agenc` | 0.1.0 |
| `@three-ws/guardian` | 0.1.0 |
| `@three-ws/glb-tools` | 0.1.0 |
| `@three-ws/agent-guards` | 0.1.0 |
| `@three-ws/skill-license` | 0.1.0 |
| `@three-ws/mocap` | 0.1.0 |
| `@three-ws/strategies` | 0.1.0 |
| `@three-ws/pumpfun-skills` | 0.1.0 |
| `@three-ws/irl` | 0.1.0 |
| `@three-ws/pose` | 0.1.0 |
| `@three-ws/avatar-schema` | 0.2.0 |
| `@three-ws/react` | 1.0.0 |
| `@three-ws/viewer-presets` | 0.2.0 |
| `@three-ws/avatar-cli` | 0.2.0 |
| `@three-ws/vscode-x402` | 0.1.0 |
| `@three-ws/agent-sniper` | 0.1.0 |
| `@three-ws/agentcore-payments-mcp` | 0.1.0 |
| `@three-ws/alibaba-cloud-mcp` | 0.1.0 |

**Claude Code plugins:** `three-ws-core` (`.agents/.claude-plugin/`, v1.0.0) — natural-language wallet + x402 skills over the three.ws wallet API, installed via the plugin marketplace (`/plugin marketplace add nirholas/three.ws`). See [Claude Code Plugin Marketplace](#claude-code-plugin-marketplace).

### On-Chain Artifacts

| Artifact | Version | Chain |
|---------|---------|-------|
| `skill_license` Anchor program | 0.1.0 | Solana (`EdngSwxmDktyrr4phwGEZnCXEoQ27vgnBtowjhKa7Wr8`) |
| `agent_invocation` Anchor program | 0.2.0 | Solana (`AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo`) |
| `ThreeWSFactory` | deployed-2026-05 | BSC, Base, Arbitrum |
| `ThreeWSPayments` | deployed-2026-05 | BSC, Arbitrum, Base |
| `IdentityRegistry` (ERC-8004) | deployed, 12 mainnets | Base, Arbitrum, ETH, Polygon, BNB, Optimism, Avalanche, Gnosis, Fantom, Celo, Linea, Scroll |
| `ReputationRegistry` (ERC-8004) | deployed, 12 mainnets | Same as above |
| `ValidationRegistry` (ERC-8004) | deployed, 7 testnets | Testnet only — mainnet pending |
| `AgentPayments.sol` (EVM) | not deployed | — |

---

## GPU Worker Service Contracts

The Python/FastAPI workers in `workers/` run on Google Cloud Run (GPU). Each exposes a small, uniform HTTP contract — `POST` to submit a job, `GET /tasks/:id` to poll, `GET /health` for liveness. Job state lives in Firestore; outputs land in GCS, then are copied to Cloudflare R2. The `api/forge*` and `api/_lib/forge-tiers.js` layer selects a backend by $THREE tier and fronts these workers.

| Worker | Submit | Poll | Other | Function |
|--------|--------|------|-------|----------|
| `avatar-pipeline-controller` | `POST /reconstruct` | `GET /jobs/:id` | `GET /health` | Orchestrates image→3D→rig→blendshapes; routes to model backends then UniRig |
| `model-hunyuan3d` | `POST /infer` | `GET /tasks/:id` | `GET /health` | Image → 3D mesh (Hunyuan3D, CUDA) |
| `model-trellis` | `POST /infer` | `GET /tasks/:id` | `GET /health` | Text/image → 3D mesh (TRELLIS, CUDA) |
| `model-triposr` | `POST /infer` | `GET /tasks/:id` | `GET /health` | Image → 3D mesh (TripoSR) |
| `model-triposg` | `POST /infer` | `GET /tasks/:id` | `GET /health` | Image → 3D mesh (TripoSG) |
| `model-text2motion` | `POST /infer` | `GET /tasks/:id` | `GET /health` | Text → SMPL motion (MDM) → canonical AnimationClip JSON |
| `unirig` | `POST /rig` | `GET /tasks/:id` | `GET /health` | Skeleton + skinning + ARKit-52 blendshapes (UniRig, SIGGRAPH 2025) |
| `rembg` | `POST /remove` | `GET /tasks/:id` | `GET /health` | Background removal (BRIA RMBG-2.0, u2net, isnet) |
| `segment` | `POST /segment` | `GET /tasks/:id` | `GET /health` | Mesh part segmentation |
| `stylize` | `POST /process` | `GET /tasks/:id` | `GET /styles`, `GET /health` | Mesh/texture style transfer (style catalog) |
| `texture` | `POST /texture` | `GET /tasks/:id` | `POST /retexture_region`, `GET /health` | Full + regional re-texturing |
| `remesh` | `POST /infer` (Blender) | `GET /tasks/:id` | `GET /health` | Geometry remesh (Blender FBX pipeline) |
| `avatar-reconstruction` | `POST /reconstruct` | `GET /jobs/:id` | `GET /health` | Photo → avatar face reconstruction (`face_pipeline.py`) |

> Deploy via `workers/deploy/` (`deploy-all.sh`, `deploy-editing.sh`, `stage-weights.sh`) + per-worker `cloudbuild.yaml`. `workers/pump-fun-mcp/` is a Cloudflare Worker (`wrangler.toml`), not a GPU worker. `workers/longcat/` is an empty stub.

### Voice & Multimodal Endpoints (Cloud Run → NVIDIA)

| Endpoint | Files / Backend | Function |
|----------|-----------------|----------|
| `POST /api/tts/speak` | `api/tts/speak.js`, `voices.js`, `edge.js` | Text → speech (NVIDIA Magpie primary, OpenAI TTS backstop) |
| `POST /api/tts/eleven` · `eleven-clone` | `api/tts/eleven*.js` | ElevenLabs premium TTS + voice cloning |
| `POST /api/asr` | NVIDIA Riva (gRPC) | Free speech-to-text (voice in) |
| `POST /api/a2f` | NVIDIA Audio2Face-3D (gRPC) | Free audio → ARKit-52 facial animation |
| `POST /api/vision` | NVIDIA NIM VLM → OpenAI gpt-5.4-nano | Public image understanding |
| `POST /api/cosmos` | NVIDIA Cosmos | Text → ~5s 1280×704@24fps world video (async MP4) |

gRPC protobufs are vendored under `api/_lib/riva-protos/` and `api/_lib/a2f-protos/`; these endpoints require the Node runtime (not Edge).

---

## Testing & Quality Assurance

There is **no GitHub Actions CI** — the project deliberately does not use `.github/workflows` for CI/deploy (the one file there, `agent-screen-pool.yml`, is an optional agent-screen worker host, not a pipeline). Deploys run through Cloud Build; schedules through Cloud Scheduler. So a large local test suite + the `gate`/`audit`/`smoke` scripts ARE the quality bar. **~591 test files.**

**Runners:**

| Script | Stack | Scope |
|--------|-------|-------|
| `test` | Vitest + Playwright | `vitest run && playwright test` — full suite |
| `test:core` | Vitest (1 worker) | Deterministic unit runs |
| `test:e2e` | Playwright | Browser end-to-end |
| `test:gate` | `test-gate.mjs` | Build-gate subset |
| `test:pages` | `test-pages.mjs` | Per-page smoke |
| `test:mcp` | `test-mcp-all.mjs` | All MCP remotes/stdio |

**Layout & coverage (by directory):**

| Dir | Count | Focus |
|-----|-------|-------|
| `tests/` (root) | ~334 | Cross-cutting unit/integration: agents, animation/retarget, ARKit blendshapes, sniper, wallet tabs, agora, IRL/AR, x402, guardian |
| `tests/api/` | ~207 | API handler tests across every feature area |
| `tests/src/` | ~38 | Frontend module tests |
| `tests/oracle/` | ~7 | Oracle scoring/conviction loops |
| `tests/three/`, `tests/runtime/`, `tests/sdk/`, `tests/public/` | ~5 | Three.js, runtime lipsync, SDK, public surfaces |
| `tests/_fixtures/`, `tests/_helpers/`, `tests/fixtures/`, `tests/helpers/`, `tests/e2e/` | — | Shared fixtures, helpers, Playwright specs |

**Heaviest-tested subsystems** (by filename prefix): `agent-*` (27), `irl-*` (20), `pump*` (20), `forge-*` (9), `three-*` (9), `vanity-*` (8), `mcp-*` (8), `wallet-*` (7), `solana-*` (6). Animation correctness is guarded by `animation-retarget`, `animation-upright-invariant`, `animation-state-machine`, `glb-canonicalize`, and `arkit-blendshapes` tests (the universal-rig contract from CLAUDE.md).

---

## Agent Discovery & Well-Known Manifests

three.ws is built to be discovered and consumed by other agents, crawlers, and registries. It publishes a full suite of machine-readable manifests under `/.well-known/` — some static (`public/.well-known/`), some served dynamically (`api/wk.js`, `api/openapi-json.js`).

| Manifest | Path | Purpose |
|----------|------|---------|
| A2A Agent Card | `/.well-known/agent-card.json` | Google A2A agent card: `provider`, `capabilities`, `authentication`, `skills`, input/output modes |
| 3D Agent Card | `/.well-known/3d-agent-card.json` (+ `.schema.json`) | three.ws-native card: `model`, `services`, `x402Support`, `x402Endpoints`, `registrations` |
| ERC-8004 Registration | `/.well-known/agent-registration.json` | On-chain agent identity manifest (agentCard + services + x402Support) for ERC-8004 hydration |
| Metaplex Metadata | `/.well-known/three-ws-agent.metaplex.json` | Token/NFT metadata (`animation_url`, `body`, model) |
| OpenAI Plugin | `/.well-known/ai-plugin.json` | ChatGPT plugin manifest (`name_for_model`, `api`, auth) |
| LobeHub Plugin | `/.well-known/lobehub-plugin.json` | LobeHub plugin (`identifier`, `ui`, `api`, `systemRole`) |
| OpenAPI | `/.well-known/openapi.yaml` · `api/openapi-json.js` | Full REST API specification |
| ERC-8004 Validators | `/.well-known/validators.json` | Allow-listed validator addresses (mainnet + testnet) |
| Security | `/.well-known/security.txt` | Security disclosure contact |
| **x402 service catalog** | `/.well-known/x402.json` · `/.well-known/x402-discovery` | Dynamically generated payable-endpoint catalog (PayAI/CDP-discoverable) |
| **Vanity proof-of-grind** | `/.well-known/three-vanity.json` | Ed25519 proof-of-grind certificates for vanity addresses |

These feed: x402 Bazaar discovery (PayAI + Coinbase CDP crawlers), ERC-8004 registries across 12+ chains, LobeHub/ChatGPT plugin stores, and A2A agent-to-agent capability negotiation.

### ERC-8004 On-Chain Deployment Matrix

CREATE2-deterministic, so `IdentityRegistry` + `ReputationRegistry` share one address per environment class. Liveness is asserted by `scripts/verify-onchain-parity.mjs` (`eth_getCode` sweep), not by stored tx hashes.

| Registry | Address | Mainnet liveness |
|----------|---------|------------------|
| `IdentityRegistry` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | bytecode-verified (2026-06-19) on **12 chains**: Ethereum (1), Optimism (10), BSC (56), Gnosis (100), Polygon (137), Mantle (5000), Base (8453), Arbitrum One (42161), Celo (42220), Avalanche (43114), Linea (59144), Scroll (534352) |
| `ReputationRegistry` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | same 12 chains |
| `ValidationRegistry` | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | **testnet only** (mainnet pending; `src/erc8004/abi.js` `MAINNET.validationRegistry = ''`) |

**Not yet deployed (mainnet):** Fantom (250), zkSync Era (324 — CREATE2 derives differently), Moonbeam (1284) — `eth_getCode` returned `0x` on 2026-06-19; registration/reputation writes revert there until deployed. **Testnets (bytecode-verified):** BSC (97), Ethereum Sepolia (11155111), Base Sepolia (84532), Arbitrum Sepolia (421614), Optimism Sepolia (11155420), + more. See `contracts/DEPLOYMENTS.md`.

---

## Scheduled Jobs (Cron Reference)

**`vercel.json` declares ~80 cron schedules** (the platform is heavily clock-driven), executed in production by **Google Cloud Scheduler** (jobs provisioned from the `vercel.json` cron list by `scripts/create-gcp-scheduler.mjs`). All hit `GET /api/cron/*` (or `/api/llm/health`) with `Authorization: Bearer $CRON_SECRET`. Write-heavy crons opt into a **storage-pressure preflight** (`wrapCron(handler, { requireWriteCapacity: true })` in `api/_lib/http.js` → `isStoragePressured()` in `db.js`): at the Neon size cap they skip the tick with `200 {skipped:'db_at_storage_cap'}` and still write a healthy heartbeat, rather than flooding logs with 53100 write errors. Every `wrapCron` also writes `cron:heartbeat:<name>` (7-day TTL) surfaced by `/api/ops/health` + `/api/admin/all-systems`. Full schedule:

| Domain | Crons (path → schedule) |
|--------|--------------------------|
| **Oracle / Intel** | `oracle-score` `*/2m` · `oracle-digest` `daily 08:00` · `intel-learn` `*/15m` · `reflect-sweep` `*/30m` · `pulse-tick` `*/2m` (circulation engine) · `coin-intel-observe` `*/2m` (PumpPortal firehose, write-preflight) · `gmgn-seed` `daily 03:00` · `pumpfun-signals` `*/15m` · `reconcile-decisions` `*/10m` |
| **x402 economy** | `x402-autonomous-loop` `*/5m` (autonomous-registry: volume engine, ring-rebalance, daily revenue-reconciliation) · `x402-seed-cron` `*/1m` (60 real USDC micropayments/tick) · `payment-session-sweep` `*/5m` (expire + refund spend sessions) |
| **Coin launcher** | `launcher-tick` `*/1m` (autonomous mint, SOL-capped, write-preflight) · `launcher-claimer` `*/5m` (creator-fee auto-claim) · `solana-autodeploy` `*/10m` (mint undeployed agents as Metaplex Core + Agent Registry) |
| **Pump.fun** | `pumpfun-monitor` `*/3m` · `pumpfun-graduations-sync` `*/2m` · `pump-agent-stats` `*/10m` · `run-buyback` `hourly` · `run-distribute-payments` `:30 hourly` · `run-coin-cycle` `*/5m` · `run-coin-payouts` `*/5m` · `cosmetic-splits-sweep` `:15 hourly` |
| **Smart money / radar** | `smart-money-rollup` `*/5m` · `smart-money-graph` `*/10m` · `radar-watchlist` `*/10m` · `recompute-reputation` `*/10m` |
| **Trading fan-out** | `copy-fanout` `*/2m` · `mirror-fanout` `*/2m` · `signal-fanout` `*/2m` · `strategy-fanout` `*/2m` · `run-dca` `hourly` · `run-subscriptions` `hourly` |
| **$THREE / treasury** | `three-holders-snapshot` `*/5m` · `treasury-autopilot` `:23 hourly` · `run-three-buyback` `daily 06:00` · `settle-royalties` `daily 03:00` |
| **Wallet / custody** | `wallet-intents` `*/10m` · `index-delegations` `*/5m` · `process-withdrawals` `hourly` · `custody-attest` `:17 */6h` · `relayer-balance-check` `*/6h` · `dead-man-switch` `daily 05:00` |
| **On-chain indexing** | `erc8004-crawl` `*/15m` · `solana-attestations-crawl` `*/10m` · `trader-score-attest` `daily 09:45` · `solana-attest-event-cleanup` `*/10m` |
| **Avatars / Forge** | `avaturn-seed-cron` `*/1m` · `auto-rig-sweep` `*/5m` · `forge-seed-cron` `*/1m` · `forge-smoke` `daily 09:30` · `avatar-thumbnail-render` `*/10m` (GLB→PNG regen) |
| **Community / IRL** | `club-payouts` `*/5m` · `irl-drops-refund` `*/10m` · `irl-reap` `:17 hourly` · `unstoppable-tick` `*/5m` |
| **X / social** | `run-x-scheduled-posts` `*/1m` · `run-x-triggers` `*/5m` · `fetch-x-metrics` `*/6h` |
| **Billing / subscriptions** | `process-subscriptions` `*/6h` · `expire-pending-purchases` `*/5m` · `flush-usage-events` `*/1m` |
| **Platform health / GC** | `uptime-check` `*/5m` · `world-health` `*/15m` · `quota-check` `hourly` · `/api/llm/health` `hourly` · `audit-log-cleanup` `daily 04:00` · `cleanup-csrf-tokens` `:17 hourly` · `siwx-gc` `daily 03:00` · `db-retention` `*/15m` (Neon housekeeping — prune unbounded tables under the 512 MB cap) · `three-market-refresh` `*/1m` (single $THREE market fetch/min → L2 cache, kills upstream quota fan-out) |

---

## Build, Test & Release Pipeline

Root `package.json` (v1.5.2, Node 24.x) declares **42 npm workspaces** and ~90 scripts. The pipeline is asset-heavy and gate-enforced — no external CI, so these scripts ARE the quality gate.

### Dev & Run

| Script | Purpose |
|--------|---------|
| `dev` | `vite --port 3000` |
| `dev:multi` / `dev:walk-all` | Multiplayer Colyseus server / full walk stack |
| `dev:lib` | `TARGET=lib vite` (CDN bundle dev) |
| `setup` / `postinstall` | `setup-dev.mjs`; postinstall builds payments SDK, fixes pump/x402/zauth/colyseus ESM, copies Three.js decoders, installs Claude skills |

### Asset Bake (prebuild)

`prebuild` runs in parallel: `build:news`, `build-skill-metadata`, `build-local-skill-packs`, `build:club-assets` (props/venue/HDRI/audio/entrance), `build:walk-environments`, then `inject-blog-seo`, `inject-hidden-guard`, `build:page-index` + page/handler/guard audits (strict), `inject-seo-meta`, `inject-theme-boot`. Other bakers: `build:animations` (Mixamo FBX → canonical JSON), `convert:fbx`, `extract:animations`, `bake:mannequin`, `build:wasm` (`wasm-pack` for `crates/vanity-grinder` → `src/solana/vanity/wasm`), `optimize:glb`, `build:artifact-viewer`, `build:apps-sdk-viewer`.

### Build & Bundle

| Script | Purpose |
|--------|---------|
| `build` | Vite MPA build (`--max-old-space-size=6144`) + strip service worker from embeds |
| `build:lib` / `build:lib:full` | CDN library bundle (ES / ES+UMD) |
| `build:artifact` | Claude Artifact bundle (`vite.config.artifact.js`) |
| `build:chat` / `build:avatar-studio` | Sub-app builds (`chat/`, `character-studio/`) |
| `build:vercel` | `build-vercel.mjs` — esbuild-bundle all `api/*.js` for deploy |
| `build:all` | chat + app + lib |
| `build:extension(:prod)` | Chrome MV3 walk-avatar extension |

### Audit / Verify / Smoke Gates

`gate` = `test:gate` + `audit:mcp` + `audit:routes` + `audit:handlers` + `audit:pages` + `audit:hidden-guard`. Plus: `verify:solana` / `verify:onchain` (parity), `verify:x402` (catalog + discovery), `smoke:onchain(:ci)`, `smoke:agent-wallet`, `smoke:mcp` / `test:mcp`, `audit:deploy` (esbuild-bundle guard), `guard:esbuild(:all)`, `check:images --strict`, `audit:web` / `snapshot` (page visual snapshots).

### i18n & Publish

`i18n` (extract → translate, `i18n:lint`), `changelog:push` (Telegram), `publish:lib`, `publish:packages(:dry)`, `publish:mcp(:dry)`, `release:lib`, `apply:r2-cors`, `generate-icons`.

---

## Configuration & Environment Reference

The codebase references **~260 distinct `process.env.*` keys** across `api/`; `api/_lib/env.js` centralizes ~200 with `req()`/`opt()` guards. (The Infrastructure section lists the load-bearing subset; this is the full categorized surface.)

| Category | Keys |
|----------|------|
| **Core infra** | `DATABASE_URL` · `UPSTASH_REDIS_REST_URL/_TOKEN` · `UPSTASH_CACHE_REST_URL/_TOKEN` · `UPSTASH_MANAGEMENT_API_KEY` · `UPSTASH_EMAIL` · `KV_REST_API_URL/_TOKEN` · `S3_ENDPOINT/_BUCKET/_PUBLIC_DOMAIN/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY` · `JWT_SECRET` · `JWT_KID` · `WALLET_ENCRYPTION_KEY` · `INTERNAL_API_KEY` · `CRON_SECRET` · `CHROMIUM_PACK_URL` · `APP_ORIGIN` · `PUBLIC_APP_ORIGIN` · `DEFAULT_APP_ORIGIN` · `STOREFRONT_ORIGIN` · `SERVER_DOMAIN` · `NODE_ENV` · `VERCEL_ENV` |
| **RPC & chains** | `SOLANA_RPC_URL` · `SOLANA_RPC_URL_DEVNET` · `MAINNET_RPC_URL` · `BASE_RPC_URL` · `BASE_SEPOLIA_RPC_URL` · `SEPOLIA_RPC_URL` · `EVM_RPC_URL` · `RPC_URL_8453` · `RPC_URL_84532` · `CLUB_BASE_RPC_URL` · `A2A_REPUTATION_RPC_URL` · `HELIUS_API_KEY` · `ETHERSCAN_API_KEY` |
| **$THREE & treasuries** | `THREE_TOKEN_MINT` · `THREE_TOKEN_DECIMALS` · `THREE_TREASURY_WALLET` · `THREE_REWARDS_WALLET` · `THREE_BURN_ADDRESS` · `THREE_QUOTE_SECRET` · `THREE_QUOTE_TTL_S` · `THREE_PRIZE_PAYOUT_KEY` · `THREE_ALLOWANCE_DELEGATE_SECRET_KEY_B64` · `THREE_WS_MARK_ENFORCE` · `PLATFORM_TREASURY_KEYPAIR` · `TREASURY_KEYPAIR` · `COIN_TREASURY_SECRET_KEY_B64` · `COIN_CREATOR_SECRET_KEY_B64_*` · `CLUB_SOLANA_TREASURY_SECRET_KEY_B64` · `CLUB_EVM_TREASURY_PRIVATE_KEY` |
| **LLM / AI** | `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `GROQ_API_KEY` · `OPENROUTER_API_KEY` · `OPENROUTER_FALLBACK_KEYS` · `NVIDIA_API_KEY` · `NVIDIA_A2F_FUNCTION_ID` · `NVIDIA_ASR_FUNCTION_ID` · `NVIDIA_COSMOS_INVOKE_URL` · `WATSONX_API_KEY/_URL/_PROJECT_ID/_SPACE_ID/_MODEL_ID/_GUARDIAN_MODEL_ID/_API_VERSION` · `WATSONX_ORCHESTRATE_URL/_API_KEY/_AGENT` · `DASHSCOPE_API_KEY` · `MODELSCOPE_API_KEY` · `LIVEPEER_API_KEY` · `VOYAGE_API_KEY` · `AIXBT_API_KEY/_API_BASE/_ENABLED` · `ELEVENLABS_API_KEY` |
| **x402 / payments** | `X402_FACILITATOR_URL(_BASE/_SOLANA)` · `X402_FACILITATOR_TOKEN(_BASE/_SOLANA)` · `X402_CDP_FACILITATOR_URL` · `X402_PAY_TO(_BASE/_BSC/_SOLANA)` · `X402_ASSET_ADDRESS_BASE/_BSC/_ARBITRUM` · `X402_ASSET_MINT(_SOLANA)` · `X402_FEE_PAYER_SOLANA` · `X402_ACCEPT_THREE_SOLANA` · `X402_THREE_AMOUNT_SOLANA` · `X402_EVM_NETWORKS` · `X402_MAX_PER_CALL/_HOUR/_DAY_ATOMIC` · `X402_MAX_AMOUNT_REQUIRED` · `X402_IDEMPOTENCY_TTL_SECONDS` · `X402_BUILDER_CODE_APP/_WALLET` · `X402_PRICE_<SLUG>` (per-endpoint overrides) · `CDP_API_KEY_ID/_SECRET` · `BSC_OPERATOR_KEY` · `PLATFORM_FEE_BPS` |
| **x402 self-facilitator / ring** | `X402_SELF_FACILITATOR_ENABLED` · `X402_FEE_PAYER_SECRET_BASE58` · `X402_TREASURY_SECRET_BASE58` · `X402_SEED_SOLANA_SECRET_BASE58` · `X402_SELF_FACILITATOR_PAYTO_ALLOWLIST` · `X402_SPONSOR_SOL_FLOOR_LAMPORTS` · `X402_SELF_FAC_MAX_CU_LIMIT/_CU_PRICE/_PRIORITY_LAMPORTS` · `X402_RING_SELF_PAY` · `X402_PRICE_RING_SETTLE` · `X402_RING_TREASURY_BUFFER_ATOMIC` · `X402_RING_MIN_SWEEP_ATOMIC` · `X402_EXTERNAL_ENABLED` · `X402_AUTONOMOUS_DAILY_CAP_ATOMIC` · `X402_VOLUME_PER_RUN_CAP_ATOMIC` · `X402_VOLUME_BATCH_PER_RUN` |
| **Circulation engine** | `CIRCULATION_ENABLED` · `CIRCULATION_TREASURY_SECRET` · `CIRCULATION_NETWORK` · `CIRCULATION_POOL_TARGET` · `CIRCULATION_GROWTH_PER_TICK` · `CIRCULATION_ACTIONS_PER_TICK` · `CIRCULATION_EVM_TREASURY_SECRET` · `CIRCULATION_EVM_CHAIN_ID` (removed: `CIRCULATION_REAL_SELLER_DEMAND`, `_DAILY_CAP`) |
| **Sniper / trading** | `SNIPER_MODE` · `SNIPER_NETWORK` · `SNIPER_GLOBAL_KILL` · `SNIPER_POLL_MS` · `SNIPER_STRATEGY_REFRESH_MS` · `SNIPER_MAX_GLOBAL_BUYS_PER_MIN` · `SNIPER_BUY_CONCURRENCY/_QUEUE_DEPTH` · `SNIPER_CONFIRM_TIMEOUT_MS` · `SNIPER_FEED_WATCHDOG_MS` · `SNIPER_EXIT_ON_BEARISH(_MIN_CONFIDENCE)` · `SNIPER_CLAIM_POLL_MS/_LOOKBACK_S/_MAX_AGE_S` · `SNIPER_WALLET_<AGENTID>` · `SNIPER_ADMIN_TOKEN` |
| **Agora** | `AGENC_DEVNET_RPC_URL` · `AGORA_CLUSTER` · `AGORA_MAX/MIN_CITIZENS` · `AGORA_TICK_MS/_JITTER_MS` · `AGORA_RECONCILE_MS` · `AGORA_DISPATCH_TASKS` · `AGORA_ENABLE_HIRING/_VERIFY/_ARENA/_GUILD` · `AGORA_ARENA/GUILD_MAX_WORKERS` · `AGORA_ARENA_MIN_REP` · `AGORA_MAINNET_ENABLED` · `AGORA_THREE_MINT` · `AGORA_MAINNET_SPEND_CAP_ATOMIC` · `AGORA_MAX/DAILY_THREE_CAP` |
| **Agent screen / launcher** | `SCREEN_WORKER_SECRET` · `SCREEN_POOL_MAX` · `BROWSERBASE_API_KEY/_PROJECT_ID` (screen); `GCP_VIDEO2SCENE_URL` · `GCP_RECONSTRUCTION_KEY` (scene capture); launcher SOL caps + `avaturn_seed`/`app_flags` runtime toggles |
| **Agent payments / guards** | `A2A_MANDATE_SECRET` · `A2A_PAYER_PRIVATE_KEY` · `A2A_PAYER_SOLANA_PRIVATE_KEY/_SECRET` · `GUARDIAN_SEND_CAP_USD` · `GUARDIAN_DISABLE` · `AGENT_RELAYER_KEY/_ADDRESS` · `PERMISSIONS_RELAYER_ENABLED` |
| **Auth / identity** | `PRIVY_APP_ID/_APP_SECRET/_JWKS_ENDPOINT` · `VITE_PRIVY_APP_ID` · `GITHUB_OAUTH_CLIENT_ID/_SECRET` · `X_OAUTH_CLIENT_ID/_SECRET` · `NEYNAR_API_KEY` · `SAML_IDP_*` / `SAML_SP_*` (12 keys) · `ADMIN_ADDRESSES` · `BUILT_IN_ADMIN_ADDRESSES` · `ERC8004_VALIDATOR_PRIVATE_KEY` · `VALIDATOR_PRIVATE_KEY` · `HOLDER_PASS_SECRET` · `WALLET_CAPABILITY_SECRET` |
| **Storage / pinning / SNS** | `PINATA_JWT` · `NFT_STORAGE_TOKEN` · `BUBBLEGUM_MERKLE_TREE` · `BUBBLEGUM_TREE_AUTHORITY` · `THREEWS_SOL_PARENT_SECRET_BASE58` · `THREEWS_SOL_PARENT_DOMAIN` · `MINT_PUBKEY` |
| **Vanity / drops** | `VANITY_SERVICE_KEY` · `VANITY_BOUNTY_PAYOUT_KEY` · `VANITY_DROP_FUNDING_KEY` |
| **Multiplayer / worlds** | `MULTIPLAYER_URL` · `MULTIPLAYER_INTERNAL_URL` · `MULTIPLAYER_SHARED_SECRET` |
| **AWS Marketplace** | `AWS_MP_PRODUCT_CODE` · `AWS_MP_REGION` · `AWS_MP_ACCESS_KEY_ID/_SECRET_ACCESS_KEY` · `AWS_MP_SNS_TOPIC_ARN` · `AWS_MP_METERING_DIMENSION` · `AWS_MP_ENTITLEMENT_REQUIRED` · `AWS_MP_DEFAULT_RATE_LIMIT_PER_MINUTE` |
| **Avatars / feature flags** | `AVATURN_API_KEY/_API_URL/_SEED_ENABLED` · `CHAT_ADMIN_KEY` · `RIDER_HELIUS_WEBHOOK_SECRET` · `RIDER_VAULT_ADDRESS` · `CZ_AGENT_ID/_AGENT_NAME/_REGISTRY_CONTRACT` · `ZAUTH_API_KEY/_DEBUG/_INCLUDE_BODIES` · `OFFER_RECEIPT_SIGNING_PRIVATE_KEY/_JWK/_JWS_ALG/_FORMAT` |
| **Publishing / comms** | `DEV_TO_API_KEY` · `MEDIUM_INTEGRATION_TOKEN` · `MEDIUM_AUTHOR_ID` (Telegram keys: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANGELOG_CHAT_ID`) |

---

## Database Schema — Complete Table Index

`api/_lib/schema.sql` + **259 dated migration files** in `api/_lib/migrations/` (2026-04-29 → 2026-07-02) define **~295 Postgres tables** on Neon. Extensions: `citext`, `pg_trgm`, `pgcrypto` — **no pgvector**; embeddings are JSONB float arrays with cosine computed in JS. Complete index by domain:

| Domain | Tables |
|--------|--------|
| **Identity & Auth** | `users` · `sessions` · `password_resets` · `email_verifications` · `api_keys` · `csrf_tokens` · `oauth_clients` · `oauth_auth_codes` · `oauth_refresh_tokens` · `siwe_nonces` · `siws_nonces` · `siwx_nonces` · `siwx_payments` · `gate_nonces` · `saml_request_ids` · `solana_credentials` · `user_subdomains` · `user_prefs` · `user_wallets` · `user_follows` · `user_mutes` · `user_notifications` · `social_connections` · `friendships` · `direct_messages` · `newsletter_subscribers` · `push_subscriptions` |
| **Agents core** | `agent_identities` · `agent_versions` · `agent_actions` · `agent_decisions` · `agent_mood_history` · `agent_reflections` · `agent_reflection_runs` · `agent_brain_anchors` · `agent_memories` · `agent_memory_entities` · `agent_memory_entity_links` · `agent_memory_pins` · `agent_registrations_pending` · `agent_bookmarks` · `agent_reviews` · `agent_anomaly_events` |
| **Wallets, custody & ledger** | `agent_payout_wallets` · `agent_payments` · `agent_payment_intents` · `agent_revenue_events` · `agent_withdrawals` · `agent_custody_events` · `agent_recovery_requests` · `agent_recovery_approvals` · `agent_recovery_guardians` · `agent_wallet_capabilities` · `agent_wallet_intents` · `agent_delegations` · `three_allowances` · `payouts` · `payment_configs_pending` · `custody_attestation_epochs` · `custody_attestation_leaves` · `ledger_anchors` · `credit_accounts` · `credit_ledger` · `circulation_actions` · `token_payments` |
| **Skills, assets & royalties** | `marketplace_skills` · `marketplace_themes` · `agent_skill_prices` · `skill_pricing_rules` · `skill_purchases` · `skill_access_grants` · `skill_installs` · `skill_license_mints` · `skill_payment_earnings` · `skill_usage_logs` · `skill_ratings` · `skill_reviews` · `skill_bundles` · `bundle_items` · `bundle_purchases` · `paid_assets` · `asset_prices` · `asset_purchases` · `asset_purchase_receipts` · `fork_royalty_terms` · `fork_royalty_payouts` · `listing_splits` · `listing_split_recipients` · `split_distributions` · `royalty_ledger` · `purchase_events` · `purchase_receipts` |
| **Pump.fun, oracle & intel** | `pump_agent_mints` · `pump_agent_payments` · `pump_agent_trades` · `pump_agent_stats` · `pump_agent_price_points` · `pump_coin_intel` · `pump_coin_outcomes` · `pump_coin_wallets` · `pump_intel_weights` · `pump_relay_trades` · `pump_trade_delegations` · `pump_buyback_runs` · `pump_distribute_runs` · `pump_autopilot` · `pump_alert_rules` · `pump_alert_rule_fires` · `pump_alert_deliveries` · `pumpfun_graduations` · `pumpfun_monitor_cursor` · `pumpfun_signals` · `pumpfun_signals_cursor` · `oracle_conviction` · `oracle_conviction_history` · `oracle_narrative` · `oracle_agent_watch` · `oracle_watch_actions` · `oracle_followers` · `coin_smart_money` · `smart_money_scored` · `smart_wallet_clusters` · `smart_wallet_folded` · `smart_wallet_reputation` · `wallet_reputation` · `firewall_decisions` · `radar_watchlist` · `radar_events` |
| **Trading, strategies & vaults** | `agent_sniper_strategies` · `agent_sniper_positions` · `token_intel_risk` · `sniper_funding_events` · `sniper_coin_sentiment` · `sniper_trade_analytics` · `three_market_signals` · `agent_strategies` · `agent_strategy_equips` · `agent_strategy_positions` · `strategy_backtests` · `strategy_kill_switch` · `orders` · `order_fills` · `agent_mirror_follows` · `agent_mirror_fills` · `copy_subscriptions` · `copy_executions` · `dca_strategies` · `dca_executions` · `market_maker_policies` · `market_maker_actions` · `agent_market_maker_configs` · `agent_market_maker_trades` · `swarms` · `swarm_members` · `swarm_votes` · `swarm_payouts` · `agent_vaults` · `vault_backers` · `vault_positions` · `vault_events` · `signal_feeds` · `signal_emissions` · `signal_subscriptions` · `signal_deliveries` · `decision_outcomes` · `portfolio_snapshots` · `wallet_value_snapshots` |
| **Coin launcher (autonomous)** | `launcher_config` · `launcher_queue` · `launcher_runs` · `launcher_claims` · `agent_launcher_configs` · `agent_launched_coins` |
| **x402, billing & subscriptions** | `x402_skus` · `x402_merchant_settings` · `x402_receipts` · `x402_checkout_calls` · `x402_pump_launches` · `x402_subscriptions` · `x402_access_log` · `x402_audit_log` · `x402_self_facilitator_log` · `x402_ring_ledger` · `x402_ring_wallets` · `x402_volume_metrics` · `x402_autonomous_log` · `x402_subscription_health` · `payment_reconciliation` · `payment_sessions` · `payment_session_executions` · `builder_code_attribution` · `granite_inference_health` · `subscriptions` · `subscription_plans` · `subscription_payments` · `subscription_checkouts` · `creator_subscriptions` · `user_agent_subscriptions` · `agent_subscriptions` · `plan_payment_intents` · `plan_quotas` · `bsc_consumed_tx` · `aws_marketplace_customers` · `aws_marketplace_metering` |
| **Community, worlds & labor** | `agora_citizens` · `agora_activity` · `agora_vouches` · `agora_idempotency` · `clash_battles` · `club_tips` · `club_payouts` · `club_bans` · `club_dancer_wallets` · `coin_launches` · `coin_events` · `coin_holders` · `coin_draws` · `coin_payouts` · `crews` · `crew_members` · `crew_invites` · `walk_sessions` · `walk_events` · `walk_metrics` · `walk_achievements` · `walk_control_sessions` · `walk_control_commands` · `tournaments` · `tournament_entries` · `bounties` · `bounty_submissions` · `bounty_submission_likes` · `agent_bounties` · `agent_jobs` · `agent_hires` · `agent_bids` · `agent_labor_policies` · `genome_breedings` · `irl_drops` · `irl_drop_claims` · `rider_passes` · `unstoppable_activity` · `unstoppable_reflections` · `unstoppable_treasury` · `scene_gates` · `world_docs` |
| **3D, avatars & forge** | `avatars` · `avatar_regen_jobs` · `avatar_thumbnail_regen_jobs` · `avatar_search_warm_cache` · `avatar_vrm_compat` · `animation_clips` · `mocap_clips` · `forge_creations` · `forge_votes` · `forge_board_winners` · `forge_seed_jobs` · `forge_consumption_redemptions` · `forge_high_redemptions` · `cosmetic_sales` · `cosmetic_creator_splits` · `token_metadata` · `launchpad_pages` |
| **Patronage & agent services** | `agent_patron_perks` · `agent_patron_prefs` · `agent_paid_services` · `agent_autopilot_proposals` |
| **Widgets, notifications & RAG** | `widgets` · `widget_views` · `widget_chat_threads` · `widget_chat_messages` · `widget_knowledge_docs` · `widget_knowledge_chunks` · `plugins` · `chat_brand_config` · `notification_events` · `notification_preferences` · `user_alert_configs` · `user_alert_fires` |
| **Indexing, attestations & infra** | `erc8004_agents_index` · `erc8004_crawl_cursor` · `solana_attestations` · `solana_attestations_cursor` · `solana_attest_event_claims` · `solana_agents_index` · `three_holder_snapshot` · `three_holder_snapshot_meta` · `three_rewards_distributions` · `three_buyback_runs` · `usage_events` · `audit_log` · `bot_heartbeat` · `indexer_state` · `webhook_deliveries` · `developer_webhooks` · `referral_visits` · `decision_outcomes` · `agent_activations` · `agent_wallet_balance_log` · `app_flags` (runtime feature flags) |
| **X (social) automation** | `x_posts` · `x_scheduled_posts` · `x_triggers` · `x_pending_reviews` |

> Several tables (e.g. `master_wallets`) are bootstrapped at runtime via `CREATE TABLE IF NOT EXISTS` rather than a migration — see [Known Gaps](#known-gaps--in-progress).

---

## Known Gaps & In-Progress

### Critical / Blocking

| Item | Impact | File |
|------|--------|------|
| `AGENT_RELAYER_KEY` declared `req()` in `env.js` but only needed for ERC-7710 paths | Every cold start of any API function importing `env.js` will throw if unset | `api/_lib/env.js` |
| `WALLET_ENCRYPTION_KEY` falls back to `JWT_SECRET` if unset | All custodial wallet confidentiality tied to session secret | `api/_lib/agent-wallet.js` |
| `ValidationRegistry` not deployed on mainnet | GLB validation attestations cannot be written on mainnet | `contracts/src/ValidationRegistry.sol` |
| `AgentPayments.sol` not deployed anywhere | All EVM agent payment addresses are `0x000…000` | `contracts/src/AgentPayments.sol`, `agent-payments-sdk/src/evm/addresses.ts` |

### In-Progress Features

| Feature | Status | Notes |
|---------|--------|-------|
| ERC-7710 delegation redemption | Opt-in, disabled by default | `PERMISSIONS_RELAYER_ENABLED` flag; `POST /api/permissions/redeem` is the incomplete path |
| `AgentPayments.sol` EVM deployment | Written, not deployed | All `agentPayments` addresses in `addresses.ts` are zero-address placeholders |
| ValidationRegistry mainnet | Testnet only | Platform validator key `0x93Bc7EfB…` provisioned but not funded or allow-listed |
| Trading swarms UI | Backend + `/swarms` dashboard live; 3D Sniper Arena at `/play/arena` | `api/swarms/*`, `src/play/arena.js`, swarms tables |
| Agora economy | **Launched** (Commons live at `/agora`; Arena/Guild migration 2026-07-02) | Agent + human citizens, professions, verifiable WORK supply chain — see [Agora](#agora--living-agent--human-economy-verifiable-work-supply-chain) |
| Self-hosted x402 facilitator | Shipped, **off by default** | `X402_SELF_FACILITATOR_ENABLED` + sponsor secret required; `api/x402-facilitator` returns 503 otherwise |
| Autonomous coin launcher | Live (`launcher_config` defaults flipped to LIVE) | Real SOL, circuit-broken, storage-preflighted; admin arm at `/admin/launcher` |
| Agent-screen pool hosting | No true 24/7 host | Only first-party host is the self-renewing GitHub Actions burst runner (`cron 0 */5`); a Docker VM/Fly/Railway is recommended for production |

### Technical Debt

| Item | Notes |
|------|-------|
| No GitHub Actions CI/CD | The project doesn't use `.github/workflows` for CI/deploy. Deploys run via Cloud Build (`npm run deploy:gcp`), schedules via Cloud Scheduler; the local `gate`/`audit`/`smoke` scripts are the push-time quality bar. Renovate handles dependency updates |
| `master_wallets` table bootstrapped at runtime | `CREATE TABLE IF NOT EXISTS` inline rather than via migration — schema drift risk |
| Two x402 payment protocols using HTTP 402 | CDP x402 v2 (`x402-spec.js`) and pump.fun agent-payments 402 (`x402.js`) coexist with no unified protocol guide |
| `THREE_TREASURY_WALLET` / `THREE_REWARDS_WALLET` / `THREE_QUOTE_SECRET` | Required in production but only fail at first use, not at startup |
| Upstash free-tier quota risk | June 2026 outage documented; quota guard requires optional env vars not guaranteed to be set |
| Multiple OG image endpoints | `@sparticuz/chromium-min` one-time `/tmp` download per cold start, no persistent cache |
| `MARKETPLACE_PLATFORM_FEE_BPS` defaults to 0 | Fee is inert unless explicitly set |
| `x402-modal-sdk` vs `x402-payment-modal` | Two near-identical modal packages (v0.2.0 and v1.2.0) — consolidation opportunity |
| `pumpfun-mcp` vendor copy in `src/tools.js` | Must be kept manually in sync with `api/pump/mcp-tools.js` |
| `data/changelog-telegram-state.json` committed | Accumulates diffs on every push, exposes internal state in PRs |
| Legacy `/studio` and `/dashboard-classic` | 301 to new dashboard but old pages not deleted from disk |
| `apps-sdk/embodiment/` | No `package.json` or build script — raw JS helpers with no version path |
| Withdrawal execution is async | `agent_withdrawals` rows created as 'pending'; actual on-chain transfer worker location unclear in `api/` tree |
| Reflection model IDs | `claude-opus-4-7` model ID referenced in `api/_lib/reflection.js` — verify against Anthropic API |
| LLM provider health | `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` noted as 'over quota' / '401s in prod' in `api/_lib/chat-models.js` — final fallback tier degraded |
| `gRPC` runtime compatibility | `api/_lib/a2f-nvidia.js` and `api/_lib/asr-nvidia.js` require Node runtime (not Edge) — no explicit `runtime` declaration found |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Used in `api/agents/[id].js` but not declared in centralized `api/_lib/env.js` |
| `QSTASH_TOKEN` | Read directly via `process.env` rather than `env.js` — inconsistent pattern |
| Skill-license marketplace initialization | `initialize_marketplace` tx not confirmed as having run on mainnet |
| animation-sources/ population pipeline | `scripts/download-mixamo-animations.js` / `fetch-animations.sh` not automated in CI |
| Payment reconciliation is not a cron file | The daily revenue-reconciliation job is autonomous-registry entry `revenue-reconciliation` (self/027) executed inside `api/cron/x402-autonomous-loop.js` (`*/5`), not a standalone `api/cron/*` — do not confuse with `api/cron/reconcile-decisions.js` (oracle predictions) |
| Trading Brain vs Sniper paths | `src/studio/money/trading-brain.js` shares the sniper compiler/backtester/DB but drives a partly separate discretionary path (`api/trading/*`, `api/strategies`, `api/agents/:id/strategies`) — two execution surfaces to keep in sync |

---

*This document is the authoritative architecture reference for three.ws. For surface-level routing, see `STRUCTURE.md`. For API endpoint details, consult `api/openapi-json.js`. For on-chain deployments, see `contracts/DEPLOYMENTS.md`.*

---

## Appendix: Complete Reference Catalogs

The catalogs below are the output of an exhaustive automated sweep of the codebase — every top-level directory, every file — enumerating the platform surface in full. They are the long-form companion to the curated sections above. Where a count here disagrees with a summary above, the appendix (counted directly from source) is authoritative.

### Complete Route & Page Map

Two layers resolve paths: **`vercel.json`** (`routes` array, 932 entries — production) and **`vite.config.js`** (dev-server `fileMap` + regex rewrites mirroring prod). Dynamic segments use `:param`.

**Core / Marketing / 3D:** `/` → `pages/home.html`; `/home*` 301→`/`; `/what-is`, `/pitch`, `/tour`, `/features` (+ `/features/{ar,forge,scan,play,walk,studio,marketplace,agent-exchange,deploy}`), `/playground`, `/coin3d`, `/hero-demo`, `/constellation`, `/galaxy`, `/cosmos`, `/genome`; `/coin`→`/demo/coin`.

**Agent:** `/agents` → `public/agents/index.html`; `/agents/:id` → `pages/agent-detail.html`; `/agent/:id` 301→`/agents/:id`; `/agent/new`, `/agent/:id/{edit,mind,embed,wallet}`; `/my-agents`; `/discover` (+`/discover/detail.html`); `/agent-studio`; `/agent-badge.html`, `/agent-passport.html`; `/a/:chainId/:agentId` (+`/edit`,`/embed`), `/a/me`, `/a/sol/:asset/.well-known/agent-card.json`→`/api/agents/solana`; `/skills`, `/brain`, `/guardian`, `/reasoning-ledger` (`/ledger/:agentId`).

**Trading / Market:** `/trader/:id`, `/trades`, `/signals` (+`/signals/:slug`), `/terminal`, `/strategies`, `/strategy-lab`, `/swarms`, `/mirror`, `/vaults`, `/labor-market`, `/alpha-copilot`, `/smart-money`, `/oracle` (+`/oracle/arm`,`/arm`), `/radar`, `/coin-intel`, `/trending`, `/activity`, `/watchlist`, `/leaderboard`, `/pulse`, `/pump-live`, `/pump-dashboard`, `/pump-visualizer`, `/pumpfun`, `/gmgn`, `/autopilot` (+`/autopilot-activity`), `/arbitrage`, `/compose`, `/agent-trade`, `/clash`, `/arena` (`/play/arena`).

**3D Worlds:** `/worlds`, `/world-lines`, `/city`, `/agora`, `/club`, `/theater`, `/stage`, `/communities` (`/communities/:mint`, `/town`), `/community`, `/agenc/{embodied,room}`, `/embodiment/embed`, `/play` (+`/play/ufo`,`/play/agent-wallet`), `/game/*` 308→`/play`, `/scene-studio/app`.

**Creation / Studio / Avatars:** `/start`, `/create` (+`/create/{selfie,prompt,character,video,next,studio}`, `/create-review`, `/creating`), `/genesis`, `/scan`, `/segment`, `/scene`, `/dad`, `/forge` (+`/forge/embed`,`/forge-studio`,`/forge-nim`,`/nim-forge`,`/forge-spark`), `/import/rpm`, `/avatar-studio` (dev serves `character-studio/build/`), `/avatar-studio-demo`, `/avatars/:id` (+`/edit`,`/ar`), `/avatar-sdk`, `/avatar-artifact`, `/avatar-wallet-chat`, `/embed/avatar` (`/:handle`), `/characters`, `/character/:id`, `/gallery`, `/gallery-picker`, `/pose` (+`/pose-mini`), `/animations`, `/mocap-studio`, `/overlay-control`, `/voice`, `/xr`, `/ar`, `/hydrate`, `/first-meet`, `/store/:slug`, `/internal/avaturn-forge.html`.

**Launch / Token / $THREE:** `/launch`, `/launchpad`, `/launches` (+`/launches/:mint`), `/launch-week`, `/three`, `/three-live`, `/three-token`, `/threews/claim`, `/claim-wallet`, `/mint-success`, `/bulk-launch` (`/admin/bulk-launch`), `/p/:slug`, `/demo/coin` (`/:mint`), `/bounties` (+`/bounty/:id`), `/go`.

**x402 / Payments:** `/x402` → `public/x402-stripe.html`; `/x402/studio`; `/ca2x402`; `/pay` (+`/pay/calls/:txSig`, `/pay/c/:slug`); `/bazaar`; `/paywall`; `/crypto-demo.html`, `/wallet-connect-demo.html`, `/studio-deposit-harness.html`; `.well-known/x402[.json]`→`/api/wk`; `.well-known/did.json`→`/api/x402/did`.

**Auth / Identity / Wallet:** `/login`, `/register`, `/forgot-password`, `/reset-password`, `/settings`, `/profile` (`/u/:handle`), `/@:handle`, `/wallet.html`, `/vanity-wallet` (+`/vanity/{verify,gallery,bounties}`), `/eth-vanity`, `/evm-wallet`, `/lookup`, `/siwx-test.html`, `/extension/{auth-callback,privacy,terms}`, `/persona/{authorize,demo}`, `.well-known/jwks.json`→`/api/auth/persona`.

**Marketplace / Widgets / Embeds:** `/marketplace` (+`/marketplace/{tools,skills,animations,onchain}` and `/:id`; `/marketplace/agents/:id`→`/agents/:id`; `/marketplace/avatars/:id`→`/avatars/:id`; `/marketplace/analytics`; `/marketplace-walk`), `/collection`, `/widgets` (`public/widgets-gallery/`), `/widget`, `/widget-demo.html`, `/embed` (+`/embed-demo`, `/embed-example.html`, `/embed/v1/preview`, `/embed/walk`), `/walk` → `pages/walk-landing.html` (+`/walk/app`,`/walk-embed`,`/walk-leaderboard`,`/walk-analytics`), `/wk/:avatar`→`/temporary`, `/temporary`, `/artifact` (+`/artifact-example.html`,`/artifact/snippet.html`), `/widget-studio`→`/studio`, `/studio` → `public/studio/index.html`, `/apps-sdk/studio-viewer.html`, `/chat/forge-viewer.html`, `/lobehub/iframe` (`/sperax/iframe`), `/demos-embed/{agents,avatar-only,forge,gallery,selfie,walk}`.

**Dashboard (dashboard-next SPA):** `/dashboard` (+`/dashboard-next`); `/dashboard/{avatars,community-avatars,agents,library,widgets,walk,developers,three-token,holders,analytics,monetize,account,referrals,copy,irl-placements,sniper,settings,tokens,portfolio,api,brain,creator,landscape,prelaunch-radar,transactions,wallet-grinder}` → `pages/dashboard-next/:slug.html`; `/dashboard/:slug` (auto); `/dashboard/edit/:id`; `/dashboard/x402` + `/dashboard/x402-admin` → `public/dashboard/*` (classic); `/dashboard/{wallets,sessions,actions,embed-policy,memory,strategy,voice,sns,delegation,agent-pumpfun,storage,usage}` 301→dashboard-next; `/dashboard-classic/*` 301→`/dashboard/*`. Classic dashboard pages still on disk (`public/dashboard/*.html`) reachable via 301.

**IBM / Cloud partners:** `/ibm/{hello,hello.live,x402-demo}`, `/aws`, `/aws-marketplace/{welcome,error}`, `/dappbay` 302→`dappbay.bnbchain.org/detail/three`, `/providers`.

**Demos:** `/demos` (+`/demos/:slug` ~28 demos incl. `bonding-curve`, `brain`, `erc8004`, `eas-reputation`, `lipsync-{mic,tts}`, `voice-clone`, `usdz-ar`, `react-sdk`, `skill-royalty`, `persona-extract`, `livepeer-inference`, `audio2face`, `halfbody-xr`, `selfie-fit`, `memory-seed`, `create-v2`, `checkout`, `walk-embed-sdk`, `3d-home`, …); `/demos/agents/:slug` (~17: `auto-rig`, `face-mocap`, `gemini-live`, `high-five`, `skateboard`, `trampoline`, `wrecking-ball`, `pickup-drop`, `sit-in-body`, `scroll-inertia`, `cursor-follower`, `builds-button`, `climb-title`, `holds-cta`, `fall-from-top`, `falls-asleep`, `walks-gutter`); `/demo` → `pages/demo-economy.html`; `/demo/avatar-os` (+`/{studio,selfie,combined}`); `/lipsync` (`/mic`); `/live`, `/agent-economy`, `/economy`, `/agent-exchange`, `/labs`, `/fact-checker`, `/unstoppable`, `/shopper`, `/tutor`, `/agi`, `/irl`, `/cz` (+`/cz/offline`), `/next`, `/forever`.

**Docs / Blog / News / Legal:** `/docs` (SPA fetching `public/docs/*.md`) + `/docs/:topic`, `/docs/tutorials/:slug`, `/docs/widgets`, `/docs/walk` (+`/docs/walk/:sub` 9 pages), `/docs/walk-embed-api`; `/tutorials` (+`/tutorials/:slug`), `/glossary`; `/blog`, `/blog/:slug` 301→`/changelog`; `/changelog` (+`/changelog/:slug`); `/news` (+`/news/:slug` ~95 entries); `/events/:slug`; `/legal/{privacy,tos,content-policy,eula,aws-marketplace-eula}`, `/irl-privacy`; `/sitemap` (+`/pages`,`/directory`,`/everything`,`/all-pages` 308→`/sitemap`).

**Identity / Reputation / Validation / Proof:** `/reputation`, `/validation`, `/proof`, `/integrity`, `/status`, `/pricing`, `/x-pricing`, `/billing`, `/credits`, `/support`.

**App / Deploy:** `/app` → `pages/app-next.html`; `/app-classic` → `pages/app.html`; `/app-next` 301→`/app`; `/app-demo`; `/deploy`, `/showcase` → `pages/app.html`; `/chat` 301→`/app` (dev proxied to `:5174`).

**Admin / Internal:** `/admin/{news,sdp,index.html}`, `/admin/bulk-launch`, `/dashboard/x402-admin`, `/internal/avaturn-forge.html`.

**System / Static / `.well-known`:** `/404` (catch-all `/(.*)`), `/500`, `/robots.txt`, `/llms.txt`, `/llms-full.txt`, `/sitemap.xml`→`/api/sitemap`, `/sitemap/{core,agents,avatars,widgets,profiles}.xml`→`/api/sitemap/[type]`, `/changelog.{json,xml}` (static, build-generated), `/rss.xml`, `/rss/announcements.xml`→`/api/rss/announcements`, `/openapi.json`→`/api/openapi-json`, `/agent-3d/versions.json` + `/agent-3d/:ver/agent-3d.js` (CDN lib), `.well-known/{solana/actions.json, chat-plugin.json, sperax-plugin.json, x402.json, agent-attestation-schemas, three-vanity.json, oauth-authorization-server, oauth-protected-resource}`→`/api/wk`, `.well-known/did.json`→`/api/x402/did`, `.well-known/jwks.json`→`/api/auth/persona`, `/footer.html`, `/nav.html` (shared partials); stable unhashed bundles `/footer-bot.js`, `/walk-companion.js`, `/walk-playground.js`, `/feature-tour.js`, `/notifications.js`, `/nav-tier-badge.js`, `/agent-bus.js`, `/i18n.js`, `/error-reporter.js`.

**New routes (2026-06-27 → 07-02):** `/launch-studio` (50 mint recipes), `/launcher` (Memetic Launcher), `/agent-screen` + `/agents-live` (live agent casting), `/capture` (Scene Capture), `/diorama` (text→3D world), `/x402-revenue`, `/payments` (payment sessions), `/billing/keys`, `/agent-economy-volume`, `/deployments` (ERC-8004 feed), `/integrations`, `/partners`, `/viability`, `/pipeline`, `/oracle/docs`, `/ui-juice` (game-feel showcase), `/labs`, `/dashboard/{capabilities,systems,watch}`, and admin `/admin/{launcher,ops,seeder}`.

**Counts:** `vercel.json` = ~970 route entries (~440 HTML/dir-index, ~65 redirects, rest API rewrites + asset/header routes); `pages/` ≈ 230 HTML, `public/` ≈ 230 HTML (incl. ~95 `news/`, demos, dashboard-classic, docs/walk). `vite.config.js` deliberately mirrors prod so dev matches.

### Complete API Directory Index

All **150+ directories** under `api/` plus many top-level single-file endpoints. `_`-prefixed dirs are shared internals; `[bracket].js` are dynamic routes. New since the last revision: `x402-facilitator/`, `launcher/`, `pay/`, `ops/`, `diorama.js`, `scene-capture.js`/`scene-upload.js`, `deployments.js`, `billboard.js`, `pipeline.js`, `three-signal.js`, `agent-screen-*.js`, `agent-task.js`, `agent-ask.js`, `agent-collab.js`, `agent-vanity-grind.js`, `agent-economy/volume`, expanded `agent/` (session, caster-config, launcher, market-maker, watch-intent/-status/-wanted, anchor-script).

| Directory | Files | Purpose |
|---|---|---|
| `_lib/` | 326 `.js` + 19 sub-pkgs | Shared utility layer (see catalog below). |
| `_mcp/` `_mcp3d/` `_mcp-studio/` `_mcpagent/` `_mcpbazaar/` `_mcpibm/` | 17/7/5/3/3/5 | Impl dirs behind the remote MCP servers (auth, catalog, dispatch, pricing, render, tools). |
| `_providers/` | 10 | 3D/image gen provider adapters (gcp, huggingface, meshy, nvidia, nvidia-cosmos, replicate, rodin, stability, tripo) + BYOK registry. |
| `_studio/` | 3 | Studio MCP tool registry/dispatch. |
| `actions/` | avatar, avatar-icon | Farcaster/embed action endpoints. |
| `admin/` | 16 | Admin console (revenue, health, bulk-launch, withdrawals, register-agents, club/news/user subdirs) + `all-systems`, `circulation-health`, `flags`, `launcher`, `seeder`, `ops`. |
| `agenc/` | [action] | AgenC / watsonx Orchestrate dispatcher. |
| `agent-3d/` | versions | 3D asset version listing. |
| `agent-economy/` | status, transact | Two-agent demo economy. |
| `agent-trade/` | demo (SSE), skill | Live A2A trade demo + tradeable skill. |
| `agent/` | activity, dreams, reflect, send-sol, wallet, session, caster-config, launcher, market-maker, watch-intent, watch-status, watch-wanted, anchor-script | Single-agent runtime + live-caster signaling + per-agent launcher/MM config. |
| `agents/` | ~60+ incl `[id]/`, a2a-* (call/cart-verify/hire/mandate/paid), solana*/onchain/, register/, sas/, ens/, pumpfun/, endpoint-shopper-run, networth, copilot, recovery | Central agent surface (identity, A2A, trading/strategy/mirror, ERC-8004 register, Solana ops, portfolio). |
| `agi/` | state | AGI global state. |
| `agora/` | [action], act | Agora citizen actions. |
| `aixbt/` | chat, grounding, intel, projects, _shared | aixbt intelligence proxy. |
| `alerts/` | rules, rules/ | Alert rule CRUD. |
| `animations/` | [id], clips, presign, sell, thumbnail | Animation clip marketplace. |
| `api-keys/` | [id] | API-key management. |
| `assets/` | index | Asset listing. |
| `auth/` | [action], extension-token, github/, persona/, privy/, saml/, session(s)/, siwe/, siws/, wallets/, x/ | Auth: sessions, OAuth, Privy, SAML, SIWE/SIWS, persona, wallet-linking. |
| `autopilot/` | activity, config, proposals | Memory-grounded autopilot. |
| `avatar/` | optimize, presign-audio, presign-glb, render, video-generate, video-status | Single-avatar ops + talking-video. |
| `avatars/` | [id]/, mine, featured, fork, from-forge, draft/, thumbnail, view | Avatar collection CRUD. |
| `aws-marketplace/` | issue-key, link, register, subscription | AWS Marketplace SaaS fulfillment. |
| `bazaar/` | arbitrage, context, list, providers, search | x402 bazaar marketplace. |
| `billing/` | fee-info, invoices, receipts, revenue, summary, payout-wallets/, withdrawals/ | Billing dashboard. |
| `bounties/` | [id]/, leaderboard | Bounty board. |
| `brain/` | chat | Portable-brain chat. |
| `ca2x402/` | resolve | CA → x402 endpoint resolver. |
| `chat-plugin/` | [tool] | LobeHub/ChatGPT plugin tool dispatcher. |
| `chat/` | config, mcp, models, proxy | Chat proxy (LLM proxy, model list, MCP, brand config). |
| `clash/` | [action] | Coin Clash battle actions. |
| `club/` | leaderboard, presence, tips, tips-stream | Club tips/presence/leaderboard (+ SSE). |
| `coin/` | [mint]/ | Per-mint coin detail. |
| `community/` | auth/, capabilities, holder-pass, world-gate, worlds, ws-ticket, messages, me, wallet/ | CoinCommunities-gated layer. |
| `copy/` | earnings, executions, settle-fee, smart-wallets, subscriptions | Copy-trading. |
| `cosmetics/` | catalog, earnings, leaderboard, owned, split | Avatar cosmetics shop + creator splits. |
| `creators/` | [id], skill-analytics | Creator profiles + analytics. |
| `credits/` | deposit, index | Prepaid credit wallet. |
| `crews/` | [tag], index | Crews/clans. |
| `cron/` | ~42 files | Scheduled jobs (fanouts, attest, reputation, seeding, sweeps, health, db-retention, launcher, x402 autonomous loop) — 72 schedules in vercel.json. |
| `custody/` | anchor, integrity | Custodial-wallet anchors + integrity proofs. |
| `cz/` | claim | CZ campaign claim. |
| `dad/` | generate | Persona/"dad" generation. |
| `dashboard/` | prefs | Dashboard preferences. |
| `demo/` | economy, coin/ | Demo surfaces. |
| `developer/` | mcp-test, usage, webhooks, webhooks/ | Developer portal. |
| `embed/` | resolve | Resolve embeddable widget/agent. |
| `erc8004/` | [action], register-confirm | ERC-8004 registry register + confirm + validate. |
| `forever/` | inscribe, status | Permanent inscription (Arweave/Ordinals). |
| `frames/` | walk | Farcaster Frame. |
| `friends/` | index, messages, presence-ticket, search | Social graph. |
| `galaxy/` | flows | Agent-galaxy money-cam flow feed. |
| `genome/` | breed, edges, lineage, preview, stud | Agent genome breeding/lineage. |
| `guardian/` | assess | Granite Guardian assessment. |
| `ibm/` | attest, galaxy, oracle, twin, vision | IBM Granite product surfaces. |
| `inference/` | livepeer | Livepeer inference proxy. |
| `intel/` | smart-money, wallet/ | Smart-money + wallet intel. |
| `irl/` | agent-card, agent-summary, drops, fix-token, interactions(+stream), pins, privacy, report, world-lines | IRL/AR layer. |
| `jobs/` | flush-usage-events | Usage-event flush. |
| `keys/` | [id], index | API/provider key store. |
| `kol/` | [action], trades | KOL actions + trades. |
| `labor/` | post, bid, award, deliver, settle, bounty, feed, policy, agent, tick | Agent Labor Market. |
| `launch/` | mm | Launch market-maker copilot. |
| `launchpad/` | get, invoke, list, publish | Paid-service launchpad. |
| `ledger/` | [agentId], verify/ | Reasoning ledger read + verify. |
| `llm/` | anthropic, health | LLM proxy + health. |
| `lobehub/` | [action] | LobeHub plugin dispatcher. |
| `marketplace/` | [action], analytics, animations, asset-price, buy-asset, check-skill-access, purchase(+-as-agent,-bundle), reviews, set-skill-price, start-trial, theme | Skill/asset marketplace. |
| `memory/` | context, curate, graph, search | Agent memory (context, KG, search). |
| `mirror/` | leaderboard | Mirror-trade leaderboard. |
| `mocap/` | [id], clips | Motion-capture library. |
| `monetization/` | prices, revenue, wallet, withdrawals | Creator monetization. |
| `nft/` | mint-scene(+confirm), resolve | Scene NFT minting. |
| `notifications/` | [id]/, index, preferences, read-all, track | In-app notifications. |
| `oauth/` | [action] | OAuth flow dispatcher. |
| `og/` | agent, sealed-drop, three-token-badge | OG image generators. |
| `onboarding/` | [action] | Onboarding dispatcher. |
| `onramp/` | link | Fiat on-ramp link. |
| `ops/` | health | Comprehensive internal health + cron heartbeats. |
| `launcher/` | me, trends | Autonomous Memetic Launcher (per-user scope + cultural-intelligence trends feed). |
| `oracle/` | 24 files (action-stream, feed, stream, leaderboard, backtest, coin, signal, social, watch, follow, movers, wins, og, …) | Granite Oracle product surface. |
| `pay/` | deal, session, execute | Pay-by-deal + governed x402 payment sessions (create/inspect/cancel + govern-then-spend execute). |
| `payments/` | intent, purchase-skill, evm/, solana/, _config | Unified payment intents. |
| `permissions/` | [action] | ERC-7710 permission grant/redeem dispatcher. |
| `persona/` | extract, preview | Persona extraction from social seeds. |
| `pinning/` | [action] | IPFS pinning dispatcher. |
| `platform/` | stats | Platform-wide stats. |
| `play/` | builds, nonce, refresh, verify | /play sandbox + play-pass. |
| `plugins/` | [action] | Plugin registry dispatcher. |
| `portfolio/` | [action] | Portfolio command dispatcher. |
| `pump-bounties/` | [id], stats | pump.fun GO bounty board. |
| `pump/` | 35 files ([action], launch-prep/-agent/-detail/-og, curve, price-history, coin-intel, intel(+enrich), safety, smart-money, autopilot, trades-stream, helius-webhook, withdraw-prep/-confirm, …) | pump.fun surface. |
| `purchase/` | skill | Skill purchase. |
| `push/` | subscribe | Web-push subscription. |
| `referral/` | visit | Referral visit tracking. |
| `registry/` | resolve | Agent/name registry resolution. |
| `render/` | avatar-clip, glb | Server render endpoints. |
| `reputation/` | leaderboard | Reputation leaderboard. |
| `rider/` | check, firebase, info, webhook | Rider-pass system. |
| `rss/` | announcements | Announcements RSS. |
| `scene/` | gate-check, gate-create | Token-gated 3D scene access. |
| `sdp/` | [...path] | Solana Data Platform proxy. |
| `seed/` | farcaster, github, x, synthesize | Persona seeding from socials. |
| `share/` | x | Share-to-X. |
| `signals/` | feed, feeds, marketplace, stream, subscribe, _common | Signal marketplace. |
| `sitemap/` | [type] | Dynamic sitemap generator. |
| `skills/` | [id]/, categories, index, license-onchain, mint, review | Skill catalog + on-chain license. |
| `sniper/` | compile, backtest, close, radar(+stream), leaderboard, status, strategy, stream, trader, history | Sniper strategy lab. |
| `social/` | sentiment, sentiment-pulse | Social sentiment. |
| `stage/` | host, index, tip | Living Stages. |
| `studio/` | retexture-region | Studio retexture endpoint. |
| `studio-assets/` | [...path] | Studio asset proxy. |
| `subscriptions/` | index, plans, subscribe, verify | Creator subscriptions. |
| `swarms/` | [id], index | Trading swarms. |
| `three/` `three-token/` `token/` | [action] each | $THREE tier/access + token data dispatchers. |
| `threews/` | me, subdomain | three.ws identity + SNS subdomain. |
| `tournaments/` | [id], index | Social Trading Arena tournaments. |
| `traders/` | preview | Trader track-record preview. |
| `trades/` | feed | Live trade feed. |
| `trading/` | scan | Trade-opportunity scanner. |
| `tts/` | speak, edge, eleven(+-clone), voices, eleven/ | Text-to-speech. |
| `tutor/` | session | AI tutor session. |
| `tx/` | explain, solana/ | Transaction explainer. |
| `usage/` | summary | Usage summary. |
| `user/` | provider-keys, wallet/ | Per-user provider keys + wallet. |
| `users/` | [username]/, by-subdomain, earnings, lookup, me/, referral-claim/-code, referrals | User profiles. |
| `v1/` | _catalog, _providers, agents/, market/, sentiment, x/, index | Versioned public API gateway. |
| `vanity/` | bounties, cert, drops, gallery, og | Vanity-address grind market. |
| `vaults/` | [id], deposit, redeem, trade, claim-fees, ledger, index | Trading vaults. |
| `walk/` | session, pilot, metrics, leaderboard, analytics, control/ | Walk/embodiment experience. |
| `wallet/` | balances | Wallet balances. |
| `watsonx/` | embed | watsonx embedding proxy. |
| `webhooks/` | replicate, solana-pay | Inbound webhooks. |
| `widgets/` | [id]/, index, oembed, og, page, view, _demo-fixtures | Embeddable widgets. |
| `world/` | [action] | Per-world persistence dispatcher. |
| `x/` | post, draft, schedule, analytics, reviews, status, triggers | X (Twitter) automation. |
| `x402/` | ~60 files (forge, mint-to-mesh(+batch), token-intel, crypto-intel, three-intel, skill-call, skill-marketplace, pay-by-name, agent-bouncer, agent-reputation, onchain-identity-verify, pump-agent-audit, pump-launch, fact-check, dance-tip, asset-download, animation-download, vanity(+-verifiable), symbol-availability, model-check, permit2-paid-demo, club-cover, cosmetic-purchase, my-receipts, did, service, admin/ · **new:** analytics, ring-settle, llm-proxy, cross-chain, bazaar-feed, mcp-tool-catalog, feed-health, schema-check, model-validation-sweep, notify, rate-limit-probe, api-key-health, auth-health, telegram-health, wallet-connect, solana-register-health, spend-session, avatar-optimize-batch, billboard, mcp-perf, granite-health, glb-optimization-report, service-pricing-report, network-cost) | Paid x402 endpoint catalog (each file = a monetized service) + free ops-dashboard reads. See [x402 self-hosted facilitator](#self-hosted-facilitator--closed-loop-economy). |
| `x402-pay/` | og | OG image for x402 payment pages. |
| `x402-facilitator/` | [action] | **Self-hosted x402 Solana facilitator** — `/verify`, `/settle`, `/supported` (off by default). |
| `x402-revenue.js` · `x402-ring.js` · `x402-status.js` | (single files) | Public revenue feed · closed-loop net-position report · facilitator status probe. |

### Complete `api/_lib/` Utility Catalog

**~357 top-level `.js` modules** + **21 sub-packages** (`a2a`, `a2f-protos`, `club`, `coin`, `copy`, `evm`, `format`, `launch`, `market`, `migrations`, `oracle`, `pay`, `pricing`, `pump-intel`, `riva-protos`, `services`, `sniper`, `solana`, `token`, `trust`, `x402`). The `x402/` sub-package now carries a `pipelines/` fleet for the autonomous economy. Nothing in `_lib` is itself a route. Grouped by domain:

- **DB / cache / storage / infra:** `db.js`, `db-retry.js`, `schema.sql`, `migrations/`, `cache.js`, `redis.js`, `redis-usage.js`, `skill-price-cache.js`, `r2.js`, `ipfs-pin.js`, `storage-mode.js`, `forge-cache.js`, `qstash.js`, `resilience.js` (cockatiel), `sse-poll-breaker.js`, `env.js`, `http.js`, `http-params.js`, `ids.js`, `sentry.js`, `axiom.js`, `rate-limit.js`.
- **Auth / security / crypto:** `auth.js`, `account-auth.js`, `admin.js`, `zauth.js`, `crypto.js`, `secret-box.js` (AES-256-GCM), `provider-keys.js`, `csrf.js`, `ssrf.js`, `ssrf-guard.js`, `fetch-model.js`, `pii.js`, `moderation.js` (NemoGuard), `granite-guardian.js`, `identity-integrity.js`, `siwe.js`, `siws.js`, `siwx-server.js`, `siwx-storage.js`, `saml.js`, `privy.js`, `audit.js`.
- **Solana / on-chain:** `solana/` (connection, rpc-fallback, confirm, gasless-tx, idl, programs, sdk-bridge), `solana-wallet.js`, `solana-signers.js`, `solana-transfer.js`, `solana-collection.js`, `solana-token-meta.js`, `token-metadata.js`, `onchain.js`, `onchain-deploy.js`, `agent-registry.js`, `agent-invocation-onchain.js`; attestations: `attest-event.js`, `sas.js`, `solana-attestations.js`, `solana-validation-attest.js`, `validation-attest.js`, `tournament-attest.js`, `trader-score-attest.js`, `ledger-anchor.js`, `brain-anchor.js`, `custody-proof.js`; `helius.js`, `balances.js`, `three-brand.js`, `threews-sns.js`.
- **EVM / x402:** `x402/` (a2a-client/server, access-control, api-keys, audit-log, auth-hints, bazaar-client/helpers, idempotency-cache, offer-receipt-issuer/server, payment-identifier-client/server, paywall-handler, receipt-storage · **economy layer:** self-facilitator, pay, solana-payer, autonomous-registry, revenue-analytics, revenue-reconciliation, user-activity-analytics, agent-leaderboard-store, wallet-balance-monitor, granite-health, three-signal-store, sniper-analytics-store, scene-capture-processor, `pipelines/*`), `x402.js`, `x402-spec.js`, `x402-paid-endpoint.js`, `x402-prices.js`, `x402-errors.js`, `x402-buyer-fetch.js`, `x402-buyer-axios.js`, `x402-user-payer.js`, `x402-offer-receipt.js`, `x402-spending-cap/-ledger/-price.js`, `x402-solana-confirm.js`, `x402-bsc-direct.js`, `x402-builder-code.js`, `pay/` (payment-session, spend-governor), `evm/rpc.js`, `evm-transfer.js`, `evm-payment-verify.js`, `erc8004-chains.js`, `a2a/` (cart-mandate, mandate, reputation-gate, spend-ledger), `aws-marketplace.js`, `aws-marketplace-bridge.js`.
- **LLM / embeddings / vision / voice:** `llm.js`, `chat-models.js`, `llm-pricing.js`, `llm-health.js`, `provider-health.js`, `strip-reasoning.js`, `orchestrate.js`, `watsonx.js`, `watsonx-forecast.js`, `embeddings.js`, `agent-embeddings.js`, `embedding-math.js`, `chunker.js`, `text-extract.js`, `rerank.js`, `vision.js`, `avatar-alt-text.js`, `forge-image-validate.js`, `a2f-nvidia.js`, `asr-nvidia.js`, `tts-nvidia.js`, `tts-voices.js`, `elevenlabs.js`, `a2f-protos/`, `riva-protos/`.
- **Forge / 3D / avatars:** `forge-tiers/-options/-store/-events/-health/-lane-health/-scale/-job-token/-provider-key/-high-payment/-consumption-payment.js`, `glb-compress/-inspect/-quality/-themer.js`, `model-inspect.js`, `rig-inspect.js`, `provider-result-url.js`, `avatars.js`, `avatar-agent/-render/-wallet.js`, `bake.js`, `accessories.js`, `auto-rig.js`, `auto-rig-eligibility.js`, `avaturn-headless.js`, `avaturn-seed.js`, `reconstruct-finalize.js`, `regen-provider.js`, `render-glb.js`, `render-clip.js`, `networth-model.js`, `genome.js`, `genome-agent.js`, `fork-royalties.js`, `remix-royalty.js`.
- **Pump / oracle / intel / market:** `pump.js`, `pump-go/-launch/-launch-feed/-quote/-pricing/-platform-fee/-swap-ix/-trade-args/-vanity/-claims.js`, `pump-alert-eval/-runner.js`, `pumpfun-mcp.js`, `pumpfun-ws-feed.js`, `pump-intel/` (enrich, funder-graph, news-matcher, smart-money-xref), `oracle/` (agent-eval, alerts, archetype, conviction, known-wallets, narrative, news-context, settle, sources, store), `aixbt.js`, `birdeye.js`, `gmgn-feed.js`, `smart-money.js`, `coin-communities.js`, `channel-feed-sources.js`, `signal-engine.js`, `alpha-read.js`, `token-market.js`, `market/` (ohlcv, token-market), `coin/` (cohorts, creator-fees, distribution, holders, three-holders, treasury, payouts, randomness).
- **Trading / vault / labor / tournament / copy / mirror / swarms:** `execution-engine.js`, `trade-firewall.js`, `orders.js`, `market-maker.js`, `strategy-schema/-compiler/-backtest.js`, `agent-strategy-runtime.js`, `sniper/notify.js`, `vault-store/-wallet/-auth/-trade/-transfer/-accounting/-jupiter.js`, `agent-labor.js`, `labor-auth/-economics/-escrow/-match/-settle.js`, `tournament-engine/-store/-scoring/-settlement.js`, `copy-engine.js`, `copy-earnings.js`, `agent-mirror.js`, `mirror-engine.js`, `mirror-stats.js`, `swarms.js`, `syndicate.js`, `trader-stats.js`, `treasury-autopilot.js`, `trust/` (access, proof-of-reserves, reputation-store, solana-bouncer, wallet-reputation).
- **Agent / memory / spend policy:** `agent-wallet/-identity/-delegate/-economy/-pumpfun/-recovery/-usdc-transfer/-paid-services.js`, `economy-shape.js`, `agent-spend-policy.js`, `agent-trade-guards.js`, `spend-policy-rules.js`, `spend-policy-compiler.js`, `wallet-capabilities.js`, `wallet-intents.js`, `wallet-anomaly.js`, `anomaly-events.js`, `memory-store.js`, `memory-entities.js`, `reasoning-ledger.js`, `reflection.js`, `autopilot.js`, `persona-store.js`, `seed-default-agent.js`, `seed-prompts.js`, `circulation.js`, `circulation-personas.js`, `brain-bundle.js`, `brain-sign.js`, `galaxy.js`, `galaxy-flows.js`.
- **Billing / usage / monetization / skills:** `metering.js`, `usage.js`, `monetization.js`, `services/MonetizationService.js`, `credits.js`, `credit-deposit.js`, `fee.js`, `payout.js`, `splits.js`, `royalty.js`, `patronage.js`, `skill-access/-runtime/-pricing-rules/-nft.js`, `skill-license-issue/-onchain/-verify.js`, `purchase-confirm.js`, `marketplace-platform-fee.js`, `nft-gate.js`, `subscription-billing/-checkout/-pricing.js`, `pricing/` (catalog, charge-three, name-rarity), `token/` (allowance, buyback, config, payments, price, quote, rewards), `three-access.js`, `three-gate.js`, `three-tier.js`, `require-three.js`, `holder-pass.js`, `account-tier.js`, `play-pass.js`, `referrals.js`, `referral-rewards.js`, `activation.js`, `sdp.js`.
- **IRL / community / world / club / stage:** `irl-auth/-bake/-drops/-presence.js`, `geohash.js`, `world-lines.js`, `sealed-drop-store.js`, `sealed-drop-funding.js`, `resolve-recipient.js`, `world-store/-gate/-service-auth.js`, `crews-store.js`, `friends-store.js`, `presence-store.js`, `diorama-store.js`, `builds-store.js`, `clash.js`, `clash-store.js`, `club/` (chain, cover-pass, payouts, sweep), `stage-bridge.js`, `stage-split.js`, `agora-human.js`, `agora-policy.js`.
- **Notifications / comms / distribution:** `notify.js`, `notify-prefs.js`, `alerts.js`, `alert-delivery.js`, `web-push.js`, `email.js`, `newsletter.js`, `webhook-dispatch.js`, `x-post.js`, `indexnow.js`, `rss-feed.js`, `feed.js`.
- **MCP / aggregator / validation / misc:** `mcp-dispatch.js`, `mcp-batch-price.js`, `mcp-error-sanitize.js`, `mcp-getting-started.js`, `pump-pricing.js`, `aggregator.js`, `gateway.js`, `validate.js` (zod schemas), `embed.js`, `embed-policy.js`, `widget-types.js`, `cosmetics.js`, `cosmetics-economy.js`, `cosmetics-ownership.js`, `pump-vanity.js`, `vanity-bounty-store.js`, `vanity-bounty-payout.js`, `vanity-cert-store.js`, `vanity-gallery-store.js`, `vanity-service-key.js`, `bounty-judge.js`, `bounty-likes.js`, `provider-job-error.js`, `format/links.js`.
- **Autonomous launcher / live-caster / seeder / infra:** `launcher-engine.js`, `launcher-funding.js`, `launcher-sources.js`, `launcher-trends.js`, `launch/` (registry, usecase-engine, candidate-sources, `usecases/{community,culture,events,github,news,onchain}`), `agent-orchestrate.js`, `agent-activation.js`, `agent-achievements(.js/-data.js)`, `agent-screen-frame.js`, `a2a-hire-phases.js`, `reaction-rules.js`, `agora-task-live.js`, `signal-engine-core.js`, `pulse-trading.js`, `pipeline-summary.js`, `solana-agents-crawl.js`, `solana-agents-normalize.js`, `studio-avatar.js`, `avaturn-photo.js`, `avatar-search-warm.js`, `embed-asset.js`, `vanity-frame.js`, `vanity-grind-stats.js`, `flags.js` (runtime feature flags), `platform-treasury.js`, `github-trending.js`, `github-reward.js`, `review-attest.js`, `quote-mints.js`, `billboard-store.js`, `diorama-store.js`, `club/cover-revenue.js`.

### Complete MCP Tool Reference

three.ws exposes MCP tools across **8 remote HTTP servers** + **34 stdio/npm servers** (`mcp-server`, `mcp-bridge`, 32 `packages/*-mcp` — now including `agentcore-payments-mcp` and `alibaba-cloud-mcp`), plus the standalone `@three-ws/agent-sniper` MCP face and the external `xactions-mcp` (~140 X/Twitter tools, [nirholas/XActions](https://github.com/nirholas/XActions)).

**Remote HTTP servers:**

- **Core — `POST /api/mcp`** (OAuth scopes or x402 USDC; prices `api/_lib/pump-pricing.js`): `getting_started`(free), `list_my_avatars`, `get_avatar`, `search_public_avatars`, `render_avatar`($0.005), `render_avatar_image`, `delete_avatar`, `get_embed_code`, `validate_model`($0.01), `inspect_model`($0.01), `optimize_model`($0.05), `list_animations`, `apply_animation`($0.02), `text_to_animation`, `solana_agent_reputation`, `solana_agent_attestations`, `solana_agent_passport`, `pumpfun_recent_claims`, `pumpfun_token_intel`, `pumpfun_creator_intel`, `pumpfun_recent_graduations`, `call_agent`, `register_agent`, `identity_check`, `remember`, `recall`, `forget`, `oracle_top_plays`, `oracle_coin`, `oracle_arm_watch`, `oracle_watch_status`, `trader_leaderboard`, `trader_profile`, `copy_subscribe`, `copy_status` (~35).
- **3D Studio — `POST /api/mcp-3d`** (OAuth or x402; `api/_mcp3d/pricing.js`): `getting_started`, `text_to_3d`(tier), `image_to_3d`(tier), `generation_status`, `preview_3d`, `remove_background`($0.01), `remesh_model`($0.02), `stylize_model`($0.02), `segment_model`($0.02), `retexture_model`($0.05), `retexture_region`($0.05), `auto_rig_model`($0.05), `pose_model`($0.01), `direct_prompt`($0.01), `generate_material`($0.01), `save_avatar`, `create_agent_persona`, `get_agent_persona`, `persona_say`, `inspect_model`, `optimize_model`, `list_animations`, `apply_animation`($0.01) (24).
- **Free Studio — `POST /api/mcp-studio`** (no auth): `forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar` (5).
- **Agent Wallet — `POST /api/mcp-agent`** (OAuth + x402 from agent wallet): `getting_started`, `wallet_status`, `find_services`, `pay_and_call`(variable), `provision_wallet`, `monetize_endpoint` (6).
- **Bazaar — `POST /api/mcp-bazaar`**: `getting_started`, `search_services`, `browse_services`, `get_service` (4).
- **IBM Granite — `POST /api/ibm-mcp`** (x402 USDC Base/Solana): `ibm_granite_getting_started`, `ibm_granite_chat`($0.02), `ibm_granite_code`($0.025), `ibm_granite_embed`($0.005), `ibm_granite_analyze`($0.04), `ibm_granite_forecast`($0.05) (6).
- **Pump.fun — `POST /api/pump-fun-mcp`** (mostly free; 4 gated tools need Bearer or $0.001 x402): `search_tokens`, `get_token_details`, `get_bonding_curve`, `get_token_trades`, `get_trending_tokens`, `get_new_tokens`, `get_graduated_tokens`, `get_king_of_the_hill`, `get_creator_profile`, `get_token_holders`, `pumpfun_vanity_mint`*, `pumpfun_watch_whales`*, `pumpfun_list_claims`, `pumpfun_watch_claims`*, `pumpfun_first_claims`, `sns_resolve`, `sns_reverseLookup`, `social_cashtag_sentiment`, `kol_leaderboard`, `pumpfun_quote_swap`, `social_x_post_impact`, `get_coin_intel`, `get_oracle_conviction`, `pumpfun_upload_metadata`*, `pumpfun_bot_status` (25; * = gated).
- **Viewer/Chat — `POST /api/chat/mcp`** (Bearer required): `setWireframe`, `setSkeleton`, `setGrid`, `setAutoRotate`, `setBgColor`, `setTransparentBg`, `setEnvironment`, `takeScreenshot`, `loadModel`, `runValidation`, `showMaterialEditor` (11).

**stdio / npm servers:**

- **`@three-ws/mcp-server`** (x402 USDC, mostly Solana): `forge_free`(free), `mesh_forge`($0.25), `rig_mesh`($0.20), `forge_avatar`($0.45), `text_to_avatar`($0.15), `get_pose_seed`($0.001), `pump_snapshot`($0.005), `sentiment_pulse`($0.003), `aixbt_intel`($0.01), `aixbt_projects`($0.01), `ens_sns_resolve`($0.0005), `vanity_grinder`($0.05), `agent_reputation`($0.01), `agent_delegate_action`($0.01), `agent_hire_discover`($0.01), `agent_hire`($0.05), `agenc_get_agent`($0.001), `agenc_get_task`($0.001), `agenc_list_tasks`($0.001) (19).
- **`@three-ws/mcp-bridge`** (x402 universal payer): `call_paid_endpoint`, `list_bazaar_tools`, `refresh_bazaar`, + 0–N dynamic `paid_<slug>` (cap `MCP_BRIDGE_DISCOVER_LIMIT`=20).
- **`@three-ws/activity-mcp`**: `get_trending_agents`, `get_trending_coins`, `get_holder_leaderboard`, `get_tier_info`, `get_feed_events`.
- **`@three-ws/agenc-mcp`**: `get_agent`, `get_task`, `link_agent`, `list_tasks`, `query_x402_services`.
- **`@three-ws/agora-mcp`**: `agora_board`, `agora_citizens`, `agora_passport`, `agora_professions`, `agora_pulse`, `agora_register`, `agora_claim_task`, `agora_complete_task`, `agora_post_task`.
- **`@three-ws/agentcore-payments-mcp`**: `create_payment_session`, `pay_with_session`, `check_payment_session`, `list_payment_sessions`, `cancel_payment_session`.
- **`@three-ws/alerts-mcp`**: `create_alert_rule`, `update_alert_rule`, `delete_alert_rule`, `list_alert_rules`, `get_alert_history`.
- **`@three-ws/alibaba-cloud-mcp`**: `qwen_chat`, `qwen_embed`, `qwen_list_models` (DashScope, user's own `DASHSCOPE_API_KEY`).
- **`@three-ws/agent-sniper`** (standalone package `./mcp` face): `arm_strategy`, `disarm_strategy`, `list_strategies`, `snipe_now`, `list_positions`, `close_position`, `sniper_status`.
- **`@three-ws/audio-mcp`**: `text_to_speech`, `speech_to_text`, `audio_to_face`, `motion_capture_clips`, `motion_capture_clip`.
- **`@three-ws/autopilot-mcp`**: `get_autopilot_config`, `set_autopilot_config`, `compute_trust`, `generate_proposals`, `list_proposals`, `adjust_proposal`, `dryrun_proposal`, `dismiss_proposal`, `execute_proposal`, `undo_action`, `list_autopilot_activity`.
- **`@three-ws/avatar-agent`**: `spawn_avatar`, `dress_avatar`, `generate_avatar`, `render_avatar`, `thumbnail_glb`, `viewer_url`, `list_avatars`, `list_animations`, `inspect_glb`, `validate_glb`, `optimize_glb`, `speak`, `ens_sns_resolve`, `wallet_create`, `wallet_balance`, `wallet_send`, `pump_buy`, `pump_launch`, `pump_collect_fees`, `pump_snapshot` (20).
- **`@three-ws/billing-mcp`**: `get_billing_summary`, `query_usage`, `export_billing_history`, `get_receipt`, `get_revenue`, `get_fee_info`.
- **`@three-ws/brain-mcp`**: `list_providers`, `chat`.
- **`@three-ws/clash-mcp`**: `get_clash_state`, `get_clash_leaderboard`, `enlist_faction`, `rally_faction`.
- **`@three-ws/copy-mcp`**: `list_subscriptions`, `create_subscription`, `update_subscription`, `cancel_subscription`, `get_executions`, `record_execution`, `get_earnings`.
- **`@three-ws/intel-mcp`**: `smart_money_coin`, `wallet_intel`, `signal_feed`, `kol_leaderboard`, `kol_trades`, `copy_smart_wallets`.
- **`@three-ws/kol-mcp`**: `get_wallet_portfolio`, `get_wallet_trades`.
- **`@three-ws/loom-mcp`**: `get_loom_feed`, `get_creation`, `submit_creation`.
- **`@three-ws/ibm-watsonx-mcp`** (your own IBM creds): `watsonx_chat`, `watsonx_forecast`, `watsonx_generate`, `watsonx_embed`, `watsonx_tokenize`, `watsonx_list_models`.
- **`@three-ws/ibm-x402-mcp`** (x402): `ibm_granite_getting_started`, `ibm_granite_chat`($0.02), `ibm_granite_code`($0.025), `ibm_granite_embed`($0.005), `ibm_granite_analyze`($0.04), `ibm_granite_forecast`($0.05).
- **`@three-ws/marketplace-mcp`**: `browse_agents`, `browse_skills`, `agent_detail`, `agent_categories`, `skill_categories`.
- **`@three-ws/naming-mcp`**: `sns_resolve`, `sns_reverse`, `threews_availability`.
- **`@three-ws/notifications-mcp`**: `list_notifications`, `mark_read`, `delete_notification`, `get_preferences`, `set_preferences`, `register_push_device`, `unregister_push_device`.
- **`@three-ws/portfolio-mcp`**: `get_portfolio_summary`, `get_portfolio_history`, `get_portfolio_asset`, `get_wallet_balances`, `get_trades_feed`, `send_transfer`.
- **`@three-ws/provenance-mcp`**: `append_agent_action`, `list_agent_actions`, `query_action`.
- **`@three-ws/pumpfun-mcp`** (proxies `/api/pump-fun-mcp`): 22 tools mirroring the remote pump.fun server (+ legacy camelCase aliases).
- **`@three-ws/scene-mcp`**: `compose_scene`, `get_scene`, `list_scenes`.
- **`@three-ws/signals-mcp`**: `list_signal_feeds`, `get_mirror_leaderboard`, `get_subscriptions`, `subscribe_signal`(x402 live mode), `set_subscription_status`.
- **`@three-ws/three-token-mcp`**: `three_price`, `three_balance`, `three_burn` (capped $100, REQUIRE_CONFIRM).
- **`@three-ws/avatar-mcp`** (free): `render_avatar`, `avatar_embed_code`, `get_avatar` + a `showcase-avatar` MCP-App prompt/resource.
- **`@three-ws/tutor-mcp`**: `load_session`, `close_session`.
- **`@three-ws/vanity-mcp`**: `vanity_quote`, `vanity_appraise`, `vanity_board`, `vanity_open`, `vanity_stats`, `vanity_leaderboard`, `vanity_config`, `vanity_gallery`.
- **`@three-ws/vision-mcp`**: `analyze_image`, `describe_image`, `get_vision_status`.
- **`@three-ws/x402-mcp`**: `x402_wallet`, `find_services`, `inspect_endpoint`, `pay_and_call`(capped MAX_PAY_USD $1).

### Complete Environment Variable Reference

Tiers: **CRITICAL** = `req()` in `api/_lib/env.js` (cold-start throw) or prod-fail-closed; **Required** = feature returns 501/503 without it; **Optional** = safe fallback/default; **Test/Ops** = scripts/CI/platform only. Names only — never values.

- **CRITICAL `req()` (cold-start risk):** `DATABASE_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_PUBLIC_DOMAIN`, `JWT_SECRET`, `AGENT_RELAYER_KEY`, `AWS_MP_ACCESS_KEY_ID`, `AWS_MP_SECRET_ACCESS_KEY`, `AWS_MP_PRODUCT_CODE`.
- **Prod fail-closed (throw only in production):** `MULTIPLAYER_SHARED_SECRET`/`HOLDER_PASS_SECRET`, `THREE_TREASURY_WALLET`, `THREE_REWARDS_WALLET`, `THREE_QUOTE_SECRET`. Money receivers fail-closed by design (no default): `X402_PAY_TO_SOLANA`/`_BASE`/`_BSC`, `X402_FEE_PAYER_SOLANA`.
- **Database / cache / storage:** `R2_ENDPOINT`/`R2_ACCOUNT_ID`/`R2_BUCKET`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `UPSTASH_REDIS_REST_URL`/`_TOKEN` (aliases `three_KV_REST_API_URL/TOKEN`, `KV_REST_API_URL/TOKEN`), `UPSTASH_CACHE_REST_URL`/`_TOKEN`, `UPSTASH_EMAIL`, `UPSTASH_MANAGEMENT_API_KEY`, `UPSTASH_REDIS_STORE_ID`, `REDIS_URL`/`REDIS_URI`, `QSTASH_TOKEN`/`QSTASH_CURRENT_SIGNING_KEY`/`QSTASH_NEXT_SIGNING_KEY`.
- **Auth / session / encryption:** `JWT_KID`, `WALLET_ENCRYPTION_KEY`, `WALLET_CAPABILITY_SECRET`, `SESSION_SECRET`, `HOLDER_PASS_SECRET`, `CSRF_DISABLED`, `PASSWORD_ROUNDS`, `PRIVY_APP_ID`/`VITE_PRIVY_APP_ID`/`PRIVY_APP_SECRET`/`PRIVY_JWKS_ENDPOINT`, `GITHUB_OAUTH_CLIENT_ID`/`_SECRET`, `X_OAUTH_CLIENT_ID`/`_SECRET`, `PERSONA_JWKS_PRIVATE_KEY_PEM`/`_PUBLIC_KEY_PEM`/`PERSONA_JWKS_KID`/`PERSONA_STORE_DIR`/`PERSONA_TTL_SEC`, `SIWX_VERIFY_MODE`, `ADMIN_ADDRESSES`, `CHAT_ADMIN_KEY`, `SAML_IDP_*` (ENTITY_ID/SSO_URL/SLO_URL/CERT/METADATA_URL), `SAML_SP_*` (ENTITY_ID/PRIVATE_KEY/CERT), `SAML_WANT_ASSERTIONS_SIGNED`/`_WANT_RESPONSE_SIGNED`/`_SIGNATURE_ALGORITHM`/`_IDENTIFIER_FORMAT`/`_CLOCK_SKEW_MS`/`_ALLOW_IDP_INITIATED`/`_BUTTON_LABEL`.
- **Solana / on-chain:** `SOLANA_RPC_URL` (+aliases `SOLANA_RPC`/`SOLANA_MAINNET_RPC`/`NEXT_PUBLIC_SOLANA_RPC_URL`), `SOLANA_RPC_URL_DEVNET`/`SOLANA_DEVNET_RPC`, `SOLANA_RPC_URLS`/`_FALLBACK_URLS`, `HELIUS_API_KEY`/`HELIUS_WEBHOOK_AUTH`, `SOLANA_USDC_MINT`/`DEVNET_USDC_MINT`, `NEXT_PUBLIC_SOLANA_ALT_ADDRESS`, `TREASURY_KEYPAIR`/`PLATFORM_TREASURY_KEYPAIR`, `MAINNET_RPC_URL`, `JITO_BLOCK_ENGINE_URL`/`JITO_BUNDLE_URL`/`JITO_TIP_SOL`, `ALCHEMY_API_KEY`/`ANKR_API_KEY`/`DRPC_API_KEY`, `SOLANA_AGENT_COLLECTION_MAINNET`/`_DEVNET`/`_AUTHORITY_KEY`, `THREEWS_SOL_PARENT_DOMAIN`/`_PARENT_SECRET_BASE58`, `STOREFRONT_ORIGIN`, `BUBBLEGUM_MERKLE_TREE`/`_TREE_AUTHORITY`, `NFT_STORAGE_TOKEN`/`WEB3_STORAGE_TOKEN`/`PINATA_JWT`/`FILEBASE_KEY`/`_SECRET`, `BTC_INSCRIPTION_RECEIVE_ADDRESS`/`ORDINALSBOT_API_KEY`/`_BASE_URL`, `AGENC_RPC_URL`/`AGENC_DEVNET_RPC_URL`/`AGENC_BRIDGE_URL`.
- **EVM / x402:** `AGENT_RELAYER_ADDRESS`, `PERMISSIONS_RELAYER_ENABLED`, `BASE_RPC_URL`/`BASE_SEPOLIA_RPC_URL`/`SEPOLIA_RPC_URL`, `RPC_URL_<CHAINID>`, `EVM_RPC_URL`, `EVM_PRIVATE_KEY`/`EVM_TREASURY_PRIVATE_KEY`/`PRIVATE_KEY`, `EVM_MIN_CONFIRMATIONS`, `X402_ASSET_MINT_SOLANA`/`X402_ASSET_ADDRESS_BASE`/`_ARBITRUM`/`_BSC`, `X402_MAX_AMOUNT_REQUIRED`, `X402_IDEMPOTENCY_TTL_SECONDS`, `X402_FACILITATOR_URL_SOLANA`/`_BASE`/`_TOKEN_*`/`_TIMEOUT_MS`, `CDP_API_KEY_ID`/`_SECRET`, `X402_CDP_FACILITATOR_URL`, `X402_ACCEPT_THREE_SOLANA`/`X402_THREE_AMOUNT_SOLANA`, `X402_EVM_NETWORKS`, `X402_BUILDER_CODE_APP`/`_WALLET`, `X402_MAX_PER_CALL_ATOMIC`/`_PER_HOUR_ATOMIC`/`_PER_DAY_ATOMIC`, `INTERNAL_API_KEY`, `OFFER_RECEIPT_SIGNING_PRIVATE_KEY`/`_FORMAT`/`_JWK`/`_JWS_ALG`, `SERVER_DOMAIN`, `A2A_MANDATE_SECRET`, `A2A_PAYER_PRIVATE_KEY`/`A2A_PAYER_SOLANA_SECRET`, `A2A_REPUTATION_RPC_URL`, `VALIDATOR_PRIVATE_KEY`, `ETHERSCAN_API_KEY`/`BASESCAN_API_KEY`, `ERC8004_CRAWL_LOOKBACK`, `SPLITS_SIGNER_PRIVATE_KEY`, `MARKETPLACE_PAYER_KEYPAIR`/`MARKETPLACE_PLATFORM_FEE_BPS`/`_WALLET`, `ZAUTH_API_KEY`/`_DEBUG`/`_API_ENDPOINT`/`_SCAN_URL`/`_CIRCUIT_*`/`_REFUND_*`.
- **MCP / bridge:** `MCP_RESOURCE`, `MCP_REGISTRY_TOKEN`, `MCP_AGENT_TALK_ENDPOINT`, `MCP_POSE_PREVIEW_BASE`, `MCP_SVM_PAYMENT_ADDRESS`, `MCP_VANITY_PRICE_USD`, `MCP_BRIDGE_EVM_PRIVATE_KEY`/`_SVM_PRIVATE_KEY`, `MCP_BRIDGE_ALLOWED_HOSTS`/`_ALLOWED_PAYTO`/`_ALLOW_HTTP`, `MCP_BRIDGE_BAZAAR_URL`/`_DISCOVER_LIMIT`, `MCP_BRIDGE_MAX_DEPOSIT_ATOMIC`/`_MAX_PRICE_PER_CALL_ATOMIC`/`_MAX_TOTAL_ATOMIC`, `X402_BRIDGE_PORT`/`_ALLOWED_ENDPOINT_ORIGINS`/`_MAX_USDC_MICROS`.
- **LLM providers:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`/`OPENAI_BASE_URL`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`/`OPENROUTER_FALLBACK_KEYS`, `DASHSCOPE_API_KEY`, `MODELSCOPE_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_GENAI_API_KEY`/`GOOGLE_CLOUD_PROJECT`, `WATSONX_API_KEY`/`_PROJECT_ID`/`_SPACE_ID`/`_URL`/`_MODEL_ID`/`_API_VERSION`/`_GUARDIAN_MODEL_ID`/`_VISION_MODEL_ID`/`_ORCHESTRATE_*`, `GUARDIAN_SEND_CAP_USD`/`GUARDIAN_DISABLE`, `LIVEPEER_API_KEY`, `LONGCAT_WORKER_URL`/`_KEY`, `OMNI_URL`/`NIM_URL`, `CHAT_MODEL`/`CHAT_MAX_TOKENS`/`CHAT_URL`, `KNOWLEDGE_RERANK_ENABLED`, `ANON_MODERATION_DISABLED`/`_MODEL`/`_TIMEOUT_MS`, `VOYAGE_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`/`EXA_API_KEY`/`SERPER_API_KEY`/`SERPAPI_API_KEY`, `BIRDEYE_API_KEY`/`GMGN_COOKIE`, `NEYNAR_API_KEY`, `TWITTER_BEARER_TOKEN`/`X_API_BEARER`, `AIXBT_API_KEY`/`_API_BASE`.
- **Voice / 3D gen:** `ELEVENLABS_API_KEY`, `NVIDIA_ASR_FUNCTION_ID`/`NVIDIA_A2F_FUNCTION_ID`/`NVIDIA_COSMOS_INVOKE_URL`, `LIVEKIT_API_KEY`/`_SECRET`/`_SERVER_URL`, `GCP_PROJECT`/`GCP_REGION`/`GCP_SERVICE_ACCOUNT_JSON`, `GCP_RECONSTRUCTION_URL`/`_KEY`, `GCP_TRIPOSG_URL`/`GCP_HUNYUAN3D_URL`/`GCP_REMESH_URL`/`GCP_TEXTURE_URL`/`GCP_STYLIZE_URL`/`GCP_SEGMENT_URL`/`GCP_REMBG_URL`/`GCP_TEXT2MOTION_URL`, `HF_TOKEN`/`HF_RECONSTRUCT_SPACE(S)`, `REPLICATE_API_TOKEN`/`_RECONSTRUCT_MODEL`/`_RERIG_MODEL`/`_POLL_MS`/`_TIMEOUT_MS`/`_WEBHOOK_URL`/`_WEBHOOK_SIGNING_KEY`, `NIM_TRELLIS_URL`/`_KEY`/`MODEL_TRELLIS_URL`, `TRIPO_MODEL_VERSION`, `VERTEX_IMAGEN_MODEL`, `CHROMIUM_PACK_URL`/`CHROME_PATH`/`PUPPETEER_EXECUTABLE_PATH`, `AVATURN_API_KEY`/`_API_URL`/`_SEED_ENABLED`, `MIXAMO_TOKEN`, `AVATAR_REGEN_PROVIDER`, `AUTO_RIG_DAILY_PER_USER`/`_GLOBAL_HOURLY`/`_PRIVATE`/`_REQUIRE_TIER`, `FORGE_ORIGIN`/`FORGE_PREFER_FREE`/`FORGE_FREE_POLL_MS`/`FORGE_PAID_GLOBAL_HOURLY`.
- **Pump.fun / $THREE / treasury:** `PUMP_X402_LAUNCHER_SECRET_KEY_B64`, `PUMP_CRON_RELAYER_SECRET_KEY_B64`, `PUMP_DEFAULT_AGENT_MINT`/`_NETWORK`, `PUMP_PLATFORM_FEE_BPS`/`_WALLET`, `PUMP_GRADUATIONS_SOURCE`/`GRADUATIONS_LIST_KEY`/`_MAX_LEN`, `PUMPFUN_BOT_TOKEN`/`_URL`/`PUMPFUN_MCP_URL`, `PUMP_COINS_V2_BASE`/`PUMP_FRONTEND_BASE`, `PUMPKIT_WEBHOOK_SECRET`, `THREE_WS_MARK_ENFORCE`/`ALLOW_UNMARKED_MINT`, `THREE_TOKEN_MINT`/`THREE_MINT`/`THREE_TOKEN_DECIMALS`, `THREE_PRIZE_PAYOUT_KEY`, `THREE_BURN_ADDRESS`, `THREE_QUOTE_TTL_S`, `THREE_ALLOWANCE_DELEGATE_SECRET_KEY_B64`, `THREE_BUYBACK_ENABLED`/`_SECRET_KEY_B64`/`_MIN_USD`/`_MAX_USD`/`_COMMIT_BPS`/`_SLIPPAGE_BPS`, `BUYBACK_BPS`, `PLATFORM_FEE_BPS`, `REWARDS_DISTRIBUTOR_SECRET`, `REFLECTION_DAILY_CAP`/`_DEBOUNCE_MS`/`REFLECT_SWEEP_BATCH`, `REFERRAL_COMMISSION_BPS`, `RIDER_VAULT_ADDRESS`/`_HELIUS_WEBHOOK_SECRET`, `CREDITS_DEPOSIT_WALLET_SOLANA`, `PURCHASE_RECEIPT_KEY`, `VANITY_SERVICE_KEY`/`VANITY_BOUNTY_PAYOUT_KEY`/`VANITY_DROP_FUNDING_KEY`, `COIN_TREASURY_SECRET_KEY_B64`, `COSMETIC_SPLIT_TREASURY_SECRET_KEY_B64`, `CLUB_SOLANA_TREASURY_SECRET_KEY_B64`/`CLUB_EVM_TREASURY_PRIVATE_KEY`/`CLUB_BASE_RPC_URL`/`CLUB_SWEEP_DUST_ATOMICS`.
- **Comms / observability:** `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHANGELOG_CHAT_ID`/`_ALERTS_CHAT_ID`/`_ORACLE_CHAT_ID`/`_SNIPER_CHAT_ID`, `RESEND_API_KEY`/`_AUDIENCE_ID`, `EMAIL_FROM`/`_REPLY_TO`, `SENTRY_DSN`/`_ENVIRONMENT`/`_RELEASE`, `AXIOM_TOKEN`/`_DATASET`/`_URL`, `VAPID_PUBLIC_KEY`/`_PRIVATE_KEY`/`_SUBJECT`, `DEV_TO_API_KEY`, `MEDIUM_INTEGRATION_TOKEN`/`_AUTHOR_ID`, `THREEWS_TWITTER_URL`.
- **Cron / multiplayer / games / ops:** `CRON_SECRET`, `WEBHOOK_SECRET`/`ALLOW_UNSIGNED_WEBHOOKS`, `IRL_FIX_SECRET`/`IRL_X402_ALLOWED_HOSTS`, `X402_SWEEP_MAX_PRICE_USD`, `NODE_ENV`/`VERCEL_ENV`, `PUBLIC_APP_ORIGIN`, `MULTIPLAYER_SHARED_SECRET`/`_INTERNAL_URL`/`_URL`/`_API_BASE`, `REALM_TRANSFER_SECRET`, `WORLD_URL`/`WORLDS_URL`/`WORLD_API_BASE`, `GAME_SERVER_URL`, `WALK_URL`/`WALK_BASE`/`WALK_EMBED_BASE`, `GAME_TOKEN_MINT`/`_DECIMALS`/`_TREASURY`/`_SECRET`/`_REWARDS`, `PLAY_GATE_MINT`/`_MIN`/`_SYMBOL`, `HOLDER_MIN_USD`, `AGORA_MAINNET_ENABLED`/`_RECONCILE_MS`/`_DEVNET_MAX_SOL_PER_TASK`/`_MAX_THREE_PER_TASK`/`_THREE_MINT`/`_THREE_TOKEN_ACCOUNT`, `ORACLE_*` (MODE/NETWORK/GLOBAL_KILL/MAX_TRADE_SOL/USE_JITO/ALERT_MIN_TIER/intervals), `SNIPER_MODE`/`_NETWORK`/`_HEARTBEAT_MS`, `ORDERS_MODE`/`_NETWORK`/`SETTLE_MS`, `DCA_ALLOWED_TOKEN_OUT`/`_CHAIN_ID`, `CIRCULATION_*`, `SMART_GRAPH`/`_INTERVAL_MS`, `CLASH_*` (EPOCH_MS/MAX_FACTIONS/MAX_POWER_PER_WALLET/PASS_SECRET/WAR_RESULT_SECRET), `AUTOPILOT_COMPUTE_TREASURY`, `AGENT_WALLET_ALLOWED_ORIGINS`/`_MAX_USDC_MICROS`/`_DAILY_USDC_MICROS`, `AGENT_TRADE_NETWORK`/`_PRICE_SOL`/`AGENT_INVOCATION_NETWORK`/`_PROGRAM_ID`, `LABOR_ESCROW_SECRET_BASE58`/`LABOR_SKILL_ROYALTY_BPS`, `SKILL_LICENSE_ENFORCE`/`_MINTER_KEY`/`_PROGRAM_ID`/`SKILL_NFT_NETWORK`, `ATTEST_AGENT_SECRET_KEY`/`SAS_AUTHORITY_SECRET`, `CUSTODY_ANCHOR_NETWORK`/`_SNAPSHOT_NETWORK`, `ALLOWED_ORIGINS`, `COINBASE_PAY_APP_ID`, `VITE_WALLETCONNECT_PROJECT_ID`, `CZ_REGISTRY_CONTRACT`/`CZ_AGENT_ID`/`_NAME`, `SDP_API_BASE`/`_KEY`, `STUDIO_API_BASE`/`_PUBLIC_BASE`, `THREEWS_API_BASE`/`_ORIGIN`/`THREE_WS_API_BASE`/`_BASE`/`_API_KEY`.
- **Test/Ops only (not request surface):** `SMOKE_*`, `X402_BUYER_*`/`X402_TEST_*`/`X402_PAYER_*`, `TEST_EMAIL`/`_PASSWORD`, `GH_TOKEN`/`GITHUB_TOKEN`, `CC_*`, `DEV_API_PROXY`/`DEV_API_UPSTREAM`, `CI`/`DEBUG`/`DRY_RUN`/`HEADED`/`STRICT_A11Y`/`SKIP_NETWORK_TESTS`/`CONFIRM_MAINNET*`/`VERIFY_ONCHAIN_CHAINS`, Vercel/Codespaces platform vars.

> Fallback chains: secrets cascade `dedicated → WALLET_ENCRYPTION_KEY → JWT_SECRET`; Redis `UPSTASH_REDIS_REST_* → three_KV_* → KV_*`; Base RPC `BASE_RPC_URL → CLUB_BASE_RPC_URL → RPC_URL_8453`; `HELIUS_API_KEY` auto-derives from `SOLANA_RPC_URL`.

### SDK & Package API Surface

**Top-level SDKs:**

- **@three-ws/sdk** 0.2.0 (`sdk/`) — cross-chain agent kit. `AgentKit`, `AgentPanel`, `loadAvatar`, `agentRegistration`, `agentCard`, `aiPlugin`, `connectWallet`, `registerAgent`, `pinToIPFS`, `buildRegistrationJSON`, `getIdentityRegistry`, `IDENTITY/REPUTATION/VALIDATION_REGISTRY_ABI`, `REGISTRY_DEPLOYMENTS`, `PermissionsClient`, `AgentClient`, `PaymentRequiredError`. Subpaths `./solana` (`signInWithSolana`, `registerSolanaAgent`, `startSolanaCheckout`, `confirmSolanaPayment`), `./solana-attestations` (`attestFeedback/Validation/Revoke/Dispute`, `createTask`, `acceptTask`, `fetchReputation`), `./permissions`, `./styles`.
- **@three-ws/solana-agent** 0.2.0 — `SolanaAgent`, `KeypairWalletProvider`, `BrowserWalletProvider`, `WalletAdapterProvider`, `transferSol`, `transferSpl`, `jupiterSwap`, `getSwapQuote`, `getOrCreateAta`, `getTokenBalance`, `stakeSOL`/`unstakeSOL`, `buildAndSend`, `fetchLookupTables`, `estimatePriorityFee`/`estimateComputeUnits`, `memoInstruction`; errors `SolanaAgentError`/`TransactionRejectedError`/`WalletNotConnectedError`/`SwapError`/`SimulationError`/`ConfirmationTimeoutError`. Subpaths `./wallet`, `./x402-exact`, `./solana-agent-kit`, `./vanity`.
- **@three-ws/agent-payments** 3.2.0 — `./solana`: `PumpAgent`, `PumpAgentOffline`, `PumpTradeClient`, PDA helpers, decoders, `subscribeToAgentEvents`; `./evm`: `EvmAgent`, `EvmAgentOffline`, `AGENT_PAYMENTS_ABI`, `EVM_CHAINS`, `getInvoiceId`; `./a2a`: `payA2A`, `requestA2AQuote`, `submitA2APayment`, `buildEvmExactPayload`, `A2A_X402_EXTENSION_URI`.
- **@three-ws/agent-protocol-sdk** 0.2.0 — `invokeSkill`, `deriveAgentPda`, `IDL`, `AGENT_INVOCATION_PROGRAM_ID`, `MAX_SKILL_NAME_LEN`, `MAX_PARAMETERS_LEN`.
- **@three-ws/agent-ui** 0.2.0 — `createAgentUI`, `createRenderer`, `loadAvatar`, `createAnimator`, `moveTo`, `walkTo`, `standOn`, `fallOnto`, `runOff`, `interceptNavigation`, `dust`, `impactPulse`, `proximityShadow`, `scan`. `./bundle`, `./styles`.
- **@three-ws/avatar** 0.2.0 — `<agent-3d>` (`Agent3DElement`), `<agent-stage>` (`AgentStageElement`), `Viewer`, `Runtime`, `SceneController`, `Memory`, `Skill`, `SkillRegistry`, `defineElement`. Subpaths `./creator` (`AvatarCreator`, `saveBlob`), `./viewer` (`<three-ws-viewer>`), `./agent` (`ensureAgent3D`), `./react` (`<Avatar>`, `<AgentAvatar>`, `useAvatar`).
- **@three-ws/walk** 0.1.0 — `createWalkCompanion`, `launchPlayground`, `WALK_AVATARS`, `getAvatar`, `createAvatarPicker`, `loadWalkAvatar`, `resolveConfig`. `./roster`, `./style.css`.
- **@three-ws/page-agent** 0.1.0 — `<page-agent>` (`PageAgentElement`), `PageAgent`, `collectSegments`, `mount`, `AvatarStage`, `SpeechNarrator`, `AvatarPicker`, `createLipsync`, `AGENTS`. `./catalog`, `./global`.
- **@three-ws/tour** 0.1.0 — `createFeatureTour`, `TourDirector`, `resolveTourConfig`, `loadCurriculum`, `buildPlaylist`, `buildCurriculum`. Bin `tour-build-curriculum`. `./curriculum(.schema.json)`.

**Feature packages** (`packages/*`; all share `ThreeWsError`/`PaymentRequiredError`/`DEFAULT_BASE_URL`):

- **forge** 0.1.0 — `createForge`, `forge`, `rig`, `catalog`. **names** 0.1.0 — `resolve`, `reverseLookup`, `checkSubdomain`, `mintSubdomain`, `claimSubdomain`, `resolvePayee`, `payByName`. **intel** 0.1.0 — `sentiment`, `intel`, `projects`, `snapshot`. **vanity** 0.1.0 — `grind`, `grindViaApi`, `validatePattern`, `expectedAttempts`, `base58Encode`. **reputation** 0.1.0 — `reputation`, `leaderboard`, `validation`, `attest`, `SUPPORTED_CHAINS`. **voice** 0.1.0 — `transcribe`, `speak`, `say`, `lipsync`, `voices`. **x402-server** 0.1.0 — `createX402Server`, `buildChallenge`, `verifyPayment`, `settlePayment`, `paid`, `feeSplit`, `X402_VERSION`, `MAX_FEE_BPS`. **x402-fetch** 1.0.1 — `withX402`, `wrapFetchWithPayment`, `privateKeyToWallet`. **agent-memory** 0.1.0 — `AgentMemory`, `createAgentMemory`. **agenc** 0.1.0 — `listTasks`, `getTask`, `getAgent`. **guardian** 0.1.0 — `check`, `govern`, `moderate`, `risks`, `RISKS`, `BLOCK_THRESHOLD`. **glb-tools** 0.1.0 — `inspect`, `theme`, `bake`. **agent-guards** 0.1.0 — `policy`, `guard`, `checkKillSwitch`, `checkPerTradeCap`, `checkDailyBudgetLamports`, `checkPriceImpact`, `checkAllowlist`, `TRADE_LIMIT_DEFAULTS`. **skill-license** 0.1.0 — `mintLicense`, `verifyLicense`, `getLicense`, `skillSeed`, `PROGRAM_ID`. **mocap** 0.1.0 — `saveClip`, `getClip`, `listClips`. **strategies** 0.1.0 — `dca`, `copy`, `mirror`, `killSwitch`, `createStrategy`, `forkStrategy`, `leaderboard`. **pumpfun-skills** 0.1.0 — `createCoin`, `swap`, `collectFees`, `sharingConfig`, `coinFees`. **irl** 0.1.0 — `checkIn`, `nearby`, `placePin`, `myPins`, `interact`, `encodeGeohash`. **pose** 0.1.0 — `poseSeed`, `presetPose`, `listPresetGroups`, `PRESETS`. **avatar-schema** 0.2.0 — `validate`, `assertValid`, `schema`, `SCHEMA_VERSION`. **react** 1.0.0 — `<Agent3D>`, `<WalkEmbed>`. **viewer-presets** 0.2.0 — `buildLightRig`, `LIGHT_CONFIG`, `floorReflectionConfig`, `bloomConfig`. **avatar-cli** 0.2.0 — CLI `three-ws-avatar {init,validate,hash,preview}`. **vscode-x402** 0.1.0 — VS Code commands `threewsX402.{refresh,search,setFilters,inspect,openService,pay,setWalletKey,clearWalletKey,scaffoldEndpoint}`.

### Key Algorithms & Internal Mechanisms

**1. Animation retargeting (`src/animation-retarget.js`).** Clips store absolute local rotations baked against `cz.glb` (A-pose Avaturn). Per canonical bone, `bindCorrections()` computes a pair `{L,R}` so `q' = L·q·R` re-expresses a keyframe as the same world-space delta on a differently-proportioned/posed target: `L = Rt·WT⁻¹·WS·Rs⁻¹`, `R = WS⁻¹·WT` (Rs/Rt = source/target local bind, WS/WT = world bind). Falls back to local-only `L = Rt·Rs⁻¹, R = I` when world rests are unknown; corrections within `BIND_EPSILON=1e-6` of identity omitted (matching rigs round-trip exactly). Root-motion: the `Hips.position` track is rotated by the inverse of the target hips-parent world rotation to preserve travel direction. Hip scaling: `targetY/sourceY` clamped `[0.2,5]`; raw Object3D graphs use **local** height (world Y ÷ parent scale) so cm-native Mixamo armatures (`scale 0.01`) don't collapse. Clip accepted only at `matched/total ≥ MIN_COVERAGE=0.5`; `rig.resetPose()` runs before measuring.

**2. Bone canonicalization (`src/glb-canonicalize.js`).** `canonicalizeBoneName` → one of 52 canonical bones: strip namespaces (`Character1:`), strip vendor prefixes (`mixamorig`, `Armature_`, Rigify `DEF/ORG/MCH`, `CC_Base_`, `Bip001`), collapse separators+lowercase, resolve against LOOKUP → UNREAL_ALIASES → EXTRA_ALIASES (lower tables never shadow canonical). De-dup retry strips trailing `_NN`/`.NNN` only if the full name didn't resolve. **Mixamo armature fix:** Mixamo bakes +90°X on armature / −90°X on Hips; the fix folds armature rotation into children, zeroes it, collapses Hips to identity — only when armature scale is uniform, and **verified by comparing every joint's world matrix before/after within `1e-4`** (reverts entirely on mismatch). GLB rewrite re-pads the JSON chunk to 4 bytes and repacks BIN verbatim.

**3. Coin intelligence scoring (`workers/agent-sniper/intel/`).** `computeSignals` is pure/deterministic (missing data → `null`, never fabricated). `bundleScore` = `(density·0.5 + clustering·0.5)·(0.6 + 0.4·walletMult)` over a 3s burst; `snipeRatio` = buy-volume share in first 5s; concentration ranks per-wallet net buys (top-1/5/10 share); organic score blends buyer diversity, arrival-time Shannon entropy, (1−bundle), (1−snipe), (1−whale), penalized for dev-sell + fresh-wallet swarms. `summarizeRisk` → transparent 0–100. Classification is 3-layered (ordered-keyword heuristic seed → `matchNewsHeadline` → LLM refinement with XML-delimited fields), never fails. **Online learning** (`learn.js`): `labelOutcomes` derives ground truth (`graduated`/`pumped ≥3×`/`rugged ≤0.25×`/`flat`) after a min age; `trainWeights` computes per-signal **Pearson correlation** vs binary good-label (≥50 samples) and persists weights + conditional win-rates; `learnedScore` = logistic squash `1/(1+e^(−Σwᵢvᵢ))` (null → fall back to baseline).

**4. Oracle conviction (`workers/oracle/score-loop.js` → `api/_lib/oracle/conviction.js`).** `convict()` is pure: four pillars scored 0–100 with weights **pedigree 0.34 · structure 0.30 · narrative 0.18 · momentum 0.18**. Pedigree anchors on smart-money composite ± proven/flagged-wallet adjustments; structure anchors on `30 + organic·0.55` minus bundle/concentration/dev-sold/cluster, several imposing a **hard cap** on the final score; narrative blends classifier virality with category prior weighted by confidence; momentum from buy/sell share + dev-buy sizing. Final `score = min(weightedSum, structure.cap)` — pedigree/narrative can't paper over a bundle. Tiers: `prime ≥86, strong ≥72, lean ≥56, watch ≥34, avoid`. History row only when score moves ≥3.

**5. Tiered agent memory (`api/_lib/memory-store.js`).** Letta/MemGPT model: working (pinned + `tier='working'`, `WORKING_TOKEN_BUDGET=2000`), recall, archival. Embeddings free-first: NVIDIA NIM `nv-embedqa-e5-v5@1024` ingest default, OpenAI `text-embedding-3-small@256` backstop — stored as **JSONB arrays tagged with the embedder** (not a pgvector column), cosine computed in JS **strictly within each embedder space** (`cosine` returns 0 on dimensionality mismatch — guards silent cross-space comparison). Search lazily embeds ≤24 rows/call, filters `minScore≥0.25`, fills shortfall with salience-ranked substring matches (never empty). Every surfaced row bumps `access_count`, `last_accessed_at=now()`, `salience=LEAST(1.0, salience+0.02)`; a Zep/Graphiti temporal KG mines entities into nodes + co-occurrence edges.

**6. A2A spend ledger / TOCTOU (`api/_lib/a2a/spend-ledger.js`, `reserveSpendUsd`).** Mandate budget enforced by Redis **`INCRBY`-then-rollback**: increment first, `DECRBY` if over cap (no funds held), `EXPIRE` set on first write. `spent()` **fails closed** (can't prove headroom → throw); `release()` floors at 0. Per-agent daily USD ceiling (`reserveSpendUsd`, `agent-trade-guards.js`) uses a **Postgres advisory lock** + pending custody reservation row to stop K concurrent calls each reading the same pre-spend total — also runs freeze gate, withdraw allowlist, NL policy eval, per-tx ceiling, capability metering, post-reserve anomaly guard.

**7. Custodial keypair encryption (`api/_lib/secret-box.js`).** Single AES-256-GCM primitive (webcrypto, no deps). **v2:** random 16-byte salt + 12-byte IV per record, key via **HKDF-SHA256** from `WALLET_ENCRYPTION_KEY`, emits `"v2:"+base64(salt‖iv‖ct+tag)`. **Fails closed in production** on missing/short key (no silent `JWT_SECRET` downgrade — a JWT leak must not decrypt wallets). Legacy v1 (no tag, `JWT_SECRET` + constant salt) still decrypts for old records; all new writes are v2.

**8. Vanity grind protocol (`crates/vanity-grinder`, `src/solana/vanity/`).** WASM `grind`: `pubkey_from_seed` = `SHA-512(seed) → low 32 → EdwardsPoint::mul_base_clamped → compress` (bit-identical to `SigningKey`, minus overhead); seeds enumerated by overwriting low 4 bytes of a CSPRNG `start_seed` with a wrapping counter. **Proof-of-grind cert** (`three-pog/v1`): canonical key-sorted JSON over `SIGNED_FIELDS`, domain-tag `three-pog/cert/v1`, `certId = SHA-256(domain‖stableStringify(address,pattern,format,nonce))`, Ed25519 attestation sig; `verifyProofOfGrind` recomputes every claim (validity, binding, difficulty `58^len`, freshness, first-cert-for-address, rotation-aware sig). Split-key non-custody assertion `P1 + a2·B == address` (server only ever knew offset `a2`). **Sealed delivery** `x25519-hkdf-sha256-aes256gcm/v1` (ECIES, ephemeral X25519 + HKDF + AES-256-GCM, epk bound as AAD, forward-secret w.r.t. server).

**9. Honeypot / firewall (`api/_lib/trade-firewall.js`, `api/pump/safety.js`).** `assessTradeSafety` runs checks concurrently, never throws (outage → `warn`, never fake `allow`). SPL authority audit: non-null `freezeAuthority` = fatal; `mintAuthority` = warn. Venue+reserves check. **Simulated buy→sell round-trip**: packs both legs in one v0 message, simulates on live RPC (`sigVerify:false, replaceRecentBlockhash:true`); revert on sell leg or ~0 SOL out = honeypot → fatal. Score starts 100, subtracts penalties; `block` if any fatal flag or ≤45, `warn` if ≤70. Authority/curve reads cached 8s; **round-trip never cached**. Logged to `firewall_decisions`.

**10. Granite Guardian gate (`api/_lib/granite-guardian.js`).** 12-risk taxonomy, each an independent watsonx classifier pass; default input risks `[jailbreak,harm,violence,unethical_behavior,social_bias]` run concurrently. Each pass recovers a real unsafe-probability by softmaxing Yes/No logprobs (`logprobs:true, top_logprobs:5`); `decide` → allow/review/block at `FLAG_THRESHOLD=0.55`. `governSend` adds a model-independent `sendCapUsd` (default $25). **Hash-chained audit:** stores only SHA-256 of content + decision + `prev` hash; `verifyAuditChain` re-derives from `GENESIS_HASH`.

**11. LLM failover (`api/_lib/chat-models.js`, `api/chat.js`).** `DEFAULT_PROVIDER_ORDER = [groq, openrouter, nvidia, anthropic, openai]` — free lanes first, paid as last-resort backstop (prod paid keys routinely 401/over-quota). `MODEL_CATALOG` annotates `{provider, tools, moderationGated}`; `usableModels` drops tool-incapable or moderation-gated models from auto-chains. `api/chat.js` skips providers in health cooldown (recent 429/5xx/timeout) + unconfigured keys, bounds the loop by `TOTAL_BUDGET_MS=25000` + `MAX_FALLBACK_ATTEMPTS=4` (per-call abort at `min(15000, remaining)`); auth/billing failures cool the whole provider; exhausted-within-budget → clean **503 + Retry-After:20**.

### Specifications, Protocols & Platform Constants

Hard, load-bearing specifics from `specs/` and `docs/`. (The $THREE hold-to-access tier ladder is documented above under On-chain & Solana / $THREE.)

**Mint-mark `3ws`** (`docs/mint-mark.md`, `src/solana/vanity/brand.js`) — address-prefix convention baked into the Ed25519 keypair; every three.ws-launched mint's pubkey starts with `3ws` (case-insensitive). `THREE_WS_MARK='3ws'`, frozen `THREE_WS_VANITY={prefix:'3ws',ignoreCase:true}`; grind ~49,000 keypairs @ ~25,000/s → <1s. Kill-switch `THREE_WS_MARK_ENFORCE` (default ON, fail-closed); enforced in `launch-prep`/`launch-agent`; unbranded → `400 unbranded_mint`. **Exempt:** `api/x402/pump-launch.js` (arbitrary caller mint).

**Persona Hub JWT** (`docs/persona-hub.md`, `api/auth/persona/[action].js`) — ES256 (P-256) when `PERSONA_JWKS_PRIVATE_KEY_PEM` set, else HS256(`JWT_SECRET`); `kid` default `persona-es256-1`. TTL `PERSONA_TTL_SEC=86400` (24h), no refresh/revocation. Claims: `iss=https://three.ws`, `sub=userId`, `aud=tenant_origin`, `scope="persona:read avatar:read"`, `token_use="persona"`, `avatar{id,name,url,thumbnail_url}`, `jti`. Endpoints `GET /me`, `POST /issue`, `GET /verify?token=&audience=`, `GET /.well-known/jwks.json`. Widget `<three-ws-signin>` (`public/persona/widget.js`), events `three-ws:authorized`/`cancelled`. Allowed origins `three.ws`, `*.three.ws`, dev localhost.

**Agent Manifest** (`specs/AGENT_MANIFEST.md`) — `$schema=https://3d-agent.io/schemas/manifest/0.2.json`, `spec="agent-manifest/0.2"` (v0.2 added `permissions`). Bundle: `manifest.json` (req) + `instructions.md`, `SKILL.md`, `body.glb`, `poster.webp`, `skills/`, `memory/MEMORY.md`, `attestations/`. Fields: `id{chain,registry,agentId,owner}`, `body{uri,format(gltf-binary|gltf|vrm),rig,boundingBoxHeight}`, `brain{provider,model,instructions,temperature(0.7),maxTokens(4096),thinking(auto)}`, `voice{tts,stt}`, `skills[]`, `memory{mode,index,maxTokens(8192)}`, `tools[]` (default `["wave","lookAt","play_clip","setExpression"]`), `attestations[]`, `permissions`. **3D Agent Card v1** is a strict superset of ERC-8004 registration v1 via ERC-721 `tokenURI`; required `model{uri(ipfs),format,sha256}` — consumers MUST treat mismatched hash as unverified.

**Skill spec** (`specs/SKILL_SPEC.md`, `spec="skill/0.1"`) — bundle `manifest.json` + `SKILL.md`; `tools.json` uses `input_schema`. Code runs in a **shared Web Worker** (no DOM/window/localStorage/navigator), handler loaded via `blob:` URL; `ctx.*` calls are structured-clone postMessage round-trips, **30s timeout each**; network only via `ctx.fetch`. Trust `any|whitelist|owned-only` (default `owned-only`), integrity hashes verified pre-exec; `trusted-main-thread` opt-out only for owned/whitelist. Events `perform-skill`/`skill-done{result:{ok,output,sentiment∈[−1,1]}}`/`skill-error`. Built-ins: `greet`, `present-model`, `validate-model`, `remember`, `think`, `sign-action`, `help`.

**Permissions ERC-7710/7715** (`specs/PERMISSIONS_SPEC.md`) — DelegationManager `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` (same address all chains via CREATE2). Caveat enforcers (`src/erc7710/abi.js` `CAVEAT_ENFORCERS`): AllowedTargets, ERC20TransferAmount, ERC20PeriodTransfer, NativeTokenTransferAmount, NativeTokenPeriodTransfer, Timestamp, LimitedCalls. Envelope `{delegate,delegator,authority,caveats[{enforcer,terms}],salt,signature(EIP-712)}`, id = `delegation_hash` keccak256. API `/api/permissions/{grant,list,revoke,redeem,metadata,verify}`. `redeemFromSkill` rate-limited 5/min/tab. Spec defaults mainnet-disabled (Base Sepolia 84532 + Sepolia 11155111); `agent_delegations` table tracks `status(active|revoked|expired)`, `redemption_count`.

**Memory spec** (`specs/MEMORY_SPEC.md`, `memory/0.1`) — salience bonus: feedback +0.3, user +0.2, project +0.1, reference +0.0; rank = salience × recency (7-day half-life); `important:true` pins to 1.0. Retrieval budget default 8192 tokens (~4 chars/token); MEMORY.md index truncated beyond 200 lines. Modes `local` (key `agent:<id>:memory`, max 150 entries / 200 timeline rows), `ipfs`, `encrypted-ipfs` (ECIES/libsodium sealed box), `none`. Spec-level recall = substring (vector search deferred; the live server engine uses cosine).

**Embed/Host protocol** (`specs/EMBED_HOST_PROTOCOL.md`, envelope `v:1`) — `{v:1, type:"<host|embed>.<cat>", id?, payload}`. Host→embed: `host.hello`, `host.chat.message`, `host.action`, `host.theme`, `host.response`. Embed→host: `embed.ready`, `embed.event` (`agent.speaking|idle|emote|error`), `embed.error`, `embed.request` (5000ms default timeout). EMBED_SPEC bridge **forbids `'*'`** origin. Delegation message types (v0.2+) `host/embed.permissions.{query,redeem,redeemed,error}`. `embedPolicy{mode:allowlist|denylist|open, hosts[]}` stored as `agent_identities.embed_policy` JSONB. **Stage** (`stage/0.1`): `<agent-stage formation=row|circle|freeform>` (row spacing 1.1m), one renderer/stage, tools `observe_agents`/`say_to_agent`.

**`<agent-3d>` web component** (`docs/web-component.md`) — CDN `/agent-3d/<ver>/agent-3d.js` (immutable; channel tags 5-min), current **v1.5.2**. Methods: `say`, `ask`, `wave`, `lookAt`, `play`, `speak`, `clearConversation`, `installSkill`/`uninstallSkill`, `expressEmotion(trigger,weight)`, `setMode`/`setPosition`/`setSize`, `pause`, `destroy`, `activateAR`. Events: `agent:ready`, `agent:load-progress{phase}`, `agent:error`, `brain:message`/`thinking`, `voice:*`, `skill:loaded`/`tool-called`, `memory:write`, `ar-status`. CSS vars `--agent-{bubble-radius,accent,surface,on-surface,chat-font,mic-glow,shadow}`. iframe `sandbox="allow-scripts allow-same-origin"`; collapses to 56px pill below 480px.

**Widget API** (`docs/widget-api.md`) — shell `/widget`, loader `embed.js`, client `widget-client.js`, global `ThreeWidget.attach`. Types `turntable`(default), `talking-agent`. **JSON-RPC 2.0** over postMessage: `viewer.{getInfo,setBackground,setAutoRotate,setEnvironment}`, `camera.{getLookAt,setLookAt,recenter}`, `animation.{list,play,stop}`, `screenshot.capture`, `model.{load,export}`, `ping`; events `viewer.ready`/`model.loaded`/`widget.revealed`. WebGL context cap ~16/tab.

**Claude Artifact** (`specs/CLAUDE_ARTIFACT.md`) — `GET /api/artifact?agent=|model=&theme=&idle=&bg=` → one self-contained HTML (three.js + GLB inlined). SSRF whitelist (`*.r2.cloudflarestorage.com`, `*.amazonaws.com`, `storage.googleapis.com`, `three.ws`, `*.vercel.app`, …); GLB max 6MB raw → 413; fetch timeout 8s; rate `widgetRead` 600/min/IP; strict CSP (`default-src 'none'`); GLB via `GLTFLoader.parse(atob(...))`, never `.load(url)`.

**On-chain attestations.** Solana: Memo program `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`; AgenC devnet `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`; mainnet genesis `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. Seven permissionless kinds (SPL Memos): `threews.{feedback,stake,validation,task,accept,dispute,revoke}.v1` (stake ≥0.001 SOL). SAS schemas `threews.verified-client.v1`, `threews.audited-validation.v1` (authority `SAS_AUTHORITY_SECRET`). EVM ERC-8004 registries (CREATE2, same address per chain): Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (scores −100…+100, optional ≥0.001 ETH stake), Validation testnet `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`. Platform validator EOA `0x93Bc7EfB0059B784465619FC73C2db8D01b1CD04` (kind `glb-schema`). **Metaplex Core collection** `56Gnsb7Jjg1N9c8V7EAnDC4HmQbQjsEueSUA3EK5272H` ("three.ws Agents", 500-bps royalty plugin, ~0.004 SOL/agent mint).

**x402 wire constants** — `X402_VERSION=2`, scheme `exact`. USDC: Solana `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`. Facilitators: PayAI `https://facilitator.payai.network`, Coinbase CDP `https://api.cdp.coinbase.com/platform/v2/x402` (Base+Arbitrum). CAIP-2: Base `eip155:8453`, Arbitrum `eip155:42161`, BSC `eip155:56`, Solana `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. $THREE accepted as second Solana settlement asset (`acceptThree:true`, opt-in `X402_ACCEPT_THREE_SOLANA`).

**AI model IDs.** NVIDIA (`NVIDIA_API_KEY`, NIM base `integrate.api.nvidia.com/v1`): text→3D `microsoft/trellis` (steps 10–50, prompt ≤77 chars), text→image `black-forest-labs/flux.1-schnell`, default LLM `meta/llama-3.3-70b-instruct`, vision `nvidia/nemotron-nano-12b-v2-vl`→`meta/llama-3.2-11b-vision-instruct`, embeddings `nvidia/nv-embedqa-e5-v5` (1024-dim, ≤512 tok)→`baai/bge-m3`, rerank `nvidia/rerank-qa-mistral-4b`, safety `nvidia/llama-3.1-nemoguard-8b-content-safety`→`meta/llama-guard-4-12b`, TTS `magpie-tts-multilingual`. IBM watsonx: chat `ibm/granite-3-8b-instruct`, embeddings `ibm/granite-embedding-278m-multilingual`, forecast `ibm/granite-ttm-{512|1024|1536}-96-r2`, vision `ibm/granite-vision-3-2-2b`, governance `ibm/granite-guardian-3-8b`; Identity Firewall similarity ≥93% = block, 86–93% = review. i18n provider ladder: groq (default) → gemini (CJK) → openrouter → nvidia → openai → anthropic; glossary `doNotTranslate` includes `$THREE`, contract address, `x402`, `USDC`, `Solana`, `IBM watsonx.ai`.

**Pump platform fee** (`docs/pump-platform-fee.md`) — `PUMP_PLATFORM_FEE_BPS` default 0 (off), hard-capped 500 (5%); recipient `PUMP_PLATFORM_FEE_WALLET` → treasury fallback; buy fee added on top, sell fee from proceeds.

**Distribution / syndication** — Listings (live): AWS Marketplace, Alibaba Cloud Intl, BNB Chain Dappbay (`dappbay.bnbchain.org/detail/three`). News syndication: WebSub hub, Dev.to (`DEV_TO_API_KEY`), Medium (`MEDIUM_INTEGRATION_TOKEN`, create-only), HackerNoon (RSS auto-import), CoinMarketCap (manual); `POST /api/admin/news/resyndicate`; store `data/rss/items.json`. **X Spaces agent** (`xspace-agent`): Puppeteer+CDP headless Chromium → WebRTC audio → STT→LLM→TTS; presets agent-zero/comedian/crypto-degen/educator/interviewer/tech-analyst; Docker `ghcr.io/nirholas/xspace-agent`.

**Agora / AgenC** (`docs/agora.md`) — AgenC agent PDA `["agent",agentId]`: `reputation` u16 (start 5000), `stake` u64 (≥0.001 SOL), `capabilities` bitmask. Professions (bits 0–7): Fetcher, Sculptor, Scribe, Cartographer, Crier, Appraiser, Verifier, Namekeeper — each WORK module emits `proofHash=sha256(deliverable)`. Task types Exclusive/Competitive/Collaborative; loop IDLE→SEEK→CLAIM→BUSY/WORK→PROVE→SPEND. On-chain currency = $THREE on mainnet (devnet uses SOL/synthetic). Identity bridge `sha256` namespaces `AgenC/three.ws/{erc8004|mpl-core|handle|composite}/v1`.

**zauth suite** (`docs/zauth/*`, vendored 2026-06-10) — API host `api.zauth.inc`. RepoScan x402 $0.05/scan (trust score 0–100), `GET /api/bot/scan`, `GET /api/bot/progress/:scanId` (SSE), `POST /x402/reposcan`. Provider Hub `@zauthx402/sdk` Express middleware `zauthProvider(apiKey)` with auto-refunds (per-refund/daily/monthly caps). Free directory `GET https://api.zauth.inc/api/directory`.

**Spec schema snippets** (`specs/schema/*.sql`) — `agent_subscriptions`(`period_seconds>0`, `status active|canceled|paused`), `dca_strategies`(`dca/0.1`, `chain_id` default 84532, `period_seconds IN (86400,604800)`, `slippage_bps` 1–500), `indexer_state`(`(contract,chain_id)` unique, `last_indexed_block`), `voice-cloning`(`agent_identities.voice_provider/voice_id/voice_cloned_at`), `embed-policy`(`agent_identities.embed_policy` JSONB).
