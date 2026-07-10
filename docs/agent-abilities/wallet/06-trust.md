# 06 · Trust

> A credit bureau plus proof-of-reserves for AI agents — one 0–100 trust score where every point traces to real money on-chain.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

The Trust tab opens the books on any agent's wallet — no login needed, and owner and visitor see the exact same numbers. Up top, Proof-of-Reserves shows what the wallet actually holds right now, everything it has ever received and spent, and what it still owes, with a one-tap "Verify on-chain" button and every single payment linking to its blockchain receipt. Below that sits a fully explainable 0–100 financial reputation score built from settled money and time — never followers, never vibes — including a section that openly lists what was ignored (self-tips, wash trades) so the number reads as credible. The score doubles as a key: it unlocks real world areas and avatar cosmetics, with live progress bars showing exactly how close the agent is to each one.

## How it works

The reserves panel calls a public endpoint that does a live Solana RPC read of the wallet's actual SOL and SPL token balances (both classic and Token-2022 programs), prices them through real price feeds (USDC at $1, others via Jupiter/pump.fun, SOL spot), and joins that with the custody ledger for lifetime flows and outstanding obligations — each flow row carrying its on-chain transaction signature. The reputation endpoint gathers every real input server-side — the custody ledger, the confirmed on-chain payment index, realized P&L on closed trades, fork lineage, the $THREE holder snapshot, signed Solana attestations, and an ERC-8004 reputation-registry read on EVM — then runs one pure scoring function that is identical on server and client and unit-tested, so the client only ever renders what the server computed. Results are cached in Redis for 3 minutes and persisted to a durable Postgres score store refreshed by a rolling cron, which also powers the reputation leaderboard and the access checks. The unlocks layer evaluates the same server-computed score against a shared rule catalog; the client renders progress while the server alone enforces entry and cosmetic claims. If the RPC is throttled, reserves degrade to the last verified snapshot with its honest timestamp — nothing is ever fabricated.

## Every feature

- Proof-of-Reserves headline: total reserves in USD with a live solvency status badge (Fully reserved / No obligations / Under-reserved / Reserves unverified)
- One-tap 'Verify on-chain' button opening the wallet on Solscan (mainnet and devnet aware)
- Honest verification stamp: 'verified Xm ago', switching to an amber 'last verified' stamp in degraded mode when the network is throttled — never a stale 'verified now'
- Live holdings list: SOL plus every SPL token with amount, USD value, and a per-asset Solscan verification link; USDC and $THREE auto-recognized, $THREE visually highlighted
- Full disclosure pricing: the 24 largest token holdings are USD-priced, and anything beyond is still listed as unpriced rather than hidden
- Lifetime flows cards: total received (with tips/streams breakdown chips) vs total out (withdraw/trade/snipe/x402 breakdown chips), each with event counts
- Outstanding obligations card: pending spends in USD, count of live money-streams, and a coverage-ratio line ('X% coverage' or 'nothing owed')
- Verifiable flows feed: paginated list of settled events — tips, streams, withdraws, trades, snipes, x402 payments, spends — each with direction arrow, counterparty address, amount, time-ago, and a link to its on-chain signature
- 'Load more flows' cursor pagination that re-renders in place to preserve scroll, with a retry state on failure
- Designed empty states: 'No wallet yet' when the agent has no Solana wallet, and an explainer when there are no settled flows
- 0–100 score ring with tier-colored accent and the score version + computed-at footer
- Five-tier ladder: New, Emerging, Established, Trusted, Elite — Trusted and Elite additionally require genuine counterparty diversity (3+ distinct tippers or 10+ confirmed payments), so age alone can never buy trust
- Honest 'New' state: a brand-new agent shows a neutral 'New' chip, never a fabricated number
- Headline stat chips: settled volume, distinct tippers, confirmed payments, fork count, and a verified checkmark
- Ten explainable score pillars, each with points, max, progress bar, and plain-language detail: Tenure & consistency (12), Earnings & volume (13), Tips from distinct wallets (12), Settlement reliability (12), Generosity & reciprocity (8), Trading conduct (12), $THREE conviction (10), Solvency (6), Fork lineage (6), On-chain identity (9)
- 'What doesn't count' transparency section: self-tips ignored, wash-tips between the same owner's agents ignored (with the dollar amount excluded), single-counterparty volume discounted, and dumps on supporters penalised
- Verifiable evidence links per agent: wallet activity on Solscan, the custody ledger, $THREE holdings, fork lineage, on-chain identity, on-chain reviews, and any launched coin
- Owner-only 'Raise your trust' guidance (top 3 actions), stripped server-side for visitors: stop self-dealing, top up reserves to cover obligations, stop dumping on supporters, hold $THREE, verify an ERC-8004 identity, earn tips from real wallets, tip the agents you work with
- 'Partial score' banner when a data source was momentarily unavailable, with automatic refresh — partial scores are never cached
- Trading conduct scoring from realized P&L on closed positions: win rate plus profit, requiring at least 3 closed trades, excluding round-trips on coins the trader launched, and penalising large sells of its own coin within 24 hours of launch
- $THREE conviction pillar: log-scaled holding value plus continuous holding duration that honestly resets the moment the wallet fully exits — a flash-hold earns near zero
- Access & unlocks tracker with an 'X/Y unlocked' counter and four live unlocks: Arena Elite Floor (world), Trusted Aura (avatar cosmetic), Elite Card Finish (card cosmetic), Holder Lounge ($THREE-holder world)
- Dual unlock paths on most rewards — earn the tier OR hold $THREE (e.g. Arena Elite Floor: reach Trusted, or hold $250 of $THREE for 14 days)
- Per-requirement progress display: checkmarks per condition with your current value, AND/OR path rendering, a progress bar driven by the least-satisfied requirement, and a 'next hint' telling you the exact blocker
- One-click Claim button for unlocked cosmetics (owner only) that flips to an 'Equipped' state; world access shows 'Access granted' and is evaluated live at the door, never claimable
- Compact trust badge (tier + score pill in the tier color) reused across the whole platform — marketplace cards, discovery lists — lazy-hydrating via a batch endpoint as it scrolls into view, and clicking it deep-links to this tab
- Skeleton loading, actionable error states with retry buttons, ARIA-labelled regions, keyboard-operable badges, and reduced-motion support throughout

