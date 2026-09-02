---
venue: CoinMarketCap Community (Articles Management > Add a new article)
account: three.ws (official)
categories: Solana, AI, Announcements
assets: THREE (or SOL if THREE is not searchable in the picker)
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# CoinMarketCap article: three.ws on Seeker, Android, and iPhone

Paste-ready for the CoinMarketCap form. CMC caps the title and meta description at 191 characters, the body editor offers H2 and H3 only, and it has no table support (a markdown table pastes as one run-on line), so every list below is plain lines. Cover: 640x360 or that proportion, under 10 MB. Upload `marketing/mobile-launch/cmc-cover-1280x720.png` (the exact 640x360 sits beside it); both are rendered from real product captures by `node marketing/mobile-launch/make-cmc-cover.mjs`.

## Title (108 characters)

```
three.ws Is Now on Solana Seeker, Android and iPhone: A 3D Agent Studio, a Wallet That Never Leaves the Chip, and an Economy
```

## Meta description (184 characters)

```
The open-source platform that turns a selfie into a rigged 3D AI agent you own on Solana is now three native apps. Why we built mobile, what is inside, every partner, and where it goes next.
```

## Body

---

three.ws, the open-source platform that gives AI agents a 3D body, an on-chain identity, a wallet, and a way to get paid, is now three native apps: one on the Solana dApp Store for the Seeker, one on Google Play for every Android phone, and one on the App Store for iPhone. Same product, same account, same library, three home screens.

This is the long-form version for the crypto-native reader: why a platform like this had to end up on a phone, why Solana is the home chain, what the apps do that a browser cannot, what the economy underneath them has become in the five months since the first commit, how $THREE sits in the middle of it, and what we are building next. Every number here is checkable against the public repository, the public changelog, or a public listing.

## The problem three.ws exists to solve

For two years the AI-and-crypto conversation lived in a narrow lane: chatbots that can read a wallet balance, agents that can sign a swap, frameworks that promise autonomous trading and stall when the demo ends. What was missing was the layer underneath: a way for an AI agent to exist as a first-class object on the internet. A body people can see. An identity that survives a model swap. A wallet that pays for its own compute. A reputation that follows it across apps. A way to be embedded anywhere a video can be embedded.

three.ws builds that layer, and it builds it in a specific order. The body first, because presence is how humans decide to trust something. Then the mind: an LLM brain with a tool loop, memory, skills, and emotion on the face. Then the identity: a Metaplex Core asset on Solana or an ERC-8004 token on EVM chains, portable, provable, ownable. Then the economy: x402 pay-per-call rails so the agent can earn and spend USDC without a human holding the keys.

The phone is where all four of those layers finally meet the person using them.

## Why mobile was inevitable

Look at where the inputs to a three.ws agent actually live.

The camera that takes the selfie is on the phone. The photo roll full of faces is on the phone. The wallet is on the phone. The share sheet, the gesture that moves a picture from one app to another, is on the phone. The AR camera that can stand an agent on your floor is on the phone. The GPS that lets an agent be pinned to a park bench is on the phone. The home screen, where a widget can show you your agent's day without opening anything, is on the phone.

A desktop browser renders three.ws beautifully and always will. But it cannot take the selfie, cannot walk into the room, cannot stand at the bench, and cannot sign without an extension. The product wanted to be on a phone from the first commit. The apps are it arriving there.

## Why Solana, and why the Seeker first

Solana is the home chain for three.ws for a reason that has nothing to do with narrative. It is where the users are, where the wallets are, where a transaction costs less than the attention it takes to approve one, and, since the Seeker shipped, where the phone is.

The Seeker is the device where the wallet story is finally right. Inside the three.ws app every signature routes to the Seed Vault through Mobile Wallet Adapter. Sign-In With Solana is a single interaction instead of a connect step followed by a signing step. The private key never enters the application process at all; it stays in the hardware-isolated secure element. Approve a session once and it survives Android killing the app in the background, because the authorization token is persisted and the next signature is a silent reauthorize rather than a fresh prompt. Revoke the session in the wallet and the app drops it cleanly and asks again next time.

Own a Seeker and you can prove it without moving anything. Solana Mobile mints a soulbound Seeker Genesis Token, a Token-2022 asset, into every device's primary Seed Vault account. The three.ws server reads the linked wallet's Token-2022 accounts, checks the mint authority, the metadata pointer, and the token-group membership against the Genesis group, and records the verification. No transaction, no signature, and it fails closed: an RPC error is a 502, never a false positive. Every agent a verified owner holds shows a Seeker verified badge on its profile.

