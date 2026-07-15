# three.ws Premium — the monthly Data API pass

Premium is one on-chain payment that replaces per-call micropayments for 30
days. Instead of answering an x402 challenge on every archive search, you buy
a pass once a month — the AIXBT model — and call the Data API with an API key
(servers, agents) or a wallet signature (browsers).

**Three tiers, paid on Solana only** — every tier is payable in **$THREE
(20% off — the platform coin is always the cheapest way in)**, native **SOL**,
or **USDC** (parity):

| Tier | Price / 30 days | Rate limit | Licence |
|---|---|---|---|
| **Developer** | $19.99 (≈ $15.99 in $THREE) | 120 req/min | Personal + evaluation |
| **Pro** | $99 (≈ $79.20 in $THREE) | 600 req/min | Commercial use |
| **Enterprise** | $499 (≈ $399.20 in $THREE) | 2,000 req/min | Commercial + priority support + bulk corpus arrangements |

$THREE mint: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`. Prices in SOL
and $THREE are locked for 10 minutes when you request a quote, so the amount
you sign is exactly the amount that's verified. Live per-tier, per-asset
pricing: `GET https://three.ws/api/premium/plans`.

**What every tier unlocks today:** unmetered search on the
[660k-article crypto-news archive](/markets/archive)
(`GET /api/news/archive`) at your tier's rate limit — versus the free tier's
60 searches/day and the $0.001-per-search x402 rail. Corpus stats, month
index, and trending are free for everyone regardless. More premium surfaces
join the same pass over time; your key starts working on them automatically.
Buying a higher tier while a pass is active upgrades your key's rate limit
immediately and appends the new period to the end.

## Buying a pass

### From the dashboard (recommended)

Open **[/dashboard/data-api](/dashboard/data-api)**, pick an asset, and
confirm one transaction in your Solana wallet. When it confirms, the page
shows your `x402_live_…` API key **once** — copy it then. Renewing later
appends 30 days to the end of your current pass; no days are lost by renewing
early.

### From the API (no account needed)

```bash
# 1. Quote — lock the price, get the unsigned transaction (base64)
#    plan: developer (default) | pro | enterprise
curl -X POST https://three.ws/api/premium/quote \
  -H 'content-type: application/json' \
  -d '{"asset":"THREE","wallet":"<your-solana-address>","plan":"pro"}'
# → { "quote": { "id", "amount_atomics", "expires_at", … }, "tx_base64": "…" }

# 2. Sign tx_base64 with the quoted wallet and send it (any Solana client).

# 3. Redeem — verify the landed payment and receive the pass + API key
curl -X POST https://three.ws/api/premium/subscribe \
  -H 'content-type: application/json' \
  -d '{"quote_id":"<quote.id>","tx_signature":"<signature>"}'
# → { "pass": { "expires_at", … }, "api_key": "x402_live_…" }   (key shown once)
```

A `202 { pending: true }` means the transaction hasn't confirmed yet — poll
`subscribe` again with the same body; redeeming is idempotent, and
re-submitting an already-redeemed signature returns the existing pass.

Live per-asset pricing: `GET https://three.ws/api/premium/plans`.
Pass state for any wallet: `GET https://three.ws/api/premium/status?wallet=…`.

## Using the pass

**Servers and agents — API key.** Send the key as a header on any premium
endpoint; the request bypasses the x402 payment entirely:

```bash
curl "https://three.ws/api/news/archive?q=mt+gox&start_date=2018-01-01&end_date=2019-12-31" \
  -H "X-API-Key: x402_live_…"
```

**Browsers — wallet signature (SIWX).** The wallet that bought the pass holds
a signature grant until the pass expires. On [/markets/archive](/markets/archive),
when the payment dialog appears, choose *sign with wallet* instead of paying —
no key, no charge.

## Managing keys

On [/dashboard/data-api](/dashboard/data-api) (signed in) you can **rotate**
(revoke + reissue; new plaintext shown once) or **revoke** your key. Key
management is tied to the account that was signed in at purchase time —
passes bought wallet-only over the raw API authenticate with the key itself
and can be re-keyed by renewing. Your purchase history and subscriptions live
at [/dashboard/billing](/dashboard/billing).

The dashboards ride two raw endpoints you can also call directly:
`POST /api/premium/keys` with `{ action: "rotate" | "revoke", id }`
(session + CSRF; rotate returns the fresh plaintext exactly once) and
`GET /api/premium/mine` (session-authenticated; your passes and keys,
including passes bought directly by your linked Solana wallet).

## Rules and edge cases

- A quote is redeemable for 30 minutes; after that, request a fresh one
  (the transaction's blockhash expires far sooner anyway).
- Verification checks the **landed** transaction: the quoted wallet must be a
  signer and the treasury balance delta must cover the quoted amount. Someone
  else's transaction signature can't redeem your quote.
- One transaction signature redeems exactly one pass, forever (database
  UNIQUE). Failed or reverted transactions redeem nothing.
- Renewal periods stack end-to-end (`new start = old expiry`); buying a
  higher tier retiers the key's rate limit immediately.
- Ops can tune pricing without a deploy: `PREMIUM_PRICE_DEVELOPER` /
  `PREMIUM_PRICE_PRO` / `PREMIUM_PRICE_ENTERPRISE` (USD),
  `PREMIUM_RATE_LIMIT_DEVELOPER` / `_PRO` / `_ENTERPRISE` (req/min),
  `PREMIUM_PASS_THREE_DISCOUNT`, `PREMIUM_PASS_DAYS`.

Related: [API reference — news archive](/docs/api-reference), the
[x402 per-call rail](/docs/x402) that Premium sits on top of, and the free
tiers that remain free (news feed, digest, archive stats/trending).
