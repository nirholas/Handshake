# x402 Revenue & Receipts

Every time someone pays one of three.ws's [paid endpoints](x402-endpoints.md), the
settlement is recorded. This page is the reference for **where that money is
recorded**, how to read endpoint revenue, and how the durable receipt is issued to
the buyer.

> Source: settlement persistence
> [`api/_lib/x402/audit-log.js`](../api/_lib/x402/audit-log.js), receipt storage
> [`api/_lib/x402/receipt-storage.js`](../api/_lib/x402/receipt-storage.js),
> revenue report [`api/_lib/x402/revenue-analytics.js`](../api/_lib/x402/revenue-analytics.js),
> served by [`api/x402/analytics.js`](../api/x402/analytics.js).

---

## Two directions of money — don't confuse them

three.ws records value moving in **two opposite directions**, in two different
tables. They never overlap, and mixing them up will double-count your numbers.

| Direction      | Meaning                                                                  | Table                  | Surfaced by                                      |
| -------------- | ------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------ |
| **Revenue IN** | Money paid **to** our endpoints for using them                           | `x402_audit_log`       | `/api/x402/analytics?report=revenue` (this page) |
| **Spend OUT**  | Money an agent's wallet **paid out** (tips, trades, agent-to-agent x402) | `agent_custody_events` | The [Money Pulse](money-feed.md) at `/api/pulse` |

The [Money Pulse](money-feed.md) shows the agent economy — one agent paying
another, tips, launches. **This page is the other side of the ledger:** the
platform's own endpoint revenue. A call to `/api/x402/token-intel` writes a
**revenue** row in `x402_audit_log`; it is not an `agent_custody_events` spend and
does not appear in the Money Pulse.

### Live view — `/x402-revenue`