Everything else in this article works on every Android phone and every iPhone too. The Seeker is where it works best.

## The three apps

### Solana Seeker, on the Solana dApp Store

The app is a Trusted Web Activity: the real three.ws, full screen, no browser chrome, with every wallet interaction routed to the Seed Vault. Share a photo to three.ws from any app and it opens the selfie flow with the photo already attached. Share a .glb and it opens the upload flow. Long-press the icon for Create, Discover, and My agents. Any three.ws link opens inside the app instead of a browser tab, verified through Digital Asset Links against our published signing certificate at three.ws/.well-known/assetlinks.json. If the two disagree, the app is not ours. Lose the network and you get a branded offline screen that reloads itself when you are back.

### Android, on Google Play

The same package, ws.three.app, for every Android phone from 6.0 up, 3.95 MB. Signing runs through Mobile Wallet Adapter into whatever wallet app you already trust, so three.ws never sees a key or a seed phrase. three.ws is not a wallet, holds no funds, and runs no exchange; the Play declaration says exactly that.

Version 1.1 added Agent glance, a home screen widget in three sizes that shows your agent's avatar, its name, and how many moves it made today. It refreshes itself about every thirty minutes without opening the app, keeps the last card it saw when the phone is offline, survives a reboot, and opens your agent on tap. Link a phone from three.ws/glance in one tap. Every linked widget carries its own revocable token that can read your card and nothing else, and every one is listed on that page with a revoke button.

### iPhone, on the App Store

A native shell whose WebView runs the live product, wrapped in the native layer a website cannot have: universal links so any three.ws link opens in the app, the system share sheet with AR captures attached as real image files, wallet and sign-in redirects that come back over threews:// to the exact page that started them, an in-app Safari sheet for off-site links so you always have a way back, haptics on primary actions, edge-swipe back and forward, real camera and motion permission prompts for the selfie scanner and AR, and a launch screen that holds until the first real frame so a three.js scene never opens onto a black void. Because the native bridge ships with the site rather than the binary, the app improves on every web deploy.

On desktop, three.ws installs as a PWA, and on Windows 11 the same glance card lives on the widgets board.

## What you can do from the phone, with no wallet at all

Creating, chatting, and browsing never touch a chain. That order is deliberate, and it is the whole thesis of the launch.

### Forge: text to 3D

Describe an object, a prop, a creature, or a scene and get a textured 3D model back, ready to download as glTF. The draft lane is free with no key and no account and finishes in about twelve seconds on NVIDIA's hosted TRELLIS lane. Paid lanes go to 200,000 polygons with PBR materials and game-ready retopology, priced at $0.05, $0.15, and $0.50 in USDC over x402 for anyone, human or agent, who wants to pay per call.

### Scan: one selfie, a rigged character of you

One frontal photo becomes a rigged, animation-ready avatar in about a minute, with a Mixamo-compatible skeleton and the full ARKit-52 blendshape set. Two optional side angles sharpen the likeness. A live 468-point face mesh runs on-device and tells you about lighting, framing, blur, or window glare before you spend the minute waiting.

### Agents: give it a mind

Attach a personality, a voice, skills, and memory to any character and talk to it. It answers in 3D, in your language, with emotion on its face and lip-sync on its mouth. Pick the brain: Claude, GPT, Gemini, Qwen, IBM Granite, or NVIDIA Nemotron.

### AR and IRL

Every model and agent has a View in AR button that works on the first tap: Quick Look on iPhone, Scene Viewer on Android, full WebXR where the browser supports it. IRL goes further: pin any agent to a real GPS coordinate and anyone who physically walks up sees it through their camera, anchored to the floor, and can talk to it, complete quests it signs, and pay it a few cents in USDC settled on-chain inside the same request. Anyone who is not there sees nothing. There is no directory and no map query, by design.

### Marketplace, embeds, worlds

Browse everyone else's work, orbit any agent, open its page and talk to it. Every agent has a shareable URL and a one-line embed for Telegram, X, Notion, or your own site. Play is a persistent multiplayer world in the browser with spatial voice, building, vehicles, quests, and an in-game economy; every token community gets its own world derived from its mint address, and at the first community meetup in August 3,145 avatars were in the plaza at once.

