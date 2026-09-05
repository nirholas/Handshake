---
venue: CoinMarketCap Community (Articles Management > Add a new article)
account: three.ws (official)
categories: Solana, AI, Announcements
assets: THREE
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
format_notes: |
  CMC caps the title and the meta description at 191 characters each. The body editor
  offers H2 and H3 only and has no table support (a markdown table pastes as one
  run-on line), so every list below is plain lines. Cover art: 640x360 or that
  proportion, under 10 MB.
accuracy_notes: |
  Live figures were read from https://three.ws/api/three-token/stats on 2026-09-04 and
  are labelled with that date. Footprint figures come from the open-source audit dated
  2026-08-25. Price, market cap and volume move, so the draft points at the live
  endpoint instead of freezing them. pump.fun verification is read live per request and
  is described as a mechanism, never asserted. The OKX.AI marketplace listing is under
  review and is described as such. Agent-to-agent volume is quoted only from our own
  completed-hire ledger; third-party x402 aggregator volume figures are not repeated,
  because at least one of them is inflated by roughly three orders of magnitude.
---

# CoinMarketCap article: the agent economy grew a body

Paste-ready for the CoinMarketCap form.

## Title (129 characters)

```
The Agent Economy Grew a Body: What a three.ws Agent Can Actually Buy Now, From Enterprise Inference to a Printed Object in a Box
```

## Meta description (190 characters)

```
An agent that can sign a transaction is not news. An agent that can pay for manufacturing, a stranger's attention, or Granite inference is. The open-source stack behind it, and the receipts.
```

## Body

---

Every cycle produces a category that is 90% narrative and 10% software. "AI agents with wallets" has been that category for about a year. The demos all look the same: an agent reads a balance, an agent signs a swap, a countdown timer, a token.

The interesting question was never whether an agent can sign a transaction. It obviously can. The interesting question is what is on the other side of the payment, and whether anything real is at the end of it.

Here is what changed at three.ws over the last few weeks. An agent can pay to have a physical object manufactured and shipped to an address. An agent can pay a stranger for thirty seconds of their attention, and get its money back if the stranger never answers. An agent can pay per call for enterprise-grade inference with no cloud account of its own. An agent can be hired by another agent, with the spend reserved against its owner's budget before any money moves and the row marked complete only after a settlement signature exists.

None of that is a demo. All of it is open-source code you can read, on rails that settle in USDC, with Solana as the home chain. This is the tour: identity, payments, what is actually purchasable, the trading surfaces, the worlds, the phones, the honest numbers, and every place it is listed.

$THREE is the platform's coin, at FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump on Solana.

## Identity first, because an unidentified agent cannot be paid safely

An off-chain agent has three problems that get worse the more useful it becomes. It can disappear when a host shuts down. It cannot be verified at a distance by a stranger's agent. And it cannot hold value or collect anything it earns.

three.ws anchors every agent to a public ledger.

### On EVM: ERC-8004, same address on twelve mainnets

Three Solidity contracts, deployed by CREATE2 to identical addresses on Ethereum, Optimism, BSC, Gnosis, Polygon, Mantle, Base, Arbitrum, Celo, Avalanche, Linea and Scroll, bytecode-verified, with vanity 0x8004 prefixes that make them recognisable at a glance.

IdentityRegistry is an ERC-721, so each agent is a token and agent ownership is token ownership: transferable, listable, and legible to every wallet and indexer that already speaks ERC-721. It carries a stable id, an owner, a manifest URI pinned to IPFS, and an optional delegated signer authorised by EIP-712 typed signatures.

That delegated signer is the piece that makes autonomy safe rather than reckless. The cold owner key stays in hardware. The runtime holds a hot signer the contract recognises for actions only, never for transferring ownership or changing registration. An agent can operate continuously in the background without the owner's main key ever being online.

ReputationRegistry holds signed feedback: one score per address per agent, from minus 100 to plus 100, with the review text off-chain at a URI and the chain enforcing who said what about whom and when. A reviewer cannot be impersonated, cannot double-count, and cannot erase a review after the fact.

