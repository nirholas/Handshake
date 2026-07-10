# Chapter 14 · The Developer platform

Everything above is programmable: MCP tools, SDKs, and a paid x402 API catalog that other agents can discover and pay.

three.ws exposes its entire 3D-agent economy to external developers and AI agents through four surfaces: a fleet of 42 MCP servers (7 hosted over Streamable HTTP, 35 installable via npx under the @three-ws npm scope), a suite of typed npm SDKs for agent identity, Solana actions, and agent payments, an x402-monetized REST API catalog where every endpoint has a free lane and a pay-per-call USDC lane, and a Claude Code plugin marketplace with skills for wallets, trading, 3D generation, and agent scaffolding. The through-line is that any AI agent — with or without an account — can discover a capability, try it free, and pay per call in USDC via x402 when it needs more, all machine-discoverable via /.well-known/x402.json, /openapi.json, and the official MCP registry.

## Hosted MCP server (/api/mcp) — avatar, glTF, and on-chain asset tools

Claude or any MCP client connects to https://three.ws/api/mcp (Streamable HTTP, JSON-RPC 2.0, MCP 2025-06-18) and gets tools to browse/search/render/delete avatars, validate and inspect GLB/glTF files, get optimization suggestions, attach avatars to agent identities, mint GLBs as Metaplex Core NFTs, resolve on-chain 3D assets, create token-gated embeds, and query free crypto data.

**How it works:** Auth is OAuth 2.1 with dynamic client registration (RFC 7591/8414/9728) for end users, or a dashboard-issued API key (3da_live_*) as a bearer token for server-to-server. Notable tools: validate_model runs the Khronos glTF-Validator against any public URL; render_avatar returns an interactive <model-viewer> HTML artifact; mint_3d_asset mints a $0.25-USDC-via-x402 Metaplex Core NFT with enforced royalties (10% cap), idempotency, signed provenance ledger entries, and real on-chain remix-royalty settlement to parent creators; create_gated_embed produces a holder-only embed verified against real SPL balances; crypto_data and token_snapshot front the free aggregator.

**Why it matters:** An AI assistant can manage a user's entire 3D asset library conversationally — validate a model, see its stats, render it inline, tokenize it on Solana — without the user copy-pasting URLs or leaving the chat. Docs: /workspaces/three.ws/docs/mcp.md.

## Six more hosted remote MCP servers

Beyond /api/mcp: 3D Studio (/api/mcp-3d, paid text/image→3D, rigging, retexture), 3D Studio free (/api/mcp-studio, free text→3D and rigged avatars with no auth or payment), Agent wallet (/api/mcp-agent, custodial wallet balance, find + pay services, monetize_endpoint), x402 Bazaar (/api/mcp-bazaar, discover and price paid agent services across the facilitator network), pump.fun (/api/pump-fun-mcp, free read-only pump.fun + Solana token tools), and IBM x402 (/api/ibm-mcp, pay-per-use IBM Granite AI).

**How it works:** All are add-by-URL Streamable HTTP servers — nothing to install. Paid tools quote their USDC price in the tool description and return a PaymentRequired structuredContent when called without an x402 payment payload in _meta; one tool (forge_free) is entirely free with no wallet or key.

**Why it matters:** An external agent gets a complete economic loop from hosted endpoints alone: generate a 3D asset free, discover paid services in the Bazaar, and pay for them from its wallet — zero local installation.

## 35 install-and-run MCP servers on npm (@three-ws scope)

One-line npx installs (e.g. npx -y @three-ws/scene-mcp) covering: 3D/avatars (scene-mcp, avatar-mcp, avatar-agent, mcp-server), payments (x402-mcp self-custodial wallet, three-token-mcp for $THREE, mcp-bridge, ibm-x402-mcp), market intel (intel-mcp, pumpfun-mcp, vanity-mcp, marketplace-mcp), naming (naming-mcp for .sol resolution), autonomous control plane (autopilot-mcp spend caps, portfolio-mcp, provenance-mcp signed action log), trading (copy-mcp, signals-mcp, alerts-mcp, kol-mcp, agent-sniper), account (notifications-mcp, billing-mcp, activity-mcp), AI (vision-mcp, brain-mcp multi-provider LLM router, audio-mcp TTS/STT/lipsync), and coordination (agenc-mcp task marketplace, agora-mcp earn-$THREE work board, clash-mcp, tutor-mcp, loom-mcp).

