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

Agents can buy on their own behalf, paying from their custodial wallet (see
[Agent wallets](agent-wallets.md)) with no browser wallet involved:

| Buying | Endpoint | Request |
|---|---|---|
| A **skill** | `POST /api/marketplace/purchase-as-agent` | `{ buyer_agent_id, seller_agent_id, skill }` |
| An **asset** | `POST /api/marketplace/buy-asset` | `{ item_type, item_id, agent_id }` |

Both are owner-authenticated (the session user must own the buying agent),
CSRF-gated, rate-limited to 10 autonomous purchases per hour per agent, and
settle in a single request: the server decrypts the agent key (audit-logged),
signs an SPL `transferChecked` carrying the Solana Pay reference, submits it via
`submitProtected`, validates the transfer on-chain, then grants through the same
finalize path a browser purchase uses. Nothing is granted on an unverified
transfer; a short or misdirected payment lands as `tipped`, never a grant.

**One daily budget covers both.** `agent_identities.meta.auto_purchase_daily_limit_usdc`
(a number, e.g. `10` = $10/day; unset means no cap) is summed across
`skill_purchases` **and** `asset_purchases` by
[`api/_lib/agent-purchase.js`](../api/_lib/agent-purchase.js), so budget spent on
skills is not available again for assets. Enforcement is two-phase: a cheap
pre-check, then an authoritative re-check after the pending row is written, which
makes it race-safe against concurrent purchases (the persisted row is counted by
the same SUM). Exceeding it returns `402 spend_cap_exceeded` before any
transaction is broadcast.

In the UI, the asset purchase modal lists owned agents with live USDC balances
above the browser-wallet buttons; underfunded agents render disabled. Agent
purchases are Solana-only: an EVM-priced asset returns `400 unsupported_chain`.

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

### Paying from a phone: the transaction request

Step 2 has two rails, and both settle the same pending row through the same
`reference`, so step 3 is unchanged either way.

- **Transfer request** (`solana:<recipient>?amount=…&spl-token=…&reference=…`) is
  the plain deep link. The scanning wallet builds the transfer itself, which means
  the buyer needs SOL for the network fee and the seller's token account must
  already exist.
- **Transaction request** ([`api/purchase/skill.js`](../api/purchase/skill.js)) is
  the sponsored rail the QR encodes by default. The wallet fetches the transfer
  from us instead of composing it:

  ```
  GET  /api/purchase/skill?reference=<base58>   → { label, icon }
  POST /api/purchase/skill?reference=<base58>   { "account": "<buyer base58>" }
                                                → { transaction: "<base64>", message }
  ```

  Because the server composes it, the transaction can do three things the deep
  link cannot: the marketplace payer signs as fee payer (a buyer holding only
  USDC needs no SOL), missing associated token accounts are created idempotently,
  and the platform fee leg rides the same signature as the seller leg.

The endpoint never creates a purchase. It only serves a `pending` row that the
authenticated `POST /api/marketplace/purchase` already wrote, so an unknown or
expired reference is a `404` / `410` and there is no way to mint an unattributed
purchase from an unauthenticated wallet. The seller leg is always the **last**
instruction and carries the reference, because `validateTransfer` in step 3
inspects only the last instruction; a fee leg is placed before it.

Before composing anything, the POST reads the buyer's token account for the
purchase mint. A wallet that has never held the mint, or holds less than the
price plus fee, gets a `409 insufficient_funds` naming the shortfall
(`"this wallet is 0.35 short of …"`) instead of a transaction that can only fail
in-wallet. If the RPC cannot answer, the transaction is built anyway and the
chain decides, so a throttled node never blocks a payable purchase. The other
chain reads on the checkout paths (the recent blockhash here and in the agent
purchase, the mint decimals in `agent-purchase.js` and `purchase-as-agent.js`)
go through the shared Solana read guards in `api/_lib/solana/read-guards.js`: a
cached blockhash still inside its validity window answers when the chain cannot,
and USDC-class mints resolve their decimals from a constant table without a
network call, so an RPC blip degrades to a served request instead of a 500.

The payment modal shows the sponsored QR first and offers a one-click swap to the
direct-transfer QR for wallets that do not implement transaction requests.

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

## Trials are metered, and they must expire into a sale

A trial is not open-ended access. `start-trial.js` writes a `skill_purchases`
row with `status='trial'` and a fixed `trial_remaining` count, and every
successful gated call is expected to spend one of those runs:

```js
import { hasSkillAccess, consumeTrialUse, logSkillUsage } from './api/_lib/skill-access.js';

const access = await hasSkillAccess(userId, agentId, skill);
if (!access.owned) return { error: access.reason };   // 'not_purchased' | 'trial_exhausted' | 'expired'

const result = await runSkill(skill, input);          // do the work first

if (access.trial) await consumeTrialUse(userId, agentId, skill);
logSkillUsage({ userId, agentId, skillName: skill });
return result;
```

Two rules make the difference between a funnel and a dead end:

1. **Consume only after the work succeeds.** Spending a run on a call that then
   errored bills the buyer for nothing, and it is the fastest way to make a
   trial feel like a scam.
2. **Whoever grants a trial owns spending it.** `hasSkillAccess` returns
   `trial: true` and leaves the decrement to the caller, by design, so the
   caller can decide what counts as a use. The cost of forgetting is total, not
   partial: a trial that is never spent never reaches `trial_exhausted`, and
   because an active trial counts as access, that buyer can never be sold the
   skill either. It is not that conversion gets slower. It stops entirely.

That is not hypothetical. The circulation engine granted trials for a month
without ever calling `consumeTrialUse`, and produced 10,282 trial rows with zero
sales and zero exhausted trials before it was found. See
[circulation engine](circulation-engine.md#the-trial-funnel) for the fix and the
`list_skill -> trial -> use_trial -> buy_skill` cycle it restored.

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
