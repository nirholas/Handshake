# 01. x402 settle: clear `fee_runway_exhausted` and hold the rate above 90%

Read [00-INDEX.md](backlog-00-INDEX.md) first.

> ## Status, re-measured 2026-09-02 (read this before the body below)
>
> Every agent-doable line of this order is now shipped. What remains is capital,
> and it is owner-owned. The body below is kept for its diagnosis method, but
> four of its factual claims have been overtaken; do not act on them:
>
> 1. **The two config levers are already applied in production.**
>    `GET /api/x402/runway-lab` reports `runway_days: 1` and the 2026-08-01
>    entry in [PROGRESS.md](backlog-PROGRESS.md) records
>    `ECONOMY_MASTER_OPERATING_SOL=0.3` landing with it. Do not re-apply them.
> 2. **Lever 2 is inert at this balance and was struck on 2026-08-02.** The
>    governor's budget is `max(minBudgetLamports, spendable / runwayDays)`. With
>    the sponsor at 0.0037 SOL the 10,000,000 lamport heartbeat floor already
>    exceeds spendable, so runway days change nothing.
> 3. **The upstream cause is NOT a mis-tuned self-heal trigger.** The deficit has
>    been positive and the reclaim leg has been running for weeks. It cannot
>    complete: the wallets it targets are encrypted under the
>    WALLET_ENCRYPTION_KEY retired in the 2026-07 host migration and fail
>    AES-GCM decryption. 0.49 SOL is stranded that way, 0.35 of it customer
>    money. See `docs/ops/wallet-key-migration.md`.
> 4. **The numbers below are a 2026-08-01 snapshot.** As of 2026-09-02 settle is
>    55.0% and `degraded`, not 25.9% and `down`; demand has fallen to 177
>    attempts/hour from 3,726; measured burn is 0.0133 SOL/day spent against
>    ~0.043 SOL/day to serve every attempt.
>
> **The one thing that lifts the settle rate is SOL in two wallets.** The ring
> payer sits 1,592 lamports under its 2,000,000 floor and the sponsor has
> 1,727,883 spendable lamports. Send SOL to the economy master
> `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`, never to per-agent wallets.
> That is stop-and-ask gate 1 and it is the owner's call.
>
> Shipped against this order: the caller-side fee admission gate
> (`assessFeeAdmission`), the governor config recurrence guard
> (`tests/x402-wallet-fee-governor.test.js`), `WALLET_ENCRYPTION_KEY_PREVIOUS`
> key rotation, and the dry-run reclaim key gate plus the corrected
> `sponsor_floor` hint (`afd349790`, 2026-09-02). Full evidence per line is in
> [PROGRESS.md](backlog-PROGRESS.md).

## What is wrong (as measured 2026-08-01)

`x402_settle` is at 25.9% (504 of 1948 paid attempts over 3 hours). The rail
faults look external (`http_502` x1180) but they are **our own facilitator
rejecting settles**: a facilitator settle rejection maps to 502 in
`api/x402-facilitator/[action].js` (respondError defaults to 502) and the ring
records it as `http_502` in `api/_lib/x402/pay.js`.

The reject reason is not ambiguous. Since boot the self-facilitator counters read:

```
settle: ok 4143, failed 85955
fail_reasons: fee_runway_exhausted 85331, broadcast_failed 562,
              signature_already_settled 56, idempotent_replay 4, not_confirmed 2
```

`fee_runway_exhausted` outnumbers every rail-shaped failure by more than 100x.
That reason comes from `assessWalletFeeBudget()` in
[api/_lib/x402/wallet-fee-governor.js](../../api/_lib/x402/wallet-fee-governor.js):
the wallet's daily fee budget is its spendable SOL (balance minus the hard floor)
divided by `X402_WALLET_FEE_RUNWAY_DAYS`, never below
`X402_WALLET_FEE_MIN_BUDGET_LAMPORTS`. A near-floor wallet gets a budget of about
0.01 SOL/day, which at roughly 6,000 to 8,000 lamports per settle is a few
thousand settles, so the budget exhausts hours after each 00:00 UTC reset and the
wave resumes.

**The upstream cause is a mis-tuned self-heal trigger, not an empty treasury.**
`ECONOMY_MASTER_OPERATING_SOL` in production sits *below* the master wallet
balance (code default is 0.15), so `master_deficit_sol` computes as 0, the
treasury-topup cron sees nothing to do, and reclaimable SOL sitting in agent
wallets is never pulled back to the wallet that pays fees.

