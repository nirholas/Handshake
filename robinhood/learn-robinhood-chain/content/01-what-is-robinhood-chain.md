Robinhood Chain launched its mainnet on July 1, 2026. In the weeks since, the amount of confident, wrong information written about it has been remarkable. This page is the antidote: the architecture, the chain IDs, and — more importantly — the three facts that every newcomer gets backwards.

Everything here is sourced. Where a claim matters, it links to the [official docs](https://docs.robinhood.com/chain/) or to something you can verify on-chain yourself in the next tutorial.

## The one-paragraph version

Robinhood Chain is a **permissionless [Arbitrum Orbit](https://docs.arbitrum.io/launch-orbit-chain/orbit-gentle-introduction) Layer 2** that settles to Ethereum, posts its data as blobs, and pays gas in **ETH**. Blocks land in roughly 100 milliseconds. It supports [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) account abstraction. Its headline feature is ~95 **Stock Tokens** — tokenized US equities, each a plain ERC-20 with a Chainlink price feed — plus **USDG**, a dollar stablecoin. That's the whole chain in one breath. The rest of this page is the fine print, and the fine print is where the money and the mistakes are.

## Architecture, precisely

| Property | Value |
| --- | --- |
| Type | Arbitrum Orbit L2 (Nitro stack) |
| Settlement | Ethereum mainnet |
| Data availability | Blobs (EIP-4844) |
| Gas token | **ETH** (not a chain-native token) |
| Block time | ~100 ms |
| Account abstraction | ERC-4337 supported |
| Multicall3 | `0xca11bde05977b3631167028862be2a173976ca11` (canonical) |

Because it's a standard Nitro Orbit chain, **your existing Ethereum tooling just works** — viem, ethers, wagmi, Foundry, Hardhat. There is no exotic SDK you're forced to adopt, no bespoke RPC dialect. That is the single most important practical fact for a developer, and it's why the rest of this course is mostly "normal EVM development, applied well."

### The two networks

You will use both. Reads and demos happen on mainnet; anything that writes, you rehearse on testnet first.

| | Mainnet | Testnet |
| --- | --- | --- |
| Chain ID | **4663** | **46630** |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com) | [explorer.testnet.chain.robinhood.com](https://explorer.testnet.chain.robinhood.com) |
| Sequencer feed | `wss://feed.mainnet.chain.robinhood.com` | — |
| Faucet | — | [faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com/) |

:::tip viem ships the chain definitions
As of `viem@2.55.0`, both networks are built in: `import { robinhood, robinhoodTestnet } from 'viem/chains'`. **Never hand-roll the chain config** — you'll get the multicall address or the block explorer wrong and spend an afternoon debugging it. Let viem do it.
:::

## The three facts everyone gets wrong

### 1. There is no chain token. Gas is ETH.

Search social media and you'll find people trading "the Robinhood Chain token," quoting its price, and posting its contract address. **It does not exist.** Robinhood Chain pays gas in bridged ETH, exactly like Arbitrum One or Base. There is no native gas token and no official chain coin.

Anyone showing you a "$HOOD chain token" contract is showing you a memecoin someone permissionlessly deployed *on* the chain — which is allowed and common (see Tutorial 7) — not a token *of* the chain. Internalize this now; it will save you from a scam later.

### 2. Stock Tokens may not be sold to US persons.

This is the fact with legal teeth. Stock Tokens are **tokenized debt securities**, issued by *Robinhood Assets (Jersey) Ltd*. They **may not be offered, sold, or delivered to US persons**, with additional restrictions for Canada, the UK, and Switzerland.

The critical nuance for developers:

- **The restriction is legal and front-end enforced — not enforced at the contract level.** The ERC-20 contracts will happily transfer to anyone. Compliance is your responsibility as the operator of any interface or agent.
- **Reading and displaying Stock Token data is unrestricted.** Prices, supply, someone's holdings — all fair game. Most of this course is reads, and none of it is gated.
- **Any flow that *acquires* a Stock Token needs an eligibility gate.** A buy button, a swap that outputs a Stock Token, an agent that accumulates one — those require a clear disclosure and a geo/eligibility gate, defaulting to *off*.

You'll see this enforced in code in Tutorial 6: the [hoodchain](https://github.com/nirholas/robinhood-chain-sdk) SDK throws a `StockTokenEligibilityError` on any swap that acquires a Stock Token until the operator explicitly affirms eligibility. That default-closed posture is the pattern to copy.

:::warning Not financial or legal advice
This is educational material about a blockchain's mechanics. It is not investment advice, and it is not legal advice about your eligibility. If you operate an interface, get real counsel on your obligations.
:::

### 3. Anyone can deploy. The chain is permissionless.

Robinhood issues the Stock Tokens and runs the sequencer, but the chain itself is open. Anyone can deploy a contract, launch a memecoin, or stand up a DEX pool — and people have. There are already two memecoin launchpads (NOXA and The Odyssey), the full Uniswap v3 stack, 1inch, a zero-fee stock DEX (Arcus), a perps venue (Lighter), and Morpho for lending.

This is why "what's on Robinhood Chain" is a moving target and why on-chain data — token names, memos, listing text — is **untrusted input**. Treat it exactly like user input from the open internet: never render it without escaping, and never let it drive a spend. Tutorial 7 shows you how to read this firehose safely.

## What's actually live

A quick, non-exhaustive map so you know the terrain:

- **Assets** — ~95 Stock Tokens (ERC-20, 18 decimals, one Chainlink feed each) and **USDG** (Paxos Global Dollar, **6 decimals**, no EIP-2612 permit).
- **DEXes / DeFi** — Uniswap v2/v3/v4 + UniswapX (the primary public liquidity), 1inch, Arcus (zero-fee stock DEX), Lighter (perps), Morpho (lending).
- **Launchpads** — NOXA ("NOXA Fun") and The Odyssey, both pump.fun-style, graduating liquidity to Uniswap v3.
- **Data providers** — DefiLlama (`/chain/robinhood-chain`), CoinGecko, GeckoTerminal, Dune, Goldsky, and the Blockscout Pro API already index the chain.

## Where to get canonical addresses

When you need a verified contract address — a Stock Token, USDG, a router — there is exactly one right source order:

1. **[docs.robinhood.com/chain/contracts](https://docs.robinhood.com/chain/contracts)** — the official registry for Stock Token and USDG addresses.
2. **Verify it resolves on Blockscout** before you ship it. An address in a blog post (including this one) is a lead, not a source of truth.

The [hoodchain SDK](https://github.com/nirholas/robinhood-chain-sdk) does this work for you: it ships a checked-in registry of all 95 Stock Tokens, each verified on-chain against the shared `Stock` beacon and mapped to its Chainlink feed, regenerable with one command. You'll use it from Tutorial 2 onward so you never hand-type an address.

## You now know more than most

You understand the architecture, both chain IDs, the no-token fact, the US-person restriction, and that the chain is permissionless and its on-chain data untrusted. That's the mental model. Next, you'll prove the architecture is real by reading the live chain yourself — in about five minutes.
