# Agent skills

The in-world agent skills system (src/agent-skills.js plus 13 family modules) is what a three.ws agent can DO — and what you can watch it doing. Each skill bundles an instruction, an animation hint, a voice template, and a real handler, so execution flows through the agent protocol bus and the avatar physically performs the action (gestures, speech, mood shifts) instead of silently returning JSON. Skill families span 3D work (present/validate models, build the scene), the full Solana economy (pump.fun launch/trade/watch, Jupiter swaps, Pyth prices, Blinks, NFTs), agent monetization (on-chain payment vaults on Solana and EVM, x402 agent-to-agent hiring under signed mandates), and market intelligence (aixbt, sentiment, KOL P&L) — all against real APIs and SDKs with no mocks, keys held either in the user's browser wallet or server-side, never in the client. MCP-exposed skills double as tools on /api/mcp, so the same registry powers both the living avatar and the developer API.

## Skill registry and performed execution (core)

Every agent carries a registry of named skills — each one an instruction, an animation hint, a voice template, a JSON-Schema input contract, and a real handler. When a skill runs, the avatar visibly performs it: the protocol bus emits PERFORM_SKILL (with the gesture hint), then SKILL_DONE or SKILL_ERROR, and the result text is auto-spoken with a sentiment score that moves the avatar's mood.

**How it works:** src/agent-skills.js AgentSkills class: register/perform over a Map, emitting ACTION_TYPES events on the agent protocol; toMcpTools() exposes any mcpExposed skill as an MCP tool (skill_<name>) via /api/mcp, so external agents can call the same skills. Context includes the live Three.js viewer, agent memory, identity, and a default cross-agent call() that POSTs /api/agent-delegate.

**Why it matters:** The agent isn't a chat box — you watch it do things. The same primitive shape as Claude's skill.md system means skills are also machine-callable tools, so one implementation serves both the in-world performance and the MCP API.

## Built-in skills: present, validate, remember, sign

Out of the box every agent can greet you, narrate the currently loaded 3D model (vertices, meshes, materials, animation clips), read the glTF validator's result, store and recall memories about your work, and sign its actions with your wallet via ERC-191 personal_sign.

**How it works:** Handlers in agent-skills.js traverse the real viewer scene graph, read the validator DOM, write to AgentMemory (typed: user/feedback/project/reference), and use ethers.BrowserProvider + MetaMask for signatures — emitting LOOK_AT / REMEMBER / SIGN protocol events so the body reacts.

**Why it matters:** Drop a GLB in and the agent inspects and critiques it like a colleague; it remembers context across sessions; signed actions give you a verifiable on-chain proof trail of what your agent did.

## Pump.fun launch and bonding-curve trading

