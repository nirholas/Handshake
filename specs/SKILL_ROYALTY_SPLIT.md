# Skill Royalty Split v1

The rules for dividing a paid skill call between the skill's author and the
platform, and for recording that division.

This is a contract, not a tutorial. Four independent code paths must agree on it
and will drift apart if they each re-derive it: the x402 rail that quotes and
settles a call ([`api/x402/skill-call.js`](../api/x402/skill-call.js)), the
accrual writer ([`api/_lib/skill-royalty.js`](../api/_lib/skill-royalty.js)),
the settle cron ([`api/_lib/royalty.js`](../api/_lib/royalty.js)), and the author
earnings surface (`MonetizationService.getCreatorSalesData`). For the
author-facing guide, read [docs/skill-royalties.md](../docs/skill-royalties.md).

Invariant ids are permanent. A retired id is never reused, so an audit citing
`SR-4` still resolves later.

## Units

All amounts are **USDC atomic units**: integers, 6 decimals, no floats. A price
of $0.25 is `250000`. Arithmetic is exact integer arithmetic; USD figures exist
only for display and for the `numeric(10,6)` ledger columns.

## The split

Given a settled price and a platform rate in basis points:

```
platform = floor(price × platformBps / 10000)
author   = price − platform
```

| Id | Invariant |
|---|---|
| SR-1 | **Conservation.** `author + platform === price` for every input. No value is created or destroyed by the split. |
| SR-2 | **Creator-favoring rounding.** The author's share is the remainder, so the platform absorbs the odd atomic. The author is never rounded down to give the platform a whole unit. |
| SR-3 | **Bounded platform rate.** `platformBps` is clamped to `[0, 5000]`. A misconfiguration can never take more than half of a call. The default is `250` (2.5%), matching the marketplace fee. |
| SR-4 | **No accrual without value.** A split whose author share is `<= 0` writes no ledger row. A free skill (`price_per_call_usd = 0`) is rejected before payment with `409 skill_not_priced`, never accrued as a zero row. |
| SR-5 | **Purity.** The split function touches no database, no network, and no clock. Given the same `(price, platformBps)` it returns the same result forever, which is what makes SR-1 and SR-2 provable in isolation. |

## Attribution

| Id | Invariant |
|---|---|
| SR-6 | The author of record is `marketplace_skills.author_id`, set from the authenticated session at publish time. Nothing in a request can override it. |
| SR-7 | Payouts resolve to that author's **primary** wallet for the settlement chain (`user_wallets.is_primary`, one per `chain_type`). A skill whose author has no wallet for a chain does not advertise that chain. |
| SR-8 | With no routable author wallet at all, the call still settles to the platform receiver. A missing wallet degrades the payout, it never fails the payment or silently drops the call. |
| SR-9 | Solana is advertised first whenever the author can receive on it. Chain order is a platform decision, not a caller's. |

## Accrual

One settled call produces at most one `royalty_ledger` row.

| Id | Invariant |
|---|---|
| SR-10 | Accrual is **fire-and-forget after settlement**. It runs from the `onSettled` hook, never in the request path, and never throws: a ledger failure cannot fail, delay, or reverse a payment that already settled on-chain. |
| SR-11 | The row records the **author's share**, not the gross price. The platform's cut is recorded separately in `platform_fee_usd`. Reading `price_usd` as revenue and subtracting a fee again would double-count. |
| SR-12 | `source` names the rail that earned the row: `x402` (per-call, paid to the author's wallet at settlement) or `skill-runtime` (in-process, settled later). Every consumer distinguishes lanes by this column, never by whether `agent_id` happens to be set. |
| SR-13 | An `x402` row lands `settled` with `settled_at` and the rail's transaction, because the funds have already moved. A `skill-runtime` row lands `pending` and awaits redemption. |
| SR-14 | `agent_id` is **NULL** for every `x402` row: the caller is a paying wallet, not a registered agent. Any query that joins `agent_identities` to read royalties must LEFT JOIN, or it discards the entire per-call lane. |

## Settlement of pending rows

| Id | Invariant |
|---|---|
| SR-15 | The EIP-7710 redeem leg is flag-gated on `SKILL_ROYALTIES_EVM_7710_ENABLED`. With the flag off, settlement is provably inert: pending rows are left untouched and reported as skipped. It never partially redeems. |
| SR-16 | Rows are claimed atomically (`pending → settling`, conditional on still being `pending`) before any redeem. A concurrent pass claiming the same rows gets an empty set, so an on-chain payout runs at most once per row. |
| SR-17 | A claim that lands below the dust threshold is released back to `pending` rather than paid, so a race can never trigger a payout whose gas exceeds its value. |
| SR-18 | A failed redeem marks its claimed rows `failed`, never silently back to `pending`. A failure is visible state, not a retry loop. |
| SR-21 | A row settled by the redeem leg records its chain (`network`, CAIP-2) in the same write as its `tx_hash`. A hash with no chain cannot be resolved to an explorer, and a consumer forced to guess would guess the platform default (Solana) for what is always an EVM redeem. |

## Reporting

| Id | Invariant |
|---|---|
| SR-19 | `pending`, `settling` and `settled` are reported as three separate totals. Collapsing `settling` into either one overstates that total. |
| SR-20 | Both lanes reach the author's earnings surface. An author sees every row where they are `author_user_id`, whether or not they own an agent, because royalties are author-scoped. |

## Test coverage

Each invariant is covered by at least one positive and one negative test. The
suites that prove them:

- [`tests/skill-royalty.test.js`](../tests/skill-royalty.test.js): the split math (SR-1 … SR-5), the accrual writer (SR-10 … SR-13), the flag gate (SR-15), and the claim semantics that make a double payout impossible (SR-16 … SR-18, SR-21).
- [`tests/skill-royalty-earnings.test.js`](../tests/skill-royalty-earnings.test.js): the read side, including the LEFT JOIN regression guard (SR-14) and separated totals (SR-19).
- [`scripts/royalty-proof.mjs`](../scripts/royalty-proof.mjs): an end-to-end proof against a real Postgres, asserting SR-1, SR-4, SR-11, SR-12, SR-13, SR-14 and SR-20 in one run, moving no funds.

## Change control

Changing the split, the rounding direction, the clamp, or the meaning of a
ledger column is a spec change: update the invariant here in the same change,
with tests citing its id. Weakening an invariant needs the same review as the
code that weakens it.
