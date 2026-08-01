# 01. x402 settle is DOWN at 26%, and two different faults are stacked

**Severity: P0.** Money path. Read [00-INDEX.md](00-INDEX.md) first.

## Symptom (measured 2026-08-01 against production)

`GET https://three.ws/api/healthz` reports the `x402_settle` subsystem as the
only DOWN entry in an otherwise green fleet:

```
x402_settle  down  settle 26.1% (506/1938 paid attempts, 3 hours);
                   1432 rail faults (http_502x1171, http_402x181, settle_failedx29)
```

The self-facilitator's own lifetime counters in the same response:

```json
"settle": { "ok": 4151, "failed": 85889,
  "fail_reasons": { "fee_runway_exhausted": 85265, "broadcast_failed": 562,
                    "signature_already_settled": 56, "idempotent_replay": 4,
                    "not_confirmed": 2 } }
"verify": { "ok": 90546, "rejected": 1531,
  "reject_reasons": { "simulation_failed": 1531 } }
```

For contrast, `ISSUES.md` recorded 30.3% on 2026-07-31 with `http_502` dominant
and near 78% on 2026-07-30. The rate has not recovered on its own.

## What is actually being claimed here, and what is not

Two distinct faults are stacked, and they have opposite fixes. Do not merge them.

1. **`fee_runway_exhausted` (85,265 lifetime).** This is NOT an empty wallet. It
   is the wallet-level fee governor refusing a settle because the wallet's daily
   fee budget is spent, while the wallet is still above its hard SOL floor. The
   decision and its exact reason string live in
   [api/_lib/x402/wallet-fee-governor.js](../../api/_lib/x402/wallet-fee-governor.js)
   (`fee_runway_exhausted:<spent>+<fee>><budget>`), applied at the one choke
   point in
   [api/_lib/x402/self-facilitator.js](../../api/_lib/x402/self-facilitator.js).
   The distinct wallet-is-empty reason is `fee_wallet_below_floor`, and it does
   not appear in the counters above. A config-shaped fault that looks exactly
   like an empty wallet is the documented trap here.
2. **`http_502` (1,171 in the 3h window).** Rail faults: broadcast failures with
   empty simulation logs, `Blockhash not found`, malformed responses. These are
   RPC-shaped and are downstream of work order
   [02](02-solana-rpc-paid-lanes.md). They will not respond to any amount of
   funding or governor tuning.

## Run the triage agent first

`.claude/agents/x402-economy-triage.md` exists precisely because
"the wallets are dry" is the wrong answer most of the time. Invoke it, give it
this file, and let it classify before you touch anything.

## The job

1. **Reproduce and split the failure set.** Query
   `x402_self_facilitator_log` through the existing tooling, not hand SQL where
   an endpoint already exists: `GET /api/x402/runway-lab` returns the live seed,
   and `/economy-lab` runs the real admission logic client-side against it via
   [api/_lib/x402/runway-sim.js](../../api/_lib/x402/runway-sim.js). Produce a
   count per reason for the last 3h and the last 24h.
2. **Confirm the amount-independence test.** Group failures by payment amount.
   If the smallest bucket has the worst success ratio, insufficient funds cannot
   be the cause, which is what `ISSUES.md` item 7 already found. Record the
   table in your report. If the result has flipped since, say so loudly, because
   it changes the fix.
3. **Fix the governor half.** Decide, with the simulation rather than by feel,
   whether the daily budget is genuinely too tight for current demand
   (`X402_WALLET_FEE_RUNWAY_DAYS`, `X402_WALLET_FEE_MIN_BUDGET_LAMPORTS`) or
   whether demand has grown past what the sponsor's balance can support. Then
   either widen the governor on the Cloud Run service with
   `gcloud run services update three-ws-api --region us-central1
   --update-env-vars ...` (config-only updates are pre-approved; note that
   `--set-env-vars` REPLACES the whole set and must never be used here), or cut
   call volume with the ring cadence knobs. Show the projected runway from the
   simulation before and after.
4. **Do not lower `X402_SPONSOR_SOL_FLOOR_LAMPORTS`.** The hard floor is the
   real protection and has already done its job once. The sponsor
   (`WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`) held 0.0318 SOL against a
   measured 0.060 SOL/day burn on 2026-07-31, so also re-measure the balance and
   the burn and put the current runway in your report. If it needs SOL, that is
   an owner action of roughly 1 SOL (about 16 days); state it, do not wait on it.
5. **Never top up per-agent wallets.** That strands SOL and kills the rail.
6. **Leave the rail half to work order 02** and say so, rather than reporting
   the settle rate as fixed when only one of the two faults moved.

## Verification

- `GET /api/healthz` `x402_settle` detail, re-read at least 30 minutes after the
  change so the 3h window has moved.
- `GET /api/ops/payment-outcomes` (the panel on `/admin/ops`, documented in
  [docs/ops/payment-outcomes.md](../../docs/ops/payment-outcomes.md)) for
  balance vs floor, measured burn, and runway.
- The reason histogram from step 1, re-run, with `fee_runway_exhausted` down.

## Done when

`x402_settle` is no longer the dominant contributor to the DOWN verdict for the
governor reason, the remaining failures are RPC-shaped only, the runway number
on the payment-outcome board is truthful, and `ISSUES.md` items 6 and 7 are
rewritten to match what you measured (or dropped if closed).
