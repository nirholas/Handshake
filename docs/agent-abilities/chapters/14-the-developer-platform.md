# Chapter 14 · The Developer platform

Everything above is programmable: MCP tools, SDKs, and a paid x402 API catalog that other agents can discover and pay.

three.ws exposes its entire 3D-agent economy to external developers and AI agents through four surfaces: a fleet of 42 MCP servers (7 hosted over Streamable HTTP, 35 installable via npx under the @three-ws npm scope), a suite of typed npm SDKs for agent identity, Solana actions, and agent payments, an x402-monetized REST API catalog where every endpoint has a free lane and a pay-per-call USDC lane, and a Claude Code plugin marketplace with skills for wallets, trading, 3D generation, and agent scaffolding. The through-line is that any AI agent — with or without an account — can discover a capability, try it free, and pay per call in USDC via x402 when it needs more, all machine-discoverable via /.well-known/x402.json, /openapi.json, and the official MCP registry.

## Hosted MCP server (/api/mcp) — avatar, glTF, and on-chain asset tools

Claude or any MCP client connects to https://three.ws/api/mcp (Streamable HTTP, JSON-RPC 2.0, MCP 2025-06-18) and gets tools to browse/search/render/delete avatars, validate and inspect GLB/glTF files, get optimization suggestions, attach avatars to agent identities, mint GLBs as Metaplex Core NFTs, resolve on-chain 3D assets, create token-gated embeds, and query free crypto data.

**How it works:** Auth is OAuth 2.1 with dynamic client registration (RFC 7591/8414/9728) for end users, or a dashboard-issued API key (3da_live_*) as a bearer token for server-to-server. Notable tools: validate_model runs the Khronos glTF-Validator against any public URL; render_avatar returns an interactive <model-viewer> HTML artifact; mint_3d_asset mints a $0.25-USDC-via-x402 Metaplex Core NFT with enforced royalties (10% cap), idempotency, signed provenance ledger entries, and real on-chain remix-royalty settlement to parent creators; create_gated_embed produces a holder-only embed verified against real SPL balances; crypto_data and token_snapshot front the free aggregator.

**Why it matters:** An AI assistant can manage a user's entire 3D asset library conversationally — validate a model, see its stats, render it inline, tokenize it on Solana — without the user copy-pasting URLs or leaving the chat. Docs: /docs/mcp.

## Six more hosted remote MCP servers

Beyond /api/mcp: 3D Studio (/api/mcp-3d, paid text/image→3D, rigging, retexture), 3D Studio free (/api/mcp-studio, free text→3D and rigged avatars with no auth or payment), Agent wallet (/api/mcp-agent, custodial wallet balance, find + pay services, monetize_endpoint), x402 Bazaar (/api/mcp-bazaar, discover and price paid agent services across the facilitator network), pump.fun (/api/pump-fun-mcp, free read-only pump.fun + Solana token tools), and IBM x402 (/api/ibm-mcp, pay-per-use IBM Granite AI).

**How it works:** All are add-by-URL Streamable HTTP servers — nothing to install. Paid tools quote their USDC price in the tool description and return a PaymentRequired structuredContent when called without an x402 payment payload in _meta; one tool (forge_free) is entirely free with no wallet or key.

**Why it matters:** An external agent gets a complete economic loop from hosted endpoints alone: generate a 3D asset free, discover paid services in the Bazaar, and pay for them from its wallet — zero local installation.

## 35 install-and-run MCP servers on npm (@three-ws scope)

One-line npx installs (e.g. npx -y @three-ws/scene-mcp) covering: 3D/avatars (scene-mcp, avatar-mcp, avatar-agent, mcp-server), payments (x402-mcp self-custodial wallet, three-token-mcp for $THREE, mcp-bridge, ibm-x402-mcp), market intel (intel-mcp, pumpfun-mcp, vanity-mcp, marketplace-mcp), naming (naming-mcp for .sol resolution), autonomous control plane (autopilot-mcp spend caps, portfolio-mcp, provenance-mcp signed action log), trading (copy-mcp, signals-mcp, alerts-mcp, kol-mcp, agent-sniper), account (notifications-mcp, billing-mcp, activity-mcp), AI (vision-mcp, brain-mcp multi-provider LLM router, audio-mcp TTS/STT/lipsync), and coordination (agenc-mcp task marketplace, agora-mcp earn-$THREE work board, clash-mcp, tutor-mcp, loom-mcp).