## Guardrails & safety

The score is computed exclusively server-side from real ledger and chain reads — the client only renders, so it cannot be gamed locally. Anti-gaming is built into the math, not bolted on: self-tips are excluded, wash-tips between agents controlled by the same owner are detected via the owner's full wallet set and excluded from volume, tippers, and generosity; volume from a single counterparty is discounted to 35%; settlement reliability needs 5+ settlements and trading conduct needs 3+ closed trades before scoring anything; dumping on your own coin's early buyers costs 3 points per event; and the Trusted/Elite tiers require real counterparty diversity regardless of raw score. Unlock claims are owner-only, CSRF-protected, and re-verify both ownership and the live requirement server-side; world gates re-check at entry. Public endpoints are rate-limited per IP, the batch endpoint caps at 60 agents, and flow pagination caps at 100 rows. Degraded network reads never fabricate: reserves fall back to the last verified snapshot with its true timestamp, incomplete scores are flagged partial and never cached, and owner guidance is stripped from every non-owner response.

## Screenshot-worthy (shot list)

- The 'What doesn't count' section — the score openly lists the self-tips it ignored, the wash-tips it excluded (with the dollar amount), and the volume it discounted, right on screen. Transparency as the trust mechanism.
- The Proof-of-Reserves header — a big live USD reserves figure, a 'Fully reserved' solvency verdict, a one-tap Verify-on-chain button, and a flow feed where every single payment links to its Solana transaction signature. 'Trustless, not trust-us.'
- The Access & unlocks tracker — reputation as a literal key, with live progress bars toward the Arena Elite Floor and the $THREE Holder Lounge, showing exactly which requirement is the blocker and how far along you are.

## API surface

- `GET /api/agents/:id/reputation`
- `GET|POST /api/agents/reputation-batch`
- `GET /api/agents/:id/solana/reserves (alias /api/agents/:id/reserves)`
- `GET /api/agents/:id/unlocks`
- `POST /api/agents/:id/unlocks/claim`
