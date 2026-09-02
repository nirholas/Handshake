# 100 Stars: The Complete three.ws Open-Source Developer Ecosystem

github.com/nirholas/three.ws crossed 100 stars this week. Thank you to everyone who starred, forked, opened an issue, or shipped a pull request.

We want to use the moment for something more useful than a thank-you. Most people who star the repo have seen one corner of it: an avatar embed, an MCP server, an x402 endpoint. Almost nobody has seen the whole thing, because it has never been written down in one place. This is that document: every package, every server, every contract, every registry, every directory, and every integration where three.ws code lives, with the number behind each one. Every figure was pulled from the registry's own API on August 25, 2026, and the canonical source for all of it is three.ws/docs/open-source-footprint.

Everything below is Apache-2.0.

[IMAGE: github-100-stars-x.png]

---

## The headline numbers

- One repository: 9,508 commits, 21 contributors, 60 pull requests, 104 stars, 26 forks.
- 101 npm packages under the @three-ws scope, 42 of them MCP servers, 6,225 downloads in the last 30 days.
- 72 MCP servers in the official Model Context Protocol registry under one namespace, io.github.nirholas.
- 4,519 priced x402 endpoints in a live discovery catalog, 110,416 on-chain USDC settlements and 803,483 payment verifications through a facilitator we host ourselves.
- ERC-8004 identity, reputation, and validation registries at the same address on 12 EVM mainnets. Two Solana programs. Seven Solidity contracts. Four Rust crates.
- 3,000 validator attestations and 126,522 custody proofs written to Solana.
- 33 GPU and CPU workers, 27 of them as Docker images. 60 agent skills. 4 Claude Code plugins. 31 specs. 1,752 test files. 725 public pages.
- 111 related public repositories with 1,222 stars between them.

What follows is the long version.

---

## 1. The repository

three.ws is one monorepo. Inside it: the frontend (vanilla JS modules and Vite), the API (serverless-style handlers that run in one Cloud Run container), the multiplayer server (Colyseus), 70 workspace packages, 33 workers, the Solidity and Anchor contracts, the specs, the docs, and about 1,750 test files. `GET https://three.ws/api/version` returns the exact commit production is running, so anyone can check that what is deployed is what is on GitHub.

The contributor path is on the first screen of the README. CONTRIBUTING.md hands out scoped issues to newcomers, every package has a README (coverage under packages/, workers/, and services/ is 100 percent and enforced by a docs audit), and GitHub Discussions is open for questions.

Development is public in real time. A Telegram feed posts every commit to main, and 2,674 holder-readable changelog entries have gone out to @three_ws automatically since April.

---

## 2. npm: 101 packages under @three-ws

Everything on npm is installable today. Grouped by what it does:

**Put a 3D agent on a page**
- @three-ws/avatar, the official SDK: the 3D viewer, the creator iframe, the AR and VR runtime, and the emotion and lip-sync engine.
- @three-ws/react, React components for the same.
- @three-ws/agent-ui, an avatar overlay that reacts to buttons, inputs, and navigation.
- @three-ws/assistant, a full-body 3D avatar assistant in one script tag.
- @three-ws/concierge, a floating chat widget with a rigged avatar that blinks and lip-syncs.
- @three-ws/page-agent, a rigged agent that talks visitors through a page.
- @three-ws/walk, an animated avatar that walks and talks over your pages.
- @three-ws/tour, a 3D guide that walks across a live site and narrates its features.
- 3d-ar-studio, a full augmented-reality studio for any web page, and 3d-ar-studio-mcp for agents.
- readme-3d, interactive 3D models inside a GitHub README.

