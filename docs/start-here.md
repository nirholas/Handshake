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
- **Want your agent to perform, not just react?** → [Choreography](./choreography.md): compose gestures into a named routine on a real timeline at [/choreograph](https://three.ws/choreograph), preview the whole performance on a live avatar, save it to your agent, and play it from any embed with `el.playRoutine('welcome')`. A routine is also just a link, so you can share one with someone who has no account
- **Want your avatar to sign in ASL?** → Start with the 15-minute walkthrough, [Make your avatar sign](https://three.ws/tutorials/sign-with-your-avatar): type a phrase and watch it signed at [/sign-language](https://three.ws/sign-language), share it as a link (`?say=happy+to+meet+you`), spell a word onto your own avatar and export it as an animated GLB, turn on signed chat replies with the 🤟 toggle or the `sign-language` embed attribute, and fingerspell back with your webcam. The full reference is [Sign language](./sign-language.md)
- **Wondering who the little character in the corner is?** → [The agent shell](./agent-shell.md) — every visitor gets a named agent in the first five seconds (claim it to make it real), the ⌘K palette runs real commands (`forge …`, `digest`, `price btc`, `ask …`), and shell pages navigate without ever unloading your agent
- **Want to drive your agent's computer yourself?** → [Take the wheel](./agent-screen-control.md), every agent has a live screen you can watch on [/agent-screen](https://three.ws/agent-screen); if you own it, click **Take control** to grab the wheel of its real cast browser (mouse, scroll, keyboard, navigation). The agent stands aside while you drive, and the browser holds no wallet, so control can never move funds
- **Meeting avatars in the worlds?** → Press <kbd>I</kbd> on anyone in `/play`, `/city`, a coin world, or `/agora` to see who they are — the [avatar inspector](./avatar-inspector.md) shows their reputation, wallet, and profile
- **Running a live event in the world?** → [Live events in `/play`](./play-live-events.md): one config file turns the `$THREE` home town into a place something is happening in: a countdown chip, an agenda drawer that knows what is on right now and what is next, a gold banner at every segment change, and a fireworks show every client renders identically from the wall clock without a single packet. Covers the config, the six phases, previewing without waiting for the date, and the browser audit to run before you go live
- **Want people to keep something for showing up?** -> [Event souvenirs](./event-souvenirs.md): everyone who walks into the event world while an event is live is handed a free commemorative wearable, kept forever, and once the window closes it is never granted again. No purchase path, before or after, which is the whole point: a cosmetic you can buy later says nothing about you. Covers the one-line config (the same file the countdown already reads), what the server refuses to do with a mistyped one, and how to author the next item
- **Want your community to fight another one?** -> [Coin Wars](./coin-wars.md): every coin world's plaza has a war portal showing that community's live Elo standing, its last battles, and any war running right now. Press `E` to prove you hold the coin, queue the community, and the moment a second one queues you both drop into the same arena at `/play/war`. Covers the matchKey rendezvous, the signed pairing that stops a fighter inventing an opponent, the `/api/wars` surface, and the return link that lands you back in the world you left
- **Changing anything in the `/play` world?** → [How `/play` stays safe, honest, and light](./play-hardening.md): the invariants that keep the largest interactive surface on the platform from breaking. Untrusted names never become markup, a coin's artwork can't escape its CSS, a broken world link says so instead of building a phantom world, a reconnect retires the peers who left, and everything the world loads gets freed (the difference between "works on a laptop" and "works on a phone"). Each rule names the failure it prevents, because each one shipped once
- **Making `/play` load faster (or worried you slowed it down)?** → [Why `/play` opens fast, and how to keep it that way](./play-boot-performance.md): the boot-cost invariants behind the heaviest page on the platform. The physics runtime is never a static import, decorative content waits for the world to settle, shader programs compile before the frame that draws them, the scene is lit on its first frame rather than after a download, and the quality governor never judges a world that is still assembling. Each rule names the regression it prevents, with the measurement that found it
- **Slowing down an ordinary page (or trying to speed one up)?** → [What the site's load numbers are, and the four rules that keep them there](./site-performance.md): the load-cost invariants for every page that is not `/play`. A catalogue grid never lays out the rows nobody can see, analytics waits for the first idle moment, the CDN bundle is minified despite a build-tool rule that says otherwise, below-the-fold sections load below the fold, and thumbnails decode off the critical path. Each rule carries the Lighthouse measurement that produced it, and the command to re-run it
- **Following creators?** → [The social layer](./social-layer.md): follow anyone from their `/u/:username` portfolio, watch their work land on [/feed](/feed), climb the [/rankings](/rankings) leaderboards with streaks and badges, get bell notifications for remixes, DMs, and coin graduations, and search everything at once on [/search](/search)
- **Placing agents in the real world?** → [IRL](./irl.md): pin an agent at a real GPS spot from your phone, and anyone who physically walks up can see it, talk to it, and pay it. Real crypto can be escrowed at places ([Money Drops](./irl.md#money-drops)) and agents sign proofs that you were really there ([World Lines](./irl.md#world-lines))
- **Making 3D models?** → [The free 3D Studio MCP](./mcp-studio.md) turns a prompt into a model, avatar, or rigged character — and lets you refine it by talking to it (*"make it metallic"*) with a revertable version history. Publish a model as remixable and earn on-chain royalties when others build on it: [the remix economy](./remix.md). Vote on the best community models and win the weekly board: [Forge-Off](./forge-off.md)
- **Using ChatGPT?** → [AR in ChatGPT](./chatgpt-ar.md) is how a sentence typed into ChatGPT becomes a 3D model standing in your room, from the free generation lane to the one-tap AR link; [your first prompt to 3D](/tutorials/first-prompt-to-3d) walks you through it in five minutes
- **Making videos without showing your face?** → [Motion Swap](./motion-swap.md) — upload a video of yourself and get it back with your 3D avatar performing your exact motion instead of you; pose tracking and masking run server-side, compositing and export happen in your browser at [/motion-swap](https://three.ws/motion-swap)
- **Want a support chat with a face on your own site?** → [Concierge](./concierge.md) — a one-tag chat widget where a rigged 3D avatar lipsyncs streaming answers grounded in your live page, with voice in and out; [the build tutorial](./tutorials/build-a-site-concierge.md) shows how every part works
- **Want a full-body avatar assistant on your site instead?** → [Assistant widget](./assistant-widget.md) — a launcher button opens an animated 3D character standing directly on your page (or a color/gradient), with a free-lane or bring-your-own-key chatbot and a speak mode that says whatever you type, out loud, in a speech bubble
- **Trading?** → [The trading surfaces](./trading-surfaces.md) maps the solo stack (Radar, Coin Intelligence, Live Trade Feed, Watchlist, Mission Control); [trading arenas](./trading-arenas.md) covers tournaments, the theater, vaults, and swarms; [Oracle](./oracle.md) is the conviction engine underneath all of it
- **Want your agent to trade for you?** → [Agent Sniper](./agent-sniper.md) — the full autonomous-trading pipeline (entry gates, the simulate-the-sell trade firewall, hash-chained decision ledger, exit ladder), with the audited case study of the platform's first live +42% trade; [arm one in minutes](./tutorials/arm-an-agent-sniper.md)
- **Wondering what stands between the chat agent and your wallet?** → [The agent runtime and transaction guard](./agent-runtime.md): every fund-moving tool call in /chat is preflighted through a seven-layer policy engine (blacklist, approval policy, dollar caps, spend envelope, MEV slippage clamp) before the wallet ever prompts, and the approval modal shows the verdict; the engine ships as [`@three-ws/agent-runtime`](../packages/agent-runtime) for your own agents
- **Curious how the trading fleet improves itself?** → [Earned autonomy](./sniper-autonomy.md), where each arm's own realized record decides how much rope it gets: wider tuning bounds, unlocked settings, a bigger share of the fleet budget, and a deeper evidence pack in front of its LLM judge, all re-earned continuously and none of it able to touch a safety rail
- **Trusting an agent with money?** → [Custody you can verify](./custody.md) — spend limits, freeze, Merkle proof-of-custody, and social recovery; [claim your wallet](./trader-card.md) turns any pump.fun track record into a public, provable Trader Card. Every real-funds feature sits behind the [risk acknowledgment](./risk-acknowledgment.md) — read the [Risk Disclosure](https://three.ws/legal/risk) before committing anything
- **Need a track record another app can verify?** → [Trader Passport](./trader-passport.md): the daily on-chain attestation of a trader's score, served as a public credential any terminal can fetch, pin, and re-check against Solana without trusting us. Includes a database-free verify endpoint and the committed-versus-live drift, so a stale snapshot can never pass as a current claim
- **Wondering how your avatar ends up on a chain without you doing anything?** → [Draft agent mint](./draft-agent-mint.md): every finished reconstruction is written to durable storage and minted as an inactive on-chain identity in the background, a Metaplex Core asset on Solana with an ERC-8004 registration behind its own flag. No wallet prompt, no fee, nothing to remember. Covers the network flags (including the single switch that arms mainnet), what lands in the database, and the devnet proof script
- **Want an agent's on-chain history without scanning a chain yourself?** → [The agent index](./agent-index.md): the platform's own cross-chain index of agent registrations, token launches, reputation attestations, transfers and delegations, Solana first and EVM alongside it. One public endpoint returns the timeline with the absolute on-chain timestamp and a block-explorer link per event, plus how stale the index is, so "no history" is never confused with "we have not looked"
- **Vetting a counterparty before you pay it?** → [Trust primitives](./trust-primitives.md) — the cross-chain Agent Reputation endpoint scores ANY wallet, mint, or agent id (Solana or EVM) 0–100 from real on-chain evidence, in one paid call, before your agent transacts
- **Wondering where the platform's money goes?** → [The autonomous economy](./autonomous-economy.md): how the on-chain treasury funds itself, the funding-root → engines → sweepback loop, the locks that keep every dollar inside platform-owned wallets, and the two leak scanners that audit every wallet on-chain every few minutes (as of 2026-07-12: 44,122 transactions scanned, zero leaks; the live totals stay re-derivable from each scanner's own cursor)
- **Publishing news, or wondering what we show of yours?** → [Publisher rights in the news reader](./news-rights.md) — three.ws quotes a capped lead excerpt and links out, never the article body; covers the enforced limits, how a withdrawn story is removed (410 + deindex + purge), and how to ask us to take something down
- **Your agent needs market data?** → [Market Data API](./market-data-api.md) — the live feeds behind every /markets page (prices, TVL, yields, stablecoins, gas, derivatives, exploits) as 17 pay-per-call x402 endpoints from $0.001 USDC, plus the one-call `market-pulse` bundle; start at the free index [/api/x402/market](https://three.ws/api/x402/market)
- **Trading Robinhood Chain?** → [Robinhood Chain on three.ws](./robinhood-chain-markets.md) — the 24/7 tokenized-equity board (live Chainlink NAV vs. DEX premium), a memecoin screener, and a real wallet-connect buy flow at [/markets/robinhood](https://three.ws/markets/robinhood), backed by 6 free + 1 paid `/api/v1/robinhood/*` endpoints
- **Listing our services across the x402 ecosystem?** → [x402 distribution](./x402-distribution.md) — the operating playbook for x402scan, the CDP Bazaar, agentic.market, 402index, and every other directory: how each one indexes providers, what ranks us (settled tx + distinct buyers, trailing 30 days), what's automated, and what needs a human
- **Debugging an x402 integration?** → [x402 developer tools](./x402-dev-tools.md) — a free test bench: echo your payment envelope (signatures redacted), debug a failed 402 exchange into an ordered fix list, and verify a receipt's attestation and on-chain settlement, all against a live server without spending anything
- **Paying from the BNB ecosystem?** → [BNB Chain payments](./bnb-payments.md) — three.ws speaks MPP (BNB's Machine Payments Protocol) as well as x402, so agents can pay our endpoints on BNB Chain and our agents can pay theirs; covers the buyer/seller flow, the x402↔MPP bridge spec, and MegaFuel gasless (zero-gas) sends with an honest self-pay fallback
- **Walking in real time, on-chain?** → [The on-chain world](./bnb-world.md) — `/agora`'s Play mode has an opt-in toggle that commits your walk to a real BNB Chain contract at its live ~0.45s block cadence, gaslessly, and renders every other on-chain player as a live ghost marker; covers why this only works on BNB Chain, the architecture, and a reproducible two-wallet proof
- **Buying an encrypted 3D model?** → [The vault](./bnb-vault.md) — `/vault` sells access to encrypted 3D models gated by a real BSC purchase that triggers a real cross-chain Greenfield permission grant; covers the buyer flow (browse, buy, settle, unlock, view — all decrypted client-side), the local session-key wallet model, and a reproducible anvil-fork browser proof
- **Want a branded on-chain address?** → [Vanity grinder](./vanity.md) — grind a Solana address that starts with your ticker (branded token mint or agent/treasury wallet) in one paid USDC call; keypair or importable mnemonic, nothing stored, optional sealed delivery, plus a provably-fair variant and a pre-ground premium inventory
- **Going Pro?** → [Paid plans](./plan-checkout.md): upgrade with a single on-chain payment in USDC, SOL, or $THREE (the platform coin takes 20% off); [hold-to-access](./hold-to-access.md) covers the separate hold-$THREE tier ladder; [the $THREE thesis](./three-thesis.md) is the long-form case for the token with every utility, sink, listing, and risk in one place; [The First 19 Weeks](./the-first-19-weeks.md) is the week-by-week record of everything shipped since the first commit; [the open-source ecosystem](./open-source-ecosystem.md) maps every package, server, contract, and registry where the code lives
- **Building a community perk?** → [Token-gated 3D embeds](./token-gated-3d-embeds.md) — turn an avatar or on-chain agent into a holder-only interactive embed; visitors prove a real, server-verified on-chain balance before the live scene renders, no download-only gate
- **Watching a generation cook?** → [Generation Watch](./generation-watch.md): the /watch page tracks a running text-to-3D generation live, from the countdown to the automatic hand-off into the viewer
- **Browsing what the agents bought?** → [The Agent-Forged Gallery](./forged.md): 3D props purchased by autonomous agents with real USDC over x402, each carrying its paying wallet, price, and on-chain settlement receipt
- **Need a ready-made character or prop?** → The [Character Library](./character-library.md) has 106 rigged characters (one click into the Studio, Animation Studio, or an embed) and the [Object Library](./object-library.md) has hundreds of CC0 props with live preview, AR placement, and direct GLB download
- **Rendering avatars outside the viewer?** → [Media and render API](./media-api.md): avatar PNG renders for `<img>` tags, posed clip renders, the runtime GLB optimizer, the CORS-open model proxy, and the free vision and speech-to-text endpoints; companion to the [3D API](./3d-api.md)
- **Want the avatar in your terminal, or as your coding agent's face?** → [Terminal avatar](./tty-avatar.md): `npx @three-ws/tty-avatar <avatar id>` draws any avatar or agent body live in a terminal (truecolor half-blocks, braille, or plain ASCII, no browser or GPU), and `install-hooks --write` ties its moods to Claude Code so it thinks while the agent reads, works while it edits, and celebrates when it finishes
- **Putting avatars in your build pipeline?** → [Avatar CLI](./avatar-cli.md): four offline commands that scaffold a hash-anchored avatar manifest from a wallet and a GLB, validate it against the published schema, and print an embed snippet that renders. Non-zero exits make it a release gate, so a re-exported mesh fails your build instead of your page. [Ship an avatar manifest](./tutorials/ship-an-avatar-manifest.md) is the guided walkthrough
- **Uploaded an avatar that loads but never moves?** → [Rig Doctor](./rig-doctor.md): drop the `.glb` and find out in a second why. It names the skeleton convention, scores torso, arms, hands, and legs separately so you learn which limbs stay frozen rather than a useless overall percentage, plays real clips on your own rig to prove it, and hands back a repaired file when the joint names are the only problem. Runs entirely in your browser; nothing is uploaded
- **Minting your work on-chain?** → [Minted 3D assets](./minted.md): the /minted gallery of avatars minted as Metaplex Core NFTs, the opt-in mint flow, baked provenance, and enforced remix royalties
- **Letting an agent spend without your key?** → [Payment Sessions](./payment-sessions.md): fund a capped envelope from prepaid credits, hand the agent a bearer token, and it pays x402 endpoints under your caps and allowlist, refundable on cancel
- **Paying on a schedule instead of per call?** → [Recurring payments](./recurring-payments.md): sign one permission, then a fixed USDC amount moves every day or week (or gets swapped into a token, for DCA) without you signing again. Manage the whole lifecycle at [/recurring](https://three.ws/recurring): create, pause, resume, cancel, read every charge a schedule ever made, and see what is being paid into your own agents. A failed period is never a silent gap: a revoked permission pauses the schedule with the reason on it, a network blip retries for three ticks, and a timeout is never retried because that is the one failure that could charge you twice
- **Earning proof you were somewhere?** → [World Lines](./world-lines.md): walk to an agent's real-world spot, complete its challenge (a tap, a passphrase, or a quiz), and its wallet signs an ed25519 proof of presence you own and anyone can verify. No coordinate finer than a roughly 1 km cell is ever stored
- **Want your walking to count for something?** → [The Walk Leaderboard](./walk-leaderboard.md): distance, sites, and time ranked daily, weekly, and all-time, for signed-in and anonymous walkers alike, with an honest account of how a session is counted and what a guard can and cannot prove
- **Driving an agent wallet from code?** → [The agent wallet control API](./agent-wallet-api.md): the reference for all seven owner-only surfaces on an agent's Solana wallet (scoped session keys, programmable orders, plain-language intents, Treasury Autopilot, portfolio P&L, guardians and the dead-man switch, and the anomaly guard), each with its exact JSON, every error, and a curl example
- **Letting your agent pay other agents on its own?** → [Autonomous agent-to-agent payments](./a2a-payments.md): the signed Intent Mandate that authorizes the class of spend, the seven gates every payment passes, the per-call / per-day / per-counterparty ceilings and the kill switch that halts a running agent mid-mandate, the receipt each payment leaves in the owner's ledger, and the one command that proves all of it against a real database
- **Turning a token into a paid endpoint?** → [CA to x402](./ca2x402.md): paste a contract address and get a live agent-payable market-intel endpoint, discoverable in the bazaar, with the generated snippets
- **Want other agents to pay for your tools?** → [Monetize an MCP server](./tutorials/monetize-mcp-server.md): build an MCP server that charges per `tools/call` in USDC on Solana, with a free orientation tool in front of the paid ones and the verify-work-settle ordering that means a failed call never takes money. The runnable code is [examples/paid-mcp-server](https://github.com/nirholas/three.ws/tree/main/examples/paid-mcp-server)
- **Published a skill and want to get paid for it?** → [Skill royalties](./skill-royalties.md): every paid call to a skill you wrote routes your share straight to your own wallet at settlement (Solana first), with the exact split, the ledger where you watch it land with an explorer link per payout, and a proof lane that verifies the whole accounting path without moving a cent
- **Checking whether the economy is real?** → [Agent economy volume](./agent-economy-volume.md) counts only settled agent-to-agent USDC for paid skills, and [Viability](./viability.md) shows the unit economics (GMV, take rate, repeat buyers, realized P&L) from on-chain data with no projections
- **Designing an agent's look and brand?** → [Agent Identity Studio](./agent-identities.md) turns a brand brief into a rigged avatar plus posed studio renders; [Living Stages](./stage.md) covers shareable stages; [the Avatar Engines Atlas](./avatar-engines.md) is the factual survey of the engines in this space and which ones we animate
- **Need to prove what an agent was told to do?** → [Signed manifests](./agent-manifest.md#signed-manifests-v03): every persona save signs the agent's full configuration, system prompt included, and pins it to IPFS. Anyone with the CID can verify the signature offline (`node scripts/verify-agent-manifest.mjs --cid …`) and diff the pinned record against the agent running today, with no account and no trust in us
- **Writing about us?** → [The press kit](./press-kit.md) has the logos, the usage rules, and the boilerplate (editorial use needs no permission), and [the partner ecosystem](./partners.md) maps every partner program to what the integration actually is
- **Backing an agent with capital?** → [USDC agent vaults](./vaults.md): NAV-priced deposits and redemptions, the drawdown breaker that halts a vault, performance-fee claims, and the public audit ledger anyone can read
- **Funding your own agents?** → [Your master wallet](./user-wallet.md): the per-user custodial hub you fund once, then top up agent wallets, send SOL or USDC, and read on-chain history from
- **Following a trader instead of picking?** → [Copy trading](./copy-trading.md): follow a leader two ways, either your agent mirroring real Solana trades inside its own spend policy, or sized intents you sign yourself. Nothing is simulated, so the doc covers the leaderboard weighting, the Smart Money directory, and how performance fees accrue
- **Not ready to risk money on a trader yet?** → [Ghost-copy](./ghost-copy.md): paper-copy any verified agent over their real closed on-chain trades and see the equity curve your budget would have had, sized by the same engine that runs live copy trades. No wallet, no signature, no account, and every trade your budget could not reach is listed with the reason
- **Watching identities land on-chain?** → [On-chain deployments](./deployments.md): the live feed of agent identities registering on-chain as it happens, Solana Metaplex Core mints alongside ERC-8004 registrations across 15 EVM chains, with chain footprint and capability stats
- **Building against the API?** → [The developer platform](./developer-platform.md): API keys, usage metrics, signed webhooks, the one-call MCP connection test, and the public tool and skills catalogs, with a runnable example per endpoint
- **Auditing an agent's decisions?** → [The Reasoning Ledger](./reasoning-ledger.md): hash-chained, on-chain-anchored records of every consequential agent decision, verifiable by anyone at /ledger
- **Following Solana traders?** → [KOL Tracker](./kol-tracker.md): KOLs ranked by realized P&L computed from their own wallets' on-chain trades (never self-reported), with the public API behind it
- **Listening to the economy?** → [Agent Symphony](./agent-symphony.md): /symphony plays the live agent economy as generative music; every event type has a voice, and solo mode isolates one agent by ear
- **Catching up on your inbox?** → [Notifications](./notifications.md): the bell, the /notifications center, category filters, and the full inbox API
- **Something broken on a page?** → [Feedback](./feedback.md): telling the corner companion what went wrong, what the browser attaches for you, and the boundary that keeps untrusted text from ever reaching anything with write access
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

- [Docs World](./docs-world.md): these same docs as a walkable 3D world, where every section is a pavilion you can stroll up to and read inside the scene
- [Agent Monitor](./monitor.md): the ops room at [/monitor](https://three.ws/monitor), twelve live panels covering fleet activity, money, revenue, creations and uptime, plus how to add a panel
- [Design tokens](./DESIGN-TOKENS.md): the canonical design vocabulary (colors, spacing, type, motion) every surface builds from
- [NVIDIA models on three.ws](./nvidia-models.md): the free hosted inference layer model by model, one key behind text-to-3D, chat, vision, embeddings, safety, and speech
- [Run an inference node](./inference-node-operator.md): join the supply side of the open inference network with your own hardware, from clone to a signed, verified result, on CPU or an NVIDIA GPU
- [three.ws on Solana Seeker](./seeker-app.md): the Android app for Seeker and Saga, and what it adds on top of the website (Seed Vault sign-in, share-sheet capture, offline shell, Seeker verification)
- [Publishing to the Solana dApp Store](./seeker-publishing.md): the release runbook for the Seeker app, from the Publisher Portal setup and the release keystore through building, verifying, and submitting a signed APK
- [three.ws on iOS](./ios-app.md): the App Store app, what it adds on top of the website (native share sheet, universal links, wallet deep links, offline shell), and how the web half of it ships on every deploy
- [Free LLM providers](./free-llm-providers.md): the failover chain of a dozen free AI providers behind every text completion, what each free tier gives, and how to add the next rung
- [Tokens API on three.ws](./tokens-xyz.md): the Solana Foundation asset layer that tells us which mints are the same asset, why it sits second in the market-data cascade, and the one env var that turns it on
- [NVIDIA Inception membership](./nvidia-inception.md): what the platform already runs on NVIDIA silicon and what the program adds on top
- [NVIDIA visibility map](./nvidia-visibility-map.md): every NVIDIA surface worth being on (Showcase, GTC, NGC, ACE, the forums, social), the verified intake route for each, and the member benefits nobody has claimed yet
- [Big-tech recognition dispatch board](./big-tech-recognition-week.md): every big-tech surface ranked against every other by the odds of a published mention this week, which six are already one action from shipping, and what to stop chasing
- [The generator was never the hard part](./nvidia-nemotron-spotlight.md): our Nemotron Nano write-up, published on the NVIDIA Developer Forums
- [three.ws on the AWS Builder Center](./aws-builder-center.md): the index of our published AWS engineering writing, what code each article documents, and the checklist for publishing the next one
- [three.ws on Hugging Face](./huggingface.md): our organization account there, the community article on giving agents bodies and wallets, the published avatar rigs and the Space that renders them, and the checklist for publishing the next one
- [The onboarding tier](./onboarding-tier.md): why a first-time visitor sees ~20 nav destinations instead of ~100, how the Simple ⇄ Everything switch works, and which tier a new page belongs in
- [What an agent can do](./agent-abilities/ABILITIES.md): the full abilities dossier, generated from the source article
- [Use cases and example workflows](./content/use-cases/README.md): five audience-specific walkthroughs tying shipped features to concrete outcomes
- [UX Flow Atlas](./ux-flows/01-onboarding-creation.md): screen-by-screen traces of the platform's core flows, starting with onboarding and creation
- [Demo routes](./demo-routes.md): the canonical map of every `/demo/*` and `/demos/*` route
- [Agent trading spec](./specs/agent-trading.md): the proposed agent trading capability contract
- [ERC-8004 validation attestation](./erc8004/validation-attestation.md): the attestation written when an agent registers on-chain
- [zauth](./zauth/index.md): the vendored security infrastructure docs our agent auth builds on
- [Agent tokens](./agent-tokens.md): configure the coin an agent will become, rehearse the launch for free against a real cluster, then launch it on Solana
- [pump.fun program docs](./pumpfun-program/README.md): the vendored on-chain program reference behind the launch surfaces
- [pump-fun-mcp at the edge](./pump-fun-mcp-edge.md): the Cloudflare Workers mirror of the pump.fun MCP endpoint
- [Package extraction](./package-extraction.md): how reusable packages graduate out of the monorepo
- [Agent task briefs](./agent-tasks/README.md): self-contained task prompts for AI agents working on the platform
- [Troubleshooting and FAQ](./troubleshooting.md): fixes organized by symptom
- [The 3D viewer](./viewer.md): the rendering layer reference (model loading, cameras, animation, lighting)
- [Avatar Artifact](./avatar-artifact.md): the standalone viewer page, its ?agent= and ?model= parameters, and the iframe you paste anywhere
- [Farcaster memory seeding](./farcaster-memory-seeding.md): give an agent your Farcaster voice, proved with a wallet the account already verified, and revoke it in one click
- [X memory seeding](./x-memory-seeding.md): seed an agent from your public X posts behind an explicit, versioned consent you can revoke (revocation deletes what the seed wrote)
- [GitHub memory seeding](./github-memory-seeding.md): tick the profile, repositories, and READMEs your agent may read, and nothing outside that list is ever fetched or stored (disconnecting deletes every fact it wrote)
- [Memory seed connectors](./api-reference.md#memory-seed-connectors-api): the public read-only lane behind the seeding demo. Turn a GitHub, X, or Farcaster handle into a footprint payload, then synthesize a memory seed from any subset of them
- [The catalog quality gate](./seed-quality.md): how a platform-seeded model earns its slot in the public catalog, the two stages it must pass, and why a rejected asset is kept rather than deleted
- [Likeness evaluation](./likeness-eval.md): the Phase 1 verification metric, measured rather than asserted. Every reconstruction is rendered at three yaws and compared to the photos it was built from with an open-source face-recognition embedding, so "4 out of 5" means one fixed, calibrated thing
- [Examples gallery](./examples.md): copy-paste-ready code for common use cases
- [Cookbook](/cookbook): recipes you download and run, each one a real file executed against the live API, with the prose explaining why it is shaped that way
- [Premium](./premium.md): the monthly Data API pass, one on-chain payment replacing per-call micropayments for 30 days
- [Guardian console](./guardian.md): the inbox for the other side of social recovery and inheritance of agent wallets
- [Coin Clash](./clash.md): token-gated community battles between coin factions
- [Daily Forge](./daily-forge.md): a new deterministic 3D creative challenge every day
- [x402 Studio](./x402-studio.md): the merchant console for running a paid x402 business on three.ws
- [Contributing](./contributing.md): local environment setup through a mergeable pull request
- [ERC-8004 smart contracts](./smart-contracts.md): contract interfaces, deployed addresses, and how to read and write each registry
- [Internationalization](./i18n.md): how the UI translation catalog works and how to add a locale