ValidationRegistry holds attestations from allow-listed validators, each carrying a passed flag, a proof hash, a proof URI, and a typed kind such as gltf-validation, skill-audit, or security-review. This is how an agent's passport can say not only "owned by this address with this reputation" but "validated by these specific reviewers for these specific kinds of correctness".

### On Solana, which is the home chain and not a checkbox

The identity analog is Metaplex Core: the asset pubkey is the agent id, and SPL Memo anchors reputation and validation attestations. At the last open-source audit on 2026-08-25 there were 3,000 validator attestations written under the platform's validation envelope, and 126,522 custody proofs across 244 epochs.

Two Solana programs written in Anchor back the on-chain half: agent invocation and skill licensing. Every coin launched through the platform carries a mint address beginning with 3ws, ground into the keypair itself by a vanity grinder compiled to WebAssembly that runs in the browser.

### Wallets that hold an allowance, not a key

The instinct when you give an agent buying power is to hand it a credential. That is the wrong primitive: a credential is unbounded until revoked, and revocation is a human action that happens after the money is gone.

What an agent gets instead is a policy. A budget, a set of allowed counterparties, a per-call ceiling, an expiry. It is published as a package for anyone to use: an on-chain spending allowance for an agent rather than a private key, per-agent spend policies and trade guards as a standalone library, and budgeted payment sessions where the agent holds a session handle and never touches a wallet at all.

## The payment layer, and the parts everyone skips

Payments run over x402: the caller requests, gets a structured HTTP 402 challenge describing what to pay and where, pays, retries with proof. Elegant, and about a third of the actual work.

The other two thirds are the failure paths, and they are where an agent economy either becomes real or quietly bleeds money.

### Preflight: do not pay a seller that cannot settle

Before paying anyone, ask whether the seller can actually complete the exchange. Is the challenge well formed. Is the receiving address real. Do the declared chain and asset match what is being asked for. Does the settlement path respond.

We learned this by losing calls to sellers that answered a challenge, accepted the proof, and then failed on their own settlement. It is now a page and a package, and it is free.

### Re-quotes, bounded at exactly one retry

If a paid replay itself answers 402, the seller refused the proof, usually because it re-quoted between probe and replay. In that case the signed transfer was never broadcast, so no money moved and exactly one retry against the fresh requirements is safe. That retry re-applies the spend cap and the recipient allowlist to the new quote, and then stops. An unbounded retry against a re-quoting seller is a slow drain, and it looks like success in your logs.

### Reserve, settle, complete

In the agent-to-agent hire path, a row is written pending and the spend is reserved against the owner's policy in the same SQL statement that checks it, so four of your agents spending at once cannot race past a budget. Because the protocol verifies before it settles, a failure means no funds moved: the reservation is released and the row flips to failed. Only after USDC has settled does it flip to completed, with the settlement signature, the payer address and the result summary attached.

That is why the public roll-up at three.ws/agent-economy-volume is trustworthy in a way most agent-economy dashboards are not. Every aggregate filters on completed, so volume means USDC moved on chain with the signature on file. Pending and failed hires contribute exactly zero to volume, counts, averages, leaderboards, and the feed. When the ledger is empty the endpoint returns a real zero and the page renders its empty state rather than inventing a number.

### The rail is ours, end to end

The settlement facilitator is self-hosted, in the repo, not a third-party dependency. At the 2026-08-25 audit it had processed 110,416 on-chain USDC settlements and 803,483 verifications. Nothing routes through anyone else to settle on Solana.

Discovery is a static, public catalog at three.ws/.well-known/x402.json listing 4,519 priced endpoints, every one on Solana mainnet, cacheable and diffable and readable by anything. A dynamic discovery API would have been one more availability dependency in the middle of a payment flow.

The receipt vault holds 58,907 signed Offer and Receipt artifacts, retrievable indefinitely. An entitlement answers whether a caller may do something. A receipt answers whether the exchange actually happened, and lets a third party check. Enterprise buyers ask the second question eventually.

One more piece of housekeeping worth saying out loud: the payments feed now separates the platform's own autonomous spend from third-party demand. A platform paying its own endpoints and reporting the total as ecosystem volume is the oldest trick in this category, and we would rather not be accused of it.

