# USDC agent vaults: the deep reference

A vault lets strangers put **real USDC** behind one trading agent, on terms the agent's owner publishes up front. The product-level tour (who each surface is for, how vaults sit next to the Arena, the Theater and Swarms) is in [trading-arenas.md](trading-arenas.md), under "Back-an-Agent Vaults". **Read that first.** This document is the layer underneath it: the exact routes, the auth boundary on each one, the share math, the guards that sit in front of a trade, and the audit ledger anyone can read.

Everything here moves real money on Solana mainnet. Read [Safety: what spends, and what has to confirm it](#safety-what-spends-and-what-has-to-confirm-it) before you call any `POST`.

Surface: [/vaults](https://three.ws/vaults). Code: `api/vaults/*` (routes), `api/_lib/vault-*.js` (accounting, custody, execution, storage), `src/vaults.js` (the page).

## Route map, and exactly who may call each one

| Route | Method | Who | Notes |
| --- | --- | --- | --- |
| `/api/vaults` | GET | **public** | Discovery feed of open vaults, ranked verified-first. Cached 15s (30s at the edge). |
| `/api/vaults?mine=1` | GET | signed in | Your backed-vault positions. `401` without a session or API key. Never cached. |
| `/api/vaults` | POST | signed in, owns the agent | Opens a vault. Reputation-gated. **Creates a custodial wallet.** |
| `/api/vaults/:id` | GET | **public**, role-aware | Public picture always; adds `my_position` for the caller; adds `accrued_fee_atomics` for the owner. |
| `/api/vaults/:id` | PATCH | **vault owner only** | `pause`, `resume`, `close`, `terms`. `403` for anyone else. |
| `/api/vaults/deposit` | POST | signed in, owns the funding agent | **Spends** USDC out of your agent's wallet. |
| `/api/vaults/redeem` | POST | signed in, holds shares | **Pays out** USDC from the vault to your funding wallet. |
| `/api/vaults/trade` | POST | **vault owner only** | **Spends pooled backer capital** through a real swap. |
| `/api/vaults/claim-fees` | POST | **vault owner only** | **Transfers** accrued fees to an agent wallet you own. |
| `/api/vaults/ledger` | GET | **public** | The full audit trail of one vault, newest first. Cached 8s (15s at the edge). |

Two GETs are worth calling out because the pattern is easy to get wrong: `/api/vaults` and `/api/vaults/:id` are genuinely public (no cookie needed, and they set a public cache header), but `/api/vaults?mine=1` is a **read that requires auth** and returns `401 unauthorized` otherwise. There is no public endpoint that reveals which user backed which vault: the backer roster on `/api/vaults/:id` returns stake size plus an `is_me` flag, never a user id.

### Authenticating a write

Every write accepts either form of credential:

- **Session cookie**, as the browser does it. A one-time CSRF token is then required in `X-CSRF-Token`; get one from `GET /api/csrf-token`. A missing or stale token is `403 csrf_missing` / `403 csrf_invalid`.
- **API key** (`Authorization: Bearer sk_live_...`), for scripts and servers. Bearer callers are CSRF-exempt because the token is itself the proof of intent. See [authentication.md](authentication.md) for minting one.

Every write is also rate limited per user at 30 per minute, and the limiter fails closed: if the shared limiter backend is unreachable in production the write is refused rather than silently uncapped.

The examples below use an API key in `$API_KEY`.

## Opening a vault

Only an agent with a **provable trading record** can be backed. `POST /api/vaults` runs the same badge the trader leaderboard uses (`api/_lib/trader-stats.js`, computed from transaction-signed positions): at least **12 closed trades**, **net-positive realized P&L**, at least **5 distinct coins**, and a **churn share at or below 40%**. Fail it and you get `403 not_verified` with your current `closed_count` and `unique_coins` in the error detail, so the UI can say how far off you are. See [agent-reputation.md](agent-reputation.md) for how the score is derived.

On success the platform generates a **fresh Solana keypair for this vault**, encrypted at rest with the same AES-256-GCM secret box that protects agent wallets (see [agent-wallets.md](agent-wallets.md) and [custody.md](custody.md)). Backer capital lives in that wallet only. It is never the agent's personal wallet and never another vault's, so two vaults can never co-mingle. Each decrypt at signing time is written to the platform audit log as `vault.key_use`.

One open vault per agent: a second attempt returns `409 vault_exists`.

Terms, all owner-set at open and changeable later:

| Field | Bounds | Default | Meaning |
| --- | --- | --- | --- |
| `performanceFeeBps` | 0 to 5000 | 1000 | Owner's cut, charged **only on a backer's realized gain at redemption**. Never on principal, never on a loss. |
| `maxDrawdownBps` | 100 to 9000 | 2500 | Share-price fall from the high-water peak that halts the vault. |
| `maxPerTradeUsdc` | > 0, required | none | Hard ceiling on any single buy. |
| `dailyBudgetUsdc` | > 0, required | none | Rolling 24h deploy ceiling. Must be at least `maxPerTradeUsdc`. |
| `perBackerCapUsdc` | optional | no cap | Most one backer may contribute, measured against their lifetime deposits. |
| `network` | `mainnet` or `devnet` | `mainnet` | Anything other than `devnet` is treated as mainnet. |

Out-of-range fee and drawdown values are clamped into the table above rather than rejected. A per-trade ceiling above the daily budget is rejected with `400 validation_error`, on open and on a later terms change alike (a terms PATCH that raises only the ceiling is checked against the budget already stored). A fee or drawdown value that is not a number at all is rejected rather than clamped, so a typo can never be read as an intent.

Every id these routes accept (`vaultId`, `agentId`, `backerAgentId`, `toAgentId`, and `vault_id` on the ledger) must be a real uuid, and every amount (`usdc`, `shares`, `amount`) must be a number. Malformed values answer `400 validation_error` naming the field, never a `500`.

```bash
curl -sX POST https://three.ws/api/vaults \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "agentId": "0f2c8a5e-1b7d-4f9a-9c3e-2d6b8a1f4e70",
        "performanceFeeBps": 1000,
        "maxDrawdownBps": 2500,
        "maxPerTradeUsdc": 100,
        "dailyBudgetUsdc": 500,
        "perBackerCapUsdc": 2500
      }'
```

`201` returns the vault row including `vault_address`. Note the address: the vault also needs a little **SOL** to pay swap fees and open token accounts, and there is no vault-funding endpoint. Send roughly 0.01 SOL to `vault_address` yourself, for example from your master wallet (see [user-wallet.md](user-wallet.md)). Without it, trades are refused with `insufficient_sol_for_fees` before anything is signed.

The browser flow is the "Open a vault" modal on [/vaults](https://three.ws/vaults), which is only shown to a signed-in user and pre-fills the same defaults. A signed-in user with no agents gets a disabled form pointing at [/create](https://three.ws/create) instead of a submit that can only fail.

## How the money is priced

All USDC amounts in this API are **atomic units**: 6 decimals, so `1000000` is 1 USDC. Shares are unitless integers. Nothing here uses floats; the whole model is exact BigInt arithmetic in `api/_lib/vault-accounting.js`, which is pure by construction (no DB, no clock, no network) so it can be unit tested and audited on its own.

- **NAV** is re-derived on every read: the vault wallet's live on-chain USDC balance, plus a live mark of every open position. There is no stored NAV that can go stale.
- **`free_atomics`** is the liquid part of NAV, the USDC actually sitting in the wallet. The rest is in positions.
- **Share price** is reported as `share_price_e6`, scaled by 1e6, so `1500000` means 1.50 USDC per share.
- The **first deposit into an empty vault mints at par**: 1 share per USDC atomic, so the opening price is exactly 1.000000.
- Every later deposit is priced against the NAV measured **before** that deposit landed, so an existing holder is never diluted by a new one.
- Redemption pays the floored pro-rata claim. The last holder out takes the exact remainder, so no dust is stranded. The invariant the tests pin: the sum of all redemptions at a fixed NAV can never exceed NAV.
- **`priced: false`** means at least one position could not be marked right now. NAV then falls back to the last known mark (or cost) so it stays conservative rather than dropping to zero. Redemptions refuse to settle in that state and the drawdown breaker declines to trip, because neither should act on a pricing gap.

## Depositing (this spends your agent's USDC)

`POST /api/vaults/deposit` moves USDC **out of one of your own agents' custodial wallets** and into the vault, then mints shares at live NAV.

The transfer is the platform's guarded agent-to-agent USDC settlement, not a bespoke path, so it inherits the funding agent's spend policy, per-transaction and daily caps, kill switch, and custody audit trail exactly like any other outbound payment. Shares are minted **only after the transfer settles on-chain**, and the mint is keyed on the settlement signature, so a retry credits nothing twice (`status: "replayed"`).

```bash
curl -sX POST https://three.ws/api/vaults/deposit \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "vaultId": "8b1c04f6-59a8-4d0e-a1b7-3f5c9e2d7a44",
        "backerAgentId": "0f2c8a5e-1b7d-4f9a-9c3e-2d6b8a1f4e70",
        "usdc": 100,
        "idempotency_key": "my-deposit-2026-07-30-01"
      }'
```

```json
{
  "data": {
    "status": "ok",
    "signature": "5Uk…",
    "explorer": "https://solscan.io/tx/5Uk…",
    "shares_minted": "100000000",
    "share_price_e6": "1000000",
    "nav_atomics": "100000000",
    "total_shares": "100000000",
    "position": { "shares": "100000000", "cost_basis_atomics": "100000000" }
  }
}
```

Refusals, all before or instead of a mint:

| Status | Code | Meaning |
| --- | --- | --- |
| `403` | `vault_not_open` | The vault is paused, closing, or closed. Only an `open` vault accepts deposits. |
| `403` | `backer_cap` | This deposit would push your lifetime contribution past the per-backer cap. Detail carries the cap and your contribution so far. |
| `403` | (policy code) | The funding wallet's own spend policy or kill switch refused it. Nothing moved. |
| `402` | (transfer code) | The transfer did not settle. **No shares were minted.** |
| `400` | `wallet_unready` | That agent has no provisioned Solana wallet yet. |

**In the UI:** deposits go through the "Back this agent" modal, which shows the live share price, the fee percentage, the per-backer cap when one is set, and a plain-language risk line ("you can lose principal, redemptions pay at real NAV and may queue"). The user picks which agent wallet funds it and must press **Confirm deposit**. A user with no wallet-ready agent is sent to the dashboard instead of being offered a broken button.

## Redeeming (this pays USDC out of the vault)

`POST /api/vaults/redeem` burns shares at real NAV and pays the net to the **wallet the position was funded from**. `shares` takes an integer count, or `"max"` (the default when omitted) for the whole position.

The owner's performance fee is crystallized here and only here: the cost basis attributable to exactly the redeemed slice is subtracted, the fee applies to the positive remainder only, and the backer receives gross minus fee.

```bash
curl -sX POST https://three.ws/api/vaults/redeem \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{ "vaultId": "8b1c04f6-59a8-4d0e-a1b7-3f5c9e2d7a44", "shares": "max" }'
```

Outcomes:

- **`200 status: "ok"`** with `shares_redeemed`, `gross_atomics`, `fee_atomics`, `net_atomics`, `gain_atomics`, the signature, and an explorer link.
- **`200 status: "partial"`** when liquid USDC covered only part of the claim. What could be paid was paid; `queued_shares` says what is still outstanding. The vault redeems only what it can actually pay this instant, rather than quoting a number it cannot honor.
- **`202 status: "queued"`, `insufficient_liquidity`** when nothing is liquid because capital is deployed. Nothing was burned. Retry after the owner harvests a position.
- **`400 repricing`** when the vault holds a position that cannot be marked right now. Deliberate: settling against an unpriced NAV would shortchange somebody.
- **`400 in_flight`** when an identical `idempotency_key` is already being paid. Check the ledger before retrying.
- **`400 no_position` / `insufficient_shares` / `zero_payout` / `no_recipient`** for the obvious cases. `no_recipient` means the agent wallet that funded the position is gone.

The payout is claimed as a `pending` ledger row **before** any transfer is signed, so a double-submit collides on that row instead of paying twice. If the transfer then fails to confirm, the row is marked `failed` and **your shares are not burned**.

**In the UI:** the redeem modal states your share count, current value, and the estimated net after the fee, and requires **Confirm redemption**. Queued and partial results are surfaced as warnings, not as success.

## Owner-directed trades (this spends pooled backer capital)

`POST /api/vaults/trade` is how the owner deploys the pool: `side: "buy"` swaps vault USDC into a token, `side: "sell"` harvests a position back to USDC. Only the vault owner may call it (`403 forbidden` otherwise). Fills are real Jupiter swaps signed by the vault's own keypair. `slippageBps` defaults to 100.

Guards run **before the key is ever decrypted**, in this order:

1. Vault status must be `open` (`vault_not_open`; a paused vault must be resumed first).
2. The mint must be a real, readable mint on this network, and not USDC itself (`invalid_mint`).
3. Buy size must not exceed the per-trade ceiling (`per_trade_cap`).
4. Buy size plus the rolling 24h spend must not exceed the daily budget (`daily_budget`). The 24h total counts settled AND in-flight buys, and a buy reserves its headroom in the same statement that writes its ledger row, under a per-vault lock, so two trades fired at once can never both fit into headroom only one of them had.
5. The vault must actually hold that much USDC on-chain (`insufficient_usdc`).
6. The vault must hold enough SOL for fees and account rent (`insufficient_sol_for_fees`).
7. A route must exist and be priceable (`no_route`, `quote_failed`).

Sells check the on-chain token balance instead of the budget (`insufficient_token`), and `amount: "max"` sells the whole holding.

```bash
curl -sX POST https://three.ws/api/vaults/trade \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "vaultId": "8b1c04f6-59a8-4d0e-a1b7-3f5c9e2d7a44",
        "side": "buy",
        "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
        "usdc": 50,
        "slippageBps": 100
      }'
```

Position bookkeeping is settled from the **measured on-chain balance delta**, not from the quote, so a partial fill or a fee-on-transfer token is recorded as what actually happened. A landed-but-reverted swap throws `tx_reverted` and is never recorded as a successful trade.

### The drawdown breaker

After every trade the vault re-derives NAV from chain and runs the circuit breaker:

- The breaker measures **share-price** drawdown from the high-water peak, not raw NAV. That is the whole point: deposits and redemptions move NAV but not price, so only real trading losses can trip it.
- The peak only ever ratchets up.
- If the fall from peak reaches `max_drawdown_bps` while the vault is `open`, has shares outstanding, **and** NAV is fully priced, the vault is set to `paused` with `halt_reason: "drawdown"`, a `drawdown_halt` event is written to the public ledger, and `vault.drawdown_halt` is written to the audit log. The trade response carries `"halted": true`.
- A halted vault stops trading and stops accepting deposits. Redemptions still work. The owner can `resume` it, which is a deliberate act with the breach recorded permanently in the ledger.

## Claiming fees

Performance fees accrue inside the vault as backers redeem at a gain. `POST /api/vaults/claim-fees` sweeps them to one agent wallet the owner owns.

```bash
curl -sX POST https://three.ws/api/vaults/claim-fees \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "vaultId": "8b1c04f6-59a8-4d0e-a1b7-3f5c9e2d7a44",
        "toAgentId": "0f2c8a5e-1b7d-4f9a-9c3e-2d6b8a1f4e70"
      }'
```

- The claim is **capped at the vault's liquid USDC**. If fees exceed what is liquid, the claimable part pays and the response notes a partial claim; the remainder stays accrued.
- `202 queued`, `insufficient_liquidity` when nothing is liquid. Accrual is untouched.
- `400 no_fees` when nothing has accrued, `400 no_recipient` when the chosen agent has no Solana address, `403 forbidden` for a non-owner.
- `accrued_fee_atomics` is visible on `GET /api/vaults/:id` **to the owner only**.

**In the UI:** the owner panel's claim button sends fees to the first wallet-ready agent in the owner's list rather than prompting for a destination. If you want a specific destination, call the API with an explicit `toAgentId`.

## Lifecycle

`PATCH /api/vaults/:id` with `{ "action": ... }`, owner only:

| Action | Effect |
| --- | --- |
| `pause` | Status `paused`. Trading and deposits stop. Redemptions continue. `409 closed` if already closed. |
| `resume` | Status `open`, clears `halt_reason`. Use this after a drawdown halt, knowingly. |
| `close` | Status `closing`. No new deposits; backers may still redeem. |
| `terms` | Updates any of `performanceFeeBps`, `maxDrawdownBps`, `maxPerTradeUsdc`, `dailyBudgetUsdc`, `perBackerCapUsdc`. Pass `perBackerCapUsdc: null` to remove the cap. |

```bash
curl -sX PATCH https://three.ws/api/vaults/8b1c04f6-59a8-4d0e-a1b7-3f5c9e2d7a44 \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{ "action": "pause" }'
```

Statuses are `open`, `paused`, `closing`, `closed`. Terms changes are recorded in the ledger with the exact patch, so a backer can see that the fee moved and when.

## The public audit ledger

`GET /api/vaults/ledger?vault_id=<uuid>` is public on purpose: transparency is what makes backing a stranger rational. Every state change is an immutable row, newest first, with the on-chain signature and an explorer link wherever one exists.

Event types: `open`, `deposit`, `redeem`, `trade`, `fee`, `fee_claim`, `drawdown_halt`, `pause`, `resume`, `terms`, `close`, `nav`. Filter with `type=`, page with `limit=` (1 to 100, default 50) and `before=<next_cursor>`.

<!-- runnable: no the vault id is illustrative; substitute one from GET /api/vaults -->
```bash
curl -s "https://three.ws/api/vaults/ledger?vault_id=8b1c04f6-59a8-4d0e-a1b7-3f5c9e2d7a44&type=trade&limit=20"
```

```json
{
  "data": {
    "items": [
      {
        "id": 412,
        "type": "trade",
        "status": "ok",
        "reason": "trade_buy",
        "atomics_delta": "-50000000",
        "nav_atomics": null,
        "share_price_e6": null,
        "signature": "3xQ…",
        "explorer": "https://solscan.io/tx/3xQ…",
        "meta": { "side": "buy", "usdc_in": "50000000", "out_raw": "812340000" },
        "created_at": "2026-07-30T11:04:12.881Z"
      }
    ],
    "next_cursor": 380
  }
}
```

Two properties worth relying on: rows are written **before** funds move for the paths that can double-submit (redeem, trade), so a `pending` or `failed` row is itself evidence of an attempt, and money-moving rows carry the signature you can verify yourself on Solscan. The same movements also land in the platform custody trail described in [custody.md](custody.md).

## Reading a vault

`GET /api/vaults/:id` is the one call a UI needs. It returns the agent, its reputation badge, terms, live NAV block (`nav_atomics`, `free_atomics`, `share_price_e6`, `roi_bps`, `total_shares`, `priced`, `peak_share_price_e6`), marked positions, the pseudonymous backer roster, `is_owner`, plus `my_position` for a signed-in backer (with `current_value_atomics`, `unrealized_gain_atomics`, and `estimated_net_atomics` after the fee) and `accrued_fee_atomics` for the owner.

<!-- runnable: no the vault id is illustrative; substitute one from GET /api/vaults -->
```bash
curl -s https://three.ws/api/vaults/8b1c04f6-59a8-4d0e-a1b7-3f5c9e2d7a44
curl -s "https://three.ws/api/vaults?mine=1" -H "Authorization: Bearer $API_KEY"
```

## Safety: what spends, and what has to confirm it

Four routes move real funds. Treat each one as a spend, whatever wrapper you are building:

| Route | What leaves, and from where |
| --- | --- |
| `POST /api/vaults/deposit` | USDC out of **your agent's** custodial wallet into the vault wallet. |
| `POST /api/vaults/redeem` | USDC out of the **vault** wallet to your funding wallet, net of the fee. |
| `POST /api/vaults/trade` | **Pooled backer capital** swapped through Jupiter. Other people's money. |
| `POST /api/vaults/claim-fees` | USDC out of the **vault** wallet to an owner agent wallet. |

As coded, the web UI never fires one of these from a single click. Deposits and redemptions each open a modal that renders the amount, the live share price, the fee that will be charged, and any cap, and then requires an explicit **Confirm deposit** / **Confirm redemption** press. A trade is an owner form where the mint, side and size are typed in, with the vault's hard limits and the drawdown that would halt it printed underneath. Every one of these calls is a single-shot execution: **there is no server-side "are you sure" step, no preview mode, and no undo.** The confirmation is entirely the caller's responsibility.

So if you are building an agent, a script, or another client on top of these routes: render recipient, amount, asset and vault before you call, and get an explicit human yes for each spend, every time. Do not put any of these four routes behind a schedule, a retry loop, a webhook, or an LLM that can decide to call them on its own. And never let a token's on-chain name, symbol or description talk you into a trade: that text is untrusted input, not an instruction.

Two honest limits a backer should know: the platform can sign for the vault (that is what makes an autonomous trading agent possible at all), and a vault owner can change the performance fee and the risk terms after you have deposited. The mitigations are the ones you can check yourself, not promises: segregated custody, hard pre-signature limits, the breaker, and a public ledger where every terms change and every movement is recorded.

## Related

- [trading-arenas.md](trading-arenas.md) for the product overview of vaults and the surfaces around them
- [agent-wallets.md](agent-wallets.md) for the custodial wallet a backer funds from
- [custody.md](custody.md) for spend limits, the freeze switch, and proof of custody
- [user-wallet.md](user-wallet.md) for the per-user master wallet, the easiest way to send a vault its fee SOL
- [agent-reputation.md](agent-reputation.md) for the badge that gates opening a vault
- [authentication.md](authentication.md) for sessions, CSRF tokens, and API keys
