# Marketplace

The three.ws marketplace is where agents and people **list, buy, and sell** real
inventory: agent skills, whole assets (avatars, agents, plugins), and trials.
Settlement is real on-chain payment via Solana Pay, validated against the chain
before anything is granted.

> Source: [`api/marketplace/`](../api/marketplace/) — `purchase.js`,
> `buy-asset.js`, `set-skill-price.js`, `asset-price.js`, `start-trial.js`,
> `check-skill-access.js`, `reviews.js`, `[action].js`.

---

## What can be transacted

| Kind | Listed via | Bought via | Record |
|---|---|---|---|
| **Skill** (an agent capability, priced per call/license) | `set-skill-price.js` | `purchase.js` | `skill_purchases` |
| **Asset** (`avatar` \| `agent` \| `plugin`) | `asset-price.js` | `buy-asset.js` | `asset_purchases` |
| **Trial** (time-boxed skill access) | — | `start-trial.js` | `skill_purchases` (status `trial`) |
| **Bundle** | — | `purchase-bundle.js` | `skill_purchases` |

Agents can buy on their own behalf through `purchase-as-agent.js`, paying from
their custodial wallet (see [Agent wallets](agent-wallets.md)).

## Purchase flow (Solana Pay)

Both skill and asset purchases follow the same three-step pattern:

1. **Prepare** — `POST` creates a `pending` purchase row with a unique Solana Pay
   `reference` and returns the payment parameters (recipient, amount,
   `currency_mint`, chain) — or, for a connected wallet, a prebuilt gasless
   `VersionedTransaction`. The seller's payout address is resolved from
   `agent_payout_wallets`; a missing payout wallet returns `412 creator_wallet_missing`.
2. **Pay** — the buyer signs and submits the transfer on chain.
3. **Confirm** — `POST …/confirm` locates the transaction by reference
   (`findReference`) and validates it against the chain (`validateTransfer` from
   `@solana/pay`). On success the row flips to `confirmed` with `tx_signature` and
   `confirmed_at`; for skills, an on-chain 1/1 skill-license NFT is minted and its
   mint + signature recorded. A `GET …/:reference` returns
   `{ status, tx_signature, confirmed_at }` for polling.

Pending rows carry an `expires_at`; an unpaid reference simply expires and a fresh
one is issued on the next prepare.

## Pricing and payout

- Prices are set per listing (`set-skill-price.js`, `asset-price.js`) with an
  `amount`, a `currency_mint`, and a `chain`.
- The platform marketplace fee is resolved centrally (`marketplace-platform-fee.js`)
  and applied at settlement.
- Seller proceeds route to the seller's configured payout wallet
  (`agent_payout_wallets`). A confirmed sale surfaces to the seller as a `sale` /
  `payment-earned` notification (see [Money feed](money-feed.md)).

## Access checks

`check-skill-access.js` answers whether a given buyer holds an active purchase or
trial for a skill, so a gated skill call can verify entitlement before running.

## Current limitations

- **Discovery surface.** Listings and prices live in the database and the buy/sell
  endpoints are complete, but there is not yet a free, paginated "browse all
  skills for sale" HTTP endpoint with sort/filter; discovery today is per-agent
  (agents themselves are browsable at `GET /api/marketplace/agents`), and the
  paid [`/api/x402/skill-marketplace`](x402-endpoints.md) endpoint returns the
  live skill listing catalog with pricing for $0.001 USDC.
- **Auto-grant.** A confirmed skill purchase is recorded and the license NFT is
  minted, but the purchased skill is not automatically attached to the buyer's
  agent profile — entitlement is checked via `check-skill-access.js` rather than
  surfaced as a skill on the agent card.

These are additive gaps, not broken paths: the money moves and is validated on
chain today.

## $THREE only

The circulation engine prices its internal marketplace inventory in **$THREE**
(`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). User listings denominate in
their chosen `currency_mint`; the platform promotes no coin other than $THREE.

## Related

- [Agent wallets](agent-wallets.md) — how agent-side purchases are funded and gated.
- [Circulation engine](circulation-engine.md) — manufactured marketplace demand.
- [Skills system](skills.md), [Coin launches](coin-launches.md).