## What an agent can actually buy

This is the part that changed most this quarter.

### A physical object

Materialize turns a generated 3D model into a real one: resin, nylon, colour sandstone, or steel, printed and shipped. Every step is an API, so an agent can order a physical object of a model it generated ninety seconds earlier with nobody in the loop.

The sequencing is the interesting part.

Analysis first, free and keyless: a printability report before any price, covering whether the mesh is a closed solid, how many separate bodies it has, where its holes are, its thinnest wall, its exact volume, and a 0 to 100 score with named deductions written in plain language. Free because a check that costs money is a check nobody runs.

Then a signed quote token, valid 24 hours, so the quoted price is the paid price and nothing in between can move it.

Then two checkouts on one pipeline: a human pays in the browser, an agent pays over 402, same order and same statuses.

Then a safety screen that is allowed to refuse, before production: no weapons, no functional key duplicates, no third-party brand marks. A print bureau has a human at that checkpoint. An API whose buyer is a machine has to put it in code.

Then a certificate of authenticity attested on Solana, with a QR code in the box, so the object proves which generation produced it. Creators can cap how many copies of a model will ever exist.

As far as we know this is the first API where an AI agent can pay for manufacturing.

### A stranger's attention, refundable

Knock is a priced door to a person. You publish it, you set what one message from a stranger costs, and the price does the filtering: someone who genuinely needs you buys thirty seconds for a nickel, and a spammer cannot buy a million of them. Delivery is not a badge on a tab you will get to later. The recipient's 3D companion walks on screen wherever they are on the site and says who is at the door and what they paid.

Three properties that matter to a crypto reader.

The money is the recipient's. USDC settles directly to the wallet they name. The platform never takes custody of it and takes no cut of it.

A priced door cannot be opened without a payout address. The API refuses the save rather than quietly routing a stranger's money into a platform wallet.

The refusals run before the payment. Price, daily cap, message length and block list are all evaluated first, so a knock that was never going to land is never a knock somebody paid for.

New this month: knock a stranger and get your money back if they never answer, with an escrowed door you can run from your own wallet and inspect against what the chain actually says.

### Enterprise inference, per call, with no cloud account

An autonomous agent cannot sign up for a cloud account, accept terms, and provision a project mid-task. So the metered model inverts the usual one: the operator holds the credentials and funds the inference, and the caller pays a few cents of USDC per call from a wallet it already controls. Enterprise-grade models become a utility an agent can consume the moment it can pay. The IBM Granite suite built this way is, as far as we know, the first x402-enabled MCP server on IBM Cloud.

### Another agent's work

Agents hire agents for paid skills through the ledger described above. On top of that sit two primitives that make publishing a skill an economic act rather than a donation: on-chain skill licenses, where each purchased skill is a 1-of-1 SPL NFT, and skill royalties, so the author earns when somebody else's agent uses their work.

### The rails that shipped alongside

Recurring payments, so an agent can hold a subscription instead of renegotiating every call.

A reputation staking market, where asserting reputation costs something and therefore means something.

Alpha-drip, a tiered release ladder where a leader's copy-trade signal reaches higher $THREE tiers first and everyone else after a delay the leader sets. It is off by default. It delays the reveal, never the record: the intent row is written in full the instant the leader trades, the trade lands in their public track record either way, and the API has no field that could express hiding one. Acting early is refused with a 409 by the same statement that changes the status, so it cannot be raced, and the delay is shown on the leader's page before anyone subscribes, because a delay discovered from an empty inbox is the version of that feature that destroys trust.

## The trading surfaces, briefly

Copy trading with a public track record. A trader passport that carries it. Ghost-copy, which answers what would have happened if you had copied a given trader. A coin radar that tells you when it is your filter and not the market that is empty. An autonomous sniper fleet with a published oracle model you can run locally. A strategy lab that back-tests against real launches. A signals marketplace where feeds are listed with the terms to get on it. A wallet portfolio view, an airdrop checker, and a season recap.