**Make and move 3D**
- @three-ws/forge, text, image, or sketch to a textured rig-ready GLB in one call, with a free TRELLIS lane.
- @three-ws/glb-tools, inspect, re-theme, and bake GLB models from a shell or CI.
- @three-ws/retarget, retarget any animation onto any humanoid GLB (Mixamo, VRM, Daz, MMD, and more).
- @three-ws/pose, deterministic named pose seeds for rigged avatars.
- @three-ws/mocap, webcam or video to face, pose, and hand animation clips.
- @three-ws/sign-language, compile text into one continuous American Sign Language clip.
- @three-ws/voice, ASR, TTS, and Audio2Face lip-sync visemes in one import.
- @three-ws/viewer-presets, tuned light rigs, floor reflections, bloom, and PBR materials.
- @three-ws/avatar-schema, the JSON Schema and validator for on-chain avatar manifests.
- @three-ws/avatar-cli, scaffold, validate, hash, and preview avatar manifests from the terminal.

**Give an agent a brain, memory, and guardrails**
- @three-ws/agent-runtime, the plan-and-execute decision loop with human-approval gates and a seven-layer guard chain.
- @three-ws/agent-memory, embeddings-backed persistent memory.
- @three-ws/agent-guards, per-agent spend policies and trade guards.
- @three-ws/guardian, content safety and governance (IBM Granite Guardian, NVIDIA NeMo) in one import.
- @three-ws/sdk, ship a cross-chain agent with EVM and Solana identity, a chat panel, and .well-known endpoints.
- @three-ws/agent-protocol-sdk, the on-chain agent-to-agent invocation protocol.

**Identity, names, reputation**
- @three-ws/reputation, read ERC-8004 trust scores and attest feedback on-chain.
- @three-ws/names, ENS and SNS resolution, *.threews.sol minting, and pay-by-name.
- @three-ws/vanity, mine Solana vanity addresses locally in Node or the browser, zero dependencies.
- @three-ws/skill-license, on-chain skill licenses as 1-of-1 SPL NFTs.
- @three-ws/onchain-agent-wallets, a Solana spending allowance for an agent instead of a private key.
- @three-ws/metaplex-agent-mcp, deploy an agent into the Metaplex Agent Registry in one atomic transaction.

**Pay and get paid (x402)**
- @three-ws/x402-server, the merchant side: turn any HTTP endpoint into a paid one.
- @three-ws/x402-fetch, a fetch wrapper that pays 402 challenges automatically.
- @three-ws/x402-modal and @three-ws/x402-payment-modal, drop-in payment modals with zero runtime dependencies.
- @three-ws/x402-mcp, a self-custodial x402 wallet for any AI agent.
- @three-ws/mcp-bridge, turn any x402-paid HTTP endpoint into a Claude-callable tool.
- @three-ws/agentcore-payments-mcp, budgeted payment sessions without holding a key.
- @three-ws/vscode-x402, browse the bazaar and pay per call from VS Code.

**Trade, launch, and watch markets**
- @three-ws/solana-agent, keypair and browser wallet, transfers, swaps, x402 exact scheme.
- @three-ws/agent-payments, the agent-token payments engine.
- @three-ws/pumpfun-skills, create a coin, swap on the curve or AMM, collect fees, as composable tools.
- @three-ws/agent-sniper, an embeddable multi-agent sniper engine.
- @three-ws/strategies, DCA, copy-trading, and mirror execution.
- @three-ws/intel, sentiment and momentum-ranked market intelligence.
- @three-ws/irl, geofenced real-world presence with proof-of-presence.
- @three-ws/agenc, a client for the AgenC coordination protocol on Solana.

**42 MCP servers on npm**, each one `npx`-runnable: activity, agenc, alerts, alibaba-cloud, assistant, audio, autopilot, avatar, avatar-agent, billing, brain, clash, concierge, copy, data-workbench, ibm-watsonx, ibm-x402, intel, kol, loom, marketplace, mcp-server, metaplex-agent, naming, notifications, portfolio, provenance, pumpfun, scene, signals, spatial, three-token, tutor, vanity, vision, x402, plus 3d-ar-studio-mcp, hood-mcp, robinhood-chain-mcp, and robinhood-mcp. Section 3 has what each one does.