**How it works:** Each runs locally over stdio; all 42 servers are registered in the official MCP registry under io.github.nirholas/* and surfaced on Smithery, Glama, PulseMCP, and mcp.so, so any MCP client can discover them by name. Package sources live in /workspaces/three.ws/packages/*-mcp.

**Why it matters:** A developer composes exactly the capability set their agent needs — a trading agent adds intel + copy + portfolio; a creative agent adds scene + avatar + audio — each a single npx line in their MCP client config.

## @three-ws/sdk — browser SDK for cross-chain 3D AI agents

Ships a complete 3D AI agent from one package: a floating chat panel with voice I/O (AgentKit.mount()), a two-line 3D avatar embed of any three.ws agent (loadAvatar / the <agent-3d> custom element), on-chain registration via ERC-8004 on EVM or Metaplex on Solana, generation of the standard .well-known manifests (agent-registration.json, agent-card.json for A2A, ai-plugin.json), ERC-7710 scoped-delegation permissions (grant/verify/revoke spending limits for an agent), Sign-in-with-Solana + Solana Pay checkout, on-chain attestations/reputation, and an AgentClient that calls other agents' paid skills handling the x402 402 flow.

**How it works:** Vanilla JS, no framework; ethers@^6 and @solana/web3.js@^1 are optional peers used only by the chain-specific helpers. Registration pins metadata to IPFS via web3.storage and writes to a deployed ERC-8004 Identity Registry. README: /workspaces/three.ws/sdk/README.md.

**Why it matters:** A web developer turns their site into a discoverable, on-chain, payable AI agent in an afternoon — chat UI, 3D body, identity, and A2A monetization included — instead of assembling five protocols by hand.

## @three-ws/solana-agent — typed Solana SDK for agents

Gives an AI agent a Solana wallet and typed on-chain actions: SolanaAgent.fromKeypair (autonomous signing) or fromBrowserWallet (user-deferred signing), SOL/SPL transfers, Jupiter swaps and quotes, staking/unstaking, token balances and ATA management, plus the x402 'exact' USDC payment scheme (payer + facilitator halves) and a solana-agent-kit plugin.

**How it works:** Four interchangeable WalletProvider implementations (keypair, browser split-signing server/client halves, wallet-adapter wrapper) behind one interface; payExact executes an SPL TransferChecked and returns the tx signature as the X-PAYMENT proof, compatible with x402 v2. Dual ESM/CJS, fully typed. README: /workspaces/three.ws/solana-agent-sdk/README.md.

**Why it matters:** An autonomous agent can hold its own keys, move funds, swap, stake, and settle x402 invoices in USDC on Solana with a typed API — or defer every signature to the human's browser wallet with the same code.

## @three-ws/agent-payments — agent-token payments engine (Solana + EVM)

The payments layer behind three.ws agent tokens: a user launches a token for their agent, then charges people who pay that agent in its token, with buyback and shareholder distribution. Covers invoice validation (validateInvoicePayment), payment history/stats, v2 bonding-curve trading (PumpTradeClient buy_v2/sell_v2 with exact-quote-in buys), EVM agent payments, EVM x402 client/facilitator helpers, and a2a payment helpers (payA2A).

**How it works:** A value-added fork of @pump-fun/agent-payments-sdk@3.0.3 binding the deployed Solana program AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7, extended with USDC + token-2022 quote assets (upstream is SOL-only), an offline instruction builder (PumpAgentOffline), and a solana-agent-kit plugin. README: /workspaces/three.ws/agent-payments-sdk/README.md.

**Why it matters:** A developer monetizing an agent gets the full commercial machinery — issue an invoice, verify it was paid on-chain within a window, trade the agent's token on its bonding curve — without writing Anchor client code.

## x402 buyer and seller toolkits (@three-ws/x402-fetch, @three-ws/x402-server)

x402-fetch is a drop-in fetch wrapper that silently answers x402 402 Payment Required challenges — wrap a wallet once (withX402(window.ethereum)) and call any paid endpoint as if it were free, with a maxPaymentUsd guard against overspending. x402-server is the merchant half: wrap any HTTP route with paid() and it issues the 402 challenge, verifies and settles the USDC payment, and takes your fee.

**How it works:** x402-fetch has zero production dependencies (secp256k1/keccak256/EIP-712 inlined) and signs EIP-3009 transferWithAuthorization for USDC on Base, byte-identical to MetaMask output; works in browser and Node with EIP-1193 providers or raw keys. Sources: /workspaces/three.ws/packages/x402-fetch, /workspaces/three.ws/packages/x402-server.

**Why it matters:** Both sides of the paid-agent-API economy in a few lines: an agent developer's HTTP calls just work against paid endpoints, and a service developer turns any endpoint into revenue without building payment infrastructure.

## x402 paid-API catalog — the /api/v1/x aggregator

One base URL fronting a growing bundle of third-party crypto/DeFi/on-chain APIs — CoinGecko, DefiLlama, Jupiter, DexScreener, direct Solana RPC, OpenAI chat and more — re-offered as GET /api/v1/x/<provider>/<endpoint> with normalized, agent-sized JSON responses instead of each upstream's raw payload.

**How it works:** Every request resolves through four billing lanes in order: free (real per-IP quotas, zero setup — a bare curl gets data), BYOK (caller passes the upstream's own key, pure pass-through, no markup), plan (three.ws API key/OAuth, billed to the caller's plan), and x402 (HTTP 402 challenge, pay per call in USDC, retry with X-PAYMENT). The registry at /workspaces/three.ws/api/v1/_providers.js is the single source of truth feeding discovery (GET /api/v1/x), /openapi.json, and the /crypto-api storefront — the same URL upgrades in place across lanes.

**Why it matters:** An agent that needs a token price, a swap quote, a chain's TVL, and an ENS lookup uses one base URL, one discovery call, and one bill instead of juggling four API keys and four rate limits — and can start with literally zero setup.

## First-party paid AI + platform endpoints under /api/v1

Versioned first-party endpoints: text→3D forge (the only text→mesh lane in the x402 ecosystem), text→image (/api/v1/ai/image, first 5/day free then $0.02 via x402), TTS and ASR (/api/v1/ai/tts, /api/v1/ai/asr), sentiment, agents, market, pump, and token data, plus free public directories like /api/v1/tokenized/launches (every 3D NFT minted through the platform) and /api/v1/pump/launches.

**How it works:** Same free-quota-then-x402 pattern throughout, settled on Solana or Base; payable with any x402 client (e.g. npx x402 curl). Full reference: /workspaces/three.ws/docs/api-reference.md; machine-readable listing at /.well-known/x402.json and /.well-known/openapi.yaml.

**Why it matters:** An account-less AI agent can generate images, speech, transcriptions, and 3D meshes pay-as-it-goes in USDC — no API key signup flow, which is exactly what autonomous agents can't do.

## REST Agents API

CRUD for agent identities at /api/agents (list, get, create, update, get-or-create default agent), with API-key bearer auth or session cookies from SIWE/Privy login, standard JSON error envelopes, and 100 req/min authenticated rate limits.

**How it works:** Base URL https://three.ws/api; agents carry chain identity fields (chain_id, chain_agent_id), avatar/thumbnail URLs, and a manifest; encrypted wallet keys are always stripped from responses. Documented in /workspaces/three.ws/docs/api-reference.md.

**Why it matters:** Programmatic control of the same agent objects the MCP tools and SDKs operate on — scripts and CI can provision and update agents that then show up with 3D bodies and on-chain identity everywhere else.

## Claude Code plugin marketplace (.claude-plugin)

An official plugin marketplace manifest (/workspaces/three.ws/.claude-plugin/marketplace.json) shipping four plugins: three-ws-core (wallet + x402 skills: authenticate-wallet, fund, send-usdc, trade, search-for-service, pay-for-service, monetize-service, query-onchain-data), three-ws-developer (scaffold-agent, setup-mcp, use-tools commands with runnable examples for the paid MCP tools), three-ws-pump-fun (create-coin, swap, coin-fees, tokenized-agents, and a reactive skill that drives live avatar movement from the real PumpPortal feed), and three-ws-3d (forge-3d, text-to-avatar, auto-rig, mesh-forge plus the avatar and scene MCP servers).

**How it works:** Each plugin bundles skills/commands and MCP server configs; installing one gives Claude Code both the how-to knowledge (skills) and the live tools (MCP) for that domain. Sources: ./.agents, ./marketplace/plugins/*, ./pump-fun-skills.

**Why it matters:** A Claude Code user adds one plugin and their agent immediately knows how to fund a wallet, pay an x402 invoice, launch a pump.fun coin, or forge a rigged avatar — the skills encode the workflows, the MCP tools execute them.

## @three-ws/tool-sdk — typed MCP tool authoring layer

A single typed home for declaring MCP tools across the repo's 38 servers: defineTool declares identity, Zod-schema API surface, and a permission manifest (network allowlist, rate limit, wallet access) once; defineExecutor wires typed implementations through one validating invoke() entry point; toMcpTools adapts the result into the exact registration shape the servers already use.

**How it works:** JSON Schema is derived automatically from the Zod schemas; validation, rate limiting, and success/failure normalization are enforced centrally instead of re-implemented per server. Internal workspace package (private, not on npm) at /workspaces/three.ws/packages/tool-sdk — relevant to developers building new three.ws MCP servers in-repo.

**Why it matters:** Contributors adding a tool to any three.ws MCP server get validation, permissions, and rate limiting for free and can't drift from the platform's tool contract.
