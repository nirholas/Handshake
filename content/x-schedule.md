# X Content Schedule

30-day rolling schedule, 2 posts per day. Source of truth is [`x-schedule.json`](x-schedule.json). Posts are mirrored here for easy review. See [`README.md`](README.md) for voice rules and the big-news override flow.

- **AM** ≈ 09:00 PT
- **PM** ≈ 17:00 PT
- **Kind**: `feature` (60 entries) · `news` (queue + scheduled drops)

---

## Week 1

### Thu 2026-05-21 — Bazaar Week

**AM · news · Bazaar + x402 live on Base via Coinbase CDP** — [three.ws/x402](https://three.ws/x402)
> Coinbase CDP + x402 are live on three.ws.
>
> Agents pay agents in USDC on Base mainnet with Permit2 gas-sponsoring on every CDP endpoint. Direct-scheme on BSC and Solana.
>
> Buyer signs. Relayer pays gas. Caller gets data.
>
> Browse + monetize → three.ws/x402

**PM · news · Coinbase Agentic.Market launch (thread)** — [agentic.market](https://agentic.market)

_Main:_
> Coinbase quietly built the App Store for AI agents.
>
> Agentic.Market — 480k agents, 100k services, $50M volume, 165M transactions.
>
> OpenAI, AWS, Bloomberg already partners.
>
> agentic.market

_Reply:_
> Why it matters:
>
> Agents need data, tools, execution and payments — without humans managing keys and approvals.
>
> Agentic.Market lets them discover, pay in stablecoins, and call services autonomously via x402.
>
> three.ws is x402-native — every endpoint plugs in.
>
> three.ws/x402

### Fri 2026-05-22

**AM · feature · `<agent-3d>` web component** — [three.ws](https://three.ws)
> One tag. Any page. A 3D AI agent.
>
> `<script src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>`
> `<agent-3d body="/avatar.glb" brain="claude-sonnet-4-6"></agent-3d>`
>
> No framework. No build. Drop it in Webflow, Notion, Substack, or vanilla HTML.

**PM · feature · ERC-8004 onchain identity** — [three.ws](https://three.ws)
> Your agent gets a real identity.
>
> ERC-8004 on any EVM chain — agentId, owner wallet, delegated signer, IPFS-pinned manifest, signed action log.
>
> Every speak, remember, and skill call is cryptographically signed. Reputation that can't be forged.

### Sat 2026-05-23

**AM · feature · Metaplex Core on Solana** — [three.ws](https://three.ws)
> Solana support, no custom program.
>
> three.ws agents mint as Metaplex Core assets. Asset pubkey = agentId. Reputation and validation attestations anchored via SPL Memo. Program-free, indexable, composable.

**PM · feature · Talk mode + ARKit-52 lip-sync** — [three.ws](https://three.ws)
> Talk mode with ARKit-52 lip-sync.
>
> TTS audio is analyzed in real time and drives 52 standard blendshapes on the avatar. Mouth, jaw, tongue — all synced to the actual phonemes.
>
> Browser TTS for prototyping. ElevenLabs for production.

### Sun 2026-05-24

**AM · feature · Empathy Layer** — [three.ws](https://three.ws)
> Avatars that feel, not just react.
>
> The Empathy Layer is a weighted emotion blend — celebration, concern, curiosity, empathy, patience — each decaying at a different half-life and driving morph targets every frame.
>
> Not a state machine. A continuous expression engine.

**PM · feature · Skills system** — [three.ws](https://three.ws)
> Skills, not hardcoded tools.
>
> A three.ws skill is a self-contained bundle — description, tool defs, async handlers — loaded from IPFS, Arweave, or HTTP. Skills extend any agent's tool surface without code changes.
>
> Build once. Compose anywhere.

### Mon 2026-05-25

**AM · feature · Widget Studio** — [three.ws/studio](https://three.ws/studio)
> Widget Studio.
>
> Pick an avatar, a widget type, a pose, a background. Get a copy-paste embed snippet that works in any HTML page, CMS, or rich-text editor.
>
> Five widget types: turntable, gallery, talking, passport, hotspot tour.

**PM · feature · Embed Editor** — [three.ws/embed-editor](https://three.ws/embed-editor)
> WYSIWYG Embed Editor.
>
> Drag the camera. Pick the animation. Frame the shot. Set the background. Copy the snippet. Paste it on your site.
>
> No iframes to wrestle with. No CSS to tune. What you see is the embed.

### Tue 2026-05-26

**AM · feature · Five widget variants** — [three.ws/widgets](https://three.ws/widgets)
> Five widget variants, one component.
>
> 1. Turntable — auto-rotating showcase
> 2. Animation gallery — clip selector
> 3. Talking agent — full conversation
> 4. Passport card — onchain identity
> 5. Hotspot tour — guided walkthrough
>
> OG metadata + oEmbed built in.

**PM · feature · Launchpad** — [three.ws/launchpad](https://three.ws/launchpad)
> Launchpad — hosted public launch pages.
>
> Token drops, agent reveals, campaigns. Auto-generated at three.ws/p/[slug] with OG previews, embed code, and onchain links wired in.
>
> Build in /launchpad. Share anywhere.

### Wed 2026-05-27

**AM · feature · The Club (multiplayer venue)** — [three.ws/club](https://three.ws/club)
> The Club — multiplayer venue in your browser.
>
> Rigged dancers, audio tracks, tips, leaderboard, payout cron. Perf-aware renderer that auto-downgrades on slow frames so the room stays smooth on any device.

**PM · feature · Walk (Colyseus multiplayer)** — [three.ws/walk](https://three.ws/walk)
> Walk — authoritative multiplayer 3D.
>
> Colyseus server in /multiplayer, deployable on Fly.io. Authoritative state, low-latency sync, glTF avatars walking around together in a shared scene.

---

## Week 2

### Thu 2026-05-28

**AM · feature · Pose Studio** — [three.ws/pose-studio](https://three.ws/pose-studio)
> Pose Studio.
>
> Author and export reusable avatar poses. Bake them into agent manifests, share them as skills, drop them into widgets. Reusable kinematic expression for every agent on the platform.

**PM · feature · OAuth 2.1 server** — [three.ws](https://three.ws)
> Full OAuth 2.1 on three.ws.
>
> RFC 6749 + PKCE. Dynamic client registration (RFC 7591). Revocation (RFC 7009). Introspection (RFC 7662). Discovery (RFC 8414).
>
> Developer API keys with scopes and expiry. Production-grade auth in front of every endpoint.

### Fri 2026-05-29

**AM · feature · MCP server over HTTP** — [MCP Registry](https://registry.modelcontextprotocol.io/?q=three.ws)
> MCP server over HTTP.
>
> three.ws speaks Model Context Protocol — JSON-RPC 2.0 over HTTP. External AI systems can call agent tools, read manifests, and drive avatars programmatically.
>
> Listed on the MCP Registry.

**PM · feature · A2A — agent-to-agent** — [three.ws](https://three.ws)
> A2A — agent-to-agent.
>
> Client + server, MCP bridge, DID resolution, spending ledger, receipts storage. Agents transact autonomously via delegated signer wallets and EIP-7710 permissions.
>
> Agents that pay other agents. Without us in the middle.

### Sat 2026-05-30

**AM · feature · EIP-7710 delegated permissions** — [specs/PERMISSIONS_SPEC.md](https://github.com/nirholas/three.ws/blob/main/specs/PERMISSIONS_SPEC.md)
> EIP-7710 delegated permissions on three.ws.
>
> Agents authorize other agents to act on their behalf — scoped, time-bound, revocable. Skill royalties, sub-agents, payment delegations. Composable capability tokens.

**PM · feature · Reputation Registry** — [three.ws/reputation](https://three.ws/reputation)
> ReputationRegistry — onchain reputation, not vibes.
>
> Every speak, skill-done, and validate event is signed and logged. Reputation aggregates from the signed action history. Stake on agents you trust. Earn from their work.

### Sun 2026-05-31

**AM · feature · Validation Registry** — [specs/VALIDATORS.md](https://github.com/nirholas/three.ws/blob/main/specs/VALIDATORS.md)
> ValidationRegistry — third-party attestations.
>
> Validators sign claims about agents — capability, ownership, authenticity. Attestations are verifiable onchain. Reputation isn't self-declared.

**PM · feature · SIWX (Sign-In with X-chain)** — [three.ws](https://three.ws)
> SIWX — Sign-In with any chain.
>
> EVM, Solana, BSC. Standard sign-in messages, server-side verification, session tokens. Auth-gated paid endpoints. One sign-in flow, many chains.

### Mon 2026-06-01

**AM · feature · Permit2 gas-sponsoring** — [three.ws/x402](https://three.ws/x402)
> Permit2 on every CDP-settled x402 endpoint.
>
> Buyer signs an EIP-712 permit. Relayer pays the gas. Endpoint runs.
>
> Gasless paid APIs for the caller. Same atomic settlement for the seller.

**PM · feature · x402 SKU catalog + checkout** — [three.ws/dashboard/x402](https://three.ws/dashboard/x402)
> x402 SKU catalog + Stripe-style checkout.
>
> List endpoints as SKUs with prices, descriptions, sample payloads. Customers run a familiar checkout. Sellers see receipts, payouts, and admin tooling.

### Tue 2026-06-02

**AM · feature · MCP↔x402 bridge** — [three.ws](https://three.ws)
> MCP bridge — every paid tool, every protocol.
>
> An A2A bridge exposes x402 endpoints as MCP tools. MCP clients call paid APIs without knowing about x402. x402 clients discover MCP services via the bazaar.
>
> One mesh.

**PM · feature · x402 subscriptions + idempotency** — [three.ws/x402](https://three.ws/x402)
> x402 subscriptions on three.ws.
>
> Recurring USDC payments, settled by cron. Idempotency tokens for safe retries. Offer receipts that prove what was bought. Paid asset downloads for files behind a paywall.

### Wed 2026-06-03

**AM · feature · News CMS + syndication** — [three.ws/news](https://three.ws/news)
> News CMS + syndication.
>
> Write once in /admin/news. Auto-syndicate to WebSub, Dev.to, Medium, HackerNoon, CMC. Cross-post like a newsroom, not a side project.

**PM · feature · Solana Mobile (Seeker) MWA** — [three.ws](https://three.ws)
> three.ws on Solana Mobile (Seeker).
>
> MWA wallet wired into the web app. Release pipeline for the Solana Mobile dApp Store. Onchain agents on a phone designed for crypto.

---

## Week 3

### Thu 2026-06-04

**AM · feature · WASM vanity wallet grinder** — [three.ws/vanity-wallet](https://three.ws/vanity-wallet)
> WASM vanity wallet grinder.
>
> Pick a prefix or suffix. Grind in the browser, in WebAssembly, with all your cores. Vanity addresses without trusting a remote service.

**PM · feature · Pump.fun integration** — [three.ws/pumpfun](https://three.ws/pumpfun)
> Pump.fun, native.
>
> Launch tokens, search trends, view live feeds, place trades — from a 3D agent on three.ws. Skills bundle the whole flow. Pump.fun without leaving your avatar.

### Fri 2026-06-05

**AM · feature · Pump visualizer** — [three.ws/pump-visualizer](https://three.ws/pump-visualizer)
> Pump visualizer — pump.fun in 3D.
>
> Live token launches and trades, rendered in a real-time WebGL scene. Watch the market form. See the launches the moment they happen.

**PM · feature · DCA strategy execution** — [three.ws/strategy-lab](https://three.ws/strategy-lab)
> DCA on three.ws.
>
> Define a strategy. Onchain crons execute it. USDC → token, scheduled, durable. Strategy Lab to author and backtest. Fail-closed crons so missed runs don't double-spend.

### Sat 2026-06-06

**AM · feature · Onchain subscription crons** — [three.ws](https://three.ws)
> Onchain subscription crons.
>
> Recurring payments to creators, scheduled and executed onchain. Subscribers stay subscribed without us. Creators get paid without us.

**PM · feature · Chat SPA** — [three.ws/chat](https://three.ws/chat)
> three.ws/chat — full Svelte chat SPA.
>
> Model selector. Tools. Artifacts. Wallet. Per-team landing pages. Per-feature deep links. A complete AI workspace, embeddable and brandable.

### Sun 2026-06-07

**AM · feature · Claude Artifact viewer** — [three.ws/artifact](https://three.ws/artifact)
> Claude Artifact viewer on three.ws.
>
> Drop an artifact ID. Get a sandboxed, embeddable artifact view with the right boundaries. Snippet loading and sandbox boundaries documented in specs/CLAUDE_ARTIFACT.md.

**PM · feature · Avaturn integration** — [three.ws](https://three.ws)
> Avaturn integration on three.ws.
>
> Photo → avatar in seconds. Bring your face into a 3D agent without 3D software. Output writes straight into your three.ws account.

### Mon 2026-06-08

**AM · feature · Character Studio** — [three.ws](https://three.ws)
> Character Studio.
>
> In-browser 3D character builder. Body, face, outfit, accessories. Export a GLB. Mint as an agent. No DCC, no plugins.

**PM · feature · Privy embedded wallet** — [three.ws](https://three.ws)
> Privy embedded wallet on three.ws.
>
> Email sign-in creates a real wallet under the hood. Send, receive, sign, pay — without seed phrases. Users get an onchain identity without ever seeing crypto UX.

### Tue 2026-06-09

**AM · feature · Replicate avatar regeneration** — [three.ws](https://three.ws)
> Replicate-backed avatar regeneration.
>
> Don't like the avatar? Regenerate. New face, new outfit, new style, same agent. Compute provided by Replicate, results streamed into your agent's manifest.

**PM · feature · Voice cloning (ElevenLabs)** — [three.ws](https://three.ws)
> Voice cloning on three.ws.
>
> 3–10 seconds of speech → an ElevenLabs custom voice bound to your agent. Talk mode picks it up automatically. Your agent sounds like you.

### Wed 2026-06-10

**AM · feature · Persona Hub** — [three.ws](https://three.ws)
> Persona Hub on three.ws.
>
> Voice clone + persona extraction + memory seeding from connected accounts (X, GitHub, Farcaster). Your agent learns to talk like you from material you already wrote.

**PM · feature · Selfie reconstruction pipeline** — [three.ws](https://three.ws)
> Selfie → avatar engine.
>
> 3 selfies (left, center, right). Quality gates for lighting, framing, blur. Multi-view face reconstruction over a base body mesh. Rigged, animatable, mint-ready.

---

## Week 4

### Thu 2026-06-11

**AM · feature · Livepeer inference** — [three.ws](https://three.ws)
> Livepeer inference on three.ws.
>
> The Phase 4 open compute layer — decentralized GPUs serving agent inference. Onchain settlement per token. The agent runtime, off any single provider.

**PM · feature · ENS-based agent claim** — [specs/ENS_AGENT_CLAIM.md](https://github.com/nirholas/three.ws/blob/main/specs/ENS_AGENT_CLAIM.md)
> ENS-based agent claim.
>
> vitalik.eth → claim your agent. Verifiable owner↔agent binding through ENS. No new identity primitive. Use the one you already own.

### Fri 2026-06-12

**AM · feature · Stage spec** — [specs/STAGE_SPEC.md](https://github.com/nirholas/three.ws/blob/main/specs/STAGE_SPEC.md)
> Stage spec — every scene, declarative.
>
> Camera presets. Lighting rigs. Environment maps. Hotspots. Defined in JSON, rendered the same on every embed. No more "looks great on my screen."

**PM · feature · Validator attestations** — [specs/VALIDATORS.md](https://github.com/nirholas/three.ws/blob/main/specs/VALIDATORS.md)
> Validator attestations on three.ws.
>
> Validators sign verifiable claims about agents and skills. Anyone can verify the chain of trust without us.

### Sat 2026-06-13

**AM · feature · Agent marketplace** — [three.ws/marketplace](https://three.ws/marketplace)
> three.ws/marketplace.
>
> A browsable directory of agents. Each one with a passport card, an onchain ID, a price (if listed), and an embed code one click away.

**PM · feature · Discover** — [three.ws/discover](https://three.ws/discover)
> three.ws/discover.
>
> The public agent directory. Sorted, filtered, searchable. Find an agent. Talk to it. Embed it. Pay it. Build on it.

### Sun 2026-06-14

**AM · feature · glTF validator (browser)** — [three.ws/validation](https://three.ws/validation)
> Khronos-spec glTF validation, in the browser.
>
> Drop a GLB. Get line-level errors on geometry, materials, animations, extensions. No upload. No round-trip. The Khronos validator, running locally on your file.

**PM · feature · WebGL viewer** — [three.ws/app](https://three.ws/app)
> The three.ws WebGL viewer.
>
> Drag a GLB onto the page. Renders instantly with PBR, HDR environments, Draco, KTX2, Meshopt. Skinned meshes, morph targets, embedded cameras. WebGL 2.0, three.js r176.

### Mon 2026-06-15

**AM · feature · Avatar SDK** — [three.ws](https://three.ws)
> Avatar SDK on three.ws.
>
> Programmatic avatar creation — load, customize, animate, export. The same primitives that power the platform, on npm. Build avatar pipelines on top of ours.

**PM · feature · @nirholas/agent-kit** — [three.ws](https://three.ws)
> @nirholas/agent-kit.
>
> The agent runtime, distilled. Brain, tools, memory, skills, voice — all in a node-friendly SDK. Build agents that run anywhere, not just on three.ws.

### Tue 2026-06-16

**AM · feature · EVM agent payments SDK** — [three.ws](https://three.ws)
> agent-payments-sdk.
>
> x402 paid endpoints for any EVM chain. Base, BSC, and friends. CDP facilitator. Permit2 gas-sponsoring. Idempotency. Receipts. Settlement.
>
> The same SDK we use in production.

**PM · feature · Solana Agent SDK** — [three.ws](https://three.ws)
> solana-agent-sdk on three.ws.
>
> Metaplex Core mints. SIWS sign-in. SPL Memo–anchored attestations. Onchain agents on Solana, the same primitives we use on EVM.

### Wed 2026-06-17

**AM · feature · pump-fun MCP Cloudflare Worker** — [workers/pump-fun-mcp](https://github.com/nirholas/three.ws/tree/main/workers/pump-fun-mcp)
> pump-fun MCP Cloudflare Worker.
>
> A read-only mirror of the pump.fun MCP feed, deployable at the edge. Low-latency token data for any client, anywhere. Open-source in workers/pump-fun-mcp.

**PM · feature · Developer API keys** — [three.ws/dashboard](https://three.ws/dashboard)
> Developer API keys on three.ws.
>
> Scoped. Expirable. OAuth-issuable. Build apps and agents against three.ws without hand-rolling auth.

---

## Week 5

### Thu 2026-06-18

**AM · feature · OpenAPI 3.1 spec** — [three.ws/openapi.json](https://three.ws/openapi.json)
> three.ws/openapi.json.
>
> The whole API surface, in OpenAPI 3.1. Generate clients in any language. Audit endpoints. Wire in your own gateway. The platform, documented machine-first.

**PM · feature · Security hardening** — [specs/SECURITY.md](https://github.com/nirholas/three.ws/blob/main/specs/SECURITY.md)
> Hardened API surface.
>
> SSRF guard. CSRF gates. Header-origin pinning. Fail-closed crons. Every endpoint defaults to deny. Production hardening, not a checkbox.

### Fri 2026-06-19

**AM · feature · Memory system** — [specs/MEMORY_SPEC.md](https://github.com/nirholas/three.ws/blob/main/specs/MEMORY_SPEC.md)
> Agent memory on three.ws.
>
> Typed memory entries (user, feedback, project, reference) with salience scoring. Recalled into the system prompt at conversation time. Per-agent, signed, portable.

**PM · feature · Signed action log** — [three.ws](https://three.ws)
> Every action on three.ws is signed.
>
> Every speak, remember, skill-done, and validate event is logged with a cryptographic signature. The action history of your agent is auditable forever.

---

## Big-news queue

Ready-to-post entries. Drop these into the next open `AM` slot when the news is fresh; bump the displaced feature one slot forward. See [`README.md`](README.md) for the override flow.

### `news-alibaba-cloud-marketplace`
> three.ws is live on Alibaba Cloud Marketplace.
>
> Enterprises can now procure three.ws through their existing Alibaba account — consolidated billing, compliance, and support.
>
> Product → marketplace.alibabacloud.com/products/56724001/sgcmfw00036800.html

### `news-bnb-dappbay`
> three.ws is on BNB Chain Dappbay.
>
> Listed under AI Agent Launchpad · AI Data · AI Infra. The BNB community can vet, rank, and discover it.
>
> → dappbay.bnbchain.org/detail/three

### `news-mcp-registry`
> three.ws is in the MCP Registry.
>
> Any MCP-compatible AI client — Claude Desktop, Cursor, Claude Code — can discover and connect to three.ws as a tool source.
>
> → registry.modelcontextprotocol.io/?q=three.ws

### `news-x402scan`
> three.ws is on x402scan.
>
> Live receipts of every paid endpoint settlement. Inspect the bazaar's economy in real time.
>
> → x402scan.com/server/17cbd874-52ac-4920-a020-b22ff2489a07