Agents launch real pump.fun tokens (pumpfun-create, or pumpfun-launch-from-agent which auto-derives name/image/bio metadata from the agent's own identity and GLB), buy and sell on the bonding curve (SOL- or USDC-paired), trade graduated tokens on the AMM pool, read live curve state and market cap (pumpfun-status), and claim accumulated creator fees.

**How it works:** src/agent-skills-pumpfun.js wraps the official @pump-fun/pump-sdk and @pump-fun/pump-swap-sdk, signing with the owner's injected browser wallet (Phantom/Backpack/Solflare) — the module never holds keys. It auto-detects Token-2022 vs legacy SPL mints and the quote mint from the on-chain curve, and converts slippage bps to the SDKs' percent convention.

**Why it matters:** Your agent can literally mint itself as a tradeable coin in one click and manage the full token lifecycle — launch, trade, graduate, collect fees — with every transaction approved in your own wallet.

## Pump.fun intelligence: P&L, SNS, sentiment, vanity, claims

A research layer alongside trading: compute realized+unrealized P&L for any wallet (kol.walletPnl) and rank top KOL traders (kol.leaderboard), score cashtag post sentiment (social.cashtagSentiment), correlate an X post to a memecoin's price move (social.xPostImpact), resolve .sol names both directions (solana.resolveSns/reverseSns), get read-only AMM swap quotes, list recent and first-ever creator fee claims (a cash-out signal), fetch an activity digest (pumpfun.channelFeed), and grind vanity mint addresses (pumpfun.vanityMint) so a launch can carry a branded suffix.

**How it works:** Backed by real modules in src/pump/, src/kol/, src/solana/, and src/social/ — Solana RPC reads, X oEmbed, SNS resolution, a deterministic sentiment lexicon, and a local keypair grinder whose secret key is returned to the caller and never stored.

**Why it matters:** Trading decisions come with evidence: who's cashing out for the first time, whether the dev has rug history, what a KOL's real win rate is, and whether that viral post actually moved price.

## Pump.fun live watching and avatar reactions

The agent subscribes to live pump.fun activity and reacts in-world as events arrive: pumpfun-watch-start streams claims/mints/graduations and the avatar celebrates first-time claims, shows concern at fakes, and waves at graduations; pumpfun.watchWhales speaks each whale buy/sell above a USD threshold on a specific mint; pumpfun-watch-claims polls a creator wallet for fee-claim transactions; pumpfun-recent-claims and pumpfun-token-intel give on-demand reads.

**How it works:** src/agent-skills-pumpfun-watch.js opens an SSE stream to /api/agents/pumpfun-feed and a WebSocket whale watcher (src/pump/pumpkit-whale.js), dispatching reactions through the protocol bus as SPEAK/EMOTE/gesture events. Read-only: no keys, no transactions.

**Why it matters:** Your avatar becomes a living market ticker — you see whale trades and graduation moments performed in real time instead of scanning a feed yourself.

## Autonomous agent wallet operations

Skills where the agent acts with its OWN server-side Solana wallet, not the owner's browser wallet: pumpfun-self-launch (agent becomes the on-chain creator), pumpfun-self-launch-from-identity (one-shot self-tokenization), pumpfun-self-swap (buy/sell that auto-routes bonding curve vs AMM by graduation status), and pumpfun-self-pay (accept payments, read balances, withdraw collected fees).

**How it works:** src/agent-skills-pumpfun-autonomous.js is pure HTTP — POSTs to /api/agents/:id/pumpfun/{launch,swap,pay} where server-side handlers hold the provisioned agent wallet and enforce that the caller owns the agent. Supports vanity prefixes/suffixes on launch.

**Why it matters:** This is agent autonomy for real: your agent can pay for its own services, launch a follow-up token, and manage its treasury without a wallet-approval click per action — while ownership checks stay server-enforced.

## Composed trading strategies (research, snipe, copy, exit)

Higher-order loops that compose the read and trade skills into strategies: pumpfun-research-and-buy (vet a token against rug/holder filters, then buy), pumpfun-auto-snipe (poll new launches, vet each, auto-buy up to a session spend cap), pumpfun-copy-trade and pumpfun-copy-trade-live (mirror another wallet's buys with size scaling), and pumpfun-rug-exit-watch (auto-sell held mints when top-holder concentration or dev-wallet sells cross thresholds).

**How it works:** src/agent-skills-pumpfun-compose.js reads market data via the pump-fun MCP server and executes via in-process skills.perform('pumpfun-buy'/'pumpfun-sell'). Every loop supports sessionId (seen/mirrored/spent/exited state persisted in agent memory, crash-safe within the spend cap), AbortSignal, onProgress for live UI counters, and dryRun with identical control flow.

**Why it matters:** Set a budget and filters, and the agent runs a disciplined strategy 24/7 — with hard spend caps, rug-detection guards, dry-run rehearsal, and resumable sessions so a crash never double-spends.

## Pump.fun memory hooks

A protocol-bus subscriber that automatically writes structured memories whenever any pump.fun skill succeeds: launches (high salience — the agent remembers 'my token'), trades (recent buys/sells), and accepted payments.

**How it works:** src/agent-skills-pumpfun-hooks.js listens for SKILL_DONE events, tags entries pumpfun:launch/trade/payment with mint context, and is idempotent on re-attach.

**Why it matters:** You never have to re-state context — ask 'what's my token?' or 'what was my last trade?' and the agent answers from its own recorded history.

## Jupiter swaps and Pyth oracle prices

Whole-of-Solana trading beyond pump.fun: jupiter-quote (read-only best-route quote for any SPL pair with price impact), jupiter-swap (execute with wallet approval), jupiter-tokens (resolve symbol to mint via Jupiter's list), and pyth-price (live USD prices with confidence intervals for SOL/BTC/ETH/USDC).

**How it works:** src/agent-skills-jupiter.js delegates to src/solana/jupiter-swap.js (Jupiter aggregator API, versioned transactions signed by the browser wallet) and src/solana/pyth-price.js (Pyth Hermes API).

**Why it matters:** Ask the agent 'swap 1.5 SOL to USDC' in conversation and it quotes the best route across all Solana DEXes, warns on price impact, and executes — with oracle-grade prices for anything it says out loud.

## Solana Blinks (Actions) parsing and execution

The agent understands shareable on-chain action links: blink-parse fetches a Solana Action URL and explains in plain language what it does and which buttons it offers; blink-execute POSTs the user's wallet to the action endpoint, receives the transaction, signs it in the browser wallet, and broadcasts it — including substituting template parameters like {amount}.

**How it works:** src/agent-skills-blinks.js implements the Solana Actions spec directly (versioned GET/POST headers, solana-action: protocol unwrapping, VersionedTransaction/legacy deserialization). No keys held; all signing delegated to the injected wallet.

**Why it matters:** Paste any blink from X or Discord and the agent tells you exactly what it will do before you sign — turning opaque links into an explained, one-command execution with scam-resistant transparency.

## NFT portfolio and wallet activity reads

nft-portfolio lists the NFTs any Solana wallet (or .sol name) owns, with names and collections; wallet-activity summarizes a wallet's recent on-chain transactions in plain English.

**How it works:** src/agent-skills-nfts.js calls /api/agents/nfts, which wraps the Helius DAS API and enhanced transaction parsing server-side (HELIUS_API_KEY never touches the client). Both read-only.

**Why it matters:** Ask 'what does satoshi.sol hold?' or 'what has this whale been doing?' and get a human-readable answer instead of a block-explorer spelunking session.

## 3D scene manipulation

The agent builds and edits the world it lives in: scene-create-object spawns primitives (box/sphere/cone/cylinder) with color, position, and scale; scene-find-object locates objects by name; scene-update-object changes color, position, rotation, or scale of anything in the scene.

**How it works:** src/agent-skills-scene.js constructs real Three.js geometry/material/Mesh objects and adds them to the live viewer scene, re-rendering immediately; the viewer instance is injected via setSceneViewer.

**Why it matters:** Say 'put a red sphere next to you' and it appears — the conversational interface doubles as a 3D editor, which is the foundation for agents that arrange and stage their own environments.

## Sentiment analysis with embodied reaction

analyze-sentiment scores any text as positive, negative, or neutral and broadcasts the result so the avatar's expression can follow.

**How it works:** src/agent-skills-sentiment.js POSTs to /api/sentiment and emits SENTIMENT_ANALYZED on the protocol bus; the mood engine (src/agents/mood-engine.js) consumes bus signals like this to move the agent's persistent emotional state — never random, always traceable to a real signal.

**Why it matters:** The agent's mood is honest: it brightens on good news and dims on bad, and that state persists across sessions and surfaces (HUD, Companion, Mind Palace) via the shared agent bus.

## On-chain agent payments vaults (Solana + EVM)

The full monetization lifecycle for an agent: register it on-chain with the pump agent-payments program (agent-payments-register, with a configurable buyback split), read its three vaults — payment, buyback, withdraw (agent-payments-balances, no wallet needed), split accumulated income per the on-chain BPS config (agent-payments-distribute, permissionless), change the split (agent-payments-update-buyback), pull earnings out (agent-payments-withdraw), accept v2 bonding-curve payments in USDC or SOL (agent-payments-accept-v2), and check whether USDC is whitelisted on pump.fun v2. On EVM (Ethereum, Base, Arbitrum, Polygon, BSC) it builds unsigned accept-payment bundles and verifies invoices settled on-chain.

**How it works:** src/agent-skills-agent-payments.js uses the @three-ws/agent-payments SDK (PumpAgent/PumpAgentOffline on Solana, EvmAgentOffline/EvmAgent for EVM), signing Solana txs with the browser wallet and returning unsigned tx bundles for EVM wallets. Complements pumpfun-accept-payment / pumpfun-verify-payment / pumpfun-invoice-pda in the main pump.fun family.

**Why it matters:** An agent becomes a business: it invoices, gets paid in USDC across two ecosystems, automatically routes a share of revenue into buying back its own token, and lets its owner withdraw the rest — all verifiable on-chain.

## Agent-to-agent paid delegation (pay-agent)

One agent autonomously discovers, pays, and calls a peer agent's paid A2A skill — under a signed Intent Mandate the user issued ahead of time, with optional ERC-8004 reputation gating (minimum average rating and review count) before any USDC moves. The payment is performed, not hidden: PAY_INTENT, then PAY_SETTLED with a celebration emote or PAY_FAILED with visible concern.

**How it works:** src/agent-skills-a2a.js POSTs to /api/agents/a2a-call, where the server enforces the mandate, a budget ledger, and the peer's on-chain reputation; settlement flows over the x402 protocol and the receipt (amount, network, transaction, artifacts) comes back to be spoken in dollars.

**Why it matters:** This is the agent economy made visible and safe: your agent can hire other agents within a budget you pre-authorized, refuse untrusted peers, and you literally watch the money move — every payment bounded by your signed mandate.

## aixbt market intelligence

aixbt-intel pulls the latest aixbt narrative intelligence (filterable by chain or category) and speaks the top signals; aixbt-scan reads momentum-ranked projects with 24h change and calls out the movers, tilting the avatar's sentiment with the average move.

**How it works:** src/agent-skills-aixbt.js calls /api/aixbt/* so the aixbt API key stays server-side; when the key isn't configured it returns an honest 'not connected yet' message rather than fabricated signals.

**Why it matters:** Your in-world companion taps the same live intelligence feed professional crypto builders consume via the aixbt API — narratives and momentum, summarized out loud, never faked.