Three of those deserve a sentence more than the rest, because they are unusual.

The oracle model is published, not just described: the conviction model runs locally, weights and all, so anyone can check what the fleet is actually deciding on.

The sniper's health is measured by whether it can act, not whether it is running. That distinction came from an audit that found twelve armed agents, all healthy by every metric we had, ten of which had not attempted an entry in weeks, because a model chain answered 404, providers were out of credit, and several wallets could not fund a single entry.

And the launch feed is a product surface, not an endorsement: it renders the coins users launched through the platform, from the platform's own launch records.

## Every coin is a world you can walk into

The multiplayer half is the piece that makes the rest social. Every pump.fun coin is a live 3D world keyed to its mint address: pick a coin, and you are standing in it with everyone else who did, as a real avatar, talking by voice.

The market does not sit politely on a panel. Buys ripple green across the plaza, sells ripple red, sustained volume spins the coin totem faster, the rolling percentage change becomes the weather, and a whale trade fires a column of light with a shockwave and a rain of gold. A quiet coin is a calm world. A coin being aped is a thunderstorm.

There is an in-world trading terminal you can walk up to, an open world anyone can enter, and a holders' world gated by a real holding, so being in the room is itself proof that everyone around you has a stake in the same coin. On top of that sit coin wars between two communities, live events with a real clock, and souvenirs you keep.

## On the phone, and off the browser entirely

The Android app is live on the Solana dApp Store, built as a Trusted Web Activity with every wallet interaction routed to the phone's Seed Vault through Mobile Wallet Adapter, plus a share target, offline handling, home-screen shortcuts, deep links, and an agent glance widget. Seeker owners can prove ownership through the soulbound Genesis Token and get a verified badge on every agent they own. The Google Play listing is in review. The iOS shell is in the repo and has not been submitted.

Beyond phones, an agent's status renders as a glance card on a Windows 11 widget board, in a GitHub README, in a Slack message, or in a terminal, and any avatar runs in a plain terminal at 24 frames a second with no browser and no GPU. There is a home surface, a car surface, and a bridge that lets any assistant control a house without ever being able to open a door it should not.

## The 3D half, in one paragraph, because it is the moat

None of the above would be interesting if the agents themselves were text boxes. A three.ws agent is generated from a prompt into a rigged, animated 3D body with 52 ARKit blendshapes for lipsync, embeddable in any website with one HTML tag. Generation runs on an owned GPU fleet across open model families, with a failover chain per lane so an unavailable model degrades quality instead of failing the request. Animation is universal: bone names are canonicalised across the Mixamo, Avaturn, Unreal, VRM, Daz, MakeHuman and Blender conventions and clips are retargeted onto whatever came in, with no curated rig allowlist. This quarter the agents also learned to see their own output, so generation became a loop instead of one shot, and to grade a model's readiness for a physics engine, which matters the moment an asset is destined for a simulator, a game, or a printer.

## The $THREE part, with the mechanics stated plainly

The coin is $THREE on Solana, FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump.

Protocol parameters are read live rather than written into a page: as of 2026-09-04 the stats endpoint reports a 1,000 $THREE burn on agent deploy and a 10 percent revenue-share pool. The same endpoint reports whether the buyback and micro-buy lanes are currently running; on the date of writing they are not, and the page shows that rather than describing a mechanism as if it were firing.

Tiers matter in one specific place: the alpha-drip ladder above, where a leader can choose to release a signal to higher tiers first. That is the only place a holding changes what the software does, and the leader sets it, not the platform.

pump.fun verification is a mechanism here, not a claim. The stats endpoint reads pump.fun's public coin record on every request (cached five minutes) and returns a live flag with three states: true when pump.fun publishes the badge right now, false when it does not, and null when pump.fun could not be reached. The badge is one shared component, so the public page and the holder dashboard can never disagree, and if verification were ever withdrawn the badge would disappear on the next read with no deploy.

## The honest numbers

Live figures, read on 2026-09-04 from an endpoint you can call yourself:

3,514 registered agents, and 15,781 $THREE holders, both from GET /api/three-token/stats.

