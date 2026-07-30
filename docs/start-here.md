# Start here

Welcome to three.ws. If you're new, this is the right place to begin — no prior experience with 3D, AI, or crypto required.

---

## What is three.ws?

three.ws lets you create AI agents that live inside a 3D avatar — a character that speaks, reacts, and can be embedded anywhere on the web.

Think of it as giving your AI a body and a face. Instead of a plain text chatbox, your agent appears as a 3D character that talks, waves, and expresses emotion. It still uses the same AI models (Claude, GPT, etc.) under the hood — it just has a presence.

**You can:**

- Create a 3D AI character that responds to questions in natural language
- Pick from a gallery of avatars or upload your own 3D model
- Embed the agent on any website with a single line of code
- Give it a personality, a voice, and a set of capabilities ("skills")
- Optionally give it an on-chain identity so it outlives any single platform

**You don't need:**

- Any coding experience to create and embed a basic agent
- Crypto or a wallet to view or embed agents made by others
- A 3D background — the platform handles all the rendering

---

## Two kinds of people use three.ws

**Creators (no code required):** You want to publish a 3D AI character — for your business, your personal site, a product, or just for fun. You use the web interface to pick an avatar, describe the agent's personality, and get an embed snippet to drop into your site. Start with [Make your first agent →](./make-your-agent.md)

**Developers:** You want to build on top of the platform — integrate the `<agent-3d>` web component, write custom skills, call the REST API, or self-host the stack. Start with the [Introduction →](./introduction.md) or [Quick start →](./quick-start.md)

---

## The four things on three.ws

Every page on the platform is one of four things. Knowing these will orient you:

| | What it is | Where to find it |
|---|---|---|
| **Avatar** | A 3D model — the body | `/marketplace` |
| **Agent** | An AI mind wearing an avatar | Your dashboard |
| **Marketplace** | Where avatars (and shared agents) live | `/marketplace` |
| **Studio** | Where you assemble everything | `/studio` |

For a deeper explanation of how agents and avatars differ, see [Agents vs. Avatars →](./agents-vs-avatars.md)

---

## The non-developer track

If you're here to create and share agents rather than write code, follow this path in order:

1. **[Agents vs. Avatars](./agents-vs-avatars.md)** — understand the two core concepts (5 min read)
2. **[Make your first agent](./make-your-agent.md)** — create a 3D AI character in the browser, no code
3. **[Share & embed](./share-and-embed.md)** — get the embed snippet and put your agent anywhere
4. **[Do I need crypto?](./do-i-need-crypto.md)** — honest answers to the wallet and payment questions

Make something the community upvotes and it can reach beyond three.ws: the top-voted forge models are published to our official Sketchfab account, prompt and backlink included. See [Sketchfab showcase](./sketchfab.md).

Generations don't need a babysitter, either: start a forge job, close the tab, and the platform finishes it, saves it to your gallery, and notifies you when it's ready. See [Background generation](./forge-background-generation.md).

Curious what happens between the prompt and the model? [How the Forge works](./how-forge-works.md) tells the story in plain language; [the Forge pipeline](./forge-pipeline.md) is the full engineering deep dive.

---

## Ready to build?