**The Robinhood Chain family, 17 packages**: hoodchain, robinhood-chain, hood-js, hood-cli, hood-api, hood-connect, hood-alerts, hood-launcher, hood-traders, hoodkit, hood402, hood402-facilitator, @three-ws/hood-pay, hood-mcp, robinhood-chain-mcp, robinhood-mcp, and erc8056, the reference implementation of the corporate-actions standard. A complete open SDK stack for a chain that launched this summer.

---

## 3. MCP: 72 servers in the official registry

The Model Context Protocol registry at registry.modelcontextprotocol.io is where AI clients discover servers. Under one namespace, io.github.nirholas, three.ws publishes 72 of them. Any MCP-capable client can install any of these today.

**3D and avatars**: three.ws (the hosted server at three.ws/api/mcp behind OAuth 2.1), threews-3d-studio and threews-3d-studio-free (text and image to 3D, rigging, animation, stylize, retexture, segment), threews-avatar (render a live on-chain avatar inline), 3D-AI-Agent-Avatar, 3d-agent-mcp, 3d-ar-studio, scene-mcp (speak a diorama into being), loom-mcp (the community gallery), assistant-widget, concierge-mcp, audio-mcp (TTS, STT, audio-to-face), vision-mcp (free NVIDIA NIM vision models).

**Agents and identity**: threews-agent, metaplex-agent, onchain-agent-wallets, naming-mcp, provenance-mcp (an append-only, ERC-191-signed action log), validation-mcp-server, signing-mcp-server, keystore-mcp-server, ethereum-wallet-mcp, transaction-mcp-server, brain-mcp (any model, one interface), agenc-mcp, agora-mcp (join the agent workforce and earn $THREE), autopilot-mcp (a daily SOL cap and a $THREE buy-only mode), billing-mcp, notifications-mcp, alerts-mcp, activity-mcp, marketplace-mcp, tutor-mcp, clash-mcp.

**Payments**: x402-mcp, x402-bridge, threews-x402-bazaar, agentcore-payments-mcp, ibm-x402-mcp and ibm-x402-mcp-remote (pay-per-use IBM Granite in USDC, no IBM account), three-token-mcp (the first MCP server whose actions can burn a token).

**Markets and data**: threews-pumpfun and pumpfun-solana-mcp (23 free read-only pump.fun tools), pump-fun-sdk, pumpfun-claims-bot, intel-mcp, kol-mcp, signals-mcp, copy-mcp, portfolio-mcp, agent-sniper, data-workbench-mcp, crypto-market-data, free-crypto-news, universal-crypto-mcp, defi-agents, hood-mcp, robinhood-mcp, vanity-mcp.

**Enterprise clouds**: ibm-watsonx, alibaba-cloud.

**Developer tooling**: github-to-mcp (turn any GitHub repo into an MCP server), abi-to-mcp (turn any contract ABI into one), solidity-compiler, extract-llms-docs, tool-discovery-mcp, crypto-tools-registry, repo-intel, claude-code-explorer-mcp, mcp-notify, xactions.

Beyond the official registry: 18 of these are indexed on PulseMCP and 10 on Glama; a LobeHub plugin manifest lives at three.ws/lobehub/plugin.json; the three.ws 3D Studio is a live app in the OpenAI GPT Store; and four Claude Code plugins ship from the repo's own marketplace (`/plugin marketplace add nirholas/three.ws`): three-ws-core (wallet and x402 skills), three-ws-3d (text to 3D and rigged avatars), three-ws-pump-fun (on-chain launch and trade skills), and three-ws-developer (scaffold agents and configure servers).

[IMAGE: mcp-tools.png]

---

## 4. x402: the open payment stack

x402 is the HTTP 402 pay-per-call protocol. three.ws runs on it, and every piece of the implementation is in the repo.