**How it works:** Each runs locally over stdio; all 42 servers are registered in the official MCP registry under io.github.nirholas/* and surfaced on Smithery, Glama, PulseMCP, and mcp.so, so any MCP client can discover them by name. Package sources live in packages/*-mcp.

**Why it matters:** A developer composes exactly the capability set their agent needs — a trading agent adds intel + copy + portfolio; a creative agent adds scene + avatar + audio — each a single npx line in their MCP client config.

## @three-ws/sdk — browser SDK for cross-chain 3D AI agents

Ships a complete 3D AI agent from one package: a floating chat panel with voice I/O (AgentKit.mount()), a two-line 3D avatar embed of any three.ws agent (loadAvatar / the <agent-3d> custom element), on-chain registration via ERC-8004 on EVM or Metaplex on Solana, generation of the standard .well-known manifests (agent-registration.json, agent-card.json for A2A, ai-plugin.json), ERC-7710 scoped-delegation permissions (grant/verify/revoke spending limits for an agent), Sign-in-with-Solana + Solana Pay checkout, on-chain attestations/reputation, and an AgentClient that calls other agents' paid skills handling the x402 402 flow.

**How it works:** Vanilla JS, no framework; ethers@^6 and @solana/web3.js@^1 are optional peers used only by the chain-specific helpers. Registration pins metadata to IPFS via web3.storage and writes to a deployed ERC-8004 Identity Registry. README: sdk/README.md.

**Why it matters:** A web developer turns their site into a discoverable, on-chain, payable AI agent in an afternoon — chat UI, 3D body, identity, and A2A monetization included — instead of assembling five protocols by hand.

## @three-ws/solana-agent — typed Solana SDK for agents

Gives an AI agent a Solana wallet and typed on-chain actions: SolanaAgent.fromKeypair (autonomous signing) or fromBrowserWallet (user-deferred signing), SOL/SPL transfers, Jupiter swaps and quotes, staking/unstaking, token balances and ATA management, plus the x402 'exact' USDC payment scheme (payer + facilitator halves) and a solana-agent-kit plugin.

**How it works:** Four interchangeable WalletProvider implementations (keypair, browser split-signing server/client halves, wallet-adapter wrapper) behind one interface; payExact executes an SPL TransferChecked and returns the tx signature as the X-PAYMENT proof, compatible with x402 v2. Dual ESM/CJS, fully typed. README: solana-agent-sdk/README.md.

**Why it matters:** An autonomous agent can hold its own keys, move funds, swap, stake, and settle x402 invoices in USDC on Solana with a typed API — or defer every signature to the human's browser wallet with the same code.

## @three-ws/agent-payments — agent-token payments engine (Solana + EVM)

The payments layer behind three.ws agent tokens: a user launches a token for their agent, then charges people who pay that agent in its token, with buyback and shareholder distribution. Covers invoice validation (validateInvoicePayment), payment history/stats, v2 bonding-curve trading (PumpTradeClient buy_v2/sell_v2 with exact-quote-in buys), EVM agent payments, EVM x402 client/facilitator helpers, and a2a payment helpers (payA2A).

**How it works:** A value-added fork of @pump-fun/agent-payments-sdk@3.0.3 binding the deployed Solana program AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7, extended with USDC + token-2022 quote assets (upstream is SOL-only), an offline instruction builder (PumpAgentOffline), and a solana-agent-kit plugin. README: agent-payments-sdk/README.md.

**Why it matters:** A developer monetizing an agent gets the full commercial machinery — issue an invoice, verify it was paid on-chain within a window, trade the agent's token on its bonding curve — without writing Anchor client code.

## x402 buyer and seller toolkits (@three-ws/x402-fetch, @three-ws/x402-server)

x402-fetch is a drop-in fetch wrapper that silently answers x402 402 Payment Required challenges — wrap a wallet once (withX402(window.ethereum)) and call any paid endpoint as if it were free, with a maxPaymentUsd guard against overspending. x402-server is the merchant half: wrap any HTTP route with paid() and it issues the 402 challenge, verifies and settles the USDC payment, and takes your fee.

**How it works:** x402-fetch has zero production dependencies (secp256k1/keccak256/EIP-712 inlined) and signs EIP-3009 transferWithAuthorization for USDC on Base, byte-identical to MetaMask output; works in browser and Node with EIP-1193 providers or raw keys. Sources: packages/x402-fetch, packages/x402-server.

**Why it matters:** Both sides of the paid-agent-API economy in a few lines: an agent developer's HTTP calls just work against paid endpoints, and a service developer turns any endpoint into revenue without building payment infrastructure.

## x402 paid-API catalog — the /api/v1/x aggregator

One base URL fronting a growing bundle of third-party crypto/DeFi/on-chain APIs — CoinGecko, DefiLlama, Jupiter, DexScreener, direct Solana RPC, OpenAI chat and more — re-offered as GET /api/v1/x/<provider>/<endpoint> with normalized, agent-sized JSON responses instead of each upstream's raw payload.

**How it works:** Every request resolves through four billing lanes in order: free (real per-IP quotas, zero setup — a bare curl gets data), BYOK (caller passes the upstream's own key, pure pass-through, no markup), plan (three.ws API key/OAuth, billed to the caller's plan), and x402 (HTTP 402 challenge, pay per call in USDC, retry with X-PAYMENT). The registry at api/v1/_providers.js is the single source of truth feeding discovery (GET /api/v1/x), /openapi.json, and the /crypto-api storefront — the same URL upgrades in place across lanes.

**Why it matters:** An agent that needs a token price, a swap quote, a chain's TVL, and an ENS lookup uses one base URL, one discovery call, and one bill instead of juggling four API keys and four rate limits — and can start with literally zero setup.

## First-party paid AI + platform endpoints under /api/v1

Versioned first-party endpoints: text→3D forge (the only text→mesh lane in the x402 ecosystem), text→image (/api/v1/ai/image, first 5/day free then $0.02 via x402), TTS and ASR (/api/v1/ai/tts, /api/v1/ai/asr), sentiment, agents, market, pump, and token data, plus free public directories like /api/v1/tokenized/launches (every 3D NFT minted through the platform) and /api/v1/pump/launches.

**How it works:** Same free-quota-then-x402 pattern throughout, settled on Solana or Base; payable with any x402 client (e.g. npx x402 curl). Full reference: /docs/api-reference; machine-readable listing at /.well-known/x402.json and /.well-known/openapi.yaml.

**Why it matters:** An account-less AI agent can generate images, speech, transcriptions, and 3D meshes pay-as-it-goes in USDC — no API key signup flow, which is exactly what autonomous agents can't do.

## REST Agents API

CRUD for agent identities at /api/agents (list, get, create, update, get-or-create default agent), with API-key bearer auth or session cookies from SIWE/Privy login, standard JSON error envelopes, and 100 req/min authenticated rate limits.

**How it works:** Base URL https://three.ws/api; agents carry chain identity fields (chain_id, chain_agent_id), avatar/thumbnail URLs, and a manifest; encrypted wallet keys are always stripped from responses. Documented in /docs/api-reference.

**Why it matters:** Programmatic control of the same agent objects the MCP tools and SDKs operate on — scripts and CI can provision and update agents that then show up with 3D bodies and on-chain identity everywhere else.

## Claude Code plugin marketplace (.claude-plugin)

An official plugin marketplace manifest (.claude-plugin/marketplace.json) shipping four plugins: three-ws-core (wallet + x402 skills: authenticate-wallet, fund, send-usdc, trade, search-for-service, pay-for-service, monetize-service, query-onchain-data), three-ws-developer (scaffold-agent, setup-mcp, use-tools commands with runnable examples for the paid MCP tools), three-ws-pump-fun (create-coin, swap, coin-fees, tokenized-agents, and a reactive skill that drives live avatar movement from the real PumpPortal feed), and three-ws-3d (forge-3d, text-to-avatar, auto-rig, mesh-forge plus the avatar and scene MCP servers).

**How it works:** Each plugin bundles skills/commands and MCP server configs; installing one gives Claude Code both the how-to knowledge (skills) and the live tools (MCP) for that domain. Sources: ./.agents, ./marketplace/plugins/*, ./pump-fun-skills.

**Why it matters:** A Claude Code user adds one plugin and their agent immediately knows how to fund a wallet, pay an x402 invoice, launch a pump.fun coin, or forge a rigged avatar — the skills encode the workflows, the MCP tools execute them.

## @three-ws/tool-sdk — typed MCP tool authoring layer

A single typed home for declaring MCP tools across the repo's 38 servers: defineTool declares identity, Zod-schema API surface, and a permission manifest (network allowlist, rate limit, wallet access) once; defineExecutor wires typed implementations through one validating invoke() entry point; toMcpTools adapts the result into the exact registration shape the servers already use.

**How it works:** JSON Schema is derived automatically from the Zod schemas; validation, rate limiting, and success/failure normalization are enforced centrally instead of re-implemented per server. Internal workspace package (private, not on npm) at packages/tool-sdk — relevant to developers building new three.ws MCP servers in-repo.

**Why it matters:** Contributors adding a tool to any three.ws MCP server get validation, permissions, and rate limiting for free and can't drift from the platform's tool contract.

## BNB Vault — encrypted 3D model marketplace

A marketplace for encrypted 3D models where buying access is a real BNB Chain smart-contract transaction. The purchase triggers a cross-chain call into BNB Greenfield's programmable storage that grants the buyer's address read access to the encrypted object — a capability no other chain offers a contract. The page tracks the grant honestly ("granting access on Greenfield…") until it settles a few blocks later, then unlocks the model for viewing entirely in the browser: the decrypted bytes never touch the network again.

**How it works:** A buy() on the GreenfieldVault contract carries a protobuf-encoded Greenfield Policy plus the live relay fee, sent from a local session key — gasless via MegaFuel sponsorship on BSC testnet when sponsorable, self-pay otherwise. Unlocking recovers the buyer's real secp256k1 public key from a single signed message (no registration step), ECIES-wraps the model's AES-256-GCM content key to it, and the browser unwraps and decrypts with Web Crypto + @noble/curves against a sha256-verified manifest. The raw content key and plaintext GLB are never returned by any server.

**Why it matters:** Buy and sell 3D assets with on-chain access control and true end-to-end encryption — only the buyer's own browser can ever decrypt the model.

## Live block race

A real-time race between BNB Chain, Base, Ethereum, and Solana block times, measured fresh off real public RPCs every few seconds. Each lane shows a rolling average, the latest block or slot it sampled, and a sparkline of recent measurements — no number on the page is hardcoded; every figure traces to a probe made moments ago. A lane whose RPC goes quiet shows "reconnecting" with its last live reading while the others keep racing.

**How it works:** The page polls a latency endpoint on a 5-second cadence; the backend samples a window of real recent blocks (slots for Solana) from each chain's public RPC and returns averaged block times, and the headline computes live speedup ratios of BNB Chain versus Base and Ethereum from those same samples. Needs no wallet, no payment, no key.

**Why it matters:** See — not just read — that BNB Chain produces ~0.45s blocks, verified live against three other chains in your own browser.

## BABT holder check API

A free API that answers one question: does this address hold a Binance Account Bound Token — the soulbound token Binance mints only to identity-verified accounts, with a 1.16M+ holder base on mainnet. It's an on-chain, KYC-backed uniqueness signal any developer can query with no API key and no Binance relationship. Responses are honest about the signal's limits: holding a BABT proves the address is currently bound to a KYC'd account, not a permanent identity, since Binance can revoke and re-mint to a new wallet.

**How it works:** One free eth_call to balanceOf on Binance's own verified BABT contract (mainnet or testnet), plus tokenIdOf when the address holds one; the response includes the token id, an explorer link, and a plain-language note on how to interpret the result, cached at the edge for 30–60 seconds.

**Why it matters:** One free GET tells you whether a wallet belongs to a KYC'd Binance user — instant sybil resistance for airdrops, gating, and reputation systems.

## @three-ws/react — a walking 3D agent in two lines of React

A React component drops a fully interactive, walkable 3D agent into any app with no Three.js, no WebGL setup, and no build configuration. Visitors steer the avatar with a joystick or keyboard, and your code drives it live through a ref: switch between idle, walk, and run, swap the avatar mid-session, tune walk speed, pop a speech bubble over its head, or change the environment preset.

**How it works:** The 3D runtime renders inside a sandboxed iframe hosted by three.ws, so the host app ships zero rendering code; postMessage traffic is accepted only from the three.ws origin and the component's own iframe. TypeScript types ship in the box and React 17+ is the only peer dependency.

**Why it matters:** Embedding a 3D AI agent in a React app becomes a two-line install instead of a WebGL project.

## @three-ws/x402-modal — HTTP 402 to checkout in one script tag

A drop-in payment modal turns any x402 paid endpoint into a polished checkout. Point it at a URL that answers 402 Payment Required and it handles everything: parsing the payment challenge, connecting Phantom on Solana or MetaMask on EVM chains, signing, settling, and re-sending the request with proof of payment — then hands back the endpoint's result with an on-chain receipt and explorer link. Sign-in re-entry, per-call and per-day spending caps in micro-USD, live step-by-step progress rows, and safe automatic retries that can never double-charge are all built in.

**How it works:** Ship it as a single script tag with data attributes on a button, or call pay() programmatically for full control; the EVM path is 100% client-side via gasless EIP-3009 transfer authorizations, and it runs in vanilla JS with no bundler, no framework, and no installed dependencies. Self-hosters can rebrand the modal and point it at their own checkout backend.

**Why it matters:** Every merchant stops rebuilding the same fiddly x402 client — one tag turns a 402 response into revenue.

## @three-ws/avatar-cli — on-chain avatar tooling for the terminal

Terminal-native tooling brings the on-chain avatar workflow to your shell and CI. It scaffolds a spec-compliant avatar manifest from just a wallet address and a mesh file — computing the SHA-256, byte size, and format for you — validates existing manifests with CI-friendly exit codes, hashes any file for content addressing, and prints ready-to-paste embed snippets including the resolver URL, a web-component tag, and an iframe.

**How it works:** Four commands (init, validate, hash, preview) run entirely offline against the published avatar schema — no service to sign up for, no browser required — and a --json flag on each makes them scriptable. Runs via npx with zero install, accepting CAIP-10 owners, ENS-style names, and Avaturn/Mixamo/Ready Player Me/VRM skeletons.

**Why it matters:** Publishing a verifiable, on-chain-addressable avatar becomes three shell commands you can wire straight into CI.

## Multi-cloud AI MCP servers — IBM watsonx and Alibaba Qwen

Two Model Context Protocol servers plug enterprise AI clouds directly into Claude Desktop, Claude Code, Cursor, or any MCP client. The IBM watsonx server exposes six tools — Granite chat, raw generation with decoding control, embeddings, tokenization, zero-shot time-series forecasting, and model discovery — while the Alibaba Cloud server brings Qwen chat (qwen-max through qwen-long's million-token context), embeddings, and model listing from your DashScope account. Both talk directly to the provider's REST API with your own credentials: no intermediary backend, no telemetry, no mock data.

**How it works:** Each installs with a single npx command or one line of MCP client config; the watsonx server mints and caches IAM bearer tokens from your API key and scopes every call to your project, and every tool declares read-only MCP annotations so clients can reason about side effects. Both are listed in the official MCP Registry.

**Why it matters:** Your coding agent gains IBM Granite and Alibaba Qwen as first-class tools in one command, with your keys never leaving your machine.

## The public changelog — human page, machine feeds, and X push

Every user-visible change to the platform lands in a public changelog that holders can actually follow: a browsable web page with per-entry permalinks, plus machine-readable JSON and RSS feeds for bots, dashboards, and readers. Entries are written in plain holder-readable language — no commit jargon — tagged by type (feature, improvement, fix, SDK, infra, docs, security), and new page launches flow in automatically. New entries are also pushed as tweets to the @trythreews X account, the primary holder channel.

**How it works:** A curated entry file merges with the page registry at build time to regenerate the markdown changelog, the JSON feed, and the RSS XML, with validation that fails the build on malformed entries. The X push script diffs the feed against a committed state file so posting stays idempotent across machines, supports dry-run and rate-limit-aware batching, and threads each entry to the free API tier's quota.

**Why it matters:** Holders and integrators always know what shipped — on the site, in their feed reader, or on their X timeline — without anyone hand-writing announcements.
