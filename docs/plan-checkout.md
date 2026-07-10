# Paid plans — pay in USDC, SOL, or $THREE

three.ws has a self-serve paid tier. Upgrading to **Pro** (or Team / Enterprise) is a single on-chain payment on Solana — no card, no billing processor. Three assets are accepted:

| Asset | What you pay | Notes |
|---|---|---|
| **USDC** | The sticker price, 1:1 | Stable — the default |
| **SOL** | USD price converted at the live SOL price | Amount pinned when the quote is created |
| **$THREE** | USD price **minus the platform-coin discount** (20% by default) | The platform's own coin, mint `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump` |

Where to use it: the Pro card on [three.ws/pricing](https://three.ws/pricing) opens the checkout when you're signed in. Confirmed payments set `users.plan`, light up the Pro badge everywhere ([api/_lib/account-tier.js](../api/_lib/account-tier.js)), and grant 30 days per payment.

This is separate from (and complementary to) [hold-to-access](./hold-to-access.md), which derives holder tiers from $THREE you *hold*; the plan checkout is $THREE you *spend*.

---

## Flow

Three endpoints, all under `/api/payments/solana` ([api/payments/solana/[action].js](../api/payments/solana/%5Baction%5D.js)):

```
GET  /api/payments/solana/plans      → prices + accepted assets (public)
POST /api/payments/solana/checkout   → create a payment intent (session required)
POST /api/payments/solana/confirm    → verify the tx on-chain, activate the plan
```

### 1. Read the plans (public)

```js
const d = await fetch('/api/payments/solana/plans').then(r => r.json());
// → {
//     plans: { pro: { label: 'Pro', price_usd: 49, three_price_usd: 39.2, duration_days: 30 }, ... },
//     assets: ['USDC', 'SOL', 'THREE'],
//     three_discount_bps: 2000,
//     three_mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
//   }
```

Pricing UIs render from this endpoint so a displayed price can never drift from what checkout charges.

### 2. Create a checkout

```js
const intent = await fetch('/api/payments/solana/checkout', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ plan: 'pro', asset: 'THREE' }), // asset: USDC | SOL | THREE
}).then(r => r.json());

// → {
//     intent_id, plan, asset, network,
//     solana_pay_url,        // scan/open with any Solana wallet
//     recipient,             // treasury pubkey
//     mint,                  // spl-token mint (null for native SOL)
//     amount_asset: '32891.4',  // exact on-chain amount owed, human units
//     amount_usd: 39.2,      // USD value charged ($THREE discount applied)
//     asset_price_usd,       // live quote price used (null for USDC)
//     discount_bps,          // 2000 when paying in $THREE
//     nonce,                 // carried as the payment's memo
//     expires_at,
//   }
```

For SOL and $THREE the USD price is converted at the **live market price** (Jupiter, with the Birdeye → DexScreener → GeckoTerminal fallback chain) and the exact on-chain amount is **pinned on the intent** — a price move during the session can't change what you owe. Live-priced quotes expire after **10 minutes** (USDC: 30); expired quotes are simply re-created.

The wallet payment **must include the `nonce` as a memo instruction** — the `solana_pay_url` already encodes it. A transfer without the matching memo will not confirm.

### 3. Pay, then confirm

Pay via the `solana_pay_url` (QR / deep link) or any wallet, then post the signature:

```js
const r = await fetch('/api/payments/solana/confirm', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ intent_id: intent.intent_id, tx_signature: sig }),
}).then(r => r.json());
// → { ok: true, plan: 'pro', asset: 'THREE', active_until: '2026-08-04T…', tx_signature }
```

The server verifies, at **finalized** commitment (reorg-safe):

1. the transaction exists and did not error;
2. the memo instruction equals the intent's nonce (binds the tx to this checkout, blocks replay);
3. the treasury actually received ≥ the pinned amount of the right asset — SPL transfers are matched by instruction **and** by pre/post token-balance delta with an explicit mint check; native SOL by the recipient's lamport delta;
4. one on-chain tx confirms at most one intent (unique index on `tx_hash`).

On success, one atomic transaction claims the intent, upserts `subscriptions`, and sets `users.plan`.

`tx_not_found` (422) usually means the tx hasn't finalized yet (~10–30 s) — retry; the built-in pricing UIs poll automatically. A payment sent just before the quote expired is still honored within a 1-hour grace window.

### Error codes

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | No session |
| 400 | `bad_request` | `$THREE` requested on devnet |
| 503 | `price_unavailable` | No live price feed for SOL/$THREE right now — retry shortly |
| 503 | `not_configured` | `PAYMENT_RECIPIENT_SOLANA` unset |
| 422 | `tx_not_found` | Not finalized yet — retry in a few seconds |
| 422 | `memo_mismatch` | Payment is missing the intent nonce memo |
| 422 | `transfer_not_found` | Right memo, wrong asset/amount/recipient |
| 410 | `intent_expired` | Quote lapsed beyond the grace window — create a new checkout |
| 409 | `already_confirmed` | Intent (or tx) already used |

---

## Configuration

| Var | Purpose |
|---|---|
| `PAYMENT_RECIPIENT_SOLANA` | Treasury pubkey that receives plan payments (**required**) |
| `THREE_PLAN_DISCOUNT_BPS` | Pay-in-$THREE discount, basis points (default `2000` = 20%, max 5000) |
| `THREE_TOKEN_MINT` | $THREE mint (defaults to the canonical CA) |
| `SOLANA_RPC_URL` / `SOLANA_RPC_URL_DEVNET` | RPC endpoints — set a paid RPC in production |
| `SOLANA_USDC_MINT` | Override the USDC mint (defaults to mainnet USDC) |

Plan prices live in [api/payments/_config.js](../api/payments/_config.js) (`PLANS`) — the single source of truth; both pricing pages and the `plans` action read from it. The EVM (USDC-only) sibling path is [api/payments/evm/[action].js](../api/payments/evm/%5Baction%5D.js).