- The facilitator is self-hosted, in api/_lib/x402/. It has processed 110,416 on-chain USDC settlements and 803,483 verifications. Nothing routes through a third party to settle on Solana.
- The discovery catalog at three.ws/.well-known/x402.json lists 4,519 priced endpoints, every one on Solana mainnet. x402scan indexes it and, since our facilitator registration merged upstream on 2026-08-11, counts our Solana settlements against it: 18,636 transactions and $1,055 of USDC volume as of 2026-09-02. 402index carries the endpoints too. The Coinbase CDP Bazaar does not: it indexes a service only after that service settles a payment through the CDP facilitator on Base, and every settlement here runs on our own Solana rail.
- The Receipt Vault at three.ws/receipts holds 58,907 signed Offer and Receipt artifacts, retrievable forever.
- The client side is published: x402-fetch for code, the two modals for any web page, x402-mcp and mcp-bridge for agents, and the VS Code extension (on the VS Code Marketplace and Open VSX) for people.
- The merchant side is published too: x402-server turns any endpoint into a paid one, and agentcore-payments-mcp gives an agent a budgeted session.
- Beyond the main repo, a 50-repository x402 suite under nirholas/* covers standalone paid services: bookings, flights, hotels, events, domains, disputes, refunds, recurring charges, group pay, gift agents, print and mail, OTP relay, shipping, research, and more. Each is a small, forkable example of one paid capability.
- The IBM Granite x402 server (ibm-x402-mcp) is, as far as we know, the first x402-enabled MCP server on IBM Cloud.

[IMAGE: x402.png]

---

## 5. On-chain: contracts, programs, attestations

- ERC-8004 identity, reputation, and validation registries are deployed by CREATE2 to the same address on 12 EVM mainnets (Ethereum, Optimism, BSC, Gnosis, Polygon, Mantle, Base, Arbitrum, Celo, Avalanche, Linea, Scroll), bytecode-verified. Identity is at 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 and Reputation at 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 on every one of them. The full Foundry implementation is in contracts/.
- Seven Solidity contracts: AgentPayments, IdentityRegistry, ReputationRegistry, ValidationRegistry, GreenfieldVault, WorldMoves, and the ThreeWSFactory for deterministic multichain addresses. The contracts that hold agent earnings, reputation stakes, and skill licenses are audit-ready, with a published threat model and invariants spec.
- Two Solana programs written in Anchor: agent-invocation and skill-license, plus program tests, and a vanity-grinder crate compiled to WASM that runs in the browser.
- On Solana the identity analog is Metaplex Core: the asset pubkey is the agent id, and SPL Memo anchors reputation and validation attestations. 3,000 validator attestations have been written under the threews.validation.v1 envelope, and 126,522 custody proofs across 244 epochs.
- Every coin launched through three.ws carries a mint address starting with 3ws, ground into the keypair itself.

---

## 6. Workers: the model fleet is open too

Thirty-three workers live under workers/, twenty-seven of them as Docker images you can build and run:

- Generation: model-hunyuan3d (Hunyuan3D 2.1 with a PBR lane), model-trellis, model-triposg, model-triposr, model-text2motion, garment-forge, agent-forge.
- Mesh pipeline: rig, remesh, texture, segment, stylize, rembg, avatar-reconstruction, avatar-pipeline-controller.
- Motion and vision: model-video2motion, model-video2scene, model-asl-recognition, longcat.
- Agents and markets: agent-sniper, agent-mm, agent-orders, agent-anchor, agent-screen-pool, agent-screen-worker, agora-citizens, oracle, robinhood-feed, okx-chat-bot, pump-fun-mcp (a Cloudflare Worker), vanity-grinder.

The production fleet runs these on Google Cloud Run GPUs (NVIDIA L4s and an RTX PRO 6000 Blackwell), and the same images run on your own hardware. Phase 4 of the roadmap, the open inference network, is already live in core: an open node-operator client (CPU and CUDA) registers under its own Solana key, claims jobs from /api/nodes, and returns signed receipts that verify offline.

[IMAGE: nvidia.png]

---

## 7. Agent skills and specs

Sixty SKILL.md skills ship in the repo for Claude Code and any agent that reads the format: authenticate a wallet, fund it, send USDC, trade, pay for a service, search the x402 bazaar, monetize an endpoint, generate a 3D model, create and rig an avatar, embed it, query on-chain data, triage production, plus the vendored MetaMask agent-wallet skills and a full OKX agent suite.

Thirty-one specs in specs/ are the contracts other code depends on: the agent manifest and 3D agent card, the avatar parameters, the embed host protocol, the permissions model, the memory spec, the skill spec and royalty split, the service catalog, the open inference protocol and receipts, the validators envelope, the reputation staking market, the spatial MCP shape (CC0), the economy contract invariants and threat model, and the x402-to-MPP bridge.

---

## 8. Integrations: editors, stores, and hosted apps

- Blender addon and ComfyUI nodes, both three.ws clients, in integrations/.
- VS Code extension on the VS Code Marketplace and Open VSX.
- A Chrome extension for the walking avatar.
- Hugging Face: the three-ws org, the avatar-viewer Space, the three-ws/avatars model repo, and a published blog post, "Giving AI agents bodies and wallets."
- Three GitHub Pages apps that run with no server and no account: the 3D AR Studio, the Metaplex agent deployer (mint an agent on Solana from a static page), and the on-chain agent wallets overview.
- The three.ws 3D Studio app in the OpenAI GPT Store, and an open pull request to the OpenAI Cookbook.
- LobeHub plugin manifest.
- A Solana Mobile dApp Store listing, Seeker-first.

---

## 9. Where it is listed and who we build with

- IBM: Business Partner, a dedicated Three.ws User Group on IBM Community with an IBM-authored welcome post and a recap of the first in-world meetup (3,145 peak concurrent avatars on August 7), an IBM Community founding blog post, and IBM's own post about three.ws on X.
- NVIDIA: Inception member, two write-ups on the NVIDIA Developer Forums (Nemotron in the text-to-3D pipeline, and NIM-powered translation into 100 languages), and NVIDIA hardware behind the fleet.
- AWS: Partner Network, an AWS Builder Center author profile with three published articles, and a SaaS metering integration built for AWS Marketplace.
- Google Cloud for Web3 Startups: production runs on Cloud Run, Vertex AI, and Imagen.
- Alibaba Cloud: a live product listing and storefront on the International Marketplace, and a feature on the marketplace blog.
- OpenAI: Select Partner.
- Quicknode Startup Program.
- BNB Chain Dappbay listing.
- Press: Yahoo Finance and Business Insider Markets on the IBM partnership; HackerNoon as a syndication partner.

[IMAGE: partners.png]

---

## 10. Open assets and open data

- 500+ CC0 3D props in the Object Library.
- 106 rigged characters in the Character Library, including CC0 additions.
- 3,000+ motion-capture animations, with a public motion-signature index.
- A crypto news archive of 740,889 articles from 197 publishers back to September 2017, with a free API tier.
- 723-plus public pages, llms.txt and llms-full.txt for machine readers, and an OpenAPI 3.1 spec at /openapi.json.

---

## 11. What is not published yet

So nobody has to guess: there is nothing on PyPI, crates.io, or Docker Hub yet, and the Smithery submission is drafted but not filed. The AWS Marketplace listing is built but not created. The OKX.AI listing is in resubmission. We would rather say that here than have someone find out.

---

## 12. Where $THREE fits

The platform coin is $THREE on Solana (FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump). In the open-source stack it shows up as three-token-mcp, the autopilot server's buy-only mode, the Metaplex deployer's holder fee waiver, the marketplace's only pricing currency, and the escrow token for the labor market and Agora bounties. The full case is at three.ws/docs/three-thesis.

---

## How to get involved

- Star and fork: github.com/nirholas/three.ws
- Pick a scoped issue from CONTRIBUTING.md
- Run one server: `npx -y @three-ws/pumpfun-mcp`, `npx -y @three-ws/x402-mcp`, `npx -y @three-ws/metaplex-agent-mcp`
- Put an avatar on a page: `npm i @three-ws/avatar`
- Read the specs and build against them: specs/
- Ask in GitHub Discussions, or come talk to us in the world at three.ws/play

[IMAGE: github-100-stars-ecosystem.png]

Thank you for the first hundred.
