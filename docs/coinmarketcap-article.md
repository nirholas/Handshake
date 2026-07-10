---
title: "three.ws, Giving AI Agents a Body, a Wallet, and a Home Onchain"
target: CoinMarketCap Community / Editorial
---

# three.ws: Giving AI Agents a Body, a Wallet, and a Home Onchain

## The missing layer between AI and crypto

For most of the last two years, the conversation about AI and crypto has lived inside a narrow lane: chatbots that can read a wallet balance, agents that can sign a swap, frameworks that promise "autonomous trading" but stall the moment the demo ends. What's been missing is the layer underneath all of that, a way for an AI agent to actually *exist* as a first-class object on the internet. To have an embodiment users can see. An identity that survives a model swap. A wallet that can pay for its own compute. A reputation that follows it across apps. A way to be embedded anywhere a YouTube video can be embedded today.

[three.ws](https://three.ws) is building exactly that. It is an open-source platform that turns an AI agent into a persistent, ownable, multi-chain object, a 3D body in the browser, an LLM brain, an onchain identity registered on any of 15+ EVM networks (or Solana), and a distributable web component you can drop into any page on the internet. Every layer is open source under Apache 2.0. The full stack is live and in production.

This article is about the part of three.ws that matters most to the crypto-native reader: **the onchain layer**. How the platform uses ERC-8004 across the EVM ecosystem, why it deploys to the same address on every chain, how Solana fits in, what role IPFS plays, and where the project is heading with agent tokens, reputation markets, skill royalties, and a decentralized inference network.

## Why an agent needs to be onchain in the first place

Before the chains and contract addresses, the *why*. An off-chain AI agent, the kind you spin up in a SaaS dashboard, has a problem that gets worse the more useful it becomes:

- **It can disappear.** The hosting company shuts down. The terms of service change. The model is retired. Whatever memory, audience, or reputation that agent built up vanishes with it.
- **It cannot be trusted at a distance.** If two strangers' agents need to coordinate, there is no way to verify which one is which, who owns it, what it has done before, or whether it is even the same agent it claimed to be yesterday.
- **It cannot transact.** An agent that wants to pay another agent for a service, or pay a GPU node for inference, or collect a royalty when its skill is used, has no way to do any of that without a human in the loop holding the keys.

The crypto-native answer to all three problems is the same: anchor the agent to a public ledger. Give it a stable ID, an owner, a wallet, a signed action history, and a manifest that lives on permanent storage. Then any third party, another agent, a marketplace, a reputation oracle, a human, can verify the agent without trusting whoever happens to be hosting it today.

That is what ERC-8004 is for, and that is the layer three.ws ships in production.

## ERC-8004: a passport for agents

ERC-8004 is a draft standard for verifiable agent identity on EVM chains. The three.ws implementation is a Foundry project containing three Solidity contracts. Each one solves a different piece of the agent-trust problem.

### IdentityRegistry, the agent itself

`IdentityRegistry.sol` is an ERC-721 contract. Each agent is a token. Token ownership equals agent ownership. The contract stores:

- a stable `agentId` (the token ID)
- the `owner` address (your wallet, or a multisig, or another contract)
- an optional `delegatedSigner`, a secondary address authorized via EIP-712 typed signatures to sign on the agent's behalf at runtime, so the cold owner key never has to be online when the agent acts
- a `tokenURI` pointing at the agent's manifest JSON, pinned to IPFS
- an on-chain `metadata` array for name, description, and image pointer

Because it is an ERC-721, it inherits the entire NFT toolchain for free: marketplaces can list it, wallets can display it, indexers already understand it, and any contract that knows how to talk to ERC-721 can talk to an agent. The transferability is real, sell an agent and the buyer becomes its owner, full stop.

The delegated-signer pattern is the part that matters for autonomy. The cold owner wallet stays in a hardware device. The agent runtime is given a hot signer key, which the contract recognizes as authorized to sign as the agent, but only for actions, never to transfer ownership or change registration. This is the cryptographic move that lets an agent operate continuously in the background without exposing the owner's main keys.

### ReputationRegistry, what the agent has done

`ReputationRegistry.sol` is where signed feedback lives. Any address can submit one score per agent, in the range −100 to +100, along with a URI pointing at the review's full text. The contract exposes `getReputation()` returning an average (scaled by 100 to preserve precision in integer math) and a count.

The on-chain part is intentionally minimal, averages, counts, signers, timestamps. The *content* of the reviews lives off-chain at the URIs. This is the right split: the chain enforces *who said what about whom and when*, and the off-chain layer carries the human-readable detail. A reviewer can't be impersonated, can't double-count, and can't be erased after the fact.

### ValidationRegistry, what experts have certified

`ValidationRegistry.sol` is for attestations from allow-listed validators. Where ReputationRegistry is open to everyone, ValidationRegistry is curated: only addresses on the validator allow-list can record attestations. Each attestation contains a `passed` boolean, a `proofHash`, a `proofURI`, and a typed `kind` (e.g., "gltf-validation", "skill-audit", "security-review").

This is how the platform records that a glTF model passed Khronos validation, that a skill was audited, that a security review was done, verifiably, with the validator's identity attached. An agent's passport can show not just "owned by this address with this reputation" but "validated by these specific reviewers for these specific kinds of correctness."

## CREATE2 across 15+ chains: same address, everywhere

This is one of the most important architectural choices three.ws made, and it is the kind of detail crypto users will appreciate but newcomers often miss.

All three contracts are deployed via CREATE2 to **deterministic addresses that are identical on every supported chain**. That means whether you are on Ethereum, Base, Arbitrum, Polygon, Optimism, Linea, Scroll, Avalanche, Celo, BSC, Gnosis, Fantom, zkSync Era, Moonbeam, or Mantle, the IdentityRegistry lives at the same address: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. The ReputationRegistry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. (The vanity-prefixed `0x8004…` addresses are not an accident, they are mnemonic, easy to recognize at a glance, and the same on every chain you'll ever encounter them on.)

For testnets, the same property holds. BSC Testnet, Sepolia, Base Sepolia, Arbitrum Sepolia, Optimism Sepolia, Polygon Amoy, and Avalanche Fuji all share one IdentityRegistry address (`0x8004A818BFB912233c491871b3d84c89A494BD9e`), one ReputationRegistry (`0x8004B663056A597Dffe9eCcC1965A193B7388713`), and one ValidationRegistry (`0x8004Cb1BF31DAf7788923b405b754f57acEB4272`).

Why does this matter?

**Multi-chain UX without confusion.** A user choosing where to mint their agent does not need to learn a different address on each chain. SDKs, indexers, block explorers, frontends, and other agents all use the same address. The chain becomes an axis of cost and ecosystem preference, not an axis of "where is the contract this week?"

**Composability across chains.** Every protocol that integrates ERC-8004, wallets, marketplaces, reputation aggregators, AI orchestration tools, only has to memorize one address. They can be confident that every supported chain shares the same ABI and the same deployment verification.

**Lower friction to add chains.** Because the salt and bytecode are fixed, adding a new EVM chain to the supported list is a deployment, not a redesign. The frontend's `REGISTRY_DEPLOYMENTS` map adds a single chain ID and the address it already knows.

**A trust property.** The bytecode at those addresses can be byte-for-byte verified against the audited Foundry build artifacts. There is no per-chain rebuild, no per-chain compiler version drift, no possibility of "oh that contract on Polygon is slightly different." The contract on Polygon is the contract on Base is the contract on Arbitrum.

For a project that wants agents to feel like a single multi-chain object, owned on one chain, paid on another, validated on a third, this kind of address parity is foundational.

## Solana, first-class, not an afterthought

EVM coverage is broad, but the world is not entirely EVM. three.ws supports Solana as a peer chain, not a checkbox.

What that means concretely:

- **SIWS (Sign-In With Solana).** Users can authenticate to the platform with a Solana wallet using the SIWS message standard, the Solana ecosystem's analog of EIP-4361 / SIWE on Ethereum. The backend issues nonces, verifies signatures, and binds the Solana address to the user's session.
- **Solana wallet linking.** A user can link a Solana address to the same account that holds an EVM wallet. Agents can list both sides of the user's onchain footprint. Future onchain payments and royalty flows will be able to settle in either ecosystem, depending on where the counterparty lives.
- **Metaplex NFT option.** Where ERC-721 represents an agent on EVM chains, Metaplex is the standard for representing it on Solana. The platform's plan is to mirror agent identity into Metaplex so a Solana-native user can mint, own, and transfer an agent without ever touching an EVM transaction.
- **`@solana/web3.js` and Solana RPC integration.** The frontend ships with the Solana web3 SDK; the backend integrates Solana signing into the same authentication flow it uses for EVM. There is no separate Solana app, Solana is part of the same agent.

This matters because the agent economy is not going to be a single-chain phenomenon. Memecoin and consumer demand currently lives on Solana. Defi liquidity lives on Ethereum L1 and the major EVM L2s. NFT culture spans both. The serious answer to "where should an agent's identity live" is "wherever its audience is", and that means an agent identity has to be a multi-chain object from day one.

## IPFS: where the agent's manifest actually lives

The chain stores the *anchor* of an agent, its ID, owner, signer, reputation, attestations. It does not store the agent's full configuration, because doing so on-chain would be wasteful and inflexible. That data lives in a manifest JSON, and that manifest is pinned to **IPFS**.

The manifest follows the project's Agent Manifest spec. It includes the agent's name and description, a pointer to the GLB body file, the LLM brain configuration (provider, model, system instructions, temperature), the voice configuration, the memory mode, and the list of skills the agent can use. Pinning happens through Pinata or Web3.Storage at registration time; the manifest's CID becomes the `tokenURI` on-chain.

The result is that every agent has the same self-describing structure as a token's metadata, but for agency: anyone can resolve an `agentId` on-chain to a manifest CID, fetch the manifest from IPFS, and reconstruct the full agent locally. No three.ws backend required. The agent is *portable*, it does not depend on any single hosting company to keep working.

This is the same content-addressed pattern that NFTs settled on, applied one layer up: not "what art does this token point to?" but "what *behavior* does this agent point to?"

## Memory, signed actions, and verifiable history

Identity is the floor of trust. The next layer up is *what the agent has actually done*.

three.ws records every meaningful agent event, `speak`, `remember`, `skill-done`, `validate`, `load-end`, to a database log, signed by the agent's delegated signer. Each entry is keyed to the agent's onchain ID and timestamped. Optionally, these events can be anchored to a chain, written to ERC-8004's reputation or validation registry, or exported as a Merkle-rooted attestation.

The memory system is parallel. Agent memories are Markdown files with structured frontmatter (`type`, `salience`, `created`, `tags`), and they can be stored in one of four modes:

- **`local`**, browser local storage, ephemeral, free, default for development
- **`ipfs`**, pinned to IPFS, public, content-addressed, durable
- **`encrypted-ipfs`**, encrypted client-side before pinning, only the user can decrypt
- **`none`**, stateless, no memory between sessions

The encrypted-IPFS mode is the privacy-preserving default for production agents. The user holds the key. The chain anchors the agent. IPFS holds the (encrypted) memory. No central server can hand over what it does not have.

For applications where verifiability matters more than privacy, public-facing brand agents, customer-service bots whose answers should be auditable, validators of other agents, public IPFS or chain-anchored logs let third parties replay the agent's history.

## EIP-7710: delegated permissions for an agent economy

ERC-8004 gives an agent a stable identity. EIP-7710 gives an agent the ability to *act on someone else's behalf*, under cryptographically constrained permissions.

three.ws's roadmap puts EIP-7710 at the center of two flows:

1. **Skill royalties.** When a skill author publishes a tool that other agents can install, they can attach EIP-7710 delegated permissions specifying that the agent owes the skill author a per-call fee. Every time the agent uses the skill, the payment settles on-chain to the author's address.
2. **Agent-to-agent transactions.** Agents can grant each other narrowly scoped permissions: "you can spend up to X tokens from my balance for inference for the next 24 hours," or "you can sign messages on my behalf only for Skill Y." The constraint is enforced cryptographically. The grantor never has to be online.

This is the part where the platform stops looking like an LLM frontend and starts looking like financial infrastructure for autonomous agents. Recurring subscriptions, dollar-cost-averaging strategies, royalty splits on creator content, agent-to-agent compute markets, all of it can be expressed as a delegated permission with a signature, an expiry, and a scope. The cron infrastructure to execute these on schedule is already in place: `/api/cron/run-dca` and `/api/cron/run-subscriptions` run hourly in production today, executing onchain orders against the agent's wallet.

## Cross-chain indexing, making "all chains" actually feel like one

A multi-chain identity layer is only useful if there is something on top of it that *unifies* the view. three.ws runs a cron job called `erc8004-crawl` every 15 minutes. It scans the IdentityRegistry mint events on every supported chain and writes the indexed agents into the platform's database. A separate job indexes EIP-7710 delegations every five minutes.

The discovery experience that comes out of that, `/discover`, shows agents from every chain side by side. A user does not browse "Base agents" or "Polygon agents" or "Solana agents." They browse *agents*. The chain is a column on the card, not a wall between two stores.

This is the deeper claim of the platform: from the moment an agent is minted, it should feel like part of one global registry, regardless of which chain its token actually lives on. The contracts on each chain are sovereign and self-sufficient; the index just makes them legible together.

## What it actually looks like in production

Today, on three.ws, an end-user flow looks like this:

1. The user uploads a GLB model (or picks one from the library) and configures an agent, name, description, system instructions, voice, skills.
2. The user clicks "Register on-chain." The platform uploads the manifest to IPFS and pins it.
3. The user picks a chain. They might pick Base for low fees and a strong consumer ecosystem. They might pick Ethereum L1 for prestige and permanence. They might pick Solana for speed and a different audience. The platform supports all of them.
4. The user signs an EIP-712 typed message with their wallet (or a Solana equivalent). The transaction submits. Within a few seconds, an ERC-721 token (or a Metaplex NFT on Solana) is minted to their address.
5. The agent now has a stable on-chain ID. Its `tokenURI` resolves to its IPFS-pinned manifest. Its actions can be signed by a delegated runtime key. Its reputation is open for anyone to score. Its validation can be attested by the platform's validator set.
6. The user grabs an embed code from the Widget Studio. They paste it into their Substack, their personal site, their Notion page, their startup's marketing site, or a Webflow project. The agent now exists on the public web, visible, animated, conversational, and the chain receipt of its existence is permanent.

That's the loop. It works today. The contracts are deployed, the cron jobs are running, the IPFS pins are live, the OAuth 2.1 server and MCP endpoint are in production, and the `<agent-3d>` web component ships from the project's CDN at versioned URLs (`/agent-3d/x.y.z/agent-3d.js`).

## What's coming: agent tokens, reputation markets, royalties, and an inference network

The roadmap on the project's GitHub is unusually specific about what comes next, and it is heavily onchain.

**Agent tokens.** Phase 3 of the roadmap introduces tokens *for individual agents*, bonding-curve mints or fair-launch options where each agent has its own market. This is where the agent stops being just a collectible and starts being a tradable economic object whose price is informed by its reputation, its action history, and its earnings.

**Reputation markets.** Stake on agents. Earn from their action history. The existing `ReputationRegistry.sol` is the substrate; the next layer turns reputation from a static score into something the market can price in real time.

**Skill royalties via EIP-7710.** Every time an agent calls a skill, the skill author earns. The permission framework that makes this safe is already specified.

**Subscriptions and DCA.** Recurring on-chain payments to creators are already being executed by cron jobs. The user-facing flows that productize them are coming next.

**Open inference network.** Phase 4 is the most ambitious: decouple agent inference from any single API provider. Anyone runs a node. Agents pay nodes onchain for compute, with cryptographic receipts. This is the bet that the long-run answer to "who runs the GPU that powers the agent" is not a single hosted API but a permissionless network with onchain settlement, closer to how Bitcoin and Ethereum settle blocks than to how today's AI APIs settle bills.

Each phase is gated on funding and partnerships rather than on technical risk. The contracts are working. The infrastructure is working. What is missing is the audit budget, the inference GPUs, the indexer scaling, and the engineering headcount to execute. The project is open to partners on all of it.

## Why this is an onchain story, not just an AI story

Plenty of teams are building AI agents. Plenty of teams are building agent identity systems. The reason three.ws belongs in a CoinMarketCap reader's feed, specifically, is that every interesting decision in the platform has been made the *crypto-native* way:

- The identity is an ERC-721 token, not a SaaS row in someone's database.
- The contracts are deployed deterministically across 15+ chains, not on a single "preferred" chain.
- Solana is supported at the same tier as EVM, not retrofitted as an afterthought.
- The manifest is pinned to IPFS, not stored on a centralized CDN.
- The signed action log is reproducible by any third party, not behind an internal API.
- The reputation system is open and pseudonymous, not curated by a moderator.
- The economic future of the platform, agent tokens, royalties, payments, inference settlement, is being built on contracts and cryptographic permissions, not on Stripe and a terms-of-service page.

The platform is open source under Apache 2.0. The viewer, the runtime, the contracts, the backend, the embedding layer, all of it. If three.ws disappeared tomorrow, the agents minted today would still be onchain, their manifests would still be pinned to IPFS, the contracts would still be callable, and any reasonably motivated developer could rebuild the frontend in a weekend.

That's the property that distinguishes a *protocol* from a product. Most "AI agent platforms" today are products. three.ws is being built as a protocol, with an unfortunately polished product layer attached so people who are not developers can use it.

## The bottom line

If you believe AI agents are going to be one of the dominant kinds of software over the next decade, then you have to have a view on where they live, who owns them, how they pay each other, and how anyone can verify that the agent talking to them today is the same one that talked to them yesterday.

The non-crypto answer to those questions has historically been "trust the platform." three.ws's answer is the crypto-native one: anchor the agent's identity to ERC-8004 on whichever chain its audience lives on, pin its configuration to IPFS, sign its actions with a delegated key, score its reputation publicly, and let it transact through cryptographically scoped permissions.

That makes an agent a *first-class citizen of the open internet*, not a tenant on someone's server.

The infrastructure for that vision is shipping today, on Ethereum and Base and Polygon and Arbitrum and Optimism and Linea and Scroll and Avalanche and Celo and BSC and Gnosis and Fantom and zkSync and Moonbeam and Mantle and Solana. The roadmap from there to a full onchain agent economy, tokens, royalties, reputation markets, decentralized inference, is published, scoped, and open for partners.

If you've been waiting for the moment AI and crypto stop talking past each other, this is what it looks like when they don't: an agent with a body you can see, a brain you can talk to, an identity nobody can take away, and a wallet of its own.

---

*three.ws is open source under Apache 2.0. The repo, contracts, and full roadmap are at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws). The platform is live at [three.ws](https://three.ws).*