This is a config and plumbing problem. Do not open with a funding request.

## Diagnose (do this first, do not skip)

```sh
# 1. The class, from outside, no credentials needed.
curl -s https://three.ws/api/healthz \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['x402']['self_facilitator'],indent=1))"

# 2. The other class. A hit here means a DIFFERENT fix (see the floor doctrine below).
npm run logs -- -s three-ws-api --grep "fee_wallet_below_floor" --since 1h
```

When you grep the service logs directly, use a **bare quoted string**, never
`textPayload:"..."`. This service logs structured JSON, so a `textPayload:` query
returns zero rows and exits 0, which reads as "class ruled out" while the cause is
live. That exact trap cost a full misdiagnosis:

```sh
gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" "fee_runway_exhausted"' \
  --freshness=6h --project aerial-vehicle-466722-p5
```

Then read the treasury engine's own view, which is read-only and safe:

```sh
curl -s -X POST "https://three.ws/api/cron/treasury-topup?dry=1" \
  -H "Authorization: Bearer $CRON_SECRET"   # CRON_SECRET is in .env
```

Read **`spendable_sol`, not `master_sol`**. A reserve set close to the balance
mutes the whole engine while the balance still looks healthy.

## Fix

Three levers, in this order. The first two are config-only and pre-approved.

1. **Make the deficit real so reclaim self-heals.**
   ```sh
   gcloud run services update three-ws-api --region us-central1 \
     --project aerial-vehicle-466722-p5 \
     --update-env-vars ECONOMY_MASTER_OPERATING_SOL=0.3
   ```
   Verify the deficit turns positive in the `?dry=1` output above.

2. **Widen the daily budget from the same balance.**
   ```sh
   gcloud run services update three-ws-api --region us-central1 \
     --project aerial-vehicle-466722-p5 \
     --update-env-vars X402_WALLET_FEE_RUNWAY_DAYS=1
   ```
   This triples the budget without spending anything. Confirm the projection with
   `/economy-lab`, which runs the real governor client-side through
   [api/_lib/x402/runway-sim.js](../../api/_lib/x402/runway-sim.js), seeded from
   `GET /api/x402/runway-lab`. Model the change there before you apply it.

3. **Actually move the reclaimable SOL.** A non-dry
   `POST /api/cron/treasury-topup` moves funds between platform wallets. That is
   **stop-and-ask gate 1**: render the source wallet, destination, and amount, and
   get an explicit owner yes before firing it. Never top up per-agent wallets;
   that strands SOL and kills the rail.

## Do not do these

- Do not lower `X402_SPONSOR_SOL_FLOOR_LAMPORTS` to make the symptom go away. The
  floor is a different guard for a different failure (`fee_wallet_below_floor`),
  and the last time it tripped the shortfall was 0.000187 SOL: the refill leg was
  blocked, not the floor set wrong.
- Do not size a funding ask from remembered numbers. Measured burn is roughly
  0.06 to 0.09 SOL/day from `fee_lamports` over successful settles. The
  "1 to 2 SOL/day" figure in old triage notes is off by about 10x.
- Do not attribute this wave to the RPC lanes. They explain `broadcast_failed`
  and `not_confirmed` (562 and 2), which is under 1% of the failures.

## Make it not recur

Config that drifts silently is how this class returns. Land at least one of:

- A healthz-level assertion that `ECONOMY_MASTER_OPERATING_SOL` is **above** the
  master balance's operating point, surfaced as a degraded reason string rather
  than a silent zero deficit.
- A test over the governor's config surface pinning the relationship between
  runway days, min budget, and the measured per-settle fee, so a future default
  change cannot re-create a sub-day budget unnoticed. Extend
  `tests/x402-wallet-fee-governor.test.js`.

## Definition of done

- [ ] `x402_settle` reports **ok** on `https://three.ws/api/healthz`, above 90%,
      read at least 3 hours after the change so a full budget window is covered.
- [ ] `fee_runway_exhausted` is no longer the top reject class.
- [ ] `POST /api/cron/treasury-topup?dry=1` shows a non-zero deficit and a
      non-zero reclaim plan.
- [ ] The recurrence guard is committed with a test, `npm run gate` green.
- [ ] `data/changelog.json` entry (tag: `fix`, `infra`) describing the recovery in
      holder-readable language.
- [ ] [PROGRESS.md](backlog-PROGRESS.md) updated with before/after settle rates.