## Ownership is one tap, and it is optional

When an agent should be properly yours, one tap deploys it on Solana as a Metaplex Core asset held in your own wallet, with an open manifest and an enforced 5% royalty plugin, enrolled in the Metaplex Agent Registry. Sell its skills, take tips, trade the agent itself in USDC. Deploying costs whatever Solana charges, typically under 0.01 SOL. Bulk deploys run at roughly 0.007 SOL per agent.

On EVM chains the same agent is an ERC-8004 token. Our identity, reputation, and validation registries are deployed by CREATE2 to one deterministic address on twelve mainnets, so the contract on Base is byte-for-byte the contract on Polygon, Arbitrum, Optimism, BSC, Gnosis, Mantle, Celo, Avalanche, Linea, Scroll, and Ethereum.

Most crypto apps ask people to install an extension, write down twelve words, and buy something before they have made anything at all. three.ws gives people the magic first and lets the wallet come second, on the day they care about it.

## The economy the apps plug into

This is the part that separates three.ws from an avatar maker. The agents are not decoration. They hold wallets, they sell services, they pay each other, and every trade becomes content. The economy that has been running on the web now runs from a phone.

### x402: HTTP 402 as the settlement layer

three.ws speaks x402, which revives HTTP's Payment Required status. An agent calls an endpoint, gets a price back, pays in USDC, retries with proof, and gets its answer. No API key, no subscription, no invoice, no human in the loop. Solana is the primary rail through a self-hosted facilitator; Base settles through the Coinbase CDP facilitator; a BSC leg exists too. As of late August the Solana facilitator had settled 110,416 payments on-chain and verified 803,483. There are 4,519 priced endpoints in the live discovery catalog, over a million individually priced datapoints at $0.0005 each, and the platform's own audit log records tens of thousands of settled payments since July 25.

### Agent wallets with spend policies

Every agent gets a custodial Solana keypair and an EVM keypair at creation, AES-256-GCM at rest with HKDF-derived keys. Five spend paths (withdraw, x402 pay, trade, purchase, snipe) all pass through one policy module at the signing boundary. Agents can buy skills and assets from the marketplace on their own, capped at ten autonomous purchases an hour and one shared daily USDC limit, with a 402 spend_cap_exceeded when they hit it.

### The launchpad, from your phone

Launch a coin from the app with a living 3D agent as its face. It talks to your community, walks in AR, and its world goes live the moment the coin does. An agent can launch autonomously over x402 for a flat $5 in USDC with no SOL and no wallet of its own; the platform fronts the deploy. Every mint address launched through three.ws is vanity-ground to start with 3ws, a brand mark in the keypair itself, and every launch appears in one public feed.

### The rest of the stack

The Oracle scores every pump.fun launch from 0 to 100 with reasoning and a public track record, every two minutes. USDC vaults let strangers back a verified trading agent behind seven ordered guards and a public audit ledger written before funds move. Swarms put many agents on one real on-chain treasury with reputation-weighted consensus. Agora is a persistent agent-plus-human economy with bounties escrowed in $THREE. 3D Drops rolls supply-capped collections of up to 10,000 unique rigged characters with recomputable rarity. And a leak scanner has checked 44,122 wallet transactions with zero leaks found, ever.

## $THREE: hold, do not spend

$THREE is how you move up inside that economy. It is never spent for access and it is never burned. You hold it, and your tier does the work.

Bronze: hold $25 for 5% off compute and 2x the free limits.

Silver: hold $100 for 10% off and 3x.

Gold: hold $500 for 20% off and 5x.

Genesis: hold $2,500 for 30% off and 10x.

Beyond the ladder: plans and Premium Data passes are 20% cheaper in $THREE, the skills marketplace and the labour market price only in $THREE, Agora bounties escrow in $THREE by default, and a published policy in the open-source code commits 50% of platform revenue to market buybacks. A micro-buy loop turns every settled x402 call into a small $THREE purchase. The treasury buys; it never sells and never burns.

The token is a Token-2022 mint on Solana, a verified project on pump.fun, Jupiter Verified, Phantom Verified, and listed on MEXC, LBank, KCEX, Bybit Alpha, KuCoin Alpha, and every major Solana DEX.

Contract address on Solana: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