Price, market cap, 24-hour volume and liquidity are on that same endpoint. They move. Read them; do not quote this article.

Agent-to-agent volume is at three.ws/agent-economy-volume, counting completed hires only.

Footprint figures, from the open-source audit dated 2026-08-25:

110,416 on-chain settlements and 803,483 verifications through a facilitator we host ourselves. 4,519 priced endpoints in the public discovery catalog. 58,907 signed receipt artifacts. 3,000 validator attestations and 126,522 custody proofs on Solana. 91 npm packages in this repo, 72 MCP servers in the official registry, 32 GPU and service workers, 31 specs, around 1,750 test files, and 795 public pages of which 128 landed since 1 August.

Three things we will not do, named because the category is full of them.

We do not repeat inflated third-party volume. At least one popular x402 aggregator's roll-up overstates our volume by roughly three orders of magnitude. Our own ledger is the number we stand behind, and it is smaller.

We do not count our own spending as demand. The payments feed separates the two.

We do not hardcode a verification badge, a partner tier, or a listing status.

## Where this is listed, precisely

Live: the BNB Chain Dappbay directory, categorised under AI Agent Launchpad, AI Data and AI Infra. The Alibaba Cloud International Marketplace, with a product listing, a storefront, and an editorial feature on the marketplace blog. The Solana Mobile dApp Store. The OpenAI GPT Store. The official Model Context Protocol registry, with 72 servers under one namespace. The VS Code Marketplace and Open VSX. The Chrome Web Store, for the walking avatar extension. And a feature article on the $THREE coin page on pump.fun.

Built and waiting: AWS Marketplace, where the SaaS integration is deployed and conformant but the listing itself is not yet public, so there is nothing to subscribe to on the AWS side today. Google Play, in review. The OpenAI plugin directory, open to submission, where the gating requirement of a public OAuth 2.1 MCP server is already met. Google Cloud Marketplace, open to partnership. Microsoft Azure Marketplace, on the roadmap.

Under review, and described as exactly that: the OKX.AI agent marketplace, where the platform is submitted as a service provider agent on X Layer. It is not listed yet, and we will not call it listed until it is.

## The programmes, with no upgrades

OpenAI: Select Partner in the OpenAI Partner Network. A partner designation, not an endorsement.

IBM: Business Partner. The public Granite-backed endpoints are independent developer tools, not IBM products and not endorsed by IBM.

AWS: AWS Partner, with three articles published on the AWS Builder Center and a SaaS metering integration built for Marketplace.

Google Cloud for Web3 Startups: member. Production, the API, and the GPU fleet run on Cloud Run, with Vertex AI in the model chain.

NVIDIA: Inception member since July 2026, with two write-ups on the NVIDIA developer forums. A startup programme, not a partnership and not an endorsement.

Alibaba Cloud: a live marketplace listing and storefront, with Qwen models as lanes in the model router.

Quicknode: accepted into the Startup Program in July 2026. Its RPC endpoints are one rung in the Solana failover chain, not the whole chain.

HackerNoon: publishing partner. Announcements auto-import from the platform's RSS feed and publish with canonical URLs pointing back.

## Why any of this should matter to a crypto reader

Because the agent-economy thesis has been stuck at the same demo for a year, and the bottleneck was never the payment protocol.

An agent that can pay is not interesting. An agent that can pay for something that exists is a different thing entirely, and getting there required a pile of unglamorous work: a budget that cannot be raced, a preflight that refuses a seller who cannot settle, a safety screen that is allowed to say no to the buyer, a receipt a stranger can verify, a ledger where only settled rows count as volume, and a health model that can tell you an agent is running perfectly and structurally unable to act.

That is the whole argument. The narrative layer of this category is saturated. The infrastructure layer is not, and it is where the next real thing gets built.

Everything above is open source under Apache-2.0 at github.com/nirholas/three.ws. The free 3D generation lane needs no account, no key and no wallet at three.ws/forge. The coin is $THREE on Solana at FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump, and the live figures behind every number in this article are one curl away at https://three.ws/api/three-token/stats.

Nothing here is financial advice. Read the endpoints, not the adjectives.
