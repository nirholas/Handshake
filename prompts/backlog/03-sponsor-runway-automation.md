# 03. Sponsor runway: measure it, alert on it, let it self-heal

Read [00-INDEX.md](00-INDEX.md) first. Run [01](01-x402-settle-runway.md) before
this one: a widened fee budget changes the burn this work order measures.

## What is wrong

The x402 sponsor wallet (`WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`, the fee
payer for platform settles) runs close to its floor. The last measurement put it
at 0.0318 SOL against a 0.03 floor with a measured burn of 0.060 SOL/day: roughly
half a day of runway. The number is already computed and rendered by
`GET /api/ops/payment-outcomes` and the "Payment outcomes" panel on `/admin/ops`
(see [docs/ops/payment-outcomes.md](../../docs/ops/payment-outcomes.md)), but
nothing acts on it and nothing warns before it bites.

The failure mode this creates is not a clean outage. Below the floor,
`sponsorKnownBelowFloor()` makes `buildRequirements()` in
`api/_lib/x402-paid-endpoint.js` **withdraw the Solana accept from every 402
challenge**, so the Solana-only ring never attempts a payment and there is nothing
to reject. Settlements collapse while rail faults stay flat, which is the exact
opposite of what a reader expects, and the whole thing is invisible unless you
look at the accepts:

```sh
curl -s https://three.ws/api/x402/three-intel | jq '.accepts[].network'
# only eip155:8453 means the Solana accept has been withdrawn
```

## The work

1. **Publish the runway where a human will see it before it hurts.** The panel
   exists; the alert does not. Wire a threshold alert (days of runway below N,
   default 3) into the existing alerting path, with a message that names the
   wallet, the balance, the floor, the measured burn, and the computed days. Do
   not interpolate the template into its own source text: the bridge-down alert
   shipped exactly that bug and logged its own template instead of the numbers.

2. **Measure burn from data, never from memory.** Derive it from `fee_lamports`
   over successful settles across a 7-day window. Recorded burn has been quoted at
   10x reality in past triage notes; the alert must carry its own measurement and
   the window it covers.

3. **Close the invisible-failure gap.** Add the withdrawn-Solana-accept condition
   as a first-class degraded reason on the settle sensor, distinct from a rail
   fault, so the outward symptom ("settlements fell, faults flat") maps to the
   right cause without a human remembering this document.

4. **Make reclaim observable.** `reclaimIdleAgentSol` writes **no ledger row on
   failure** (unlike the engine leg's `inflow_failed`), so a failing reclaim is
   invisible. Write a row on failure with the reason. The audit trail that proves
   whether the send loop ran at all is `usage_events` where `tool='economy_reclaim'`.

## Funding is an owner decision, not your call

At the measured burn, roughly 1 SOL covers about 16 days. Render the numbers and
ask; do not move funds yourself. Any transfer is stop-and-ask gate 1. **Never top
up per-agent wallets:** that strands SOL in wallets that do not pay fees and kills
the rail. Top-ups go to the master or the sponsor only.

## Verify

```sh
# Runway panel, authenticated (ops secret or admin session)
curl -s -H "x-ops-secret: $OPS_SECRET" https://three.ws/api/ops/payment-outcomes

# The accepts probe: both networks present means the Solana accept is live
curl -s https://three.ws/api/x402/three-intel | jq '.accepts[].network'

npm run gate
```

## Definition of done

- [ ] A runway alert fires below the configured threshold and its message contains
      real interpolated numbers, proven by a test over the formatter.
- [ ] Burn is computed from `fee_lamports` over a stated window and the window is
      shown next to the number.
- [ ] The settle sensor distinguishes `sponsor_floor` from `rail` causes.
- [ ] A failed agent reclaim writes a ledger row naming the reason.
- [ ] `docs/ops/payment-outcomes.md` updated to describe the alert and thresholds.
- [ ] `data/changelog.json` entry (tag: `infra`), `npm run gate` green.