There is a public, live dashboard of this ledger at
[`/x402-revenue`](https://three.ws/x402-revenue): gross revenue, the top-earning
endpoints, the settlement success rate, and a real-time feed of each settlement
(endpoint, amount, network, payer, explorer link) the moment it lands. It is the
revenue mirror of the [Money Pulse](https://three.ws/pulse) and reads the public,
unauthenticated `GET /api/x402-revenue` (operational fields like IP and user agent
are never exposed — only the on-chain-public route, amount, payer, and tx).

### The public API: `GET /api/x402-revenue`

No key, no auth, CORS open. Four views:

| Request | Returns |
| --- | --- |
| `?view=stats&period=24h\|7d\|30d\|all` | totals, fee splits, per-endpoint, per-network, hourly/daily series, momentum vs the prior window, settlement health |
| `?view=feed&limit=30&cursor=<iso>` | recent settlements, newest first, keyset-paged |
| `?since=<iso>` | delta poll: only settlements newer than the cursor, never cached |
| `?view=export&period=24h` | CSV of the window (max 5000 rows) |

`?endpoint=<slug>` and `?network=<chain>` filter the feed and the export.

**Chain values are CAIP-2, filters are chain families.** The ledger stores
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` and `eip155:8453`, so every settlement
also carries a folded family slug and a readable label
([`api/_lib/x402/revenue-networks.js`](../api/_lib/x402/revenue-networks.js)):

```jsonc
{
  "route": "/api/x402/token-intel",
  "network": "eip155:8453",        // raw ledger value, unchanged
  "network_family": "base",        // what ?network= filters by
  "network_label": "Base",         // what the UI renders
  "amount_usd": 0.001,
  "tx_url": "https://basescan.org/tx/0x…"  // that chain's explorer, null if unknown
}
```

`?network=` accepts the family slug (`solana`, `base`, `bsc`), a legacy bare name,
or a full CAIP-2 id: all three select the same rows, and an unrecognised value
drops the filter instead of returning an empty feed. `by_network` in the stats
view is folded the same way, one row per family with the raw ids it covers:

```bash
curl -s "https://three.ws/api/x402-revenue?view=stats&period=24h" | jq '.data.by_network'
# [ { "network": "solana", "label": "Solana", "count": 414, "gross_usd": 8.508,
#     "caip": ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] } ]

curl -s "https://three.ws/api/x402-revenue?view=feed&limit=5&network=base" | jq '.data.count'
```

CSV columns: `timestamp,endpoint,network,chain,amount_usd,asset,payer,tx_hash,tx_url`
(`network` is the raw CAIP-2 id, `chain` its readable label).

**Malformed params answer 4xx, not 5xx.** `?since=` and `?cursor=` are bound into
a `::timestamptz` cast, so an unparseable value is rejected before it reaches the
query rather than surfacing as an opaque 500:

```bash
curl -s "https://three.ws/api/x402-revenue?since=notadate"
# {"error":"invalid_since","error_description":"`since` must be an ISO 8601 timestamp"}
```

`?endpoint=` is sanitized to a slug (`../../etc/passwd` becomes `etcpasswd`), and
the response echoes the sanitized value in `data.filter.endpoint`, so the filter
you read back is always the filter that ran. `?period=` and `?network=` fall back
to the default instead of erroring: an unrecognised period is `24h`, an
unrecognised network drops the filter.

---

## The settlement flow

When a buyer pays a paid endpoint, the shared handler
([`api/_lib/x402-paid-endpoint.js`](../api/_lib/x402-paid-endpoint.js)) runs:

1. **Challenge** — no `X-PAYMENT` header → respond `402 Payment Required` with the
   accepted networks, asset, price, and pay-to address.
2. **Verify** — the buyer retries with an `X-PAYMENT` header; the facilitator's
   `/verify` confirms the signed payment matches the requirement
   ([`api/_lib/x402-spec.js`](../api/_lib/x402-spec.js) `verifyPayment()`).
3. **Settle** — the facilitator's `/settle` (or, for BSC, a direct on-chain
   `pay(bytes32)` contract call) moves the USDC (`settlePayment()`).
4. **Persist** — `logPaymentEvent()` writes one row to `x402_audit_log`, and a
   signed receipt is stored in `x402_receipts`.
5. **Run + respond** — the endpoint logic executes and returns the result.

Steps 4's writes are fire-and-forget (`queueMicrotask`) with a connection-level
retry, so a transient DB blip never silently drops a settled payment.

---

## The revenue ledger — `x402_audit_log`

This is the **single source of truth for money flowing through our endpoints.**
Every payment event lands here — settled, failed, and access-control events alike.

```sql
CREATE TABLE x402_audit_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type           TEXT NOT NULL,   -- 'payment_settled' | 'payment_failed'
                                         -- | 'siwx_grant' | 'siwx_access' | 'bypass_granted'
  route                TEXT NOT NULL,    -- e.g. '/api/x402/token-intel'
  resource_url         TEXT,
  payer                TEXT,             -- wallet address
  network              TEXT,             -- CAIP-2 id, e.g. 'solana:5eykt4Us…' | 'eip155:8453'
  amount_atomics       TEXT,             -- USDC atomics (6 decimals): '10000' = $0.01
  asset                TEXT,
  tx_hash              TEXT,
  settlement_status    TEXT,             -- 'success' | 'failed'
  facilitator_response JSONB,
  duration_ms          INTEGER,
  ip_address           TEXT,
  user_agent           TEXT,
  metadata             JSONB,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);
```

Schema:
[`api/_lib/migrations/2026-05-27-x402-audit-log.sql`](../api/_lib/migrations/2026-05-27-x402-audit-log.sql).
Filter `event_type = 'payment_settled'` for revenue; `amount_atomics` is USDC at 6
decimals, so divide by `1e6` for dollars.

### Reading revenue directly

Total settled revenue and unique payers over the last 24h:

```sql
SELECT
  count(*)                                  AS payments,
  count(DISTINCT payer)                     AS unique_payers,
  sum((amount_atomics)::numeric / 1e6)      AS gross_usd
FROM x402_audit_log
WHERE event_type = 'payment_settled'
  AND created_at >= now() - interval '24 hours';
```

Revenue by endpoint, last 7 days, top 10:

```sql
SELECT
  route,
  count(*)                              AS calls,
  sum((amount_atomics)::numeric / 1e6)  AS gross_usd
FROM x402_audit_log
WHERE event_type = 'payment_settled'
  AND created_at >= now() - interval '7 days'
GROUP BY route
ORDER BY gross_usd DESC
LIMIT 10;
```

---

## The revenue report — `/api/x402/analytics`

You don't have to query SQL. The `analytics` endpoint serves the same numbers,
pre-aggregated. It is itself a [paid endpoint](x402-endpoints.md) ($0.005 default).
It is a `POST` endpoint: pass `report` and `period` in the JSON body:

```bash
# After settling the 402 challenge (see the x402 buyer client doc), retry with:
curl -s -X POST https://three.ws/api/x402/analytics \
  -H 'content-type: application/json' \
  -H "X-PAYMENT: <settled-payment-header>" \
  -d '{"report":"revenue","period":"24h"}'
```

`report` accepts: `revenue`, `x402_volume`, `clubs`, `marketplace`,
`agent_leaderboard`, `sniper_trades`, `user_activity`. `period` accepts `1h`,
`6h`, `24h`, `7d`, `30d`, `all`.

The `revenue` report shape
([`revenue-analytics.js`](../api/_lib/x402/revenue-analytics.js)); money fields
are serialized as fixed 6-decimal strings:

```json
{
	"report": "revenue",
	"period": "24h",
	"since": "2026-06-29T00:00:00.000Z",
	"generated_at": "2026-06-30T00:00:00.000Z",
	"totals": {
		"gross_usd": "12.340000",
		"net_platform_usd": "11.900000",
		"settlement_fee_usd": "0.440000",
		"total_payments": 247,
		"failed_payments": 3,
		"unique_payers": 18,
		"avg_payment_usd": "0.050000"
	},
	"fee_splits": {
		"gross_usd": "12.340000",
		"settlement_fee_usd": "0.440000",
		"net_platform_usd": "11.900000",
		"effective_fee_rate": 0.0357,
		"fee_per_settlement_usd": "0.001800",
		"fee_source": "..."
	},
	"by_endpoint": [
		{ "endpoint": "/api/x402/token-intel", "count": 120, "gross_usd": "1.200000", "share": 0.097 }
	],
	"top_endpoint": { "endpoint": "/api/x402/token-intel", "count": 120, "gross_usd": "1.200000" }
}
```

`net_platform_usd` is gross minus the estimated on-chain settlement fee — what the
platform actually keeps. `failed_payments` counts `event_type = 'payment_failed'`
rows in the same window, so you can watch the settlement success rate.

---

## Receipts — `x402_receipts`

Each successful settlement also issues the buyer a durable, signed receipt
([`receipt-storage.js`](../api/_lib/x402/receipt-storage.js)):

```sql
CREATE TABLE x402_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer          text        NOT NULL,   -- buyer wallet
  network        text        NOT NULL,
  resource_url   text        NOT NULL,   -- what they paid for
  format         text        NOT NULL,
  receipt        jsonb       NOT NULL,   -- the signed receipt artifact
  transaction    text,                   -- settlement tx
  amount_atomics text,                   -- what it cost (atomic units)
  asset          text,                   -- the settlement asset (USDC mint/contract)
  issued_at      timestamptz NOT NULL DEFAULT now()
);
```

A buyer reads **their own** receipts at
[`/api/x402/my-receipts`](x402-endpoints.md) — that endpoint is free but gated by
a wallet signature (SIWX), so a buyer proves ownership of the `payer` address
rather than paying again.

### The signed artifact vs. our row

These are two different things and the difference matters:

- **The signed artifact** (`receipt` column) follows the x402 Offer & Receipt
  spec §5.1. It carries no amount at all, and it omits `transaction` entirely
  whenever the endpoint declares `includeTxHash: false`, the spec §5.2 privacy
  default. That is what goes out on the wire, and it is what a third party
  verifies against our issuer key.
- **The row** is our own audit trail. It records the settlement tx and the
  amount/asset we already had in hand at issue time, even when the artifact
  omits them. The wire format and its privacy properties are unchanged; these
  columns are only ever returned to the wallet that signed for its own
  receipts.

Receipts written before 2026-07-28 have `amount_atomics` and `asset` null. The
Receipt Vault reports that honestly ("2 of 3 priced") rather than
under-reporting a total.

### Verifying a receipt

The issuer signs with an Ed25519 JWK (`OFFER_RECEIPT_FORMAT=jws`); the `kid` is
`did:web:three.ws#key-1`, and the public key is published at
[`https://three.ws/.well-known/did.json`](https://three.ws/.well-known/did.json)
(served by [`api/x402/did.js`](../api/x402/did.js)). Anyone holding a receipt
can resolve that DID document and verify the signature without trusting us.
When neither `OFFER_RECEIPT_JWK` (jws) nor
`OFFER_RECEIPT_SIGNING_PRIVATE_KEY` (eip712) is set, no receipts are issued or
stored at all: the x402 wire format stays valid, the extension is purely
additive.

### The buyer's view: `/receipts`

[`/receipts`](https://three.ws/receipts) is the Receipt Vault: the buyer-facing
UI over `/api/x402/my-receipts`. Connect a Solana or EVM wallet, sign one
read-only message, and every receipt ever issued to that wallet is listed with
its endpoint, amount, network, and settlement tx (explorer-linked), plus a
per-receipt JSON download of the full signed artifact and a CSV export.

The signing message is a fixed four-line string and must stay byte-identical on
both sides. [`src/receipts-lib.js`](../src/receipts-lib.js)
`buildReceiptsMessage()` and [`api/x402/my-receipts.js`](../api/x402/my-receipts.js)
`buildExpectedMessage()`:

```
three.ws x402 receipts read
Network: solana
Address: <base58 pubkey, verbatim>
Issued At: <ISO timestamp>
```

EVM addresses are lower-cased in the message (matching how the storage layer
normalizes them); Solana base58 is case-sensitive and stays verbatim. The
signature is valid for 5 minutes server-side. Fetch it yourself:

```bash
# after signing the message above with the payer wallet
curl -s "https://three.ws/api/x402/my-receipts?\
address=$ADDRESS&signature=$SIGNATURE&issuedAt=$ISSUED_AT&network=solana&limit=50"
```

`/receipts` is the buyer-side mirror of `/x402-revenue`: that page is what the
platform earns, this one is what a given wallet spent.

### Anti-replay — `bsc_consumed_tx`

For BSC direct-scheme settlements (where there is no facilitator and the buyer
pays the `ThreeWSPayments` contract directly), each on-chain `Payment` tx is
recorded in `bsc_consumed_tx` (`tx_hash` primary key) the first time it is spent,
so the same on-chain payment can never be replayed against two requests.

---

## Proof-of-volume — `x402_volume_metrics`

`x402_audit_log` is the per-call ledger (one row per settlement). Alongside it,
the **Volume Bootstrap Loop** (autonomous registry `self/026`,
[`pipelines/volume-bootstrap-loop.js`](../api/_lib/x402/pipelines/volume-bootstrap-loop.js))
maintains a compact **rolling aggregate keyed on endpoint** in
`x402_volume_metrics`. On each sweep the loop round-robins the catalog of cheap
paid self endpoints, pays each a real on-chain USDC payment, and upserts one row
per endpoint — accumulating call / success / fail counts, total + last USDC
spent, last tx signature, last status, and first/last call timestamps.

```sql
CREATE TABLE x402_volume_metrics (
  endpoint_key        text PRIMARY KEY,  -- one row per paid endpoint
  service_name        text,
  endpoint_path       text,
  network             text NOT NULL DEFAULT 'solana:mainnet',
  asset               text,
  call_count          bigint NOT NULL DEFAULT 0,
  success_count       bigint NOT NULL DEFAULT 0,
  fail_count          bigint NOT NULL DEFAULT 0,
  total_spent_atomic  bigint NOT NULL DEFAULT 0,   -- USDC atomics, lifetime
  last_amount_atomic  bigint NOT NULL DEFAULT 0,
  last_success        boolean,
  last_status         int,
  last_tx_signature   text,
  last_error          text,
  last_run_id         uuid,
  first_called_at     timestamptz DEFAULT now(),
  last_called_at      timestamptz DEFAULT now()
);
```

Schema:
[`api/_lib/migrations/20260629110000_x402_volume_metrics.sql`](../api/_lib/migrations/20260629110000_x402_volume_metrics.sql)
(the pipeline also creates it lazily via `ensureSchema`). It feeds two things the
growth + status surfaces read: **proof-of-volume** (total settled calls and USDC
volume per endpoint — the metric agentic.market ranks facilitators on) and
**per-endpoint liveness** (`last_success` / `last_called_at` confirm each paid
endpoint is up). Add an endpoint to `api/_lib/x402/ring-catalog.js` with
`autobuy: true` and the cursor and ledger pick it up automatically.

> **Synthetic vs organic — do not conflate them.** The Volume Bootstrap Loop pays
> our **own** endpoints from our **own** seed wallet, and those endpoints settle
> to the platform's own `X402_PAY_TO_*` treasury. Every transaction is real and
> on-chain — but the _demand_ is synthetic: it is the platform paying itself, a
> liveness canary, not external buyers. It is legitimate as **synthetic
> monitoring** (proving every paid endpoint is live) and is bounded small by
> design (see the budget knobs in [Autonomous x402 loop](autonomous-x402.md)).
> It is **not** marketplace demand. Any headline "marketplace volume" or
> facilitator-ranking number we publish must **exclude the seed wallet's own
> calls** — filter `x402_audit_log` by `payer` to separate organic settlements
> from the loop's synthetic ones. Reporting self-paid round-trips as organic
> volume is wash volume: real transactions, fake demand, and trivially detectable
> by anyone clustering the seed wallet on-chain. The honest path to real volume
> is external demand (discovery, real `agent_hire` commerce, the
> [Circulation engine](circulation-engine.md)), not a bigger self-paid sweep.

---

## Reconciliation — `payment_reconciliation`

A live payment platform's books must match the chain. The **Payment Revenue
Reconciliation** job (autonomous registry `self/027`, runs **daily**,
[`revenue-reconciliation.js`](../api/_lib/x402/revenue-reconciliation.js)) is the
financial-integrity watchdog. Each run pulls recent records that claim settlement
from both books — `x402_autonomous_log` (outbound spend) and
`agent_payment_intents` (inbound revenue) — verifies each Solana signature
on-chain via `getSignatureStatuses` (batched, full-history search), and upserts
one verdict row per record into `payment_reconciliation`.

```sql
CREATE TABLE payment_reconciliation (
  id            bigserial   PRIMARY KEY,
  source        text        NOT NULL,   -- 'autonomous_log' | 'payment_intent'
  source_ref    text        NOT NULL,   -- row id within that book
  tx_signature  text,
  network       text,
  amount_atomic bigint,
  db_status     text        NOT NULL,   -- what the book claims
  chain_status  text        NOT NULL,   -- confirmed | failed_onchain | missing_onchain
                                        -- | missing_signature | skipped_non_solana | unknown
  reconciled    boolean     NOT NULL,
  discrepancy   text,                   -- null when reconciled
  detail        jsonb,
  run_id        uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);
```

Schema:
[`api/_lib/migrations/20260629120000_payment_reconciliation.sql`](../api/_lib/migrations/20260629120000_payment_reconciliation.sql).
The job is **read-only**, so it runs even when the spend wallet is absent (it
falls back to a keyless RPC connection; the `/api/x402-status` probe it uses is
free). A row with `reconciled = false` is a financial-integrity alert — the DB
recorded a settlement the chain does not corroborate. The ops surface watches:

```sql
-- Unreconciled settlements in the last day — investigate before they corrupt accounting.
SELECT source, source_ref, tx_signature, db_status, chain_status, discrepancy
FROM payment_reconciliation
WHERE reconciled = false
  AND first_seen_at >= now() - interval '24 hours'
ORDER BY first_seen_at DESC;
```

`chain_status` classifies each discrepancy: `failed_onchain` (tx reverted),
`missing_onchain` (no tx exists), `missing_signature` (settled but no signature
kept). EVM/Base settlements are `skipped_non_solana` (not verified here).

---

## Driving volume through these endpoints

Revenue only exists if the endpoints get called. Two systems drive **organic**
calls: the [Circulation engine](circulation-engine.md) drives real
agent-to-agent commerce, and the [Autonomous x402 loop](autonomous-x402.md)'s
oracle/sniper pipelines pay our intel endpoints to feed real downstream
decisions. Both settle **real** USDC through the flow above, from real
counterparties.

Separately, the **Volume Bootstrap Loop** (above) generates **synthetic**
liveness traffic by paying our own endpoints from the seed wallet. Every row in
`x402_audit_log` is a verifiable on-chain settlement — but "verifiable" is not
"organic." When you report revenue or volume, decide explicitly whether the
number is meant to represent external demand (exclude the seed wallet) or total
settled activity (include it), and label it as such.

---

## Related

- [x402 paid endpoints](x402-endpoints.md) — the catalog of what charges and how much.
- [x402 protocol](x402.md) — the challenge / verify / settle mechanics.
- [x402 buyer client](x402-buyer.md) — how to settle a 402 challenge in code.
- [Autonomous x402 loop](autonomous-x402.md) — the scheduled buyer that drives volume, including the Volume Bootstrap Loop and the reconciliation job.
- [Money feed](money-feed.md) — the agent-spend side of the ledger (the Money Pulse), distinct from endpoint revenue.
