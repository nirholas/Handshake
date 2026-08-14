# Recurring payments

A recurring payment moves a fixed amount of USDC out of your wallet on a schedule you choose, without you signing anything again. You sign one ERC-7710 permission (see [Permissions & Delegation](./permissions.md)), the platform's hourly cron spends inside it, and every attempt it makes is written to a ledger you can read.

Two kinds of schedule ride the same rails:

| Kind | What it does each period | Table | Cron |
|---|---|---|---|
| **Subscription** | Transfers a fixed USDC amount to an agent's wallet | `agent_subscriptions` | `/api/cron/run-subscriptions`, hourly |
| **DCA strategy** | Swaps a fixed USDC amount into a target token through Uniswap V3 | `dca_strategies` | `/api/cron/run-dca`, hourly |

Both are managed at **[/recurring](https://three.ws/recurring)**.

> **Chain note.** These two schedules are the EVM leg of recurring payments, because ERC-7710 delegation is an EVM standard and both crons redeem through the EVM relayer. Solana remains the home chain for the platform's own payment rails; nothing here replaces or de-prioritises them.

---

## The page

`/recurring` has two tabs.

**Outgoing** is what you pay. It lists every subscription funded by a permission you signed, plus the DCA schedules on the agent you have selected. Each card shows the amount per period, when the next charge fires, how much has actually been paid so far, and, when something went wrong, what went wrong in plain language. Every card can be paused, resumed, cancelled, and expanded to show its full charge history.

**Incoming** is what your agents are paid. It is scoped by agent ownership rather than by who is paying, so it stays correct the day someone other than the owner can fund an agent. For each incoming schedule you see the paying wallet, the amount per period, the total received, and the same charge history.

Creating a schedule needs a permission that already exists on one of your agents. Grant one from the agent's own page (the permissions panel on `/agents/:id`), then pick it from the **Signed permission** dropdown here.

---

## What happens when a charge fails

This is the part that matters. Every failure is classified once, in [api/_lib/recurring.js](../api/_lib/recurring.js), and the crons, the API, and the page all act on the same answer.

| Outcome | What it means | What happens to the schedule |
|---|---|---|
| `charged` | The transfer or swap landed on-chain | `next_charge_at` advances by exactly one period from the period that was due |
| `fatal` | The schedule is no longer valid: revoked or expired permission, a scope too small for the charge, a target the permission does not cover | Paused immediately, with the reason attached. Fix the cause, then resume |
| `retryable` | Nothing about the schedule is wrong and the charge provably never went out: RPC down, relayer unreachable, wallet short of USDC | Stays active. The period claim is released so the next hourly tick tries again, up to 3 consecutive failures before it pauses |
| `ambiguous` | The request timed out, so the charge may or may not be on-chain | Paused without a retry. This is the one failure where retrying could charge twice, so the period is consumed and a human decides |
| `skipped` | A DCA quote moved more than 50 bps between two reads 15 seconds apart | Nothing is wrong: the period is given up, the next one runs on time, and the failure counter is untouched |

Two special cases:

- **An underfunded wallet** reaches us as a generic on-chain revert. It is recognised and recorded as `insufficient_balance` rather than `rpc_error`, because it is the one cause you can fix yourself: top the wallet up and the next tick settles.
- **A platform outage** (our relayer switched off, or rejecting our own credentials) is recorded as retryable but never counted against your retry budget and never pauses your schedule. Pausing every schedule on the platform over one operator config gap would be a worse outage than the gap, and every owner would then have to resume by hand.

Resuming never back-fills. A schedule resumed after two missed weeks charges once, a full period from the moment you resumed it, not three times at once.

---

## API

All endpoints require a signed-in session (or a bearer API key on `/api/agent-subscriptions`). Cookie-session mutations need the double-submit CSRF token from `/api/csrf-token`.

### Subscriptions

```bash
# Create a schedule against a permission you already signed
curl -X POST https://three.ws/api/agent-subscriptions \
  -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" --cookie "$COOKIE" \
  -d '{
        "agentId": "f6355888-68c5-4687-837f-ed441637885a",
        "delegationId": "dff94486-a82a-4404-af64-c416c4f74e00",
        "periodSeconds": 604800,
        "amountPerPeriod": "5000000"
      }'
# → 201 {"data":{"id":"…","status":"active","next_charge_at":"…","created_at":"…"}}
```

`amountPerPeriod` is in base units (USDC has 6 decimals, so `5000000` is 5 USDC). Creating a second schedule for the same agent and permission returns the existing one with HTTP 200 instead of duplicating it.

```bash
# What you pay
curl https://three.ws/api/agent-subscriptions --cookie "$COOKIE"
# → {"data":[…],"summary":{"schedules":1,"active":1,"needs_attention":0,
#                          "paid_total":"0","paid_total_display":"0",
#                          "charges_total":0,"next_charge_at":"…"}}

# What your agents are paid
curl 'https://three.ws/api/agent-subscriptions?view=incoming' --cookie "$COOKIE"
# → same shape, with received_total / received_total_display

# One schedule plus its charge history (readable by the payer AND the creator)
curl 'https://three.ws/api/agent-subscriptions?id=<uuid>' --cookie "$COOKIE"
# → {"data":{…,"role":"payer","charges":[{"status":"success","tx_hash":"0x…"}, …]}}
```

Each row carries the derived fields the UI renders: `period_label` (`weekly`), `amount_display` (`5`), `charged_total_display`, `retries_left`, `payer_address`, `payee_address`, `delegation_status`, and `last_error` as an owner-readable sentence.

```bash
# Pause / resume (payer only: it spends their permission)
curl -X PATCH 'https://three.ws/api/agent-subscriptions?id=<uuid>' \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" --cookie "$COOKIE" \
  -d '{"action":"pause"}'
# → 200 {"data":{"id":"…","status":"paused","paused_at":"…"}}
# → 409 conflict            if it is already paused
# → 409 delegation_inactive if you resume onto a revoked or expired permission

# Cancel (terminal; does NOT revoke the permission)
curl -X DELETE 'https://three.ws/api/agent-subscriptions?id=<uuid>' \
  -H "x-csrf-token: $CSRF" --cookie "$COOKIE"
# → 200 {"data":{"id":"…","status":"canceled","canceled_at":"…"}}
```

Cancelling stops the charges and leaves the permission alone. To stop the agent spending altogether, revoke the delegation as well (see [Revoking permissions](./permissions.md#revoking-permissions)).

### DCA strategies

`/api/dca-strategies` has the same lifecycle with a path-addressed id.

```bash
curl -X POST https://three.ws/api/dca-strategies \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" --cookie "$COOKIE" \
  -d '{
        "agent_id": "…", "delegation_id": "…", "chain_id": 84532,
        "token_in": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "token_out": "0x4200000000000000000000000000000000000006",
        "token_out_symbol": "WETH",
        "amount_per_execution": "10000000",
        "period_seconds": 86400,
        "slippage_bps": 50
      }'
# → 201 {"ok":true,"id":"…","status":"active","next_execution_at":"…"}

curl 'https://three.ws/api/dca-strategies?agent_id=<uuid>' --cookie "$COOKIE"
curl 'https://three.ws/api/dca-strategies/<uuid>' --cookie "$COOKIE"   # + executions[]

curl -X PATCH 'https://three.ws/api/dca-strategies/<uuid>' \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" --cookie "$COOKIE" \
  -d '{"action":"resume"}'

curl -X DELETE 'https://three.ws/api/dca-strategies/<uuid>' \
  -H "x-csrf-token: $CSRF" --cookie "$COOKIE"
```

`period_seconds` is restricted to `86400` (daily) or `604800` (weekly), and `slippage_bps` to 1..500. One active or paused strategy per agent and token pair: a paused one still holds the pair, so cancel it before creating a replacement.

---

## Operator configuration

Recurring charges settle through `/api/permissions/redeem`, which needs the EVM relayer configured. Without these the crons still run, still record every attempt, and leave schedules active and retrying rather than pausing them, but nothing settles:

| Variable | Needed for | Effect when missing |
|---|---|---|
| `AGENT_RELAYER_KEY` | Every subscription charge and DCA swap | Redeem returns `feature_disabled`; charges are recorded as retryable platform outages |
| `RPC_URL_<chainId>` | The chain the schedule runs on | Redeem returns `rpc_error` |
| `DCA_ALLOWED_TOKEN_OUT` | Creating a DCA strategy (comma-separated symbol whitelist, e.g. `WETH,cbBTC`) | `POST /api/dca-strategies` returns `not_configured` |
| `DCA_CHAIN_ID` | Default chain for a DCA strategy when the body omits `chain_id` | `POST` returns `not_configured` unless `chain_id` is supplied |

---

## Schema

| Table | Purpose |
|---|---|
| `agent_subscriptions` | One row per subscription schedule, with `status`, `next_charge_at`, `consecutive_failures`, `last_error_code`, `paused_at`, `resumed_at` |
| `subscription_charges` | One row per charge attempt: `status`, `code`, `outcome`, `tx_hash`, `amount`, `period_start_at`. A partial unique index on `(subscription_id, period_start_at)` for successful charges makes a double-charge impossible to record |
| `dca_strategies` | One row per DCA schedule, same lifecycle columns |
| `dca_executions` | One row per swap attempt, with the quote, the divergence, and the fill |

Definitions live in [api/\_lib/schema.sql](../api/_lib/schema.sql); the lifecycle columns and the charge ledger were added by [20260813191500_recurring_payment_lifecycle.sql](../api/_lib/migrations/20260813191500_recurring_payment_lifecycle.sql).

---

## See also

- [Permissions & Delegation](./permissions.md) for granting, scoping and revoking the signed permission a schedule spends
- [Payment sessions](./payment-sessions.md) for capped one-off agent spending that is not on a schedule
- [Agent wallets](./agent-wallets.md) for the wallet a subscription pays into