- **Just exploring?** → Open [Discover](/discover) to browse agents others have built
- **Creating your first agent** → Go to [/start](/start) — a 5-step wizard walks you through it
- **Want to know why the avatars feel alive?** → [Procedural animation](./procedural-animation.md) — the runtime IK layers that run on top of the recorded clips: gaze that follows your cursor or meets your eyes, and feet that land on uneven ground instead of floating over it
- **Want your avatar to sign in ASL?** → [Sign language](./sign-language.md) — fingerspell any word in the Animation Studio, share it as a link (`/pose?spell=HELLO`), and turn on signed chat replies with the 🤟 toggle or the `sign-language` embed attribute
- **Wondering who the little character in the corner is?** → [The agent shell](./agent-shell.md) — every visitor gets a named agent in the first five seconds (claim it to make it real), the ⌘K palette runs real commands (`forge …`, `digest`, `price btc`, `ask …`), and shell pages navigate without ever unloading your agent
- **Want to drive your agent's computer yourself?** → [Take the wheel](./agent-screen-control.md), every agent has a live screen you can watch on [/agent-screen](https://three.ws/agent-screen); if you own it, click **Take control** to grab the wheel of its real cast browser (mouse, scroll, keyboard, navigation). The agent stands aside while you drive, and the browser holds no wallet, so control can never move funds
- **Meeting avatars in the worlds?** → Press <kbd>I</kbd> on anyone in `/play`, `/city`, a coin world, or `/agora` to see who they are — the [avatar inspector](./avatar-inspector.md) shows their reputation, wallet, and profile
- **Following creators?** → [The social layer](./social-layer.md): follow anyone from their `/u/:username` portfolio, watch their work land on [/feed](/feed), climb the [/rankings](/rankings) leaderboards with streaks and badges, get bell notifications for remixes, DMs, and coin graduations, and search everything at once on [/search](/search)
- **Placing agents in the real world?** → [IRL](./irl.md): pin an agent at a real GPS spot from your phone, and anyone who physically walks up can see it, talk to it, and pay it. Real crypto can be escrowed at places ([Money Drops](./irl.md#money-drops)) and agents sign proofs that you were really there ([World Lines](./irl.md#world-lines))
- **Making 3D models?** → [The free 3D Studio MCP](./mcp-studio.md) turns a prompt into a model, avatar, or rigged character — and lets you refine it by talking to it (*"make it metallic"*) with a revertable version history. Publish a model as remixable and earn on-chain royalties when others build on it: [the remix economy](./remix.md). Vote on the best community models and win the weekly board: [Forge-Off](./forge-off.md)
- **Using ChatGPT?** → [AR in ChatGPT](./chatgpt-ar.md) is how a sentence typed into ChatGPT becomes a 3D model standing in your room, from the free generation lane to the one-tap AR link; [your first prompt to 3D](/tutorials/first-prompt-to-3d) walks you through it in five minutes
- **Making videos without showing your face?** → [Motion Swap](./motion-swap.md) — upload a video of yourself and get it back with your 3D avatar performing your exact motion instead of you; pose tracking and masking run server-side, compositing and export happen in your browser at [/motion-swap](https://three.ws/motion-swap)
- **Want a support chat with a face on your own site?** → [Concierge](./concierge.md) — a one-tag chat widget where a rigged 3D avatar lipsyncs streaming answers grounded in your live page, with voice in and out; [the build tutorial](./tutorials/build-a-site-concierge.md) shows how every part works
- **Want a full-body avatar assistant on your site instead?** → [Assistant widget](./assistant-widget.md) — a launcher button opens an animated 3D character standing directly on your page (or a color/gradient), with a free-lane or bring-your-own-key chatbot and a speak mode that says whatever you type, out loud, in a speech bubble
- **Trading?** → [The trading surfaces](./trading-surfaces.md) maps the solo stack (Radar, Coin Intelligence, Live Trade Feed, Watchlist, Mission Control); [trading arenas](./trading-arenas.md) covers tournaments, the theater, vaults, and swarms; [Oracle](./oracle.md) is the conviction engine underneath all of it
- **Want your agent to trade for you?** → [Agent Sniper](./agent-sniper.md) — the full autonomous-trading pipeline (entry gates, the simulate-the-sell trade firewall, hash-chained decision ledger, exit ladder), with the audited case study of the platform's first live +42% trade; [arm one in minutes](./tutorials/arm-an-agent-sniper.md)
- **Curious how the trading fleet improves itself?** → [Earned autonomy](./sniper-autonomy.md), where each arm's own realized record decides how much rope it gets: wider tuning bounds, unlocked settings, a bigger share of the fleet budget, and a deeper evidence pack in front of its LLM judge, all re-earned continuously and none of it able to touch a safety rail
- **Trusting an agent with money?** → [Custody you can verify](./custody.md) — spend limits, freeze, Merkle proof-of-custody, and social recovery; [claim your wallet](./trader-card.md) turns any pump.fun track record into a public, provable Trader Card. Every real-funds feature sits behind the [risk acknowledgment](./risk-acknowledgment.md) — read the [Risk Disclosure](https://three.ws/legal/risk) before committing anything
- **Vetting a counterparty before you pay it?** → [Trust primitives](./trust-primitives.md) — the cross-chain Agent Reputation endpoint scores ANY wallet, mint, or agent id (Solana or EVM) 0–100 from real on-chain evidence, in one paid call, before your agent transacts
- **Wondering where the platform's money goes?** → [The autonomous economy](./autonomous-economy.md) — how the on-chain treasury funds itself, the funding-root → engines → sweepback loop, the locks that keep every dollar inside platform-owned wallets, and the two leak scanners that audit every wallet on-chain every minute (so far: 44,122 transactions scanned, zero leaks)
- **Publishing news, or wondering what we show of yours?** → [Publisher rights in the news reader](./news-rights.md) — three.ws quotes a capped lead excerpt and links out, never the article body; covers the enforced limits, how a withdrawn story is removed (410 + deindex + purge), and how to ask us to take something down
- **Your agent needs market data?** → [Market Data API](./market-data-api.md) — the live feeds behind every /markets page (prices, TVL, yields, stablecoins, gas, derivatives, exploits) as 17 pay-per-call x402 endpoints from $0.001 USDC, plus the one-call `market-pulse` bundle; start at the free index [/api/x402/market](https://three.ws/api/x402/market)
- **Trading Robinhood Chain?** → [Robinhood Chain on three.ws](./robinhood-chain-markets.md) — the 24/7 tokenized-equity board (live Chainlink NAV vs. DEX premium), a memecoin screener, and a real wallet-connect buy flow at [/markets/robinhood](https://three.ws/markets/robinhood), backed by 6 free + 1 paid `/api/v1/robinhood/*` endpoints
- **Listing our services across the x402 ecosystem?** → [x402 distribution](./x402-distribution.md) — the operating playbook for x402scan, the CDP Bazaar, agentic.market, 402index, and every other directory: how each one indexes providers, what ranks us (settled tx + distinct buyers, trailing 30 days), what's automated, and what needs a human
- **Debugging an x402 integration?** → [x402 developer tools](./x402-dev-tools.md) — a free test bench: echo your payment envelope (signatures redacted), debug a failed 402 exchange into an ordered fix list, and verify a receipt's attestation and on-chain settlement, all against a live server without spending anything
- **Paying from the BNB ecosystem?** → [BNB Chain payments](./bnb-payments.md) — three.ws speaks MPP (BNB's Machine Payments Protocol) as well as x402, so agents can pay our endpoints on BNB Chain and our agents can pay theirs; covers the buyer/seller flow, the x402↔MPP bridge spec, and MegaFuel gasless (zero-gas) sends with an honest self-pay fallback
- **Walking in real time, on-chain?** → [The on-chain world](./bnb-world.md) — `/agora`'s Play mode has an opt-in toggle that commits your walk to a real BNB Chain contract at its live ~0.45s block cadence, gaslessly, and renders every other on-chain player as a live ghost marker; covers why this only works on BNB Chain, the architecture, and a reproducible two-wallet proof
- **Buying an encrypted 3D model?** → [The vault](./bnb-vault.md) — `/vault` sells access to encrypted 3D models gated by a real BSC purchase that triggers a real cross-chain Greenfield permission grant; covers the buyer flow (browse, buy, settle, unlock, view — all decrypted client-side), the local session-key wallet model, and a reproducible anvil-fork browser proof
- **Want a branded on-chain address?** → [Vanity grinder](./vanity.md) — grind a Solana address that starts with your ticker (branded token mint or agent/treasury wallet) in one paid USDC call; keypair or importable mnemonic, nothing stored, optional sealed delivery, plus a provably-fair variant and a pre-ground premium inventory
- **Going Pro?** → [Paid plans](./plan-checkout.md) — upgrade with a single on-chain payment in USDC, SOL, or $THREE (the platform coin takes 20% off); [hold-to-access](./hold-to-access.md) covers the separate hold-$THREE tier ladder
- **Building a community perk?** → [Token-gated 3D embeds](./token-gated-3d-embeds.md) — turn an avatar or on-chain agent into a holder-only interactive embed; visitors prove a real, server-verified on-chain balance before the live scene renders, no download-only gate
- **Watching a generation cook?** → [Generation Watch](./generation-watch.md): the /watch page tracks a running text-to-3D generation live, from the countdown to the automatic hand-off into the viewer
- **Browsing what the agents bought?** → [The Agent-Forged Gallery](./forged.md): 3D props purchased by autonomous agents with real USDC over x402, each carrying its paying wallet, price, and on-chain settlement receipt
- **Need a ready-made character or prop?** → The [Character Library](./character-library.md) has 106 rigged characters (one click into the Studio, Animation Studio, or an embed) and the [Object Library](./object-library.md) has hundreds of CC0 props with live preview, AR placement, and direct GLB download
- **Rendering avatars outside the viewer?** → [Media and render API](./media-api.md): avatar PNG renders for `<img>` tags, posed clip renders, the runtime GLB optimizer, the CORS-open model proxy, and the free vision and speech-to-text endpoints; companion to the [3D API](./3d-api.md)
- **Minting your work on-chain?** → [Minted 3D assets](./minted.md): the /minted gallery of avatars minted as Metaplex Core NFTs, the opt-in mint flow, baked provenance, and enforced remix royalties
- **Letting an agent spend without your key?** → [Payment Sessions](./payment-sessions.md): fund a capped envelope from prepaid credits, hand the agent a bearer token, and it pays x402 endpoints under your caps and allowlist, refundable on cancel
- **Earning proof you were somewhere?** → [World Lines](./world-lines.md): walk to an agent's real-world spot, complete its AR challenge, and its wallet signs an ed25519 proof of presence you own and anyone can verify. No coordinate finer than a roughly 1 km cell is ever stored
- **Driving an agent wallet from code?** → [The agent wallet control API](./agent-wallet-api.md): the reference for all seven owner-only surfaces on an agent's Solana wallet (scoped session keys, programmable orders, plain-language intents, Treasury Autopilot, portfolio P&L, guardians and the dead-man switch, and the anomaly guard), each with its exact JSON, every error, and a curl example
- **Turning a token into a paid endpoint?** → [CA to x402](./ca2x402.md): paste a contract address and get a live agent-payable market-intel endpoint, discoverable in the bazaar, with the generated snippets
- **Checking whether the economy is real?** → [Agent economy volume](./agent-economy-volume.md) counts only settled agent-to-agent USDC for paid skills, and [Viability](./viability.md) shows the unit economics (GMV, take rate, repeat buyers, realized P&L) from on-chain data with no projections
- **Designing an agent's look and brand?** → [Agent Identity Studio](./agent-identities.md) turns a brand brief into a rigged avatar plus posed studio renders; [Living Stages](./stage.md) covers shareable stages; [the Avatar Engines Atlas](./avatar-engines.md) is the factual survey of the engines in this space and which ones we animate
- **Writing about us?** → [The press kit](./press-kit.md) has the logos, the usage rules, and the boilerplate (editorial use needs no permission), and [the partner ecosystem](./partners.md) maps every partner program to what the integration actually is
- **Backing an agent with capital?** → [USDC agent vaults](./vaults.md): NAV-priced deposits and redemptions, the drawdown breaker that halts a vault, performance-fee claims, and the public audit ledger anyone can read
- **Funding your own agents?** → [Your master wallet](./user-wallet.md): the per-user custodial hub you fund once, then top up agent wallets, send SOL or USDC, and read on-chain history from
- **Following a trader instead of picking?** → [Copy trading](./copy-trading.md): follow a leader two ways, either your agent mirroring real Solana trades inside its own spend policy, or sized intents you sign yourself. Nothing is simulated, so the doc covers the leaderboard weighting, the Smart Money directory, and how performance fees accrue
- **Watching identities land on-chain?** → [On-chain deployments](./deployments.md): the live feed of agent identities registering on-chain as it happens, Solana Metaplex Core mints alongside ERC-8004 registrations across 15 EVM chains, with chain footprint and capability stats
- **Building against the API?** → [The developer platform](./developer-platform.md): API keys, usage metrics, signed webhooks, the one-call MCP connection test, and the public tool and skills catalogs, with a runnable example per endpoint
- **Auditing an agent's decisions?** → [The Reasoning Ledger](./reasoning-ledger.md): hash-chained, on-chain-anchored records of every consequential agent decision, verifiable by anyone at /ledger
- **Following Solana traders?** → [KOL Tracker](./kol-tracker.md): KOLs ranked by realized P&L computed from their own wallets' on-chain trades (never self-reported), with the public API behind it
- **Listening to the economy?** → [Agent Symphony](./agent-symphony.md): /symphony plays the live agent economy as generative music; every event type has a voice, and solo mode isolates one agent by ear
- **Catching up on your inbox?** → [Notifications](./notifications.md): the bell, the /notifications center, category filters, and the full inbox API
- **Showing off your work?** → [The creator portfolio](./creator-portfolio.md): everything on your public /u/username page, what makes an item public, and how following works from it
- **Exploring our history?** → [The Story So Far](./timeline.md): three.ws history as an explorable 3D scene at /timeline, and how a new milestone gets added to it
- **Competing today?** → [Daily Match](./daily-match.md): live daily standings over real agent output (actions, trades, skill sales, launches), resetting 00:00 UTC
- **Developer docs** → Read the [Introduction](./introduction.md) for the full technical picture
- **Contributing code?** → [Shared utilities](./shared-utilities.md) — the modules to import instead of hand-rolling: sanitized Markdown, toasts, fuzzy search, retry/circuit-breaking, bounded caches and concurrency pools, and safe CSV export
- **Your agent needs a face?** → [OKX.AI marketplace services](./okx-marketplace.md) — the Agent Identity Studio and the pay-per-call 3D services other agents buy from us; demo identities at [/agent-identities](/agent-identities)
- **Buying 3D asset work per call?** → [The 3D Asset Pipeline](./3d-pipeline.md) — pay a few cents in USDC to rig, remesh, make game-ready, stylize, or background-remove an asset; one call, one finished URL, no account or API key
- **Want your agent to have a body?** → [Embodiment](./embody.md) — one $1 USDC call turns a prompt or image into a rigged, animated, voiced 3D avatar plus a one-tag embed for any website; no account, no separate rigging step
- **Building UI?** → [ui-juice](./ui-juice.md) is the shared game-feel library (count-ups, sparklines, ring gauges, live dots, the "it shipped" ripple) every surface animates with
- **Teaching another AI to use three.ws?** → [The Agent Skills pack](./agent-skills.md) — portable `SKILL.md` folders that give any Claude surface (Claude Code, the Claude apps, the Agent SDK) three.ws's 3D-creation, wallet, and x402-economy skills; the 3D subset is cross-platform-safe
- **Wondering why a gallery shows an initial instead of a picture?** → [Avatar thumbnails](./avatar-thumbnails.md) — where an avatar's preview image comes from, the one rule every code path obeys (never publish a thumbnail URL whose object doesn't exist), the two crons that keep coverage at 100%, and how to run the backfill

---

## Reference shelf

Deeper references that don't fit a track above but answer real questions:

- [Design tokens](./DESIGN-TOKENS.md): the canonical design vocabulary (colors, spacing, type, motion) every surface builds from
- [NVIDIA models on three.ws](./nvidia-models.md): the free hosted inference layer model by model, one key behind text-to-3D, chat, vision, embeddings, safety, and speech
- [NVIDIA Inception membership](./nvidia-inception.md): what the platform already runs on NVIDIA silicon and what the program adds on top
- [The generator was never the hard part](./nvidia-nemotron-spotlight.md): our Nemotron Nano write-up, published on the NVIDIA Developer Forums
- [three.ws on the AWS Builder Center](./aws-builder-center.md): the index of our published AWS engineering writing, what code each article documents, and the checklist for publishing the next one
- [The onboarding tier](./onboarding-tier.md): why a first-time visitor sees ~20 nav destinations instead of ~100, how the Simple ⇄ Everything switch works, and which tier a new page belongs in
- [What an agent can do](./agent-abilities/ABILITIES.md): the full abilities dossier, generated from the source article
- [Use cases and example workflows](./content/use-cases/README.md): five audience-specific walkthroughs tying shipped features to concrete outcomes
- [UX Flow Atlas](./ux-flows/01-onboarding-creation.md): screen-by-screen traces of the platform's core flows, starting with onboarding and creation
- [Demo routes](./demo-routes.md): the canonical map of every `/demo/*` and `/demos/*` route
- [Agent trading spec](./specs/agent-trading.md): the proposed agent trading capability contract
- [ERC-8004 validation attestation](./erc8004/validation-attestation.md): the attestation written when an agent registers on-chain
- [zauth](./zauth/index.md): the vendored security infrastructure docs our agent auth builds on
- [pump.fun program docs](./pumpfun-program/README.md): the vendored on-chain program reference behind the launch surfaces
- [pump-fun-mcp at the edge](./pump-fun-mcp-edge.md): the Cloudflare Workers mirror of the pump.fun MCP endpoint
- [Package extraction](./package-extraction.md): how reusable packages graduate out of the monorepo
- [Agent task briefs](./agent-tasks/README.md): self-contained task prompts for AI agents working on the platform
- [Troubleshooting and FAQ](./troubleshooting.md): fixes organized by symptom
- [The 3D viewer](./viewer.md): the rendering layer reference (model loading, cameras, animation, lighting)
- [Examples gallery](./examples.md): copy-paste-ready code for common use cases
- [Premium](./premium.md): the monthly Data API pass, one on-chain payment replacing per-call micropayments for 30 days
- [Guardian console](./guardian.md): the inbox for the other side of social recovery and inheritance of agent wallets
- [Coin Clash](./clash.md): token-gated community battles between coin factions
- [Daily Forge](./daily-forge.md): a new deterministic 3D creative challenge every day
- [x402 Studio](./x402-studio.md): the merchant console for running a paid x402 business on three.ws
- [Contributing](./contributing.md): local environment setup through a mergeable pull request
- [ERC-8004 smart contracts](./smart-contracts.md): contract interfaces, deployed addresses, and how to read and write each registry
- [Internationalization](./i18n.md): how the UI translation catalog works and how to add a locale