There is one contract. three.ws will never launch a second token, so any migrated or replacement $THREE is a theft whatever it is posted under. We never message first, and nobody from three.ws will ever ask for a seed phrase, a private key, or a wallet signature.

## The platform in numbers

From the first commit on April 14, 2026 to the end of August:

761 public pages, more than 2,700 community-readable changelog entries, roughly twenty shipped changes a day, each one pushed automatically to the community Telegram.

101 npm packages under the @three-ws scope, 72 MCP servers in the official registry, 60 installable agent skills, an OAuth 2.1 authorization server, and a hosted MCP endpoint any AI assistant can drive.

ERC-8004 registries on 12 EVM mainnets, two Solana programs, 33 workers, 1,752 test files, 111 open-source repositories spun out with more than 1,200 stars between them.

A crypto news archive of more than 740,000 articles from 197 publishers going back to 2017, refreshed hourly, and about 15,000 DeFi pools indexed live.

More than 3,000 motion-capture animations, 500 CC0 props, and 106 rigged characters in the library.

A self-hosted GPU fleet on Google Cloud Run: NVIDIA L4s and an RTX PRO 6000 Blackwell.

All of it Apache-2.0 at github.com/nirholas/three.ws, from the renderer to the Android packaging to the release pipeline.

## Why generation is free: the partners

Serious backers covered the compute early, and each one deserves the exact designation.

Solana Mobile built the phone this app was designed for, the dApp Store it ships on, and the Mobile Wallet Adapter and Seed Vault that make the sign-in story what it is.

NVIDIA: three.ws is a member of NVIDIA Inception. Every 3D generation lane runs on NVIDIA silicon, the free hosted NIM lane behind the Forge runs TRELLIS, and Nemotron models handle the LLM, vision, embedding, reranking, and safety work around it. Membership is a startup programme, not an endorsement.

OpenAI: three.ws is an OpenAI Select Partner. The free 3D Studio connector gives ChatGPT eleven keyless 3D tools with an AR handoff on every generation. We are an independent member of the partner network.

Google Cloud: production runs on Cloud Run, the GPU fleet runs on Cloud Run, Vertex AI provides the Gemini and image lanes, and three.ws is a member of Google Cloud for Web3 Startups, whose grant funds the compute behind every model you make.

IBM: three.ws is an IBM Business Partner, and agents can think on IBM Granite models through watsonx.ai. Our public Granite tools are independent developer showcases, not IBM products.

Amazon Web Services: three.ws is an AWS Partner, publishes engineering writing on the AWS Builder Center, and has the AWS Marketplace integration built so an enterprise can link its AWS account and pay per call over x402.

Alibaba Cloud brings Qwen models into the brain router and a live listing on the Alibaba Cloud International Marketplace. Quicknode approved three.ws into its Startup Program with infrastructure credits, a rung in the Solana RPC failover chain behind agent wallets and x402 settlement. Helius powers the DAS reads behind Seeker verification. HackerNoon syndicates every announcement. MetaMask Agent Wallet early access brought EIP-7710 delegated signing into the skill set. The Coinbase Developer Platform settles the Base lane and indexes our endpoints in the x402 Bazaar.

## What comes next

Widgets on every home screen: Android and Windows have the glance card today; a shared WidgetKit extension brings it to the iPhone home screen and the macOS widget gallery against the same endpoint and the same revocable token.

Push: your agent tells you when it earned something, when someone walked up to it in IRL, or when a trade closed.

Likeness: the selfie engine is wired end to end and fidelity is the open track. The goal has not moved: creating your agent should be as simple as taking a selfie.

Voice: cloning, persona, and memory seeds move from the demos hub into the main flow.

The on-chain economy, phase three: agent tokens, reputation markets, and per-call skill royalties. The royalty ledger already accrues on paid skill calls; contracts and audits are next.

The open inference network: the node-operator client and the signed-receipt job queue are live, Livepeer federation is behind a flag, and the end state is a GPU layer no single company runs.

## Go make something

Open the dApp Store on your Seeker and search three.ws. Open Google Play or the App Store on anything else. Sign in with the wallet you already have, or do not sign in at all and start making things.

The next million people will not arrive in crypto through an exchange signup. They will arrive through something they wanted to make anyway, with the ownership waiting underneath for the day they care about it. That is what these three apps are for.

Open source: github.com/nirholas/three.ws
