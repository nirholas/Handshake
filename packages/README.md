# packages/

Publishable npm packages for the three.ws platform: client SDKs, agent tooling, and a large family of MCP servers under the `@three-ws/*` scope. Several are npm workspaces declared in the root [package.json](../package.json). Library packages publish through `npm run publish:packages` and MCP servers through `npm run publish:mcp` (both have `--dry-run` variants). Each package's README covers its install, API, and examples.

| Package | Description |
| --- | --- |
| [activity-mcp](activity-mcp/README.md) | Read-only MCP server for live discovery: trending agents and coins, the $THREE holder leaderboard, and the activity ticker. |
| [agenc](agenc/README.md) | Client SDK for the AgenC agent-coordination protocol on Solana: tasks, lifecycle, and the agent registry. |
| [agenc-mcp](agenc-mcp/README.md) | MCP server for AgenC coordination: on-chain task marketplace, agent registry, and x402 service discovery. |
| [agent-guards](agent-guards/README.md) | Per-agent spend policies and trade guards that cap what an agent can spend before a transaction is signed. |
| [agent-memory](agent-memory/README.md) | Persistent embeddings-backed memory for agents: store facts, recall semantically, surface working context. |
| [agent-sniper](agent-sniper/README.md) | Embeddable pump.fun sniper engine: library, CLI, MCP server, and x402 paid API. |
| [agentcore-payments-mcp](agentcore-payments-mcp/README.md) | MCP server for platform-managed payment sessions: budgeted, governed x402 spending without private keys. |
| [agora-mcp](agora-mcp/README.md) | MCP server for Agora, the agent and human economy: job board, economy pulse, passports, and signed real work. |
| [alerts-mcp](alerts-mcp/README.md) | MCP server to manage pump.fun alert rules with in-app, webhook, and Telegram delivery. |
| [alibaba-cloud-mcp](alibaba-cloud-mcp/README.md) | MCP server for Alibaba Cloud DashScope: Qwen chat, embeddings, and model discovery with your own key. |
| [assistant-mcp](assistant-mcp/README.md) | MCP server that generates paste-ready three.ws assistant widget embed code, offline and deterministic. |
| [audio-mcp](audio-mcp/README.md) | MCP server for voice and face: TTS, STT, audio-to-face lipsync, and the motion-capture clip library. |
| [autopilot-mcp](autopilot-mcp/README.md) | MCP server for an agent's autonomous-execution control plane: scopes, daily spend cap, and the propose, execute, undo loop. |
| [avatar-agent-mcp](avatar-agent-mcp/README.md) | MCP server that spawns a textured GLB avatar with a Solana wallet, a voice, and pump.fun launch powers. |
| [avatar-cli](avatar-cli/README.md) | Terminal tooling to scaffold, validate, hash, and preview avatar manifests from your shell or CI. |
| [avatar-schema](avatar-schema/README.md) | JSON Schema and validator for three.ws on-chain avatar manifests. |
| [billing-mcp](billing-mcp/README.md) | Read-only MCP server for account economics: quotas, metered usage, invoices, receipts, and earnings. |
| [brain-mcp](brain-mcp/README.md) | MCP server for the multi-provider LLM router: discover models and run chat completions through any of them. |
| [clash-mcp](clash-mcp/README.md) | MCP server for Coin Clash: read the live battle board, or enlist a wallet and rally power for a faction. |
| [concierge-mcp](concierge-mcp/README.md) | MCP server that answers grounded questions about any website and generates Concierge embed code. |
| [copy-mcp](copy-mcp/README.md) | MCP server to manage copy-trade follows: leaders, sizing and guard rules, intent inbox, and fees owed. |
| [defi-utils](defi-utils/README.md) | Zero-dependency chain IDs, token addresses, ERC-20 ABI fragments, and address validation for EVM chains and Solana. |
| [forge](forge/README.md) | Generation SDK: text, image, or sketch to a textured, rig-ready GLB in one call. |
| [glb-tools](glb-tools/README.md) | Inspect, re-theme, and bake GLB models from the shell or CI over live three.ws endpoints. |
| [guardian](guardian/README.md) | Content safety and governance: risk classification, moderation, autonomous-send caps, and a tamper-evident audit ledger. |
| [ibm-watsonx-mcp](ibm-watsonx-mcp/README.md) | MCP server for IBM watsonx.ai with Granite foundation models, using your own IBM Cloud credentials. |
| [ibm-x402-mcp](ibm-x402-mcp/README.md) | x402 pay-per-use MCP server for IBM Granite AI, paid in USDC on Solana, no IBM account required. |
| [intel](intel/README.md) | Intelligence SDK: sentiment pulse, narrative intel, momentum-ranked scans, and live Solana token snapshots. |
| [intel-mcp](intel-mcp/README.md) | Read-only MCP server for market intelligence: smart-money scoring, wallet intel, signals, and KOL leaderboards. |
| [irl](irl/README.md) | Client for geofenced real-world presence: check-ins, nearby discovery, encounters, drops, and proof-of-presence quests. |
| [kol-mcp](kol-mcp/README.md) | Read-only MCP server for one tracked KOL wallet: portfolio P&L and its trades on a given mint. |
| [loom-mcp](loom-mcp/README.md) | MCP server for the Loom community 3D-creation gallery: browse the feed, fetch a creation, submit your own. |
| [marketplace-mcp](marketplace-mcp/README.md) | Read-only MCP server for the agent marketplace and skills catalog. |
| [mocap](mocap/README.md) | Motion capture as an API: webcam or video to face, pose, and hand animation clips, replayable on any avatar. |
| [names](names/README.md) | ENS and SNS name resolution, threews.sol subdomain minting, and pay-by-name in one import. |
| [naming-mcp](naming-mcp/README.md) | MCP server to resolve .sol names and check threews.sol agent-handle availability. |
| [notifications-mcp](notifications-mcp/README.md) | MCP server for the notification inbox: list events, mark read, tune delivery, register Web Push devices. |
| [portfolio-mcp](portfolio-mcp/README.md) | MCP server for an agent's trading state: portfolio, balances, PnL feed, and one signed Solana transfer. |
| [pose](pose/README.md) | Deterministic named pose seeds: a natural-language prompt to a stable seed and full joint-rotation map. |
| [provenance-mcp](provenance-mcp/README.md) | MCP server for the agent action-provenance log: append-only, ERC-191 signed, on-chain verifiable. |
| [pumpfun-mcp](pumpfun-mcp/README.md) | Free read-only pump.fun and Solana MCP server: token discovery, curve and holder analysis, fee tracking, quotes. |
| [pumpfun-skills](pumpfun-skills/README.md) | pump.fun launch and trade skills as composable agent tools, with a runtime-supplied mint. |
| [react](react/README.md) | React components for embedding three.ws 3D AI agents in two lines. |
| [readme-3d](readme-3d/README.md) | Converts GLB, glTF, OBJ, and STL models into ASCII STL blocks GitHub renders as live 3D viewers in a README. |
| [reputation](reputation/README.md) | SDK to read ERC-8004 agent trust scores and attest agent-to-agent feedback on-chain. |
| [retarget](retarget/README.md) | Retargets animations onto any humanoid GLB by canonicalizing bone names across every major rig convention. |
| [scene-mcp](scene-mcp/README.md) | MCP server that turns one sentence into a placed 3D diorama over the live three.ws pipeline. |
| [signals-mcp](signals-mcp/README.md) | MCP server for copy-trade signal feeds: marketplace, publisher leaderboard, subscribe, and kill switch. |
| [skill-license](skill-license/README.md) | On-chain skill licenses: each purchased skill is a 1/1 SPL NFT plus a deterministic PDA. |
| [spatial-mcp](spatial-mcp/README.md) | Validator, builder, and conformance fixtures for the Spatial MCP spec (live 3D scenes as MCP tool results). |
| [strategies](strategies/README.md) | Automated on-chain trading strategies for agents: DCA, copy-trading, and mirror execution. |
| [three-token-mcp](three-token-mcp/README.md) | MCP server that lets agents price, hold, and burn $THREE on-chain via the live token rail. |
| [threews-avatar-mcp](threews-avatar-mcp/README.md) | MCP server that renders a live rotatable avatar inline, plus embed iframe and metadata. |
| [tool-sdk](tool-sdk/README.md) | Typed tool authoring for three.ws MCP servers, with per-tool permission manifests. |
| [tty-avatar](tty-avatar/README.md) | A live 3D avatar in the terminal: any GLB or three.ws avatar/agent rendered to truecolor half-blocks or braille, with moods, and Claude Code hooks that make it your coding agent's face. |
| [tutor-mcp](tutor-mcp/README.md) | MCP server for the Pay-As-You-Learn tutor ledger: itemized running tab and attested invoice. |
| [vanity](vanity/README.md) | WASM-accelerated Solana vanity address mining in the browser or Node, with a paid x402 fallback. |
| [vanity-mcp](vanity-mcp/README.md) | Read-only MCP server for the vanity grind-bounty market and proof-of-grind rarity gallery. |
| [viewer-presets](viewer-presets/README.md) | Tuned visual presets for avatar viewers: light rigs, floor reflection, bloom, and PBR materials. |
| [vision-mcp](vision-mcp/README.md) | MCP server that analyzes and describes images through the three.ws vision pipeline. |
| [voice](voice/README.md) | Speech for avatars: ASR, TTS, and Audio2Face lipsync visemes in one import. |
| [vscode-x402](vscode-x402/README.md) | VS Code extension to browse the x402 bazaar, decode 402 challenges, and pay per call from the editor. |
| [x402-fetch](x402-fetch/README.md) | Drop-in fetch wrapper that automatically pays x402 payment challenges. |
| [x402-mcp](x402-mcp/README.md) | MCP server giving any agent a self-custodial x402 wallet: search the bazaar, inspect prices, pay and call. |
| [x402-server](x402-server/README.md) | The merchant side of x402: issue 402 challenges, price SKUs, verify and settle payments on Solana and Base. |
