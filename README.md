# three.ws   

https://github.com/user-attachments/assets/d52515d1-cb04-4dd6-98bd-fef233312dc4

**Give your AI a body.** three.ws is an open-source, browser-native 3D AI agent platform. Drop a GLB file, add an LLM brain, register on-chain, and embed anywhere — no plugins, no server uploads, no installs required.

---

## Table of Contents

- [What is three.ws?](#what-is-threews)
- [Vision](#vision)
- [Roadmap](#roadmap)
- [Key Features](#key-features)
- [Platform Pages](#platform-pages)
- [Cloud Marketplaces](#cloud-marketplaces)
- [Ecosystem Directories](#ecosystem-directories)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
    - [Design Docs & Specs](#design-docs--specs)
- [Tech Stack](#tech-stack)
    - [Browser Support](#browser-support)
- [Getting Started](#getting-started)
- [Examples](#examples)
- [Tutorials](#tutorials)
- [Project Structure](#project-structure)
- [The Agent System](#the-agent-system)
    - [Event Bus (Agent Protocol)](#event-bus-agent-protocol)
    - [LLM Runtime](#llm-runtime)
    - [Empathy Layer](#empathy-layer)
    - [Skills](#skills)
    - [Memory](#memory)
- [Web Component & Embedding](#web-component--embedding)
- [Widget System](#widget-system)
- [Embed Editor](#embed-editor)
- [Pose Studio](#pose-studio)
- [Launchpad](#launchpad)
- [The Club](#the-club)
- [Walk & Multiplayer](#walk--multiplayer)
- [Coin Communities](#coin-communities)
- [Adventure — Onchain RPG](#adventure--onchain-rpg)
- [City](#city)
- [Friends, Presence & Social](#friends-presence--social)
- [In-Game Economy](#in-game-economy)
- [Voice Lab & Mocap Studio](#voice-lab--mocap-studio)
- [x402 Payments](#x402-payments)
- [A2A — Agent-to-Agent Protocol](#a2a--agent-to-agent-protocol)
- [Talk Mode & Lip-Sync](#talk-mode--lip-sync)
- [Solana Mobile (Seeker)](#solana-mobile-seeker)
- [Selfie Reconstruction Pipeline (Phase 1)](#selfie-reconstruction-pipeline-phase-1)
- [Livepeer Inference Network (Phase 4)](#livepeer-inference-network-phase-4)
- [Voice & Persona Hub (Phase 2)](#voice--persona-hub-phase-2)
- [WASM Vanity Grinder](#wasm-vanity-grinder)
- [News CMS & Syndication](#news-cms--syndication)
- [Security Hardening](#security-hardening)
- [Developer SDKs](#developer-sdks)
- [Claude Code Integration](#claude-code-integration)
- [Demos Hub](#demos-hub)
- [Skill Library](#skill-library)
- [Animation System](#animation-system)
- [Avatar Accessories & Coin Launchpad](#avatar-accessories--coin-launchpad)
- [Brain Proxy & LLM Routing](#brain-proxy--llm-routing)
- [API Reference](#api-reference)
- [Authentication & OAuth 2.1](#authentication--oauth-21)
- [MCP Server](#mcp-server)
- [On-Chain Identity (ERC-8004 + Metaplex Core)](#on-chain-identity-erc-8004--metaplex-core)
- [Pump.fun Integration](#pumpfun-integration)
- [Database Schema](#database-schema)
- [Build & Deployment](#build--deployment)
    - [Versioning & Compatibility](#versioning--compatibility)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [FAQ & Troubleshooting](#faq--troubleshooting)
- [Contributing](#contributing)
- [Contributors](#contributors)
- [License](#license)

---

## What is three.ws?

three.ws is a full-stack system for creating, deploying, and embedding 3D AI agents. It combines a WebGL model viewer, an LLM-driven agent runtime, on-chain identity contracts, and a distributable web component into one cohesive platform.

At its core, it does four things:

1. **Render** — loads and validates glTF 2.0 / GLB models in WebGL 2.0 with zero server-side processing. Drag a file onto the browser and it renders instantly with full Draco, KTX2, and Meshopt decompression.

2. **Embody** — wraps any avatar with an LLM brain. The agent listens to the user, thinks with Claude, executes tools (animations, gestures, memory operations, skill calls), and expresses emotion through morph-target blending on the 3D model in real time.

3. **Register** — optionally mints the agent on-chain: as an **ERC-8004 token on any EVM chain**, or as a **Metaplex Core NFT on Solana**. Either path gives the agent a stable on-chain identity, a wallet address, signed action history, and a reputation score that cannot be forged.

4. **Embed** — distributes the agent as an `<agent-3d>` web component that anyone can drop into a page, or as one of five purpose-built widget types (turntable, animation gallery, talking agent, passport card, hotspot tour) with Open Graph and oEmbed support built in.

The backend is a set of Vercel serverless functions backed by Neon Postgres for metadata, Cloudflare R2 for model storage, and Upstash Redis for rate limiting. It exposes a full OAuth 2.1 authorization server and an MCP (Model Context Protocol) endpoint so external AI systems can drive avatars programmatically.

three.ws is production-ready and serves [three.ws](https://three.ws) live. The entire stack — viewer, agent runtime, contracts, backend, and web component — is open source under Apache 2.0.

---

## Vision

One day, creating your agent should be as simple as taking a selfie.

Point your camera at yourself — or anyone — and watch a fully realized 3D avatar emerge: your face, your voice, your personality, alive in the browser. That avatar becomes an agent with memory and skills, registered onchain — as an ERC-8004 token on EVM or a Metaplex Core asset on Solana — permanent and verifiable by anyone forever. No 3D software. No wallet setup. No uploads. Just a photo and a name.

This is the direction three.ws is heading: **photo → avatar → agent → onchain identity**, in a single flow. The infrastructure is already here — the viewer, the runtime, the contracts, the embedding layer. What comes next is closing the gap between a picture of a person and a living, ownable, embeddable piece of them that exists on the internet permanently.

---

## Roadmap

three.ws ships in four phases. Each phase closes a specific gap between the current platform and the end-state vision: **anyone can mint a 3D agent of themselves, own it onchain, and embed it anywhere on the internet.**

| Phase | Theme                                                                                  | Status                                                                                                         |
| ----- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **0** | Platform foundations (viewer, runtime, ERC-8004 + Metaplex Core identity, embed layer) | ✅ Shipped                                                                                                     |
| **1** | Selfie → Avatar engine (3-photo capture, hosted inference)                             | 🟡 In progress — capture UX + quality gates shipped; GPU reconstruction backend wiring                         |
| **2** | Agent personalization + voice cloning                                                  | 🟡 In progress — voice clone, persona, memory seeds shipped behind `/demos`; main-flow integration next        |
| **3** | Onchain economy (agent tokens, reputation markets, royalties)                          | 🟡 Scaffolding — bonding-curve sim, EAS-reputation viewer, 0xsplits + EAS SDKs landed; contracts + audits next |
| **4** | Open inference network (decentralized GPU layer)                                       | 🔮 Future — livepeer dep landed for early experimentation                                                      |

---

### Phase 0 — Foundations _(Shipped)_

The full stack is live at [three.ws](https://three.ws): WebGL viewer, LLM agent runtime, ERC-8004 identity contracts (EVM) and Metaplex Core mints (Solana), OAuth 2.1 server, MCP endpoint, and the `<agent-3d>` web component. Anyone can register an agent today — but the avatar still has to come from a 3D artist or a third-party tool.

**What works:** model upload, agent runtime, onchain registration, embedding, signed action history, reputation scores.
**What doesn't:** there is no automated path from a real human face to a usable 3D avatar.

---

### Phase 1 — Selfie → Avatar Engine

**Goal:** any user takes 3 selfies (left, center, right) and receives a rigged, animatable 3D avatar in under 60 seconds.

**Deliverables**

- Mobile-first capture UX with realtime quality gates (lighting, framing, blur)
- Multi-view face reconstruction pipeline (FLAME / 3DMM fitting on top of a base body mesh)
- Hosted inference workers (GPU-backed) for sub-minute generation
- Output written directly to R2 and minted as a draft agent token — ERC-8004 on EVM, Metaplex Core asset on Solana

**Compute requirements**

- A100/H100-class GPUs for inference, sized to ~10k avatars/day at launch
- Training budget for fine-tuning a stylized face-fitter on a curated dataset
- CDN egress scaling for high-res GLB delivery

**Verification:** 1,000 test users complete capture and mint an onchain agent of themselves end-to-end with ≥4/5 likeness score.

---

### Phase 2 — Agent Personalization

**Goal:** the avatar isn't just _you_ — the agent _acts_ like you.

**Deliverables**

- Voice cloning (3–10 seconds of speech → ElevenLabs custom voice bound to the agent)
- Persona extraction from a short onboarding interview (tone, vocabulary, interests)
- Memory seeding from connected accounts (X, GitHub, Farcaster) with explicit user consent
- Per-agent fine-tuned system prompt stored in the manifest, signed and pinned to IPFS

**Verification:** users return to converse with their own agent; ≥30% week-2 retention on minted agents.

---

### Phase 3 — Onchain Economy

**Goal:** agents are real economic objects on EVM and Solana, not just collectibles.

**Deliverables**

- **Agent tokens** — ERC-8004 mints with bonding-curve pricing or fair launch options
- **Reputation markets** — stake on agents, earn from their action history (extends `ReputationRegistry.sol`)
- **Skill royalties** — skill authors earn per-call fees through EIP-7710 delegated permissions
- **Agent-to-agent payments** — agents transact autonomously via their delegated signer wallets
- **Subscriptions & DCA** — recurring onchain payments to creators (cron infra already in place)

**Funding requirements**

- Smart contract audits (multi-firm) for the reputation, royalty, and delegation contracts
- Liquidity for agent token launches
- Indexer infrastructure across Base, Solana, and additional EVM chains

**Verification:** ≥1,000 agents minted with active onchain reputation; ≥$X in cumulative skill royalties paid out.

---

### Phase 4 — Open Inference Network

**Goal:** decouple agent inference from any single provider. Anyone can run a node; agents pay nodes onchain for compute.

**Deliverables**

- Open protocol for agent inference (model weights, GPU runtime, signed responses)
- Node operator client (Docker + GPU drivers) with onchain registration
- Onchain settlement for inference jobs — pay-per-token with cryptographic receipts
- Federation with existing decentralized compute networks where appropriate

**Compute requirements**

- Bootstrap GPU credits for early node operators
- Cryptoeconomic security model (slashing, validator set) — research + audit budget

**Verification:** ≥50% of production agent traffic served by independent node operators; latency parity with centralized inference.

---

### What we need

| Resource                   | Used for                                   | Phase |
| -------------------------- | ------------------------------------------ | ----- |
| **Inference GPUs**         | Avatar generation, agent conversations     | 1, 2  |
| **Training compute**       | Fine-tuned face-fitter, voice models       | 1, 2  |
| **Smart contract audits**  | Reputation, royalty, delegation contracts  | 3     |
| **Token launch liquidity** | Agent token markets                        | 3     |
| **Indexer infrastructure** | Multi-chain crawl + reputation aggregation | 3     |
| **Node operator credits**  | Bootstrap the open inference network       | 4     |
| **Engineering headcount**  | Capture pipeline, contracts, indexer, ops  | 1–4   |

Phases 1 and 2 unblock the consumer story — _anyone gets an agent of themselves_. Phases 3 and 4 unblock the onchain story — _those agents are real economic actors that don't depend on any one company to keep running_. Both are required for the vision; neither is funded yet.

If you want to support the project — compute credits, grants, partnerships, or contributions — open an issue or reach out via [three.ws](https://three.ws).

---

## Key Features

**3D Viewer**

- WebGL 2.0 rendering via three.js r176
- glTF 2.0 and GLB with Draco geometry compression, KTX2 texture compression, and Meshopt mesh optimization
- Khronos-spec glTF validation with line-level error reporting
- HDR environment maps, PBR materials, skinned mesh animations, morph targets, and embedded cameras
- OrbitControls (pan, zoom, rotate) with configurable auto-rotation
- Real-time parameter tweaking (lights, exposure, morph weights) via dat.GUI

**Agent Runtime**

- LLM brain powered by Claude (Anthropic API) with a structured tool-loop architecture
- Up to 8 tool iterations per turn before returning final output
- Built-in tools: `wave`, `lookAt`, `play_clip`, `setExpression`, `speak`, `remember`
- Composable skill system — install skills from IPFS, Arweave, or HTTP; each skill is a self-contained bundle with a description, tool definitions, and async handlers
- Weighted emotion blending (celebration, concern, curiosity, empathy, patience) driven by protocol events, not a finite-state machine
- Web Speech API for STT/TTS out of the box; ElevenLabs integration for production-quality voice
- **Talk mode** with audio-driven ARKit-52 lip-sync — TTS audio is analysed in real time and drives 52 standard blendshapes on the avatar
- Anonymous Groq-powered chat for unauthenticated visitors; owner-card gating when an agent has a paying author

**x402 Payments & Bazaar**

- Native [x402](https://x402.org) paid endpoints on Base, BSC, and Solana — agents pay other agents in USDC for API calls, asset downloads, and skill royalties
- Coinbase CDP facilitator on Base mainnet; direct-scheme payments on BSC
- Permit2 gas-sponsoring siblings on every CDP-settled endpoint (buyer signs, relayer pays gas)
- **Pay-by-name** — `/api/x402/pay-by-name` resolves `@username`, `*.sol` (incl. subdomains), or raw base58 to a recipient and builds an unsigned USDC transfer for the payer's wallet. Every 402 manifest emitted by a named agent advertises `recipient_name` next to the wallet, so payers verify a human-readable name before signing
- SKU catalog + Stripe-style checkout at `/dashboard/x402`; receipts ledger with admin tooling
- Subscriptions, idempotency tokens, offer receipts, paid asset download, and a bazaar listing/search API
- SIWX (Sign-In with X-chain) server for auth-gated paid endpoints
- Listed on [x402scan](https://www.x402scan.com/server/17cbd874-52ac-4920-a020-b22ff2489a07) and the [MCP Registry](https://registry.modelcontextprotocol.io/?q=three.ws)

**SNS / `*.threews.sol` subdomains**

- `/threews/claim` lets any signed-in user mint `[username].threews.sol` in a single atomic Solana transaction — `createSubdomain` → URL record → `transferSubdomain` to the user's wallet, with three.ws absorbing gas
- Brave Browser resolves the subdomain directly to the user's `/u/[username]` showcase via the SNS URL record
- Agents can bind a `.sol` name (theirs or a fresh registration) via `/api/agents/:id/sns`; once bound, every public surface — agent page, x402 manifest, MCP listing, marketplace card — displays the name in place of the raw wallet
- See [docs/internal/SNS_PARTNERSHIP_PROPOSAL.md](docs/internal/SNS_PARTNERSHIP_PROPOSAL.md) for the partnership pitch to Bonfida

**A2A — Agent-to-Agent Protocol**

- A2A client + server, MCP bridge, DID resolution, spending ledger, receipts storage
- Agents transact autonomously via their delegated signer wallets and EIP-7710 permissions

**Identity & On-Chain**

- ERC-8004 smart contracts (IdentityRegistry, ReputationRegistry, ValidationRegistry) deployable on any EVM chain — plus a **program-free Metaplex Core analog on Solana** (asset pubkey = agent ID, SPL Memo–anchored reputation + validation attestations)
- Each agent is an ERC-721 token with a stable `agentId`, owner wallet, delegated signer (EIP-712), and IPFS-pinned manifest
- Signed action log — every `speak`, `remember`, `skill-done`, and `validate` event is recorded on-chain-optionally or in the database with a cryptographic signature
- EIP-7710 delegated permissions for composable agent-to-agent authorization
- Solana support (SIWS sign-in, Solana wallet linking, Metaplex NFT option)

**Embedding & Distribution**

- `<agent-3d>` custom element — drop it anywhere with no framework dependency
- Five widget variants: turntable, animation gallery, talking agent, ERC-8004 passport card, hotspot tour
- Widget Studio + WYSIWYG **Embed Editor** at `/embed-editor` — pick an avatar, animation, framing, and background, copy the snippet
- **Launchpad** at `/launchpad` — hosted public launch pages at `/p/[slug]` for tokens, agents, and drops
- Open Graph metadata and oEmbed support for rich social previews when links are shared
- Versioned CDN bundles at `/agent-3d/x.y.z/agent-3d.js`

**Social & Multiplayer 3D**

- **Coin Communities** at `/communities` + `/play` — every Solana token gets a live 3D world; pick the same coin and land together, with peer avatars, chat, emotes, voxel building, and a live market-cap screen
- **Adventure** at `/game` — an authoritative onchain RPG: trainable skills, gathering, combat, banking, mounts, multi-realm world, daily quests, cosmetics shop, player marketplace, and $THREE/gold economy
- **City** at `/city` — free-roam walkable 3D city scene
- **Friends, presence & DMs** — account-level social graph with live presence ("Online · Mainland"), direct messages, and a per-account realtime delivery hub
- **The Club** at `/club` — multiplayer venue with rigged dancers, audio tracks, tips, leaderboard, payouts cron, perf-aware renderer that auto-downgrades on slow frames
- **Walk** at `/walk` — authoritative multiplayer walk scene backed by a Colyseus server in `multiplayer/` (deployable on Fly.io)
- **Pose Studio** at `/pose-studio`, **Voice Lab** at `/voice`, **Mocap Studio** at `/mocap-studio` — author poses, bind voices, and capture/retarget motion into reusable clips

**Backend & Integrations**

- OAuth 2.1 server (RFC 6749 + PKCE, RFC 7591 dynamic registration, RFC 7009 revocation, RFC 7662 introspection, RFC 8414 discovery)
- Developer API keys with scope and expiry
- MCP (Model Context Protocol) over HTTP with JSON-RPC 2.0 for tool-calling from external AI systems; A2A bridge exposes paid tools as x402 endpoints
- Avaturn (photo-to-avatar), Character Studio (in-browser builder), Avatar Studio (rebranded marketplace), and Privy (embedded wallet) integrations
- Replicate-backed avatar regeneration provider for photo-to-avatar workflows
- Native selfie reconstruction pipeline (Phase 1) + Livepeer inference network (Phase 4) wired into the agent runtime
- DCA strategy execution and on-chain subscription scheduling via cron jobs
- News CMS at `/admin/news` with multi-destination syndication (WebSub, Dev.to, Medium, HackerNoon, CMC handoff)
- Solana Mobile (Seeker) MWA wallet wired into the web app + Solana Mobile dApp Store release pipeline
- Hardened API surface: SSRF guard, CSRF gates, header-origin pinning, fail-closed crons
- OpenAPI 3.1 spec generated at `/openapi.json`

---

## Platform Pages

A map of every user-facing route. Full detail (source files, feature descriptions, hash-routes) is in [docs/internal/PAGES.md](docs/internal/PAGES.md).

| Section              | Key URLs                                                                                        | What it does                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Landing**          | `/`, `/features`, `/discover`                                                                   | Marketing, public agent directory                                                                               |
| **App / Core**       | `/app`, `/create`, `/first-meet`                                                                | 3D viewer, agent creation wizard, onboarding                                                                    |
| **Marketplace**      | `/marketplace`, `/marketplace/agents/[id]`                                                      | Browsable agent marketplace                                                                                     |
| **Chat SPA**         | `/chat`                                                                                         | Full Svelte AI chat with model selector, tools, artifacts, wallet                                               |
| **Chat — Marketing** | `/chat#solutions/*`, `/chat#business/*`                                                         | Per-team and enterprise landing pages                                                                           |
| **Chat — Features**  | `/chat#features/*`                                                                              | Feature detail pages (web-app, mobile-app, ai-design, ai-slides, browser-operator, wide-research, mail, skills) |
| **Chat — Resources** | `/chat#resources/*`                                                                             | Blog, docs, trust center, updates, use cases                                                                    |
| **Auth**             | `/login`, `/register`, `/forgot-password`, `/reset-password`                                    | Email + wallet sign-in/up                                                                                       |
| **Agent (Platform)** | `/agent/[id]`, `/agent/[id]/embed`, `/agent/[id]/edit`                                          | Agent chat, chromeless embed, manifest editor                                                                   |
| **Agent (On-Chain)** | `/a/[chain]/[id]`, `/a/sol/[asset]`                                                             | ERC-8004 and Metaplex Core passports                                                                            |
| **Profile**          | `/profile`, `/u/[username]`, `/avatars/[id]`                                                    | User and avatar public pages — SNS badge + pay-by-name modal when `[username].threews.sol` is claimed           |
| **SNS Subdomain**    | `/threews/claim`                                                                                | Mint `[label].threews.sol`, set the URL record to your showcase, transfer ownership — single tx, platform pays  |
| **Dashboard**        | `/dashboard`, `/dashboard/actions`, `/dashboard/wallets`, `/dashboard/usage`, `/dashboard/x402` | Account management, settings, and x402 receipts/payouts                                                         |
| **Studio / Tools**   | `/studio`, `/embed-editor`, `/pose-studio`, `/voice`, `/mocap-studio`, `/hydrate`, `/validation`, `/strategy-lab` | Widget Studio, WYSIWYG embed editor, pose authoring, Voice Lab, Mocap Studio, on-chain import, glTF validator, DCA |
| **Widgets**          | `/widgets`, `/w/[id]`                                                                           | Widget gallery and public widget pages (OG + oEmbed)                                                            |
| **Launchpad**        | `/launchpad`, `/p/[slug]`                                                                       | Launchpad Studio + hosted launch pages (token, agent, drop campaigns)                                           |
| **Club**             | `/club`                                                                                         | Multiplayer 3D venue — tips, leaderboard, audio tracks, perf-aware renderer                                     |
| **Walk**             | `/walk`                                                                                         | Authoritative multiplayer walk scene (Colyseus on Fly.io)                                                       |
| **Coin Communities** | `/communities`, `/communities/[mint]`, `/worlds`, `/play`                                       | Live 3D world per Solana token — lobby, coin profile, and the shared coin-keyed world                           |
| **Adventure**        | `/game`                                                                                         | Onchain RPG — skills, gathering, combat, quests, cosmetics, player marketplace, $THREE/gold economy            |
| **City**             | `/city`                                                                                         | Free-roam walkable 3D city scene                                                                                |
| **Bazaar (x402)**    | `/x402`, `/x402-discover`, `/x402-pay`                                                          | Paid-API marketplace, discovery, Stripe-style checkout                                                          |
| **Artifacts**        | `/artifact`, `/artifact/snippet`, `/artifact-example`                                           | Claude Artifact viewer                                                                                          |
| **Solana / DeFi**    | `/pumpfun`, `/pump-visualizer`, `/vanity-wallet`                                                | pump.fun launcher, live token visualizer, WASM vanity grinder                                                   |
| **Mobile (Seeker)**  | Solana Mobile dApp Store                                                                        | MWA wallet wired into the web app + Seeker release pipeline                                                     |
| **News / Blog**      | `/news`, `/admin/news`                                                                          | News feed + local-only CMS, syndicated via WebSub / Dev.to / Medium / HackerNoon                                |
| **Admin / Rep**      | `/admin`, `/reputation`                                                                         | Staff admin, reputation registry                                                                                |
| **Experiments**      | `/rider`                                                                                        | A-Frame WebVR music visualization                                                                               |
| **Integrations**     | `/cz`, `/lobehub/iframe`                                                                        | CZ demo, LobeHub plugin                                                                                         |
| **Docs**             | `/docs`, `/docs/widgets`                                                                        | Developer documentation                                                                                         |
| **Legal**            | `/legal/privacy`, `/legal/tos`                                                                  | Privacy policy and terms                                                                                        |

---

## Cloud Marketplaces

three.ws is available on major cloud marketplaces and open to infrastructure partnerships.

| Cloud             | Status                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS**           | **AWS Partner** (APN Software Path). AWS Marketplace SaaS listing in review — see [docs/aws-marketplace.md](docs/aws-marketplace.md) and the public partner page at [three.ws/aws](https://three.ws/aws). Production runs on AWS `us-east-1`, registered in AWS MyApplications under account `155407237916`. |
| **Alibaba Cloud** | Live: [product listing →](https://marketplace.alibabacloud.com/products/56724001/sgcmfw00036800.html) · [storefront →](https://marketplace.alibabacloud.com/store/3247293.html)                       |
| **Google Cloud**  | three.ws runs on WebGL, Vercel edge, EVM (15+ chains), and Solana (Metaplex Core) — a natural fit for GCP's AI infrastructure, Vertex AI, and global CDN. Open to co-listing, credits, and joint GTM. |

## Ecosystem Directories

three.ws is indexed in chain-ecosystem dApp directories so the community can discover, vet, and rank it.

| Directory               | Status                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **BNB Chain · Dappbay** | Live: [dappbay.bnbchain.org/detail/three →](https://dappbay.bnbchain.org/detail/three) — categories: AI Agent Launchpad · AI Data · AI Infra |

---

## Screenshots

| Viewer                                   | Widget Studio                                   |
| ---------------------------------------- | ----------------------------------------------- |
| ![Viewer](public/screenshots/viewer.png) | ![Widget Studio](public/screenshots/studio.png) |

| Agent Discovery                              | Avatar Creation                          |
| -------------------------------------------- | ---------------------------------------- |
| ![Discover](public/screenshots/discover.png) | ![Create](public/screenshots/create.png) |

---

## Architecture

The platform is organized into four layers. All layers communicate through a single event bus (`agent-protocol`) rather than direct calls.

```
┌────────────────────────────────────────────────────────────┐
│  Layer 4: Embed & Distribution                             │
│  <agent-3d> web component · CDN library · 5 widget types   │
│  Widget Studio · oEmbed · Open Graph cards                 │
└────────────────────────────────────────────────────────────┘
                            ↓ protocol events
┌────────────────────────────────────────────────────────────┐
│  Layer 3: Identity & Persistence                           │
│  Agent passport · ERC-8004 (EVM) + Metaplex Core (Solana)  │
│  Signed action log · Memory store · Cross-chain SIWX       │
└────────────────────────────────────────────────────────────┘
                            ↓ protocol events
┌────────────────────────────────────────────────────────────┐
│  Layer 2: Agent Runtime                                    │
│  LLM tool-loop · Built-in tools · Skill registry           │
│  Empathy Layer (emotion blending) · TTS/STT                │
└────────────────────────────────────────────────────────────┘
                            ↓ protocol events
┌────────────────────────────────────────────────────────────┐
│  Layer 1: Viewer                                           │
│  three.js r176 · glTF / GLB · Draco / KTX2 / Meshopt       │
│  Animations · Morph targets · HDR · Validation             │
└────────────────────────────────────────────────────────────┘
```

The event bus decouples every component. The avatar emotion system reacts to `speak` events without knowing the runtime exists. The identity module records actions without knowing the UI exists. This makes the system testable, embeddable in isolation, and composable across pages.

The backend is stateless serverless functions. All persistent state lives in Postgres (Neon), object storage (Cloudflare R2), or on-chain. Cron jobs handle scheduled blockchain operations (ERC-8004 crawl, DCA execution, subscription execution).

### Design Docs & Specs

The architecture above is the bird's-eye view; each load-bearing surface has a dedicated spec that defines its wire format, invariants, and extension points. New contributors should skim the spec for any subsystem they're about to change.

| Spec                                                         | What it covers                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [specs/AGENT_MANIFEST.md](specs/AGENT_MANIFEST.md)           | Agent manifest JSON schema — body, brain, voice, memory, skills, signing. The contract every `<agent-3d>` reads. |
| [specs/3D_AGENT_CARD.md](specs/3D_AGENT_CARD.md)             | The on-chain passport card layout — fields, signing, and rendering rules.                                        |
| [specs/SKILL_SPEC.md](specs/SKILL_SPEC.md)                   | Skill bundle layout (`SKILL.md`, `tools.json`, `handlers.js`), trust modes, and distribution.                    |
| [specs/PERMISSIONS_SPEC.md](specs/PERMISSIONS_SPEC.md)       | EIP-7710 delegated permissions model — capability scopes, redemption, revocation.                                |
| [specs/MEMORY_SPEC.md](specs/MEMORY_SPEC.md)                 | Memory file format, types, salience model, and storage modes.                                                    |
| [specs/STAGE_SPEC.md](specs/STAGE_SPEC.md)                   | Scene/stage configuration: camera presets, lighting, environment maps, hotspots.                                 |
| [specs/EDITOR_SPEC.md](specs/EDITOR_SPEC.md)                 | Widget Studio + Embed Editor configuration surface and persistence shape.                                        |
| [specs/EMBED_SPEC.md](specs/EMBED_SPEC.md)                   | The `<agent-3d>` element and chromeless iframe — attributes, JS API, and lifecycle.                              |
| [specs/EMBED_HOST_PROTOCOL.md](specs/EMBED_HOST_PROTOCOL.md) | `postMessage` wire protocol between the iframe and its host page (origin lock, message kinds, RTT).              |
| [specs/CLAUDE_ARTIFACT.md](specs/CLAUDE_ARTIFACT.md)         | Claude Artifact viewer integration — snippet loading and sandbox boundaries.                                     |
| [specs/ENS_AGENT_CLAIM.md](specs/ENS_AGENT_CLAIM.md)         | ENS-based agent claim flow for verifiable owner ↔ agent binding.                                                |
| [specs/VALIDATORS.md](specs/VALIDATORS.md)                   | Validator attestation rules — what gets signed, who can sign, how to read attestations.                          |
| [specs/SECURITY.md](specs/SECURITY.md)                       | Threat model, trust boundaries, and the hardening checklist for production deployments.                          |

Longer-form architecture and how-to documentation lives under [docs/](docs/): [docs/architecture.md](docs/architecture.md), [docs/agent-system.md](docs/agent-system.md), [docs/animations.md](docs/animations.md), [docs/web-component.md](docs/web-component.md), [docs/api-reference.md](docs/api-reference.md), [docs/mcp.md](docs/mcp.md), [docs/permissions.md](docs/permissions.md), [docs/security.md](docs/security.md), [docs/smart-contracts.md](docs/smart-contracts.md), and more.

---

## Tech Stack

**Frontend**

- **Main UI**: The core application, including the 3D viewer, agent creation, and marketplace, is built with vanilla JavaScript modules and Vite.
- **Chat**: The chat interface is a standalone Svelte application located in the `chat/` directory.
- **3D Rendering**: three.js (r176) is used for WebGL 2.0 rendering.

**Backend (Vercel Serverless)**

- **Runtime**: Node.js
- **Database**: Neon Postgres (serverless)
- **Storage**: Cloudflare R2 for model and avatar storage.
- **Rate Limiting**: Upstash Redis.
- **LLM**: The agent's brain is powered by the Anthropic (Claude) SDK.

**Smart Contracts**

- **Language**: Solidity 0.8+
- **Framework**: Foundry for compiling, testing, and deploying the ERC-8004 contracts.
- **Standards**: ERC-721, EIP-712, EIP-7710.

### Browser Support

The viewer targets every browser that ships WebGL 2.0 on a desktop or modern mobile device. Concrete support matrix:

| Browser                  | Minimum   | Notes                                                                                                              |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------ |
| Chrome / Edge (Chromium) | 113+      | Full feature set including WebGPU experiments behind a flag. Recommended for development.                          |
| Safari (macOS / iOS)     | 16.4+     | WebGL 2.0, Web Speech recognition (iOS 16.4 added support behind a permission prompt). Voice input requires HTTPS. |
| Firefox                  | 115+      | KTX2 / Meshopt decoders all supported. Web Speech recognition is feature-gated by user-locale.                     |
| Mobile Safari            | iOS 16.4+ | Touch controls and gyroscope mapped through `OrbitControls`.                                                       |
| Android Chrome           | 113+      | Full feature set; AR button surfaces a Scene Viewer intent when present.                                           |

**Capabilities and graceful degradation**

- **WebGL 2.0** is required; the viewer refuses to boot without it and shows a fallback message.
- **WebAssembly** is required for the Draco / KTX2 / Meshopt decoders that ship under [`public/three/draco/`](public/three/draco/), [`public/three/basis/`](public/three/basis/), and `node_modules/three/examples/jsm/libs/`.
- **`getUserMedia` (microphone)** requires HTTPS — see [Common gotchas](#common-gotchas). Without it the agent falls back to text input.
- **`speechSynthesis`** is detected at runtime; agents fall back to silent text replies when TTS is unavailable.
- **WebGPU** is not required and is not used yet — Phase 4 reserves it for client-side inference experiments.

---

## Getting Started

### Prerequisites

- Node.js 24+ (the project pins `"engines.node": "24.x"` in `package.json`; earlier majors are not tested)
- npm 10+
- A Neon Postgres database
- A Cloudflare R2 bucket
- An Anthropic API key

### Installation and Setup

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/nirholas/three.ws.git
    cd three.ws
    ```
2.  **Install dependencies**:
    ```bash
    npm install
    ```
3.  **Set up environment variables**:
    Copy the `.env.example` file to `.env.local` and fill in the required values. See the [Environment Variables](#environment-variables) section for more details.
    ```bash
    cp .env.example .env.local
    ```
4.  **Initialize the database**:
    The schema is idempotent. Run it against your Postgres instance to create all tables:
    ```bash
    psql $DATABASE_URL < api/_lib/schema.sql
    ```
5.  **Run the development server**:
    ```bash
    npm run dev
    ```
    The application will be available at `http://localhost:3000`.

---

## Examples

Copy-paste ready snippets for the most common use cases. Swap in your own GLB URL and go.

### 1. Minimal viewer (no AI)

The simplest possible setup — one script tag, one element, zero build step.

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>3D Viewer</title>
		<style>
			body {
				margin: 0;
				background: #0a0a0a;
				display: flex;
				align-items: center;
				justify-content: center;
				height: 100vh;
			}
			agent-3d {
				width: 400px;
				height: 560px;
				display: block;
			}
		</style>
	</head>
	<body>
		<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>
		<agent-3d body="https://cdn.three.ws/models/sample-avatar.glb"></agent-3d>
	</body>
</html>
```

Drag-to-rotate, scroll-to-zoom, full PBR rendering — no API key, no account required. Swap `body=` for any publicly accessible `.glb` URL.

---

### 2. Talking agent with inline instructions

Add `brain=` and `instructions=` to turn the viewer into a conversational agent.

```html
<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>

<agent-3d
	body="https://cdn.three.ws/models/sample-avatar.glb"
	brain="claude-sonnet-4-6"
	name="Aria"
	instructions="You are Aria, a friendly AI guide. Be warm, concise, and occasionally playful.
                When someone greets you, wave at them. Keep replies to 2–3 sentences."
	mode="inline"
	width="400px"
	height="560px"
></agent-3d>
```

The chat input and mic button appear automatically when `brain` is set. No UI to build.

---

### 3. Floating bubble (support widget style)

Pin the agent to a corner of the page so it persists as users scroll.

```html
<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>

<agent-3d
	body="https://cdn.three.ws/models/sample-avatar.glb"
	brain="claude-sonnet-4-6"
	instructions="You are a helpful product assistant. Answer questions about our features."
	mode="floating"
	position="bottom-right"
	width="320px"
	height="420px"
></agent-3d>
```

`position` accepts `bottom-right`, `bottom-left`, `top-right`, or `top-left`.

---

### 4. Load a registered agent by ID

If you've registered an agent on the platform, load it entirely from its manifest — no inline attributes needed.

```html
<!-- By platform agent ID -->
<agent-3d agent-id="a_abc123def456"></agent-3d>

<!-- By on-chain ERC-8004 ID -->
<agent-3d agent-id="42" chain-id="8453"></agent-3d>
```

The element fetches the manifest (model URL, instructions, skills, memory config) automatically.

---

### 5. Custom chat UI with JavaScript API

Hide the built-in chrome and wire in your own input using the element's JS API.

```html
<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>

<agent-3d
	id="agent"
	body="./avatar.glb"
	brain="claude-sonnet-4-6"
	kiosk
	style="width:400px;height:560px;display:block"
></agent-3d>

<input id="msg" type="text" placeholder="Ask something…" />
<button onclick="send()">Send</button>

<script>
	const agent = document.getElementById('agent');
	const input = document.getElementById('msg');

	async function send() {
		const text = input.value.trim();
		if (!text) return;
		input.value = '';
		await agent.say(text);
	}

	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') send();
	});

	// Auto-greet on load
	agent.addEventListener('agent:ready', () => {
		setTimeout(() => agent.say('Hello! How can I help you today?'), 1200);
	});

	// Listen to replies
	agent.addEventListener('brain:message', (e) => {
		if (e.detail.role === 'assistant') console.log('Agent:', e.detail.content);
	});
</script>
```

**Full JS API:**

| Method                                  | Description                                         |
| --------------------------------------- | --------------------------------------------------- |
| `agent.say(text)`                       | Send a message; agent speaks and animates the reply |
| `agent.ask(text)`                       | Same as `say()`, returns reply text as a string     |
| `agent.wave()`                          | Trigger the wave gesture directly                   |
| `agent.lookAt(target)`                  | `'camera'`, `'model'`, or `'user'`                  |
| `agent.play(clipName)`                  | Play a named animation clip                         |
| `agent.clearConversation()`             | Reset conversation history                          |
| `agent.expressEmotion(trigger, weight)` | Manually inject an emotion blend                    |

**Key events:** `agent:ready`, `brain:message`, `brain:thinking`, `skill:tool-called`, `voice:transcript`

---

### 6. iframe widget (works in Notion, Substack, Webflow)

Use a widget URL directly — no script tag needed.

```html
<iframe
	src="https://three.ws/a/8453/42/embed"
	width="400"
	height="560"
	frameborder="0"
	allow="microphone"
	style="border-radius:16px;"
></iframe>
```

Generate the `src` URL from [Widget Studio](https://three.ws/studio) — pick an avatar, choose a widget type, and copy the snippet.

---

### 7. Agent manifest JSON

For anything beyond a quick one-liner, define the agent in a manifest file and reference it with `manifest=`.

**agent.json:**

```json
{
	"spec": "agent-manifest/0.2",
	"name": "Aria",
	"description": "A friendly AI guide",
	"body": {
		"uri": "./avatar.glb",
		"format": "gltf-binary"
	},
	"brain": {
		"provider": "anthropic",
		"model": "claude-sonnet-4-6",
		"instructions": "You are Aria, a warm and curious AI guide. Wave when greeted.",
		"temperature": 0.8,
		"maxTokens": 1024
	},
	"voice": {
		"tts": { "provider": "browser", "rate": 1.05 },
		"stt": { "provider": "browser", "language": "en-US" }
	},
	"memory": { "mode": "local" },
	"skills": [{ "uri": "https://cdn.three.ws/skills/wave/" }]
}
```

```html
<agent-3d manifest="./agent.json" width="400px" height="560px"></agent-3d>
```

---

### 8. Dead-simple copy-paste widget

For the absolute simplest way to embed an agent, use this snippet. It requires no build tools or imports. Just copy and paste it into your HTML.

```html
<div
	class="threews-widget"
	data-agent-id="YOUR_AGENT_ID"
	data-background="transparent"
	data-nameplate="true"
	style="width: 400px; height: 500px;"
></div>
<script src="https://three.ws/dist/widget.js" defer></script>
```

You can find your agent ID in the agent's settings page. This method is great for quick integrations on platforms like WordPress, Ghost, or any static HTML site. Customize the appearance with `data-background` and `data-nameplate`.

---

## Tutorials

Step-by-step guides in [`docs/tutorials/`](docs/tutorials/):

| Tutorial                                                       | What you'll build                                                    | Time    |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | ------- |
| [Build Your First Agent](docs/tutorials/first-agent.md)        | A talking 3D character on a shareable page, from zero                | ~20 min |
| [Embed on Your Website](docs/tutorials/embed-on-website.md)    | Add an agent to any page — plain HTML, React, Webflow, WordPress     | ~15 min |
| [Write a Custom Skill](docs/tutorials/custom-skill.md)         | A new tool the agent can call (e.g., fetch live weather data)        | ~30 min |
| [Register On-Chain](docs/tutorials/register-onchain.md)        | Mint your agent onchain — ERC-8004 on EVM or Metaplex Core on Solana | ~20 min |
| [Build a Personal AI Site](docs/tutorials/personal-ai-site.md) | A full personal site with an embedded AI version of yourself         | ~45 min |

### Common gotchas

**CORS** — if your GLB is hosted on a different domain, the server must send `Access-Control-Allow-Origin: *`. Without it the fetch is blocked and the canvas stays blank. Uploading via the platform's storage sets this automatically.

**File size** — models over ~50 MB load slowly. Compress with Draco:

```bash
npx gltf-transform draco input.glb output.glb
```

**Voice on HTTPS** — `getUserMedia` (microphone) requires HTTPS. Localhost is exempt; any remote deployment needs TLS. Vercel and Netlify both provide it automatically.

**CSP** — if your page has a strict Content Security Policy, add:

```
script-src 'self' https://three.ws;
```

For sandboxed iframes use the widget embed path instead — it runs in its own browsing context.

---

## Project Structure

- `src/`: The core frontend JavaScript for the main application, including the 3D viewer, agent protocol, custom element, and feature modules (`club-*.js`, `walk*.js`, `pose-*.js`, `voice/`, `selfie-*.js`). Social/gameplay surfaces live in `game/` (Coin Communities + Adventure RPG: `coincommunities*`, `iso-game*`, `game-hud`, `spin-wheel-ui`, `cosmetics-visual`, `avatar-rig`), `city/` (the `/city` world), `social/` (sentiment, X-post impact), `community/` (coin lobby/town), plus `friends.js`, `communities.js`, `marketplace*.js`, and `token-pay.js`.
- `api/`: Vercel serverless functions that form the backend API. Subdirectories include `x402/`, `a2a/`, `club/`, `pump/`, `persona/`, `news/`, `admin/`, `agents/`, `auth/`, `oauth/`, `cron/`, plus the social/game surfaces `play/`, `token/`, `three-token/`, `friends/`, `social/`, `community/`, `marketplace/`, and `mocap/`.
- `public/`: Static assets and various sub-applications (`club/`, `seeker/`, `news/`, `persona/`, `vanity-wallet.html`, `pumpfun.html`).
- `chat/`: A standalone Svelte application for the chat interface.
- `character-studio/`: A sub-project for in-browser character creation; also serves the rebranded **Avatar Studio** marketplace.
- `rider/`: A-Frame WebVR music visualization experiment.
- `contracts/`: Solidity smart contracts for on-chain identity (ERC-8004) and the multichain payment factory.
- `multiplayer/`: Colyseus WebSocket server for `/walk`, `/play` (WalkRoom), and `/game` (GameRoom); deployable on Fly.io. Holds the authoritative game logic and single sources of truth — `items.js`, `quests.js`, `cosmetics.js`, `spin-wheel.js`, `marketplaceStore.js`, `playerStore.js`, `realms.js`, `game-token.js`, `play-pass.js`, `holder-pass.js`, and the per-account `social-hub.js`.
- `sdk/`: `@nirholas/agent-kit` and the Avatar SDK (`sdk/agent-sdk/`).
- `agent-payments-sdk/`: EVM agent payments SDK (Base / BSC / other EVM chains).
- `solana-agent-sdk/`: SDK for Solana blockchain interactions (Metaplex Core mints, SIWS, attestations).
- `pump-fun-skills/`: Skills related to the pump.fun integration.
- `scripts/`: Node.js scripts for development, build, deployment, and pump.fun launch automation.
- `workers/`: Code for background workers — includes the Cloudflare Worker mirror of the pump.fun MCP read API in [`workers/pump-fun-mcp/`](workers/pump-fun-mcp/).
- `docs/`: Public-facing developer docs.
- `docs/internal/`: Working docs (PLAN, STATUS, TODO, NEXT, PROGRESS, RELEASE_CHECKLIST) — not part of the published docs surface.
- `docs/club/`: Pole-club venue design, performance notes, and release checklist.
- `tests/`: Vitest unit tests (`tests/api/`, `tests/src/`, `tests/workers/`) and Playwright end-to-end smokes (`tests/e2e/`).

---

## The Agent System

### Event Bus (Agent Protocol)

`src/agent-protocol.js` implements a lightweight `EventTarget` subclass that is the nervous system of the platform. Every component — avatar, runtime, identity, UI — communicates exclusively through this bus. There are no direct method calls between layers.

The bus maintains a 200-action ring buffer for debugging and replay. Embed variants expose a filtered subset of events through `postMessage` to the host page.

**Core event types:**

| Event                     | Payload                                  | Who emits       | Who listens                               |
| ------------------------- | ---------------------------------------- | --------------- | ----------------------------------------- |
| `speak`                   | `{ text, sentiment: -1..1 }`             | runtime, skills | avatar (emotion), identity (log), chat UI |
| `think`                   | `{ thought }`                            | runtime         | home (timeline), avatar                   |
| `gesture`                 | `{ name, duration }`                     | avatar, skills  | avatar (one-shot clip)                    |
| `emote`                   | `{ trigger, weight: 0..1 }`              | avatar          | avatar (emotion inject)                   |
| `look-at`                 | `{ target: 'user'\|'camera'\|'center' }` | skills          | scene controller                          |
| `perform-skill`           | `{ skill, args, animationHint }`         | runtime         | skill registry                            |
| `skill-done`              | `{ skill, result }`                      | skills          | avatar, identity                          |
| `skill-error`             | `{ skill, error }`                       | skills          | avatar, identity                          |
| `remember`                | `{ type, content, ... }`                 | skills, runtime | memory, identity                          |
| `load-start` / `load-end` | `{ uri, error? }`                        | viewer          | avatar (emotion)                          |
| `validate`                | `{ errors, warnings }`                   | validator       | avatar, identity                          |
| `presence`                | `{ state }`                              | element         | home UI                                   |

Identity-relevant events (`speak`, `remember`, `sign`, `skill-done`, `validate`, `load-end`) are fire-and-forwarded to `POST /api/agent-actions` for durable logging.

### LLM Runtime

`src/runtime/index.js` implements the `Runtime` class, which drives the agent's LLM-powered brain.

**Tool-loop flow:**

1. User message (text or STT transcript) arrives
2. System prompt is assembled: manifest instructions + recalled memory + skill descriptions
3. Claude is called with the conversation history and all available tools
4. Tool calls are dispatched in order — each built-in tool or skill handler receives a rich context object:
    ```js
    {
    	viewer,
    		memory,
    		llm,
    		speak,
    		listen,
    		fetch,
    		loadGLB,
    		loadClip,
    		loadJSON,
    		call,
    		stage,
    		agentId;
    }
    ```
5. Tool results are appended to conversation history as `tool_result` messages
6. Steps 3–5 repeat until Claude returns with no tool calls, or the iteration limit (8) is hit
7. Final text response is optionally spoken via TTS

**Providers** (`src/runtime/providers.js`):

- `AnthropicProvider` — connects to the Anthropic API, supports streaming
- `NullProvider` — no-op for testing and offline mode

**Built-in tools** (`src/runtime/tools.js`):

| Tool            | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `wave`          | Play a wave gesture animation                                     |
| `lookAt`        | Direct the agent's gaze (user, camera, or scene center)           |
| `play_clip`     | Play a named animation clip from the model or animation library   |
| `setExpression` | Set a named morph target weight directly                          |
| `speak`         | Emit text through TTS and the protocol bus                        |
| `remember`      | Write a memory entry (user, feedback, project, or reference type) |

Skills can define additional tools that override or augment the built-ins. The skill registry is loaded from the agent manifest before each conversation turn.

### Empathy Layer

`src/agent-avatar.js` implements the Empathy Layer — a continuous weighted emotion blend that drives the avatar's facial morph targets and head orientation in real time.

Emotions are not a finite-state machine. Each emotion is a float (0..1) that decays linearly per frame at a different rate. Protocol events inject spikes:

| Trigger                      | Emotion              | Spike       |
| ---------------------------- | -------------------- | ----------- |
| `speak` (positive sentiment) | celebration          | +0.7        |
| `speak` (negative sentiment) | concern              | +0.5        |
| `skill-error`                | concern + empathy    | +0.6 / +0.5 |
| `load-start`                 | patience + curiosity | +0.4 / +0.3 |
| `validate` (clean)           | celebration          | +0.5        |
| `validate` (errors)          | concern              | +0.6        |

Decay half-lives (approximate):

- Patience: ~20s — persists during long operations
- Empathy: ~13s — lingers after emotional events
- Concern: ~12s — sustained worry
- Curiosity: ~8s — alert, fades moderately
- Celebration: ~6s — brief, upbeat

The blended emotion mix drives morph target values each frame. For example:

- Celebration → `mouthSmile 0.85`, `mouthOpen 0.2`
- Concern → `mouthFrown 0.55`, `browInnerUp 0.6`
- Empathy → `eyeSquint 0.4`, `browInnerUp 0.5`

Head tilt and lean are also driven by the blend — curiosity tilts the head, patience leans slightly back.

This architecture means the avatar feels responsive and emotionally coherent without any hand-authored animation triggers.

### Skills

Skills are self-contained capability bundles that extend the agent's tool set. Each skill lives in its own directory:

```
skills/wave/
├── SKILL.md        # Human-readable description and usage instructions
├── tools.json      # Tool definitions (name, description, input JSON schema)
└── handlers.js     # Async handler functions (default export)
```

**tools.json example:**

```json
[
	{
		"name": "wave",
		"description": "Plays a waving gesture on the avatar for the specified duration.",
		"inputSchema": {
			"type": "object",
			"properties": {
				"duration_ms": { "type": "integer", "minimum": 500, "maximum": 5000 }
			}
		}
	}
]
```

**handlers.js example:**

```js
export default {
	async wave(args, ctx) {
		const { viewer, speak } = ctx;
		await viewer.playClipByName('wave');
		return { ok: true, output: 'Waved!' };
	},
};
```

Skills are loaded from the agent manifest at runtime. The `SkillRegistry` supports three trust modes:

- `any` — install skills from any source (development only)
- `owned-only` — only skills the agent owner has registered
- `whitelist` — only approved skill URIs

Skills are distributed over IPFS, Arweave, or HTTP. The public skills registry is at `/public/skills-index.json`.

### Memory

`src/memory/index.js` implements a file-based memory system (mirroring this project's own Claude memory system). Memories are Markdown files with YAML frontmatter, organized by type:

```markdown
---
type: user
key: user_role
name: User's Role
created: 2024-01-15T10:30:00Z
salience: 0.95
---

User is a game developer interested in character animation.
```

A `MEMORY.md` index file is auto-maintained. At the start of each conversation turn, the memory store is scanned and high-salience entries are injected into the system prompt.

**Storage modes:**

- `local` — stored in the browser's local storage (default for development)
- `ipfs` — pinned to IPFS via Pinata or Web3.Storage
- `encrypted-ipfs` — encrypted before pinning (user holds the key)
- `none` — stateless, no memory between sessions

Memory types (`user`, `feedback`, `project`, `reference`) follow the same taxonomy used by this codebase's own Claude guidelines.

---

## Web Component & Embedding

The `<agent-3d>` custom element (`src/element.js`) is the primary distribution mechanism. It lazy-boots on intersection (IntersectionObserver), so off-screen agents don't load until visible.

**Basic usage:**

```html
<script src="https://three.ws/agent-3d/latest/agent-3d.js"></script>

<agent-3d
	body="https://example.com/my-avatar.glb"
	brain="https://example.com/manifest.json"
	mode="chat"
></agent-3d>
```

**Key attributes:**

| Attribute          | Type                        | Description                                           |
| ------------------ | --------------------------- | ----------------------------------------------------- |
| `body`             | URL                         | GLB model URL                                         |
| `brain`            | URL                         | Agent manifest JSON URL                               |
| `agent-id`         | string                      | Registered agent ID (resolves manifest automatically) |
| `mode`             | `view` \| `chat` \| `embed` | Interaction mode                                      |
| `eager`            | boolean                     | Load immediately without intersection check           |
| `sandbox`          | boolean                     | Disable network calls (offline mode)                  |
| `width` / `height` | number                      | iframe dimensions when generating embed code          |

The element fires a `postMessage` API for host-page communication (documented in `specs/EMBED_HOST_PROTOCOL.md`). Hosts can send events to the agent and receive `speak`, `think`, and `skill-done` events back.

**Versioned CDN bundles** are published at `/agent-3d/x.y.z/agent-3d.js`. Use `latest` for auto-updates or pin to a version for stability:

```html
<script src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>
```

### Iframe quickstart with the embed SDK

For when you want a chromeless iframe that you control from the parent page (rather than the `<agent-3d>` web component), drop in the embed SDK:

```html
<iframe
	id="agent"
	src="https://three.ws/agent/abc123/embed"
	style="width:480px;height:600px;border:0"
></iframe>
<script src="https://three.ws/embed-sdk.js"></script>
<script>
	const bridge = Agent3D.connect(document.getElementById('agent'), {
		agentId: 'abc123',
		onReady: ({ name }) => console.log('agent ready:', name),
		onAction: (action) => console.log('agent action:', action),
		onError: (err) => console.error('embed error:', err),
	});

	// Drive the agent
	bridge.send({ type: 'speak', payload: { text: 'Hello!' } });
	bridge.ping().then((rttMs) => console.log('rtt', rttMs, 'ms'));
</script>
```

**Origin contract.** The SDK derives the iframe's origin from `iframe.src` and refuses to start if it can't (no wildcard targets, ever). The iframe locks onto the parent's origin from the first authenticated message it sees and ignores any later messages from a different origin. See [specs/EMBED_SPEC.md](specs/EMBED_SPEC.md) §"Bridge origin model" for the full rules.

### Typed host bridge (npm-friendly)

For TypeScript/bundler workflows, import `EmbedHostBridge` directly:

```js
import { EmbedHostBridge } from 'three-ws/embed-host-bridge';

const iframe = document.getElementById('agent');
const bridge = new EmbedHostBridge({
	iframe,
	agentId: 'abc123',
	allowedOrigin: new URL(iframe.src).origin, // required, never '*'
});

await bridge.ready;
await bridge.speak('Hello world');
const off = bridge.on('action', (a) => console.log(a));

// Clean up when done.
off();
bridge.destroy();
```

Both surfaces speak the same v1 wire protocol — pick the one that fits your stack.

---

## Widget System

The Widget Studio (`/studio`) lets anyone build a shareable, embeddable 3D experience without writing code. Pick an avatar, pick a widget type, configure it, and get an iframe snippet.

**Five widget types:**

| Widget                | Description                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------ |
| **Turntable**         | Auto-rotating model showcase with configurable background, lighting, and camera            |
| **Animation Gallery** | Paginated grid of named clips; click any to play it on the model                           |
| **Talking Agent**     | Full chat interface with the LLM brain; embed a conversational agent anywhere              |
| **ERC-8004 Passport** | On-chain identity card — shows agent name, owner, reputation score, and verification badge |
| **Hotspot Tour**      | 3D hotspots pinned to world-space coordinates; click to reveal text annotations            |

Each widget has:

- A public URL at `/w/<id>` with server-rendered Open Graph metadata for rich link previews
- An oEmbed endpoint at `/api/widgets/oembed` for WordPress, Ghost, Notion embedding
- An iframe embed URL at `/api/widgets/<id>/view`
- A view counter tracked at `/api/widgets/<id>/stats`
- A duplicate API at `/api/widgets/<id>/duplicate`

Widgets are stored as JSON config in Postgres, pointing at an avatar in R2.

---

## Embed Editor

The **Embed Editor** at `/embed-editor` is a WYSIWYG configurator for the `<agent-3d>` element. Pick an avatar from a modal grid with lazy-loaded 3D thumbnails, choose an animation from the dock, frame the camera with face-camera mode, set a background (transparent, glow, solid), and copy a ready-to-paste snippet.

| Feature            | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| **Avatar picker**  | Modal with lazy 3D thumbnails — no full page rerender on selection              |
| **Animation dock** | All clips visible at once; click to preview live on the model                   |
| **Kiosk default**  | Chrome-free preview surface — what you see is what gets embedded                |
| **Face-camera**    | One-click camera framing aligned to the avatar's face                           |
| **Lock toggle**    | Freezes the wrap and avatar motion so you can author screenshots / video        |
| **Device frame**   | Preview the embed inside phone / tablet / desktop chrome                        |
| **Backdrop glow**  | Optional radial glow behind the avatar (opt-in, off by default)                 |
| **Snippet UX**     | One-click copy of `<agent-3d>` HTML or the iframe URL — versioned CDN reference |

The editor produces video-ready output for marketing assets and a copy-paste snippet for production use. Built as a single Vite-compiled bundle, no separate framework runtime.

---

## Pose Studio

`/pose-studio` is a 3D pose-reference tool inspired by setpose.com. It builds a Three.js scene with an articulated mannequin, orbit camera, ground + grid, and a control panel that lets you pick presets, drag joints to pose them, fine-tune with sliders, swap body type, add floor props, change lighting and FOV, and export a PNG screenshot.

| Module         | Path                                           | Role                                        |
| -------------- | ---------------------------------------------- | ------------------------------------------- |
| Mannequin      | [src/pose-mannequin.js](src/pose-mannequin.js) | Articulated rig with named joints + IK      |
| Preset library | [src/pose-presets.js](src/pose-presets.js)     | Standing, sitting, action, idle, expressive |
| Studio shell   | [src/pose-studio.js](src/pose-studio.js)       | Scene, controls, export, props, lighting    |

Poses author cleanly into the avatar runtime via the `play_clip` tool — the agent can adopt any saved pose on demand. Exported PNGs are useful as marketing renders or as reference frames for downstream image/video pipelines.

---

## Launchpad

The **Launchpad** at `/launchpad` is a hosted-page builder for token launches, agent debuts, and drop campaigns. Each published page lives at a public URL like `/p/<slug>` with full Open Graph metadata for sharing.

| Surface     | Path                      | Purpose                                                              |
| ----------- | ------------------------- | -------------------------------------------------------------------- |
| Studio      | `/launchpad`              | Authoring UI — pick a template, configure copy, avatar, mint targets |
| Public page | `/p/[slug]`               | Hosted landing page rendered server-side with OG card                |
| Publish API | `POST /api/launchpad/...` | Versioned publish + revert for the page bundle                       |

Launchpad templates are JSON-configured and can embed any combination of `<agent-3d>` widget, x402 paid endpoint, or pump.fun launch button. Pages are stored in Postgres and served as static HTML with hydration for interactive elements.

---

## The Club

`/club` is a multiplayer 3D venue — a pole-club scene with rigged dancers, audio tracks, spotlights, mirror-ball cube cam, and on-chain tips.

**Stack:**

- Venue GLB + HDRI lit by four spotlights; bloom + chromatic aberration on the high tier
- Audio tracks streamed from R2 with synchronized playback across clients
- Camera state machine — DJ booth, overhead, dance-floor, follow-cam — sequenced per track
- Performance profile detector picks `high` / `medium` / `low` from `navigator.deviceMemory`, `hardwareConcurrency`, `pointer: coarse`, and the UA string
- Frame-budget watchdog auto-downgrades the profile if sustained slow frames are detected

**Economics:**

- Tips API at `/api/club/tips` — viewers tip dancers in USDC via x402 (CDP-settled, Permit2-gasless sibling available)
- Leaderboard at `/api/club/leaderboard` with windowed top-tipper rankings
- Hourly payouts cron sweeps the tips ledger into the dancers' treasury wallets

**Detail:** see [docs/club/PERF_NOTES.md](docs/club/PERF_NOTES.md), [docs/club/PLAN.md](docs/club/PLAN.md), and [docs/club/RELEASE_CHECKLIST.md](docs/club/RELEASE_CHECKLIST.md).

---

## Walk & Multiplayer

`/walk` is an authoritative multiplayer walk scene. Players join a shared 3D space, see each other's avatars in real time, and emit gestures over a WebSocket connection.

Vercel doesn't host long-lived WebSockets, so the multiplayer server lives in its own workspace at [`multiplayer/`](multiplayer/) — a [Colyseus](https://colyseus.io) server packaged with a Fly.io `fly.toml` and Dockerfile. The Vite client at `/walk` autodiscovers the server (`ws://localhost:2567` in dev, your deployed host in prod).

```bash
# Run both servers together
npm run dev:walk-all     # Vite (:3000) + Colyseus (:2567)
```

**WalkRoom** (`multiplayer/src/rooms/WalkRoom.js`) is the authoritative state container — position, rotation, gesture, presence. Origin allow-listing is enforced at the WS upgrade (`ALLOWED_ORIGINS` env, with `*.vercel.app` and `*.three.ws` always permitted for preview deploys). The same Colyseus server now hosts a second authoritative room — **GameRoom** (the Adventure RPG, see below) — alongside WalkRoom, plus a per-account **social hub** (`multiplayer/src/social-hub.js`) for presence and live event delivery.

---

## Coin Communities

Every Solana token gets a **live 3D world**. Coin Communities turns a mint address into a shared multiplayer space: pick the same coin as someone else and you land together, walk around, emote, voice-chat, build with voxels, and watch the live market-cap chart on an in-world screen.

| Surface           | Route                       | What it does                                                                                        |
| ----------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| Lobby             | `/communities`, `/worlds`   | Browse real pump.fun trending coins + search, pick an avatar, drop into a world                     |
| Coin profile      | `/communities/[mint]`       | Deep-linkable coin page — metadata, bonding-curve price, graduation progress, recent trades         |
| 3D world          | `/play`                     | The shared coin-keyed world — peer avatars, name labels, chat, emotes, voxel building, market screen |

**How it works**

- **Real pump.fun data, no mocks.** The lobby and coin profiles pull live trending coins, search results, bonding-curve pricing, and recent trades from the pump.fun feed.
- **Bring any avatar.** Use a default, an uploaded GLB/VRM, or paste a model URL. The same rig (`src/game/avatar-rig.js`) drives `/play` and `/game` with no drift.
- **Realtime presence + chat.** Each coin is its own room. Town chat is backed by the [CoinCommunities](https://coin-communities.xyz) service — reads work out of the box; posting unlocks behind X-OAuth sign-in + a linked wallet. If `CC_API_KEY` is unset, chat renders its designed locked state.
- **Voxel building & spatial voice.** Collaborative block placement (server-capped) and optional geofenced WebRTC voice (`src/game/voice-chat.js`).
- **Holder-gated rooms.** A coin can require token holders (tier `holders` vs general); gating is enforced server-side via a sealed play-pass.

**Key files:** `src/communities.js` (lobby), `src/game/coincommunities.js` + `coincommunities-ui.js` (3D scene + HUD), `src/game/community-net.js` (socket bridge), `api/community/*` (worlds, messages, ws-ticket, capabilities, me), `api/_lib/coin-communities.js` (CoinCommunities SDK client).

---

## Adventure — Onchain RPG

`/game` is an authoritative multiplayer RPG. It's a tile-stepped isometric world with trainable skills, gathering, combat, banking, quests, cosmetics, a player-to-player marketplace, and onchain payments — all validated server-side so nothing can be spoofed by the client.

**Core loop**

| System         | What it is                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Skills**     | Five trainable skills (combat, woodcutting, mining, fishing, cooking), level 1–99, XP-gated                            |
| **Gathering**  | Resource nodes (trees, rocks, coal, fishing spots) worked with the right tool; server-authoritative loot rolls         |
| **Inventory**  | 6-slot hotbar, 24-slot backpack, 48-slot account bank; stackable resources, non-stackable tools                        |
| **Combat & death** | Mobs drop trophies; in danger realms death drops a lootable tombstone (TTL), safe realms preserve inventory        |
| **Cooking**    | Raw fish → cooked food at a roast pit; heal value scales with cooking level                                            |
| **Mounts**     | Rare drops (dire wolf, war boar) — non-stackable, rideable for faster travel                                           |
| **Realms**     | Multi-realm world (Mainland, Wilderness, Whisperwood, Pond, Mine, Arena…), each a 48×48 grid with portals and stat gates |
| **Quests**     | An 8-step tutorial + 3 deterministic daily quests per UTC day, with gold/XP/item/badge rewards                         |

**Wallet-first entry (play-gate).** There's no password. `GET /api/play/nonce` issues a nonce + gate config; `POST /api/play/verify` checks the wallet signature and on-chain token balance, then mints a short-lived HMAC-sealed **play-pass** the game server trusts without re-querying the RPC. Gating is configured via `PLAY_GATE_MINT` / `PLAY_GATE_MIN` and `HOLDER_PASS_SECRET`.

**Server-authoritative.** `multiplayer/src/rooms/GameRoom.js` owns all state; `multiplayer/src/` holds the single sources of truth — `items.js` (item registry, loot tables, mount stats), `quests.js` (tutorial + daily pool + badges), `cosmetics.js` (shop catalog + rotation), `spin-wheel.js`, `marketplaceStore.js`, `playerStore.js`, and `realms.js`/`realm-transfer.js` (layouts, portals, signed stat-gated transfers).

**Client:** `src/game/iso-game.js` (scene), `iso-controls.js` + `keybindings.js` (input), `game-hud.js` (hotbar, skills, quests, bank, shop, marketplace panels), `game-net.js` (socket bridge), `spin-wheel-ui.js`, `cosmetics-visual.js`.

---

## City

`/city` is a free-roam 3D city scene — a walkable urban world with a follow camera, map, and player controller, built on the same Three.js stack as the rest of the platform.

**Key files:** `src/city/city-world.js` (scene + render loop), `city-map.js` (layout), `city-player.js` (movement/controller), `city-camera.js` (follow cam), `city.css`.

---

## Friends, Presence & Social

A full account-level social layer spans the multiplayer surfaces. Friendships are durable; presence is volatile — and both are keyed to the account, not the ephemeral session, so they survive reconnects and realm changes.

| Capability     | Backed by                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| **Friends graph** | `POST /api/friends` (request, accept, decline, remove, mute, unmute), `GET /api/friends` (graph + live presence) |
| **User search** | `GET /api/friends/search?q=` — find accounts by display name, relationship status inline                       |
| **Direct messages** | `GET`/`POST /api/friends/messages` — DM threads, live delivery when online + durable queue for offline       |
| **Presence**   | Short-lived signed ticket (`GET /api/friends/presence-ticket`) → multiplayer server writes `presence:<uid>` to Redis (75s TTL, 30s heartbeat) |
| **Live delivery** | The social hub (`multiplayer/src/social-hub.js`) pushes DM + friend events to every open socket for an account |

Friends are stored in Postgres (`friendships`, `direct_messages`, `user_mutes` — see migration `api/_lib/migrations/2026-06-01-friends.sql`); presence lives in Upstash Redis and self-heals if a process dies. Muting is send-side only — a muted account is never told it was muted. The friends panel UI (`src/friends.js`, `src/game/friends-panel.js`) surfaces requests, DM threads, and "Online · Mainland" / "Offline" status inside `/play` and `/game`. The `src/social/` module adds sentiment + X-post-impact scoring used by community surfaces.

---

## In-Game Economy

The game runs on two currencies and a real onchain settlement path.

**Gold (soft currency)** — earned from quests, gathering, and combat; spent in the cosmetics shop and the player marketplace. Used for fee-free trades.

**$THREE (onchain, Solana)** — an SPL token with a server-authoritative **quote → sign → settle** flow (`api/token/*`, `src/token-pay.js`, `api/_lib/token/`). The server issues a purpose-scoped, HMAC-sealed quote (`spin`, `marketplace_sale`); the client signs an atomic split transaction; the server verifies it on-chain (destination + amount + memo) before crediting. Live USD pricing comes from Jupiter (primary, pump.fun-aware) with a Birdeye fallback. The **$THREE protocol** layer (`api/three-token/*`) tracks holder revenue-share, a deploy-to-burn ledger, and an activity feed. Game-server config: `GAME_TOKEN_MINT`, `GAME_TOKEN_TREASURY`, `GAME_TOKEN_BURN`, `GAME_TOKEN_SECRET`.

| Sink            | Detail                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| **Cosmetics shop** | ~15-item catalog across five rarity tiers; daily (3) + weekly (2) rotations are seeded and deterministic per UTC day. Cosmetics are visual only — tints, props (`.glb` accessories at head/face anchors), and auras. High-price buys gate behind a two-click confirm. |
| **Player marketplace** | Peer-to-peer listing board (`multiplayer/src/marketplaceStore.js`). List items or gold; settle in gold (fee-free) or $THREE (95% seller / 5% treasury). Offline sellers receive pending payouts on next login; Redis-persisted across restarts. |
| **Spin wheel**  | A Mainland wheel — one free spin every 12h or a paid spin in $THREE. The outcome is rolled and sealed server-side before the client animates, so the wheel can't be gamed. |

The separate **agent/avatar marketplace** at `/marketplace` (discovery, fork, bookmark, Solana-Pay asset purchase, skill pricing) is documented under [API Reference](#api-reference); the in-game economy above is distinct and lives in the Colyseus rooms.

---

## Voice Lab & Mocap Studio

Two creator tools sit alongside [Pose Studio](#pose-studio):

- **Voice Lab** (`/voice`, `src/voice-lab.js`) — audition and bind voices to an agent, building on the [Voice & Persona Hub](#voice--persona-hub-phase-2).
- **Mocap Studio** (`/mocap-studio`, `src/mocap-studio.js`, `api/mocap/`) — capture and retarget motion onto a rigged avatar, exporting reusable animation clips.

---

## x402 Payments

three.ws is a first-class [x402](https://x402.org) host. Agents can both **pay for** and **expose** paid endpoints. Settlement runs on Base, BSC, and Solana; the bazaar at `/x402` is the discovery surface.

### Payment rails

| Chain               | Settlement                     | Permit2 sibling     | Status |
| ------------------- | ------------------------------ | ------------------- | ------ |
| **Base mainnet**    | Coinbase CDP facilitator       | Gasless via relayer | Live   |
| **Base sepolia**    | CDP facilitator                | Yes                 | Live   |
| **BSC**             | Direct-scheme (no facilitator) | —                   | Live   |
| **Solana (devnet)** | x402-solana direct             | —                   | Live   |

Every CDP-settled endpoint ships a Permit2 sibling that accepts an EIP-2612 permit instead of an upfront approval — the buyer signs once, and the relayer pays gas. Wire-level checks live in `tests/e2e/` and exercise the buyer/seller flow end-to-end.

### Paid endpoints

| Route                                    | What you get                                  |
| ---------------------------------------- | --------------------------------------------- |
| `POST /api/x402/mint-to-mesh`            | Mint an avatar's mesh as an NFT               |
| `POST /api/x402/mint-to-mesh-batch`      | Batch mint up to N meshes                     |
| `POST /api/x402/dance-tip`               | Tip a club dancer in USDC                     |
| `POST /api/x402/model-check`             | Run Khronos glTF validation as a paid service |
| `POST /api/x402/pump-agent-audit`        | Audit a pump.fun token's creator history      |
| `POST /api/x402/agent-reputation`        | Compute on-chain reputation snapshot          |
| `POST /api/x402/onchain-identity-verify` | Verify ERC-8004 identity for a wallet         |
| `POST /api/x402/symbol-availability`     | Check token symbol availability across chains |
| `POST /api/x402/skill-marketplace`       | Paid skill marketplace listing                |
| `POST /api/x402/asset-download`          | Pay-per-download for gated R2 assets          |
| `POST /api/x402/did`                     | DID resolution as a service                   |
| `GET /api/x402/my-receipts`              | Buyer-side receipts ledger                    |

### Bazaar, SKUs, and subscriptions

| Surface       | Path                              | Purpose                                     |
| ------------- | --------------------------------- | ------------------------------------------- |
| Bazaar        | `/x402`                           | Browsable marketplace of paid endpoints     |
| Discovery     | `/x402-discover`                  | Search by tag, price, chain                 |
| Checkout      | `/x402-pay`, `/api/x402-checkout` | Stripe-style one-shot purchase              |
| SKU catalog   | `/api/x402-skus`                  | Server-defined SKUs with per-row pricing    |
| Dashboard     | `/dashboard/x402`                 | Seller + buyer dashboard, receipts, payouts |
| Subscriptions | `/api/x402/subscriptions`         | Recurring x402 charges on cron              |
| Status        | `/api/x402-status`                | Health and chain reachability checks        |

### How to expose a paid endpoint

```js
import { paidEndpoint } from './_lib/x402-paid-endpoint.js';

export default paidEndpoint({
	price: '0.10', // USDC
	chain: 'base', // base | bsc | solana
	network: 'mainnet',
	resource: 'https://three.ws/api/your-endpoint',
	description: 'What the buyer is paying for',
	handler: async (req, res, { payer }) => {
		// payer is verified — settle the request
		res.json({ ok: true, payer });
	},
});
```

The helper handles the 402 challenge, Permit2 sibling, receipt write-back, idempotency-token enforcement, and CSRF/SSRF guards. See [api/\_lib/x402-paid-endpoint.js](api/_lib/x402-paid-endpoint.js).

### Wire checks

- Wire-level CORS, CDP, and Permit2 sibling checks: `tests/e2e/`
- Offer receipts schema + buyer fetch: [api/\_lib/x402-buyer-fetch.js](api/_lib/x402-buyer-fetch.js)
- Error envelope: full 402 body returned in the `PAYMENT-REQUIRED` header

---

## A2A — Agent-to-Agent Protocol

Agents transact with each other directly through an A2A bridge that sits on top of the MCP server and x402 payments.

| Surface         | Path                 | Purpose                                                  |
| --------------- | -------------------- | -------------------------------------------------------- |
| A2A client      | `sdk/a2a/`           | Outbound calls — pay another agent, settle the response  |
| A2A server      | `api/a2a/`           | Inbound paid tools, exposed via MCP bridge               |
| MCP bridge      | `api/mcp.js`         | Wraps paid tools as MCP `tools/call` with auto-402 retry |
| Spending ledger | `api/a2a/spending`   | Per-agent spend caps and authorization gates             |
| Receipts store  | `api/a2a/receipts`   | Signed receipts written on every paid call               |
| DID resolution  | `POST /api/x402/did` | Resolve a counterparty DID to wallet + endpoints         |

**SIWX (Sign-In with X-chain)** brokers cross-chain identity for paid sessions: an agent on Base proves ownership of a Solana wallet (or vice versa) to unlock chain-specific paid endpoints.

---

## Talk Mode & Lip-Sync

The `talk` interaction mode wires together the LLM runtime, ElevenLabs TTS, and an **audio-driven ARKit-52 lip-sync driver** that maps live audio amplitude + formant analysis onto the 52 standard ARKit blendshapes.

When the agent speaks, the driver runs at ~60fps and drives `mouthClose`, `jawOpen`, `mouthSmileLeft/Right`, and the rest of the ARKit-52 set — the Empathy Layer's emotional morphs continue to blend on top, so the avatar simultaneously emotes and articulates. Unit tests for the ARKit-52 mapping live in `tests/src/arkit-morphs.test.js`.

---

## Solana Mobile (Seeker)

three.ws ships with Mobile Wallet Adapter (MWA) wired into the web app and a release pipeline for the Solana Mobile dApp Store.

- MWA detection prefers seed-vault-backed signing on Seeker / Saga devices, falls back to WalletConnect elsewhere
- dApp Store listing assets, icons, and staging copy live under `public/seeker/`
- Release pipeline scripts handle build → sign → submit for the dApp Store update
- On Seeker hardware, users sign x402 payments and Solana agent registrations (Metaplex Core mints, attestations) from the seed vault — no browser extension required

---

## Selfie Reconstruction Pipeline (Phase 1)

Anyone takes 3 selfies (left, center, right) and receives a rigged, animatable 3D avatar in under a minute. The pipeline ships native — no third-party black box.

| Module        | Path                                             | Role                                                                                                                 |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Capture UX    | [src/selfie-capture.js](src/selfie-capture.js)   | Mobile-first 3-shot capture with real-time quality gates (lighting, framing, blur)                                   |
| Pipeline      | [src/selfie-pipeline.js](src/selfie-pipeline.js) | Multi-view fit → FLAME / 3DMM face → base body mesh → rigged GLB                                                     |
| Sandbox route | `/creating`                                      | Isolated reconstruction test bench, decoupled from the main flow                                                     |
| Output        | Cloudflare R2                                    | Meshopt-compressed GLB pinned to IPFS and minted as a draft agent token — ERC-8004 on EVM or Metaplex Core on Solana |

Reconstruction inference runs against the same Anthropic-token-billed Vercel function pool as the agent runtime, with optional offload to the **Livepeer Inference Network** (see below) for GPU-heavy steps.

---

## Livepeer Inference Network (Phase 4)

three.ws is wiring the **Livepeer** decentralized GPU network as an alternative inference backend for avatar reconstruction and agent conversations.

- Open protocol: model weights, GPU runtime, signed responses
- Onchain settlement: pay-per-token with cryptographic receipts, mediated by the same x402 rails described above
- Node operator client (Docker + GPU drivers) with onchain registration
- Federation with existing decentralized compute networks where appropriate

The Livepeer dependency landed early so the Phase 1 selfie pipeline can switch its heaviest step (multi-view face fitting) onto external GPU nodes without touching the rest of the system. The goal: ≥50% of production agent traffic served by independent node operators with latency parity to centralized inference.

---

## Voice & Persona Hub (Phase 2)

The avatar isn't just _you_ — the agent _acts_ like you. The Voice & Persona Hub captures the inputs that turn a body into a personality.

| Surface             | Path                                                                 | Purpose                                                          |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Persona extraction  | [api/persona/extract.js](api/persona/extract.js)                     | Short onboarding interview → tone, vocabulary, interests profile |
| Persona preview     | [api/persona/preview.js](api/persona/preview.js)                     | Try the extracted persona against test prompts before saving     |
| Persona keys        | `scripts/generate-persona-key.mjs`                                   | Per-agent signing key + persona SSO setup                        |
| Voice clone modal   | [src/voice/voice-clone-modal.js](src/voice/voice-clone-modal.js)     | 3–10s recording → ElevenLabs custom voice bound to the agent     |
| Talk controller     | [src/voice/talk-controller.js](src/voice/talk-controller.js)         | Push-to-talk and continuous talk modes                           |
| ARKit blendshapes   | [src/voice/arkit-blendshapes.js](src/voice/arkit-blendshapes.js)     | Standard ARKit-52 morph table                                    |
| Lip-sync driver     | [src/voice/lipsync-driver.js](src/voice/lipsync-driver.js)           | Web Audio analyser → blendshape weights per frame                |
| Avatar morph target | [src/voice/avatar-morph-target.js](src/voice/avatar-morph-target.js) | Per-rig binding of ARKit blendshapes to the loaded GLB           |
| Avatar snapshot     | [src/voice/avatar-snapshot.js](src/voice/avatar-snapshot.js)         | Render-time pose capture for thumbnails and OG cards             |
| Persona docs        | [docs/persona-hub.md](docs/persona-hub.md)                           | Full design + onboarding flow                                    |

Memory seed extensions (X, GitHub, Farcaster) feed the agent's memory store at creation time with explicit user consent — see [docs/persona-hub.md](docs/persona-hub.md).

The per-agent fine-tuned system prompt is stored in the manifest, signed, and pinned to IPFS — the persona becomes a verifiable part of the agent's onchain identity.

---

## WASM Vanity Grinder

`/vanity-wallet` is a browser-based vanity-address grinder compiled to WebAssembly. Generate **EVM addresses** with a prefix (`0xBEEF…`) or pattern, or **Solana addresses** (base58 prefix / suffix, e.g. `…pump`) in seconds, fully client-side, without leaking the private key to any server.

| Module         | Path                            | Role                                                   |
| -------------- | ------------------------------- | ------------------------------------------------------ |
| WASM grinder   | `public/vanity-wallet.html`     | Multi-threaded secp256k1 keygen via WebWorkers         |
| Solana variant | `scripts/pump-vanity-grind.mjs` | Server-side grinder for pump.fun mint vanity addresses |

Common use cases on the platform: branded agent wallet addresses (e.g. an agent named `agent.eth` getting an address starting with `0xA6EF…`), or pump.fun token mint vanity (e.g. ending in `pump`).

The Solana grinder backs the platform's pump.fun launches — the inaugural USDC token launches use a vanity mint pre-grind to produce shareable token addresses.

---

## News CMS & Syndication

A local-only news/blog CMS at `/admin/news` produces signed posts that auto-syndicate to multiple destinations.

| Surface        | Path                                                       | Purpose                                             |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| CMS            | `/admin/news`                                              | Local-only editor — drafts, images, scheduled posts |
| Public listing | `/news`                                                    | Cover-image grid with permalinks                    |
| Article        | `/news/<slug>`                                             | Server-rendered article with OG card                |
| RSS / Atom     | `/api/news/rss`                                            | Standards-compliant feed for HackerNoon auto-import |
| WebSub hub     | `/api/news/websub`                                         | Push notifications to subscribed hubs on publish    |
| Dev.to         | syndication adapter                                        | Cross-posts with canonical URL pointing back        |
| Medium         | syndication adapter                                        | Same, with format-aware re-render                   |
| CMC handoff    | syndication adapter                                        | Coinmarketcap article + announcement listing        |
| Newsletter     | [api/newsletter-subscribe.js](api/newsletter-subscribe.js) | Resend-backed double-opt-in newsletter              |

Each article is a static HTML file in `public/news/` with metadata in Postgres. The CMS supports a cover-image convention for listing thumbnails and OG previews. Articles can be published once and reach HackerNoon, Dev.to, and Medium readers without manual cross-posting.

---

## Security Hardening

The platform has been hardened against the OWASP top-10 plus a set of issues specific to agent payments and cross-chain identity.

| Control                   | Where                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **SSRF guard**            | All outbound `fetch()` from agent runtime + skills goes through an SSRF allow-list filter (`api/_lib/safe-fetch.js`)                     |
| **CSRF gates**            | State-changing endpoints require an Origin + Sec-Fetch-Site check; bearer-only paths exempt                                              |
| **Header-origin pinning** | The iframe bridge locks onto the parent's origin from the first authenticated message and ignores later messages from a different origin |
| **Fail-closed crons**     | Cron endpoints fail closed if their auth token is missing — no silent skips                                                              |
| **Idempotency tokens**    | x402 paid endpoints require an idempotency key to prevent double-charge on retry                                                         |
| **Embed policy**          | Per-agent iframe origin allow-list (`/api/agents/:id/embed-policy`) gates the chromeless embed                                           |
| **Rate limiting**         | Upstash Redis per-user + per-API-key + per-IP buckets at every public endpoint                                                           |
| **JWT key rotation**      | `JWT_KID` lets you rotate signing keys without invalidating in-flight sessions                                                           |
| **Bcrypt cost**           | Tunable via `PASSWORD_ROUNDS` (default 11)                                                                                               |
| **Audit signing**         | Every agent action is signed with the delegated signer key and chained into a per-agent action log                                       |

---

## Developer SDKs

Three npm-publishable SDKs ship from this repo. They share types and helpers but target different surfaces.

| SDK                                | Path                                       | What it does                                                                                      |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **`@nirholas/agent-kit`**          | [sdk/](sdk/)                               | One-line agent embed for any site — chat panel, voice I/O, ERC-8004 register, Solana attestations |
| **`@pump-fun/agent-payments-sdk`** | [agent-payments-sdk/](agent-payments-sdk/) | EVM agent payments — wallet, signing, EIP-7710 delegation                                         |
| **`solana-agent-sdk`**             | [solana-agent-sdk/](solana-agent-sdk/)     | Solana-native agent ops — Metaplex Core mints, SIWS, attestations, transfer hooks                 |
| **Avatar SDK**                     | [sdk/agent-sdk/](sdk/agent-sdk/)           | Avatar load + manipulation helpers — pose, animation, snapshot                                    |

**`@nirholas/agent-kit` quickstart:**

```js
import { AgentKit, loadAvatar } from '@nirholas/agent-kit';
import '@nirholas/agent-kit/styles';

const agent = new AgentKit({
	name: 'My Agent',
	description: 'Does cool stuff',
	endpoint: 'https://myapp.com',
	onMessage: async (text) => `You said: ${text}`,
});
agent.mount(document.body);

// Drop a three.ws agent's avatar onto the page
loadAvatar('a_abc123', document.getElementById('avatar-slot'));
```

The agent-kit also exposes `attestFeedback`, `attestValidation`, and `listAttestations` for Solana reputation flows. See [sdk/README.md](sdk/README.md).

---

## Claude Code Integration

three.ws ships as a first-class Claude Code SDK. There are two ways to integrate — pick one or use both:

### 1. MCP server (paid tools via `npx`)

Add the `@3d-agent/mcp-server` to your Claude Desktop, Cursor, or Claude Code config in one step:

```json
{
	"mcpServers": {
		"3d-agent": {
			"command": "npx",
			"args": ["-y", "@3d-agent/mcp-server"],
			"env": {
				"MCP_EVM_PAYMENT_ADDRESS": "0xYourBaseWallet",
				"MCP_SVM_PAYMENT_ADDRESS": "YourSolanaWallet"
			}
		}
	}
}
```

| Config file location                                              | Platform                     |
| ----------------------------------------------------------------- | ---------------------------- |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | macOS Claude Desktop         |
| `%APPDATA%\Claude\claude_desktop_config.json`                     | Windows Claude Desktop       |
| `.mcp.json` in your project root                                  | Claude Code (project-scoped) |
| `~/.cursor/mcp.json`                                              | Cursor                       |

Once configured, Claude can call these tools directly in conversation — no API key required, each call is settled in USDC via x402:

| Tool               | Price       | What it does                                                                              |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------- |
| `get_pose_seed`    | $0.001      | Pose map for a three.ws avatar from a plain-text prompt                                   |
| `pump_snapshot`    | $0.005      | Live pump.fun token snapshot — price, volume, holders, trust signals                      |
| `agent_reputation` | $0.01       | Agent reputation — ERC-8004 ReputationRegistry on EVM, attestation-memo roll-up on Solana |
| `vanity_grinder`   | up to $0.50 | Mine a Solana keypair with a custom address prefix                                        |

See [`mcp-server/README.md`](mcp-server/README.md) for full environment variable reference and programmatic client usage.

### 2. Slash commands (`.claude/commands/`)

This repo ships three Claude Code slash commands that work in any project referencing this repo:

| Command                  | What it does                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/setup-mcp`             | Detects your OS, collects wallet addresses, and writes the MCP config to the right file — end-to-end, no manual JSON editing              |
| `/scaffold-agent`        | Scaffolds a new three.ws agent in your project: installs dependencies, creates `agent.js` with MCP client wiring, and adds `.env.example` |
| `/use-tools [tool_name]` | Produces a complete, runnable Node.js script for calling a specific paid MCP tool with automatic x402 payment handling                    |

Commands live in [`.claude/commands/`](.claude/commands/) and are picked up automatically by Claude Code when you open this repo.

---

## Demos Hub

`/demos` is a curated index of sandbox pages that exercise individual platform capabilities in isolation. Each demo is a single HTML file in [`public/demos/`](public/demos/) — perfect for screen recordings, bug reproductions, or showing off one feature without the rest of the app.

| Demo                                | Path                             | What it shows                                            |
| ----------------------------------- | -------------------------------- | -------------------------------------------------------- |
| **USDZ & AR Quick Look**            | `/demos/usdz-ar.html`            | iOS USDZ export + AR Quick Look on a real device         |
| **Half-body XR**                    | `/demos/halfbody-xr.html`        | Upper-body avatar in WebXR (Meta Quest, Vision Pro)      |
| **Avatar SDK**                      | `/demos/avatar-sdk.html`         | `@three-ws/avatar` SDK loading + animating an avatar     |
| **React SDK**                       | `/demos/react-sdk.html`          | React wrapper around the `<agent-3d>` element            |
| **Audio-driven lipsync (mic)**      | `/lipsync/mic`                   | Live microphone → ARKit-52 lip-sync                      |
| **Audio-driven lipsync (TTS)**      | `/lipsync`                       | ElevenLabs TTS → ARKit-52 lip-sync                       |
| **Multi-LLM brain**                 | `/brain`                         | Side-by-side comparison of Claude / GPT / Groq / Gemini  |
| **ERC-8004 registry browser**       | `/demos/erc8004.html`            | Browse all registered agents across chains               |
| **Button jump**                     | `/demos/button-jump.html`        | Avatar reacts to a 2D button press                       |
| **Tactile button (Gemini concept)** | `/demos/gemini-jump.html`        | Tactile button demo with avatar                          |
| **Create v2**                       | `/demos/create-v2.html`          | Next-generation agent creation flow                      |
| **3D home**                         | `/demos/3d-home.html`            | Home page with overlay canvas + transparent-bg viewer    |
| **Selfie fit**                      | `/demos/selfie-fit.html`         | Selfie reconstruction pipeline (Phase 1)                 |
| **Persona extract**                 | `/demos/persona-extract.html`    | Voice & Persona Hub onboarding interview                 |
| **Memory seed**                     | `/demos/memory-seed.html`        | Memory seeding from X/GitHub/Farcaster                   |
| **Voice clone**                     | `/demos/voice-clone.html`        | 3–10s recording → ElevenLabs custom voice                |
| **Livepeer inference**              | `/demos/livepeer-inference.html` | Decentralized GPU inference end-to-end                   |
| **Skill royalty**                   | `/demos/skill-royalty.html`      | Per-call royalty payouts to skill authors                |
| **EAS reputation**                  | `/demos/eas-reputation.html`     | EAS-attested reputation viewer                           |
| **Bonding curve**                   | `/demos/bonding-curve.html`      | Pre-launch bonding-curve pricing simulator               |
| **Gallery picker**                  | `/demos/gallery-picker.html`     | Lazy 3D-thumbnail avatar picker (Embed Editor primitive) |
| **Button**                          | `/demos/button.html`             | Minimal `<agent-3d>` embed reaction test                 |

The demos are intentionally separate from production routes (`/create`, `/avatars/[id]`, etc.) so the production flow keeps working while we test new ideas.

---

## Skill Library

The platform ships with a set of built-in agent skills, packaged in `src/agent-skills-*.js` and registered via [`public/skills-index.json`](public/skills-index.json).

| Skill                  | Module                                   | What it does                                                                               |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Wave / scene**       | `src/agent-skills-scene.js`              | Built-in wave, lookAt, play_clip, setExpression handlers                                   |
| **Sentiment**          | `src/agent-skills-sentiment.js`          | Score incoming text 0–1, drive Empathy Layer spikes                                        |
| **Agent payments**     | `src/agent-skills-agent-payments.js`     | EVM A2A payments, EIP-7710 delegated signing                                               |
| **Solana Blinks**      | `src/agent-skills-blinks.js`             | Compose and broadcast Solana Action / Blink links                                          |
| **Jupiter**            | `src/agent-skills-jupiter.js`            | Quote + swap any SPL token via Jupiter v6                                                  |
| **NFTs**               | `src/agent-skills-nfts.js`               | Mint, transfer, and look up Metaplex Core / SPL-22 NFTs                                    |
| **Pumpfun watch**      | `src/agent-skills-pumpfun-watch.js`      | Subscribe to pump.fun events (`recent-claims`, `token-intel`, `watch-start`, `watch-stop`) |
| **Pumpfun compose**    | `src/agent-skills-pumpfun-compose.js`    | Build a pump.fun launch transaction with creator-signer split                              |
| **Pumpfun hooks**      | `src/agent-skills-pumpfun-hooks.js`      | React-style hooks for in-app pump.fun integrations                                         |
| **Pumpfun autonomous** | `src/agent-skills-pumpfun-autonomous.js` | Autonomous trade execution against signals + sentiment                                     |
| **Pumpfun core**       | `src/agent-skills-pumpfun.js`            | Shared pump.fun client utilities                                                           |
| **Accessories**        | `src/agent-accessories.js`               | Hat / glasses / prop slot attachment to a rigged avatar                                    |
| **Memory**             | `src/agent-memory.js`                    | File-based memory CRUD (see [Memory](#memory))                                             |
| **Reputation**         | `src/agent-reputation.js`                | Read on-chain reputation, surface in the chat UI                                           |

Third-party skills are distributed over IPFS / Arweave / HTTP. See [docs/skills.md](docs/skills.md) for the full skill manifest spec and authoring guide.

---

## Animation System

The avatar runtime ships with a slot-based animation manager that decouples animation clips from rigs — a clip authored for one body can be retargeted to any other rig at load time.

| Module        | Path                                                             | Role                                                                  |
| ------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Manager       | [src/animation-manager.js](src/animation-manager.js)             | Load, blend, and crossfade clips per slot (idle, gesture, locomotion) |
| State machine | [src/animation-state-machine.js](src/animation-state-machine.js) | Drives slot transitions from protocol events                          |
| Idle library  | [src/idle-animation.js](src/idle-animation.js)                   | Subtle breath / weight-shift loops that play under everything else    |
| Fetcher       | `npm run fetch-animations`                                       | Downloads the canonical clip library from R2                          |
| Builder       | `scripts/build-animations.mjs`                                   | Re-packs clip bundles into Meshopt + Draco-compressed GLB             |

A new clip can be authored against any rig in Blender, exported as a GLB, and dropped into the animation library — the manager picks it up automatically and the agent runtime can invoke it via the `play_clip` tool.

The **`sitidle` clip** is shipped as the default seated idle for chat-mode avatars; the **gemini-jump clip** drives the hero on `/`.

---

## Avatar Accessories & Coin Launchpad

Avatars are not just GLB files — they're composable rigs that the runtime can decorate with onchain accessories.

### Accessories

- Hats, glasses, props attached to named bone slots via [src/agent-accessories.js](src/agent-accessories.js)
- Accessories are themselves ERC-1155 tokens, ownable and tradeable independently of the avatar
- Equipping is non-destructive — the agent's base manifest stays unchanged, the accessory is layered at runtime

### Coin Launchpad

Every agent can mint a coin alongside its avatar — turning the agent into a tradeable economic object.

| Surface          | Path                         | Purpose                                                            |
| ---------------- | ---------------------------- | ------------------------------------------------------------------ |
| Launchpad Studio | `/launchpad`                 | Configure coin name, ticker, supply, fee shares                    |
| Hosted page      | `/p/[slug]`                  | Public launch page with `<agent-3d>` widget + buy button           |
| Avatar coin drop | `public/demo/coin/`          | Demo flow — connect wallet → mint avatar + coin in one transaction |
| Pump.fun bridge  | `POST /api/pump/launch-prep` | Route the launch through pump.fun's bonding curve                  |
| Direct mint      | `contracts/script/`          | Deploy a standalone ERC-20 / SPL-22 alongside the agent            |

The coin's metadata points back at the agent's onchain identity — ERC-8004 token on EVM or Metaplex Core asset on Solana — and the agent's manifest references the coin. The two-way binding is read from the bazaar, marketplace, and reputation registry on either chain.

---

## Brain Proxy & LLM Routing

three.ws supports multiple LLM providers behind a single `brain` interface. The runtime is provider-agnostic — switch from Claude to GPT to Gemini to a local model with a one-line change.

| Provider               | Path                             | Use case                                                              |
| ---------------------- | -------------------------------- | --------------------------------------------------------------------- |
| **Anthropic (Claude)** | `POST /api/llm/anthropic`        | Default — tool-loop, streaming, sentiment-tagged speak                |
| **Groq**               | (anonymous)                      | Free fast-mode chat for unauthenticated visitors on `/chat`           |
| **Multi-LLM brain**    | `/brain`, `POST /api/brain/chat` | Side-by-side compare Claude / GPT / Gemini / Groq for the same prompt |
| **OpenRouter**         | proxied via brain                | Fallback when the primary provider is rate-limited                    |
| **Null provider**      | `src/runtime/providers.js`       | No-op for tests and offline mode                                      |

**Owner-card gating** — when an agent has a paying owner (paid by ERC-8004 mint or x402 subscription), the embed shows an owner-attribution card and unlocks longer context windows + higher-tier models. Anonymous visitors get Groq-powered chat with a smaller window.

---

## API Reference

The full OpenAPI 3.1 spec is available at `/openapi.json`. The key API surface is organized below.

### Agent API

| Method   | Route                             | Auth    | Description                                                |
| -------- | --------------------------------- | ------- | ---------------------------------------------------------- |
| GET      | `/api/agents`                     | session | List your agents                                           |
| POST     | `/api/agents`                     | session | Create an agent                                            |
| GET      | `/api/agents/:id`                 | —       | Get agent detail                                           |
| PATCH    | `/api/agents/:id`                 | session | Update agent                                               |
| DELETE   | `/api/agents/:id`                 | session | Delete agent                                               |
| GET      | `/api/agents/:id/manifest`        | —       | Download manifest JSON                                     |
| POST     | `/api/agents/:id/sign`            | session | Sign a message with agent wallet                           |
| GET/POST | `/api/agents/:id/embed-policy`    | session | Manage iframe origin allowlist                             |
| POST     | `/api/agents/register-prep`       | session | Prep EVM on-chain registration (ERC-8004)                  |
| POST     | `/api/agents/register-confirm`    | session | Confirm EVM registration (ERC-8004)                        |
| POST     | `/api/agents/register-solana`     | session | Mint a Metaplex Core agent NFT on Solana                   |
| GET      | `/api/agents/solana-attestations` | —       | Read Solana feedback / validation memos for an agent       |
| GET      | `/api/agents/solana-card`         | —       | Solana agent passport card (mirrors EVM `/a/[chain]/[id]`) |
| GET      | `/api/agents/solana-reputation`   | —       | Solana off-chain reputation snapshot                       |
| POST     | `/api/agent-actions`              | session | Record signed agent action                                 |

### Avatar API

| Method | Route                       | Auth    | Description                 |
| ------ | --------------------------- | ------- | --------------------------- |
| GET    | `/api/avatars`              | —       | List public avatars         |
| POST   | `/api/avatars`              | session | Create avatar record        |
| GET    | `/api/avatars/:id`          | —       | Get avatar detail           |
| PATCH  | `/api/avatars/:id`          | session | Update metadata             |
| DELETE | `/api/avatars/:id`          | session | Soft-delete avatar          |
| POST   | `/api/avatars/:id/presign`  | session | Get presigned R2 upload URL |
| POST   | `/api/avatars/:id/pin-ipfs` | session | Pin to IPFS                 |

**Three-step upload flow:**

```
1. POST /api/avatars/:id/presign  →  { url, storage_key }
2. PUT <presigned_url>            ←  raw GLB bytes
3. POST /api/avatars              →  register metadata with storage_key
```

### Widget API

| Method | Route                        | Auth    | Description       |
| ------ | ---------------------------- | ------- | ----------------- |
| GET    | `/api/widgets`               | session | List your widgets |
| POST   | `/api/widgets`               | session | Create widget     |
| PATCH  | `/api/widgets/:id`           | session | Update widget     |
| DELETE | `/api/widgets/:id`           | session | Delete widget     |
| POST   | `/api/widgets/:id/duplicate` | session | Clone widget      |
| GET    | `/api/widgets/:id/stats`     | —       | View stats        |
| GET    | `/api/widgets/oembed`        | —       | oEmbed card       |

### Memory API

| Method | Route                   | Auth    | Description              |
| ------ | ----------------------- | ------- | ------------------------ |
| GET    | `/api/agent-memory/:id` | session | Fetch agent memory store |
| POST   | `/api/agent-memory/:id` | session | Append memory entries    |
| PUT    | `/api/agent-memory/:id` | session | Replace memory store     |

### Chat & LLM

| Method | Route                | Auth               | Description                      |
| ------ | -------------------- | ------------------ | -------------------------------- |
| POST   | `/api/chat`          | session \| api-key | Chat with agent (Claude backend) |
| POST   | `/api/llm/anthropic` | session            | Anthropic API proxy              |

### Cron Jobs

Scheduled via `vercel.json`, these run automatically in production. All cron endpoints are fail-closed — a missing auth token aborts with an error rather than silently skipping (see [Security Hardening](#security-hardening)).

All 22 crons in `vercel.json` are routed through a single dynamic handler at [`api/cron/[name].js`](api/cron/[name].js); the `name` segment selects the handler function. Schedules below match `vercel.json` verbatim.

| Schedule             | Endpoint                                | Purpose                                                                                                                      |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Every minute         | `/api/cron/run-x-scheduled-posts`       | Publish queued X (Twitter) posts                                                                                             |
| Every 3 min          | `/api/cron/pumpfun-monitor`             | Watch for new pump.fun token creates                                                                                         |
| Every 5 min          | `/api/cron/expire-pending-purchases`    | Clear stale x402 pending purchases                                                                                           |
| Every 5 min          | `/api/cron/solana-attestations-crawl`   | Index new Solana feedback / validation memos                                                                                 |
| Every 5 min          | `/api/cron/index-delegations`           | Index EIP-7710 delegations                                                                                                   |
| Every 5 min          | `/api/cron/run-x-triggers`              | Trigger-based X posts (mentions, milestones)                                                                                 |
| Every 5 min          | `/api/cron/run-coin-cycle`              | Unified coin-launch tick: holder snapshots, vault claims, lottery draws, reflections                                         |
| Every 5 min (offset) | `/api/cron/run-coin-payouts`            | Drain the coin-payouts queue; runs on a different minute from `run-coin-cycle` so a stuck payout never blocks the next cycle |
| Every 5 min (offset) | `/api/cron/club-payouts`                | Sweep unpaid Pole Club tips to each dancer's wallet                                                                          |
| Every 10 min         | `/api/cron/pump-agent-stats`            | Refresh pump-agent dashboard stats                                                                                           |
| Every 10 min         | `/api/cron/solana-attest-event-cleanup` | Prune Solana attestation events older than ~1 hour                                                                           |
| Every 15 min         | `/api/cron/erc8004-crawl`               | Index new ERC-8004 mints on indexed chains                                                                                   |
| Every 15 min         | `/api/cron/pumpfun-signals`             | Sweep pump.fun signals into the `pumpfun_signals` table                                                                      |
| Hourly               | `/api/cron/cleanup-csrf-tokens`         | Expire used / stale CSRF tokens                                                                                              |
| Hourly               | `/api/cron/process-withdrawals`         | Sweep creator withdrawals (pump.fun, club tips)                                                                              |
| Hourly               | `/api/cron/run-dca`                     | Execute DCA strategy orders                                                                                                  |
| Hourly               | `/api/cron/run-subscriptions`           | Execute recurring x402 subscriptions                                                                                         |
| Hourly               | `/api/cron/siwx-gc`                     | Prune SIWX nonces (10-min replay window) and expired payment grants                                                          |
| Every 6h             | `/api/cron/fetch-x-metrics`             | Pull X engagement metrics for owned accounts                                                                                 |
| Every 6h             | `/api/cron/process-subscriptions`       | Charge creator subscriptions whose period is about to end                                                                    |
| Daily 03:00 UTC      | `/api/cron/settle-royalties`            | Settle creator and skill royalties owed                                                                                      |
| Daily 04:00 UTC      | `/api/cron/audit-log-cleanup`           | Rotate audit logs past the retention window                                                                                  |

---

## Authentication & OAuth 2.1

three.ws supports three authentication methods:

**1. Email + Password (Session cookie)**

```
POST /api/auth/register   →  create account
POST /api/auth/login      →  JWT session cookie
GET  /api/auth/me         →  current user
POST /api/auth/logout     →  revoke session
```

**2. Wallet (SIWE / SIWS)**

```
POST /api/auth/siwe        →  get nonce challenge
POST /api/auth/siwe/verify →  verify EIP-4361 signed message → session
POST /api/auth/siws        →  Solana equivalent
```

**3. Developer API Keys**

```
POST /api/api-keys          →  create key (set scope + expiry)
DELETE /api/api-keys/:id    →  revoke key
Authorization: Bearer sk-...  →  authenticate requests
```

**OAuth 2.1 Server (RFC 6749 + PKCE)**

For third-party apps and MCP integrations:

```
GET  /oauth/authorize                       →  consent screen
POST /oauth/authorize                       →  submit consent → auth code
POST /oauth/token                           →  exchange code for tokens
POST /oauth/register                        →  RFC 7591 dynamic client reg
POST /oauth/revoke                          →  RFC 7009 token revocation
POST /oauth/introspect                      →  RFC 7662 token check
GET  /.well-known/oauth-authorization-server →  RFC 8414 discovery
GET  /.well-known/oauth-protected-resource  →  RFC 9728 resource discovery
```

Token scopes: `avatars:read`, `avatars:write`, `agents:read`, `agents:write`, `mcp`.

Access tokens are short-lived JWTs (1 hour). Refresh tokens are opaque strings stored hashed in Postgres.

---

## MCP Server

[`api/mcp.js`](api/mcp.js) is a thin HTTP entrypoint (POST / GET-SSE / DELETE) that implements the [Model Context Protocol](https://modelcontextprotocol.io) 2025-06-18 specification over JSON-RPC 2.0. The protocol logic is split across [`api/_mcp/`](api/_mcp/) — `auth.js` (Bearer/OAuth + x402 paywall), `dispatch.js` (JSON-RPC routing), `catalog.js` (dynamic tool catalog), `payments.js` (x402 paid-tool settlement), `render.js`, and `embed-policy.js`. Tools are registered per category under [`api/_mcp/tools/`](api/_mcp/tools/) (`avatars.js`, `models.js`, `solana.js`, `pumpfun.js`). External AI systems (including Claude Desktop, other agents, or custom integrations) can drive avatars programmatically through this surface.

**Endpoint:** `POST /api/mcp` (tools), `GET /api/mcp` (SSE), `DELETE /api/mcp` (session terminate)
**Auth:** OAuth 2.1 Bearer token with `mcp` scope; some tools additionally require x402 USDC payment
**Registry:** Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/?q=three.ws) as `io.github.nirholas/three.ws`
**x402scan:** [view on x402scan](https://www.x402scan.com/server/17cbd874-52ac-4920-a020-b22ff2489a07) — paid MCP tool calls and revenue

**Available tools:**

The catalog is assembled dynamically at request time from the per-category tool modules. Current tools:

_Avatars_ ([`api/_mcp/tools/avatars.js`](api/_mcp/tools/avatars.js))

| Tool                    | Description                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_my_avatars`       | List the authenticated user's avatars with id, name, slug, size, visibility, and (when permitted) direct `model_url`.                      |
| `get_avatar`            | Fetch a single avatar by id or owner+slug; returns metadata plus a public `model_url` or short-lived signed URL for private avatars.       |
| `search_public_avatars` | Free-text + tag search across the public avatar gallery; useful for finding characters to render without prior knowledge of an id.         |
| `render_avatar`         | Produce an HTML `<model-viewer>` snippet that renders the given avatar, with configurable background, camera orbit, poster, and AR button. |
| `delete_avatar`         | Soft-delete an avatar you own. Requires the `avatars:delete` scope.                                                                        |

_Models_ ([`api/_mcp/tools/models.js`](api/_mcp/tools/models.js))

| Tool             | Description                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate_model` | Run the Khronos glTF-Validator against a public https GLB/glTF URL; returns a structured report of errors, warnings, infos, and hints. SSRF-hardened.                                                                      |
| `inspect_model`  | Parse a GLB/glTF and return structural stats: scene/node/mesh counts, vertex and triangle totals, material and texture summaries, and extensions used. Pure inspection — no advice.                                        |
| `optimize_model` | Inspect the model and return actionable suggestions for reducing size and draw-call overhead: triangle budget, Draco/Meshopt, oversized textures, KTX2 transcoding, non-indexed primitives, redundant materials, and more. |

_Solana_ ([`api/_mcp/tools/solana.js`](api/_mcp/tools/solana.js)) — all public, no auth required

| Tool                        | Description                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `solana_agent_reputation`   | Computed reputation summary for a Solana-registered agent: total/verified feedback counts, raw + verified-only score averages, validation pass/fail, task-acceptance, and dispute counts.      |
| `solana_agent_attestations` | List recent on-chain attestations (feedback, validation, task offers, acceptances, disputes) about a Solana agent; each row includes verified/disputed/revoked flags.                          |
| `solana_agent_passport`     | Full discovery card for a Solana agent: identity, owner wallet, reputation summary, latest validation result, and attestation schema endpoint — the Solana equivalent of an ERC-8004 passport. |

_Pump.fun_ ([`api/_mcp/tools/pumpfun.js`](api/_mcp/tools/pumpfun.js))

| Tool                         | Description                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pumpfun_recent_claims`      | Most recent pump.fun GitHub social-fee claim events with full enrichment: GitHub profile, X/Twitter follower data, influencer tier, first-time-claim flag, fake-claim detection, and AI summary. |
| `pumpfun_recent_graduations` | Tokens that recently graduated from the bonding curve to PumpAMM, with creator and holder analysis.                                                                                              |
| `pumpfun_token_intel`        | Full intel on a pump.fun token: graduation status, bonding-curve progress, creator profile, top holders, volume, bundle detection, and trust signals.                                            |
| `pumpfun_creator_intel`      | Reputation profile for a pump.fun creator wallet: prior launches, graduation rate, claim activity, and behavioural trust signals.                                                                |

**MCP discovery:** configured in `.mcp.json` at the repo root for Claude Desktop integration.

**SSE stream:** `GET /api/mcp` returns a Server-Sent Events stream for real-time notifications from long-running operations (validation, optimization).

---

## On-Chain Identity (ERC-8004 + Metaplex Core)

three.ws supports two onchain identity paths as first-class peers — every reputation, attestation, and discovery surface reads from both, and SIWX brokers proofs between them so a single agent can hold reputation on both at once.

- **EVM path** — ERC-8004, a draft standard for verifiable 3D agent identity, deployed on Base, BSC, and other supported EVM chains. The `contracts/` directory contains a full Foundry implementation (IdentityRegistry, ReputationRegistry, ValidationRegistry).
- **Solana path** — Metaplex Core asset minted via the `solana-agent-sdk`. No custom on-chain program is required: the asset pubkey is the agent ID, and feedback / validation events are written as on-chain memos that the indexer rolls up into a reputation score (see the [Solana variant](#solana-variant--same-shape-no-deployed-program) section below).

### ERC-8004 (EVM)

ERC-8004 is a draft standard for verifiable 3D agent identity. The `contracts/` directory contains a full Foundry implementation.

### Contracts

**IdentityRegistry.sol** — the primary EVM contract. Each agent is an ERC-721 token with:

- `agentId` — stable numeric ID (the token ID)
- `owner` — EVM address of the agent's owner
- `delegatedSigner` — optional secondary address for runtime signing (EIP-712 typed signature)
- `tokenURI` — IPFS URL of the agent manifest JSON
- `metadata` — on-chain name, description, image pointer

On **Solana**, the equivalent identity is a **Metaplex Core asset**: the asset pubkey is the agent ID, the asset's `update_authority` is the owner, and the asset's URI points at the same IPFS-pinned manifest. No custom program is deployed — Metaplex Core handles mint, transfer, and update natively.

**ReputationRegistry.sol** — stores signed feedback scores. Each reviewer can submit one score per agent. Scores are averaged for an on-chain reputation metric. The **Solana analog** is an SPL Memo with envelope `threews.feedback.v1`, posted in a transaction whose accounts include the agent's Metaplex Core asset pubkey — readable by any client via `getSignaturesForAddress`.

**ValidationRegistry.sol** — records validator attestations for off-chain proofs (glTF validation reports, skill audits, security reviews). The **Solana analog** uses SPL Memo with envelope `threews.validation.v1` against the agent's Metaplex Core asset pubkey.

### Deployment Addresses

See [`contracts/DEPLOYMENTS.md`](contracts/DEPLOYMENTS.md) for current mainnet and testnet addresses. All three registries are deployed via **CREATE2** against a custom vanity-prefixed factory, so the **same address is used on every supported EVM chain** within an environment class — mainnet contracts have one address, testnet contracts another.

**Mainnet (across Ethereum, Optimism, BSC, Gnosis, Polygon, Fantom, zkSync Era, Moonbeam, Mantle, Base, Arbitrum One, Celo, Avalanche, Linea, Scroll):**

| Contract           | Address                                      |
| ------------------ | -------------------------------------------- |
| IdentityRegistry   | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| ValidationRegistry | _(same address on all chains)_               |

**Testnet (BSC Testnet, Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Optimism Sepolia, Polygon Amoy, Avalanche Fuji):**

| Contract           | Address                                      |
| ------------------ | -------------------------------------------- |
| IdentityRegistry   | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

### CREATE2 Factory (ThreeWSFactory)

A custom vanity-prefixed CREATE2 deployer at `0x00000000D49195AE81759cd247cFeDD9D0B479df` (7 leading zeros) is used to mint matching addresses across chains. The factory init code hash is `0x30f9d9020bf9622bbe7f8a1625d447efe350dfafd0a91e6dbd62d56547db835f`; bytecode is byte-identical on every deployed chain. Source is verified on each chain's explorer.

### Audits & EAS

- Smart contract audits are scheduled for the reputation, royalty, and delegation contracts as part of Phase 3
- **EAS** (Ethereum Attestation Service) integration ships as a sibling reputation surface — see `/demos/eas-reputation.html` for the viewer
- **0xsplits** SDK is wired for splitting skill royalties across multiple authors

### Registration Flow (EVM)

```
1. POST /api/agents/register-prep   →  { manifest, typedData }
   (uploads manifest to IPFS, builds EIP-712 typed data for signing)

2. User signs typedData with their wallet

3. POST /api/agents/register-confirm  →  { txHash, agentId }
   (submits transaction, waits for confirmation, updates agent record)
```

The agent is now an ERC-721 token. Its manifest lives on IPFS. Its action history is anchored to its `agentId`. Any third party can verify the agent's identity, owner, and reputation without trusting three.ws.

### Registration Flow (Solana)

Solana ships an ERC-8004 analog without any custom on-chain program — identity is a Metaplex Core asset, reputation + validation are SPL Memo–anchored attestations referencing that asset.

```
1. POST /api/agents/register-solana  →  { tx }
   (server builds a Metaplex Core mint instruction; client signs)

2. User signs and submits the tx with their Solana wallet (Phantom / Backpack / Seeker MWA)

3. POST /api/agents/register-solana?step=confirm  →  { asset, agentId }
   (server verifies the mint, writes back the asset pubkey as the agent's ID)
```

The agent is now a Metaplex Core NFT. Its asset pubkey is the canonical agent ID. Anyone can read every feedback / validation attestation about it via `getSignaturesForAddress(assetPubkey)` — see [Solana variant — same shape, no deployed program](#solana-variant--same-shape-no-deployed-program) below.

### On-Chain Indexing

`api/cron/erc8004-crawl.js` runs every 15 minutes to index new IdentityRegistry mint events. Indexed agents appear in `/discover` and can be imported via `/hydrate`.

### Solana variant — same shape, no deployed program

Solana ships an ERC-8004 analog without any custom on-chain program:

- **Identity** — Metaplex Core NFT minted via `registerSolanaAgent()` (the asset pubkey is the agent ID).
- **Reputation + Validation** — signed SPL Memo transactions referencing the agent asset pubkey, with a JSON envelope (`threews.feedback.v1` / `threews.validation.v1`). Anyone can read every attestation about an agent via `getSignaturesForAddress(assetPubkey)`.

SDK:

```js
import { attestFeedback, attestValidation, listAttestations } from '@nirholas/agent-kit';

await attestFeedback({ agentAsset, score: 5, network: 'devnet' });
await attestValidation({ agentAsset, taskHash: '0x…', passed: true, network: 'devnet' });
const rows = await listAttestations({ agentAsset, kind: 'all', network: 'devnet' });
```

Server read endpoint: `GET /api/agents/solana-attestations?asset=<pubkey>&kind=feedback|validation|all&network=devnet|mainnet`.

Demo page: [sdk/example/solana-attest.html](sdk/example/solana-attest.html).

### Pump.fun signals (Solana off-chain reputation)

Solana agents can ingest live pump.fun activity (GitHub social-fee claims, token graduations) as off-chain trust signals that feed into the agent's Solana reputation score and surface through the Empathy Layer in real time.

| Surface       | Path                                                                                 | Purpose                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP client    | [api/\_lib/pumpfun-mcp.js](api/_lib/pumpfun-mcp.js)                                  | Cached JSON-RPC client to upstream `pumpfun-claims-bot`                                                                                                                                                               |
| Read API      | [api/agents/pumpfun.js](api/agents/pumpfun.js)                                       | `GET ?op=claims\|graduations\|token\|creator`, plus `?_handler=feed` for the SSE event stream and `?_handler=metadata` for token metadata. Auth: session or bearer (`mcp`/`profile` scope).                           |
| Write actions | [api/agents/pumpfun/[action].js](api/agents/pumpfun/[action].js)                     | Dynamic dispatcher for `buy`, `sell`, `swap`, `launch`, `pay`, `portfolio`, `balances`, and buyback lifecycle (`create`, `accept`, `withdraw`, `distribute`, `extend_account`, `update_authority`, `update_buyback`). |
| Cron crawler  | [api/cron/[name].js](api/cron/[name].js) (`name=pumpfun-signals`)                    | 15-min sweep that writes the `pumpfun_signals` table; routed through the dynamic cron handler.                                                                                                                        |
| Skills        | [src/agent-skills-pumpfun-watch.js](src/agent-skills-pumpfun-watch.js)               | `recent-claims`, `token-intel`, `watch-start`, `watch-stop`                                                                                                                                                           |
| Widget        | [src/widgets/pumpfun-feed.js](src/widgets/pumpfun-feed.js)                           | Live cards overlay                                                                                                                                                                                                    |
| Reputation    | [api/agents/solana/[action].js](api/agents/solana/[action].js) (`action=reputation`) | Reputation summary with the `pumpfun_signals` block included in the response                                                                                                                                          |
| Passport      | [api/agents/solana/[action].js](api/agents/solana/[action].js) (`action=card`)       | Public passport card with the `pumpfun` block on the agent card                                                                                                                                                       |

The crawler runs on a `*/15 * * * *` schedule (see [vercel.json](vercel.json)) and writes into the `pumpfun_signals` table. Agents subscribed via `watch-start` react to incoming events through the existing protocol bus — no new event types required.

Full design and configuration in [docs/solana-pumpfun.md](docs/solana-pumpfun.md).

---

## Pump.fun Integration

Beyond the Solana reputation signals described above, the platform also ships consumer-facing pump.fun tooling:

- **Token Launcher** — UI for creating and launching new tokens, at [public/pumpfun.html](public/pumpfun.html).
- **Live Dashboard** — real-time tracker for new tokens, at [pages/pump-live.html](pages/pump-live.html).
- **Skills** — the [pump-fun-skills/](pump-fun-skills/) directory contains agent skills for reading and acting on pump.fun.

### Token launcher (USDC v2)

The launcher uses pump.fun's v2 USDC quote payload and supports a creator-signer split — the agent's owner can authorize a delegated signer to publish the token without exposing the root key.

| Surface          | Path                           | Purpose                                                  |
| ---------------- | ------------------------------ | -------------------------------------------------------- |
| Web UI           | `/pumpfun`                     | One-page launcher (avatar, ticker, supply, fee shares)   |
| Prep             | `POST /api/pump/launch-prep`   | Build the launch transaction with creator + signer split |
| Quote            | `POST /api/pump/quote-sdk`     | v2 USDC quote (replaces deprecated v1 path)              |
| Curve            | `GET /api/pump/curve`          | Bonding-curve sim for pre-launch pricing preview         |
| Dashboard        | `GET /api/pump/dashboard`      | Per-creator launch history + cumulative revenue          |
| Stats            | `GET /api/pump/helius-stats`   | Helius-backed per-token holder + trade counts            |
| Trades stream    | `GET /api/pump/trades-stream`  | SSE feed of trades for a token                           |
| Inaugural launch | `scripts/pump-launch-usdc.mjs` | First-USDC launch flow used to mint platform tokens      |

### Pump-swap buyback

A buyback flow lets an agent route revenue from x402 paid endpoints into pump-swap purchases of its own token — closing the loop between paid usage and tokenholder value. See [scripts/pump-launch-usdc.mjs](scripts/pump-launch-usdc.mjs) and the inaugural-launch self-contained prompts in [docs/internal/](docs/internal/).

### Pump visualizer

`/pump-visualizer` is a live view of pump.fun activity with three modes:

| Mode           | What it shows                                                         |
| -------------- | --------------------------------------------------------------------- |
| **Feed**       | Newest launches as they happen, with cover images and creator history |
| **Migrations** | Tokens graduating from the curve to pump-swap pools                   |
| **Pulses**     | Real-time trade pulses overlaid on a graph                            |

The visualizer supports search, sort, live pulses, and auto-refresh. Backed by the same Helius webhooks and JSON-RPC client as the cron crawler.

### Pump.fun MCP edge worker

For external agents that need pump.fun data with strict latency, a Cloudflare Worker mirror of the read API lives in [workers/pump-fun-mcp/](workers/pump-fun-mcp/). Deploy with `wrangler deploy` — the worker proxies the upstream `pumpfun-claims-bot` and answers MCP `tools/call` requests at the edge.

### Channel & Telegram bridge

| Endpoint                                                        | Purpose                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/pump/channel-feed`                                    | Per-creator activity feed for any agent's channel page  |
| `POST /api/pump/deliver-telegram`                               | Optional Telegram bridge for trade and migration alerts |
| `POST /api/pump/accept-payment-prep` / `accept-payment-confirm` | Two-step USDC handoff for buyback flow                  |
| `POST /api/pump/withdraw-prep` / `withdraw-confirm`             | Creator fee withdrawal with signature verification      |

### Vanity mint addresses

The platform's pump.fun launches pre-grind vanity mint addresses with the WASM grinder so token addresses end in a brand-relevant suffix (`…pump`, `…ws`, etc.). See [WASM Vanity Grinder](#wasm-vanity-grinder).

---

## Database Schema

The Postgres schema ([`api/_lib/schema.sql`](api/_lib/schema.sql)) is fully idempotent — every `CREATE TABLE` uses `IF NOT EXISTS`, so the file is safe to re-run on any environment. Per-feature migrations live under [`api/_lib/migrations/`](api/_lib/migrations/) and are applied with `npm run db:migrate`.

The schema currently defines ~53 tables grouped below. Columns shown are the most commonly queried ones; the source file is authoritative.

**Core identity & content**

```sql
users             (id, email, password_hash, display_name, avatar_url, plan, wallet_address, deleted_at)
avatars           (id, owner_id, slug, name, description, storage_key, visibility,
                   tags, checksum_sha256, version, deleted_at)
sessions          (id, user_id, token_hash, user_agent, ip, expires_at, revoked_at)
api_keys          (id, user_id, prefix, token_hash, scope, expires_at, revoked_at)
user_prefs        (user_id, key, value, updated_at)
agent_identities  (id, user_id, name, description, avatar_id, skills,
                   meta, wallet_address, erc8004_agent_id, deleted_at)
agent_actions     (id, agent_id, type, payload, source_skill,
                   signature, signer_address, created_at)
agent_memories    (id, agent_id, type, content, tags, context,
                   salience, expires_at, created_at)
```

**OAuth 2.1**

```sql
oauth_clients         (client_id, client_secret_hash, redirect_uris, grant_types, scope, ...)
oauth_auth_codes      (code, client_id, user_id, code_challenge, expires_at, consumed_at)
oauth_refresh_tokens  (token_hash, client_id, user_id, scope, expires_at, revoked_at, ...)
```

**Wallet & signing**

```sql
user_wallets  (user_id, address, chain_type, chain_id, is_primary)
siwe_nonces   (nonce, address, issued_at, expires_at, consumed_at)
siws_nonces   (same shape for Solana)
gate_nonces   (nonce, scene_gate_id, issued_at, consumed_at)
scene_gates   (id, owner_id, scope, policy, created_at)
csrf_tokens   (token, user_id, issued_at, consumed_at)
```

**Authentication extras**

```sql
email_verifications  (token_hash, user_id, expires_at, consumed_at)
password_resets      (token_hash, user_id, expires_at, consumed_at)
social_connections   (user_id, provider, provider_user_id, access_token_hash, ...)
```

**Widgets**

```sql
widgets       (id, owner_id, kind, config, public_slug, ...)
widget_views  (widget_id, ip_hash, user_agent_hash, viewed_at)
```

**ERC-8004 / EVM indexing**

```sql
erc8004_agents_index    (chain_id, agent_id, owner, token_uri, ...)
erc8004_crawl_cursor    (chain_id, last_block, updated_at)
indexer_state           (key, value, updated_at)
agent_registrations_pending (id, user_id, chain_id, typed_data, signed_payload, status, ...)
agent_delegations       (agent_id, delegate, scope, expires_at, ...)
```

**Solana attestations & registration**

```sql
solana_attestations          (asset_pubkey, kind, payload, signer, network, slot, sig)
solana_attestations_cursor   (network, last_slot, updated_at)
solana_credentials           (user_id, asset_pubkey, network, role)
pumpfun_signals              (asset_pubkey, signal_kind, payload, observed_at)
pumpfun_graduations          (mint, creator, graduated_at, amm_pool, ...)
```

**Marketplace, skills & royalties**

```sql
marketplace_skills    (id, skill_uri, owner_id, title, description, price_usdc, ...)
skill_installs        (skill_id, agent_id, installed_at)
skill_purchases       (skill_id, buyer_user_id, price_usdc, settled_at, tx_hash)
skill_ratings         (skill_id, rater_user_id, stars, comment, created_at)
agent_skill_prices    (agent_id, skill_id, override_price_usdc)
royalty_ledger        (id, owner_id, source, amount_usdc, settled_at, tx_hash)
plugins               (id, owner_id, manifest, public_slug, ...)
```

**Subscriptions, DCA & payments**

```sql
subscriptions          (id, user_id, plan_id, status, current_period_end, ...)
subscription_plans     (id, owner_id, name, price_usd, cadence)
subscription_payments  (subscription_id, status, amount_usdc, tx_hash, attempted_at)
creator_subscriptions  (id, subscriber_user_id, plan_id, status, current_period_end, ...)
agent_subscriptions    (id, agent_id, subscriber_user_id, status, ...)
agent_payments         (id, agent_id, payer_user_id, amount_usdc, status, tx_hash)
agent_payment_intents  (id, agent_id, status, payload, created_at)
plan_payment_intents   (id, plan_id, status, payload, created_at)
dca_strategies         (id, owner_id, source_token, target_token, cadence, amount, status)
dca_executions         (strategy_id, status, amount, tx_hash, executed_at)
purchase_events        (id, kind, payload, observed_at)
purchase_receipts      (purchase_id, receipt_json, settled_at)
```

**Usage & quotas**

```sql
usage_events  (user_id, api_key_id, client_id, avatar_id, kind, tool, status, bytes, latency_ms)
plan_quotas   (plan, max_avatars, max_bytes_per_avatar, max_total_bytes)
```

---

## Build & Deployment

### npm Scripts

| Command                    | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `npm run dev`              | Vite dev server on port 3000 with HMR                              |
| `npm run build`            | Production build to `dist/`                                        |
| `npm run build:lib`        | Build `<agent-3d>` web component library to `dist-lib/`            |
| `npm run build:artifact`   | Build standalone Claude artifact viewer bundle                     |
| `npm run build:all`        | Chat build, then `build` + `build:lib` + `build:rider` in parallel |
| `npm run publish:lib`      | Publish versioned CDN bundles to `/agent-3d/`                      |
| `npm run test`             | Vitest unit suite + Playwright end-to-end suite                    |
| `npm run test:e2e`         | Playwright end-to-end suite only                                   |
| `npm run verify`           | Prettier check + Vite build (pre-deploy gate)                      |
| `npm run format`           | Prettier write (entire repo)                                       |
| `npm run deploy`           | `build:all` → `check:dist` → `vercel --prod`                       |
| `npm run clean`            | Remove `dist/` and `dist-lib/`                                     |
| `npm run fetch-animations` | Download animation clip assets                                     |
| `npm run generate-icons`   | Generate PWA icon set                                              |
| `npm run db:migrate`       | Apply Postgres migrations from `scripts/migrations/`               |
| `npm run db:status`        | Show pending Postgres migrations                                   |
| `npm run seed:skills`      | Seed the skills registry from `skills-manifest.js`                 |
| `npm run install:sdk`      | Install + build `agent-payments-sdk` and link it locally           |
| `npm run validate:cards`   | Validate agent definition cards in `src/agents/`                   |
| `npm run pump:smoke`       | Run the pump.fun lifecycle smoke test                              |

### Claude CLI

`scripts/claude.sh` (aliased as `npm run claude`) wraps the npm scripts above with confirmation prompts on destructive commands (`deploy`, `db-migrate`). Useful when you want guard-rails or a single entry point for an agent to drive.

```bash
npm run claude -- <command>
# or
./scripts/claude.sh <command>
```

| Command               | Wraps                                      |
| --------------------- | ------------------------------------------ |
| `install-sdk`         | `npm run install:sdk`                      |
| `validate-cards`      | `npm run validate:cards`                   |
| `db-migrate`          | `npm run db:migrate` (with confirmation)   |
| `db-status`           | `npm run db:status`                        |
| `pump-smoke-test`     | `npm run pump:smoke`                       |
| `seed-skills`         | `npm run seed:skills`                      |
| `test`                | `npm run test`                             |
| `format`              | `npm run format`                           |
| `clean`               | `npm run clean`                            |
| `deploy`              | `npm run deploy` (with confirmation)       |
| `deploy-agent <name>` | Packages an agent into a distributable zip |
| `help`                | List all commands                          |

### Vercel Deployment

The project is built for Vercel. Deployment is one command:

```bash
npm run deploy
```

This runs `build:all` then `vercel --prod`. Routing, rewrites, cache headers, and cron schedules are defined in `vercel.json`.

For preview deployments, push a branch — Vercel auto-deploys it with a preview URL.

**Environment variables** must be set in the Vercel dashboard (not in `.env` files). See [Environment Variables](#environment-variables) for the full list.

### Self-Hosting

For a traditional server deployment:

1. Build: `npm run build` → `dist/`
2. Serve `dist/` as static files (nginx, Caddy, Express)
3. Run `api/` endpoints via Node.js (wrap with Express or use the Vercel dev adapter)
4. Connect to Postgres (Neon or self-hosted)
5. Connect to S3-compatible storage (R2, MinIO, AWS S3)
6. Schedule cron jobs with node-cron or systemd timers

**Minimal nginx config:**

```nginx
server {
    listen 80;
    root /var/www/3d-agent/dist;
    index index.html;

    location /api {
        proxy_pass http://localhost:3001;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Versioning & Compatibility

three.ws follows [Semantic Versioning](https://semver.org). The authoritative version lives in [package.json](package.json); the current release is reflected in the badge at the top of this README.

**What "stable" means**

| Surface                                                                      | Stability                                                                                          | Versioning                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `<agent-3d>` web component attributes, JS API, and events                    | **Stable** — semver-major bumps for breaking changes                                               | Pin a major in your `<script>` tag, e.g. `/agent-3d/1.x/agent-3d.js` |
| `agent-manifest/0.2` JSON schema                                             | **Stable** within `0.2.x`; `0.3` will be additive where possible                                   | Indicated by the `spec` field on every manifest                      |
| Public REST API (`/api/agents`, `/api/widgets`, `/api/avatars`, `/api/chat`) | **Stable** — additive changes only without a major bump                                            | Tracked in the OpenAPI doc at `/openapi.json`                        |
| OAuth 2.1 endpoints (`/oauth/*`, `/.well-known/*`)                           | **Stable** — frozen by the relevant RFCs                                                           | n/a                                                                  |
| MCP surface at `POST /api/mcp`                                               | **Stable** — pinned to protocol version `2025-06-18`; tool catalogue is additive                   | The protocol version is part of every response                       |
| Internal Vercel functions, helpers under `api/_lib/`, `api/_mcp/`            | **Unstable** — no compatibility guarantees                                                         | Subject to refactor between releases                                 |
| Solidity contracts in `contracts/`                                           | **Stable per deployment** — see [contracts/DEPLOYMENTS.md](contracts/DEPLOYMENTS.md) for addresses | New chains add rows; existing deployments are immutable              |

**Pinning recommendations**

- For production embeds, pin to the patch version (`/agent-3d/1.5.1/agent-3d.js`) and bump deliberately.
- For prototypes, pin to the major (`/agent-3d/1.x/agent-3d.js`) so you receive bug-fixes automatically.
- For agent manifests, always set the `spec` field — the loader rejects manifests with an unknown spec rather than guessing.
- For API consumers, request `application/json` and inspect the response `version` header (present on every endpoint).

**Deprecation policy.** Stable surfaces get a deprecation notice in the changelog plus a runtime warning for at least one minor release before removal. Anything marked **unstable** in the table above may change at any time.

---

## Environment Variables

### Required (Backend)

```env
# App
PUBLIC_APP_ORIGIN=https://three.ws           # No trailing slash

# Database
DATABASE_URL=postgres://user:pass@host/db    # Neon or any Postgres 15+

# Object storage (Cloudflare R2 or S3-compatible)
S3_ENDPOINT=https://...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=3d-agent-avatars
S3_PUBLIC_DOMAIN=https://cdn.three.ws        # CDN base URL for public model URLs

# Redis (rate limiting)
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...

# Auth
JWT_SECRET=<base64>                          # openssl rand -base64 64
JWT_KID=k1                                   # Key ID (rotate by incrementing)
PASSWORD_ROUNDS=11                           # bcrypt cost factor

# LLM
ANTHROPIC_API_KEY=sk-ant-...
CHAT_MODEL=claude-sonnet-4-6
CHAT_MAX_TOKENS=1024
```

### Optional (Backend)

```env
# Email (required for registration flow)
RESEND_API_KEY=...

# Error monitoring
SENTRY_DSN=...

# Privy (social/embedded wallets)
PRIVY_APP_ID=...
PRIVY_APP_SECRET=...

# Avatar regeneration
AVATURN_API_KEY=...
AVATAR_REGEN_PROVIDER=none                   # none | avaturn

# EIP-7710 permissions relayer
PERMISSIONS_RELAYER_ENABLED=false
AGENT_RELAYER_KEY=0x...
AGENT_RELAYER_ADDRESS=0x...

# Per-chain RPC URLs (add chains as needed)
RPC_URL_84532=https://sepolia.base.org
RPC_URL_8453=https://mainnet.base.org

# IPFS pinning
PINATA_JWT=...
WEB3_STORAGE_TOKEN=...                       # Fallback

# Coin Communities chat (reads work without keys; posting needs these)
CC_API_KEY=...                               # read + WebSocket tickets
CC_SERVER_KEY=...                            # server-attributed posts (optional)
CC_SERVER_SECRET=...
```

> **Multiplayer / game server.** The Colyseus server in `multiplayer/` reads its own config — `PLAY_GATE_MINT` / `PLAY_GATE_MIN` and `HOLDER_PASS_SECRET` for the play-gate, and `GAME_TOKEN_MINT` / `GAME_TOKEN_TREASURY` / `GAME_TOKEN_BURN` / `GAME_TOKEN_SECRET` for the in-game $THREE economy. These belong to the game server's environment, not the Vercel function pool.

### Optional (Frontend, prefixed `VITE_`)

```env
VITE_CHARACTER_STUDIO_URL=https://studio.three.ws  # Avatar builder iframe origin
VITE_PRIVY_APP_ID=...
VITE_AVATURN_EDITOR_URL=https://editor.avaturn.me/
VITE_AVATURN_DEVELOPER_ID=...
```

---

## Testing

`npm run test` runs Vitest (unit + integration) followed by Playwright (end-to-end). API tests stub the database and auth layer; frontend tests stub the viewer. The project currently has ~150 test files spread across `tests/`, `tests/api/`, `tests/src/`, and `tests/e2e/`.

```bash
npm run test                            # Vitest then Playwright
npx vitest run tests/api/agents.test.js # Single Vitest file
npm run test:e2e                        # Playwright only
npm run verify                          # Prettier check + Vite build
```

**Representative Vitest coverage** (full inventory under [tests/](tests/)):

| Area                         | File                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent CRUD                   | [tests/api/agents.test.js](tests/api/agents.test.js)                                                                                                                                                                                                                                                                                                                         |
| Agent memory                 | [tests/api/agent-memory.test.js](tests/api/agent-memory.test.js), [tests/src/agent-memory.test.js](tests/src/agent-memory.test.js)                                                                                                                                                                                                                                           |
| Agent protocol bus           | [tests/agent-protocol.test.js](tests/agent-protocol.test.js), [tests/src/agent-protocol.test.js](tests/src/agent-protocol.test.js)                                                                                                                                                                                                                                           |
| Widget CRUD                  | [tests/api/widgets.test.js](tests/api/widgets.test.js)                                                                                                                                                                                                                                                                                                                       |
| Widget types                 | [tests/src/widget-types.test.js](tests/src/widget-types.test.js)                                                                                                                                                                                                                                                                                                             |
| OAuth flow                   | [tests/api/oauth-authorize.test.js](tests/api/oauth-authorize.test.js), [tests/api/oauth-token.test.js](tests/api/oauth-token.test.js), [tests/api/oauth-introspect.test.js](tests/api/oauth-introspect.test.js)                                                                                                                                                             |
| SIWE / SIWS wallet auth      | [tests/api/siwe.test.js](tests/api/siwe.test.js)                                                                                                                                                                                                                                                                                                                             |
| Email + password auth        | [tests/api/auth-email.test.js](tests/api/auth-email.test.js), [tests/api/auth-helpers.test.js](tests/api/auth-helpers.test.js)                                                                                                                                                                                                                                               |
| API keys                     | [tests/api/api-keys.test.js](tests/api/api-keys.test.js)                                                                                                                                                                                                                                                                                                                     |
| LLM proxy                    | [tests/api/llm-anthropic.test.js](tests/api/llm-anthropic.test.js), [tests/api/chat-proxy-ratelimit.test.js](tests/api/chat-proxy-ratelimit.test.js)                                                                                                                                                                                                                         |
| MCP server                   | [tests/api/mcp.test.js](tests/api/mcp.test.js)                                                                                                                                                                                                                                                                                                                               |
| Schema validation            | [tests/api-validate.test.js](tests/api-validate.test.js)                                                                                                                                                                                                                                                                                                                     |
| Crypto utilities             | [tests/api/crypto.test.js](tests/api/crypto.test.js)                                                                                                                                                                                                                                                                                                                         |
| Embed CORS policy            | [tests/api/embed-policy.test.js](tests/api/embed-policy.test.js)                                                                                                                                                                                                                                                                                                             |
| Embed bridge handshake       | [tests/embed-bridge-origin.test.js](tests/embed-bridge-origin.test.js), [tests/embed-bridge-roundtrip.test.js](tests/embed-bridge-roundtrip.test.js)                                                                                                                                                                                                                         |
| Animation slots / state      | [tests/src/animation-slots.test.js](tests/src/animation-slots.test.js), [tests/animation-state-machine.test.js](tests/animation-state-machine.test.js), [tests/animations.test.js](tests/animations.test.js)                                                                                                                                                                 |
| ARKit-52 morphs / lipsync    | [tests/arkit52.test.js](tests/arkit52.test.js), [tests/arkit-blendshapes.test.js](tests/arkit-blendshapes.test.js), [tests/agent-avatar-lipsync.test.js](tests/agent-avatar-lipsync.test.js), [tests/lipsync-driver.test.js](tests/lipsync-driver.test.js), [tests/src/lip-sync-analyser.test.js](tests/src/lip-sync-analyser.test.js)                                       |
| x402 protocol                | [tests/api/x402.test.js](tests/api/x402.test.js), [tests/api/x402-spec.test.js](tests/api/x402-spec.test.js), [tests/api/x402-paid-endpoint-siwx.test.js](tests/api/x402-paid-endpoint-siwx.test.js), [tests/api/x402-gas-sponsoring.test.js](tests/api/x402-gas-sponsoring.test.js), [tests/api/x402-payment-identifier.test.js](tests/api/x402-payment-identifier.test.js) |
| Persona                      | [tests/api/persona.test.js](tests/api/persona.test.js)                                                                                                                                                                                                                                                                                                                       |
| Pump.fun MCP / skills        | [tests/api/pump-fun-mcp.test.js](tests/api/pump-fun-mcp.test.js), [tests/pump-mcp-tools.test.js](tests/pump-mcp-tools.test.js), [tests/pumpfun-ported-skills.test.js](tests/pumpfun-ported-skills.test.js), [tests/src/pump-fun-skill.test.js](tests/src/pump-fun-skill.test.js)                                                                                             |
| Pump.fun pricing / curves    | [tests/api/pump-curve.test.js](tests/api/pump-curve.test.js), [tests/bonding-curve.test.js](tests/bonding-curve.test.js), [tests/pump-swap-ix.test.js](tests/pump-swap-ix.test.js)                                                                                                                                                                                           |
| Pump.fun signals / live feed | [tests/pumpfun-signals.test.js](tests/pumpfun-signals.test.js), [tests/pumpfun-ws-feed.test.js](tests/pumpfun-ws-feed.test.js), [tests/pump-live-stream.test.js](tests/pump-live-stream.test.js), [tests/carbon-graduations.test.js](tests/carbon-graduations.test.js)                                                                                                       |
| Club tips / payouts          | [tests/api/club-tips.test.js](tests/api/club-tips.test.js), [tests/api/club-tips-stream.test.js](tests/api/club-tips-stream.test.js), [tests/api/club-payouts-cron.test.js](tests/api/club-payouts-cron.test.js), [tests/api/dance-tip.test.js](tests/api/dance-tip.test.js)                                                                                                 |
| Club performance / venue     | [tests/club-audio.test.js](tests/club-audio.test.js), [tests/club-camera.test.js](tests/club-camera.test.js), [tests/club-perf.test.js](tests/club-perf.test.js), [tests/club-venue-load.test.js](tests/club-venue-load.test.js), [tests/club-sequence.test.js](tests/club-sequence.test.js)                                                                                 |
| Avatar bake / snapshot       | [tests/avatar-bake.test.js](tests/avatar-bake.test.js), [tests/avatar-snapshot.test.js](tests/avatar-snapshot.test.js), [tests/api/avatar-og.test.js](tests/api/avatar-og.test.js)                                                                                                                                                                                           |
| glTF canonicalize / extras   | [tests/glb-canonicalize.test.js](tests/glb-canonicalize.test.js), [tests/src/gltf-extras.test.js](tests/src/gltf-extras.test.js), [tests/src/validator.test.js](tests/src/validator.test.js)                                                                                                                                                                                 |
| Vanity (Solana + EVM)        | [tests/vanity-wasm-grinder.test.js](tests/vanity-wasm-grinder.test.js), [tests/src/eth-vanity-derivation.test.js](tests/src/eth-vanity-derivation.test.js), [tests/src/eth-vanity-server-verify.test.js](tests/src/eth-vanity-server-verify.test.js), [tests/src/vanity-validation.test.js](tests/src/vanity-validation.test.js)                                             |
| Build asset paths            | [tests/build-asset-paths.test.js](tests/build-asset-paths.test.js)                                                                                                                                                                                                                                                                                                           |
| Agent monetization           | [tests/agent-monetization.test.js](tests/agent-monetization.test.js)                                                                                                                                                                                                                                                                                                         |
| Billing                      | [tests/billing.test.js](tests/billing.test.js)                                                                                                                                                                                                                                                                                                                               |
| Branding / camera presets    | [tests/branding.test.js](tests/branding.test.js), [tests/camera-presets.test.js](tests/camera-presets.test.js)                                                                                                                                                                                                                                                               |

### Playwright end-to-end smokes

Browser-driven smokes live in [tests/e2e/](tests/e2e/) and run against the local Vite + Vercel dev stack. They cover user-visible flows that don't fit in Vitest.

| Smoke                                            | What it exercises                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| [tests/e2e/club.spec.js](tests/e2e/club.spec.js) | `/club` venue + HDRI load and audio session within the cold-start budget |

Run with `npx playwright test` (or `npm run test:e2e`). Configuration in [playwright.config.js](playwright.config.js); results in `test-results/` (gitignored).

### Smart contracts

Smart contract tests are in `contracts/test/` and run via Foundry:

```bash
cd contracts && forge test
```

CREATE2 vanity grinds for the multichain factory and payment contracts are recorded in [contracts/DEPLOYMENTS.md](contracts/DEPLOYMENTS.md).

---

## FAQ & Troubleshooting

**Does three.ws require a wallet to use?**
No. The viewer, agent runtime, manifest editor, and `/app` work without a wallet or an account. A wallet is only required for on-chain registration (ERC-8004 mint, Solana Metaplex Core mint) and for paid surfaces (x402 endpoints, agent token launches).

**Does my GLB get uploaded anywhere?**
Not unless you explicitly choose to publish or register the agent. Drag-and-drop in the viewer is fully client-side — the file never leaves the browser. The "Publish" and "Register" flows are the points where the GLB is uploaded to R2.

**Which LLM does the agent use?**
The default is Anthropic Claude (`claude-sonnet-4-6` for production, `claude-haiku-4-5-20251001` for low-cost development). Brain routing is configurable per-agent through the manifest and via the `brain` attribute on `<agent-3d>`. Other providers can be wired in by extending [`src/runtime/providers.js`](src/runtime/providers.js).

**Can I run three.ws fully offline?**
Yes for the viewer, no for the agent runtime. With `sandbox` set on `<agent-3d>` the element refuses all network calls; you can still load a local GLB, play animations, and exercise the manifest. The LLM brain, voice, and on-chain features require network connectivity.

**Why does the avatar appear black or all-white?**
Usually a missing HDR environment or a material that expects an environment map. Confirm the GLB has a default scene, that the lighting attributes (`exposure`, `env`) are set, and that your build has access to `public/env/` (the HDR assets ship there). For all-white avatars, check that morph targets aren't being zeroed by an empty emotion mix.

**The agent never speaks back. What's wrong?**
Most often the chat input isn't reaching the brain. Check (in order): (1) the `brain` attribute or `manifest.brain` is set; (2) the network panel shows a `POST /api/chat` (or the configured proxy) succeeding; (3) the response body isn't blocked by a Content Security Policy; (4) TTS is supported and not muted at the OS level. If running locally, set `ANTHROPIC_API_KEY` in `.env.local`.

**Why does microphone capture fail on my deployment?**
`getUserMedia` requires HTTPS. Localhost is exempt; any remote deployment needs TLS. Vercel and Netlify provide it automatically. Self-hosted deployments must terminate TLS in front of the app.

**How big can a GLB be?**
Hard ceiling: 50 MB before the loader refuses (configurable via the `maxBytes` attribute). Soft target: ≤8 MB for sub-3-second cold start over a typical broadband connection. Run `npx gltf-transform draco input.glb output.glb` and `npx gltf-transform ktx output.glb output.ktx2.glb` to compress aggressively without visual loss.

**Can I host the web component on my own CDN?**
Yes. Run `npm run build:lib` and serve the resulting `dist-lib/agent-3d.js` from anywhere. Update the `<script>` tag in your embed snippet accordingly. The element has no hard-coded origin assumption — it only contacts the backend you point its `manifest`/`brain` attributes at.

**How do I rotate `JWT_SECRET` without invalidating sessions?**
Increment `JWT_KID` and add the new secret. Existing tokens continue to validate against the old `kid`; new tokens sign with the new one. Drop the old `kid` from rotation after the session window (default 30 days) expires.

**Where do I get help?**

- Bugs and feature requests: [open a GitHub issue](https://github.com/nirholas/three.ws/issues)
- Security: see [Reporting Security Issues](#reporting-security-issues)
- Discussion and showcase: [GitHub Discussions](https://github.com/nirholas/three.ws/discussions)
- Live status: [three.ws](https://three.ws)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide. Contributors are expected to follow the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) in every project space — issues, pull requests, discussions, and any community channel that links to this repository.

**Quick rules:**

- Match existing style — no reformatting adjacent code
- Every changed line should trace to the task
- Add tests for new API endpoints
- Run `npm run verify` before opening a PR (Prettier + build check)
- Keep PRs focused — one concern per PR

**Branch conventions:**

- `feat/...` — new features
- `fix/...` — bug fixes
- `refactor/...` — structural changes without behavior changes
- `docs/...` — documentation only

**Development tips:**

- The viewer runs standalone at `/app` — no auth, no backend required
- Use `mode=view` in the `<agent-3d>` element to test rendering without a brain
- Set `CHAT_MODEL=claude-haiku-4-5-20251001` locally to keep API costs low during development
- The MCP server can be tested with `curl` — it's plain JSON-RPC over HTTP

### Reporting Security Issues

Please **do not** file public GitHub issues for vulnerabilities. Disclosure runs on a coordinated timeline so users get a fix before details circulate.

1. Email **security@three.ws** (or open a [private GitHub security advisory](https://github.com/nirholas/three.ws/security/advisories/new) on the mirror repos) with a clear write-up: affected component, reproduction steps, and the impact you observed.
2. You will receive an acknowledgement within two business days.
3. We aim to ship a fix or mitigation within 30 days for high-severity reports, and to credit reporters in the release notes (unless you ask to remain anonymous).

The current threat model and hardening notes live in [specs/SECURITY.md](specs/SECURITY.md) and [docs/security.md](docs/security.md). The [Security Hardening](#security-hardening) section above summarises the in-tree controls.

In-scope: this repository and its deployed surfaces (`three.ws`, `cdn.three.ws`, `*.three.ws`). Out-of-scope: third-party services we integrate with (Vercel, Neon, Cloudflare R2, Upstash, Privy, Anthropic, ElevenLabs, pump.fun) — please report directly to them.

---

## Contributors

Thanks to everyone who has contributed to this project. Commit-level contributors are visible in [the GitHub contributors graph](https://github.com/nirholas/three.ws/graphs/contributors); a few standouts:

- [@nirholas](https://github.com/nirholas) — maintainer
- [@humanoidrobot-glitch](https://github.com/humanoidrobot-glitch) — thank you for your contributions!
- [@overstepping](https://github.com/overstepping) — thank you for your contributions!
- [@swarmsyy](https://github.com/swarmsyy) — thank you for your contributions!

Want your name here? Open a PR — see [Contributing](#contributing).

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

The three.js library (`node_modules/three`) is MIT licensed. The gltf-validator (`node_modules/gltf-validator`) is Apache 2.0. See each dependency's license for details.

---

_Built with [three.js](https://threejs.org), [Claude](https://claude.ai), and a belief that AI deserves a body._
