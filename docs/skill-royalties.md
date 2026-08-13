# Skill royalties: authors earn per call

Publish a skill to the three.ws marketplace, put a price on it, and you get paid
every time someone calls it. Not per install, not per month: per call. This page
explains where the money comes from, how it is split, where you watch it land,
and how to verify a payout on-chain yourself.

If you just want the short version: price your skill, add a Solana wallet, and
your share of every paid call routes straight to that wallet at settlement.
Watch it arrive in [Creator Studio](/dashboard/creator).

---

## The two ways a paid skill earns

A priced skill can be reached down two different paths, and both credit the same
author ledger.

**1. The per-call x402 rail (live, Solana first).**
`GET /api/x402/skill-call?skill=<slug>` is a paid endpoint. Any wallet, agent, or
script can call it: the first request answers `402 Payment Required` with a quote
equal to that skill's `price_per_call_usd`, the caller pays in USDC, and the
response carries the skill's tool schema and content so the caller can run it.

There is no re-access grant. Unlike a buy-once asset download, every invocation
is a fresh payment, which is what "per call" actually means.

The payment does not route to the platform and then get forwarded to you later.
The 402 challenge names *your* wallet as the payee, so USDC moves from the caller
to you as part of settlement. Solana is advertised first whenever you have a
Solana wallet, because Solana is the platform's home chain.

**2. In-app calls through the skill runtime.**
When an agent inside three.ws invokes your paid skill, the runtime bills it
against the agent's spending delegation instead of a fresh 402 handshake. Those
accruals land as `pending` and settle later through the delegated-permission
redeem leg described in [Activation](#activation-owner-gated) below.

| | Per-call x402 rail | In-app runtime |
| --- | --- | --- |
| Caller | Any paying wallet | An agent on three.ws |
| Ledger `source` | `x402` | `skill-runtime` |
| Lands as | `settled` (money already moved) | `pending` |
| Chain | Solana first, Base second | EVM, behind a flag |
| Status | Live | Accrual live, settlement owner-gated |

---

## What you keep

The platform takes a small share of each paid call and you keep the rest. The
default is **250 basis points (2.5%)**, matching the marketplace fee, and it is
set by `X402_SKILL_ROYALTY_PLATFORM_BPS`. It is clamped to a maximum of 5000 bps
in code, so a configuration mistake can never take more than half of a call.

The split is exact integer arithmetic on USDC atomic units (6 decimals):

```
platform = floor(price × platformBps / 10000)
author   = price − platform
```

Two properties matter and both are enforced by tests:

- **Nothing is created or lost.** `author + platform === price`, for every input.
- **Rounding favors the creator.** The platform absorbs the odd atomic, never you.

A $0.25 call at the default rate splits to **$0.243750 to the author** and
**$0.006250 to the platform**.

The math lives in `computeSkillRoyaltySplit`
([api/_lib/skill-royalty.js](../api/_lib/skill-royalty.js)) and is pure: no
database, no chain access, so the invariants are provable in isolation.

---

## Where you watch it

**[Creator Studio](/dashboard/creator)** is the author's cockpit. The royalty
ledger panel lists every accrual newest first, with:

- the skill that earned it and which rail it came from,
- the settlement chain, named (never a raw CAIP-2 id),
- the amount, linked to the block explorer when the row has a settlement
  transaction, so you can verify your own payout instead of trusting the table,
- pending / settling / settled / failed totals, and a CSV export carrying the
  full provenance at USDC's real 6-decimal precision.

You do **not** need an agent to see this. Royalties are author-scoped: if you
published a skill and it is earning, Creator Studio shows you the money even if
you never created an agent.

**`GET /api/users/me/earnings`** is the same data as JSON, for the signed-in
author. It returns `pending_usd`, `settling_usd`, `settled_usd`,
`platform_fee_usd`, and an `entries` array where each royalty entry carries
`source`, `network`, `tx_hash`, and `platform_fee_usd` alongside the amount.

> Use `/api/users/me/earnings`, not `/api/users/earnings`. The bare path is
> swallowed by the `/api/users/:id` catch-all and answers "user not found" for a
> user literally named `earnings`.

---

## Attribution: whose skill is it

A skill's author is `marketplace_skills.author_id`, set from the authenticated
session at publish time. It is returned by `/api/skills` and `/api/skills/:id`
as `author: { id, display_name }`, and it is the only thing that decides who
gets paid.

Payouts resolve to that author's **primary** wallet per chain
(`user_wallets.is_primary`), one for Solana and one for EVM. Consequences worth
knowing:

- **No wallet, no direct routing.** A skill whose author has no linked wallet
  still sells; the payment falls back to the platform receiver. Link a wallet
  before you price a skill.
- **Only the chains you can receive on are advertised.** If you have a Solana
  wallet and no EVM wallet, the 402 challenge offers Solana only.
- A skill with no author at all (a platform seed) collects to the platform.

---

## Proving it works without moving money

`scripts/royalty-proof.mjs` runs the whole accounting path against a real
Postgres and moves no funds. It runs the shipping code, not a re-implementation:
the same split function, the same accrual writer, and the same service call that
backs `/api/users/me/earnings`.

It refuses to run without an explicit throwaway database, so it can never write
proof rows into real creator earnings, and it deletes everything it seeded on the
way out.

The driver in `api/_lib/db.js` speaks Neon's HTTP protocol rather than raw
Postgres TCP, so a local run puts a Neon HTTP proxy in front of Postgres:

```bash
docker run -d --name royalty-pg \
  -e POSTGRES_PASSWORD=example -e POSTGRES_DB=threews -p 55433:5432 postgres:16-alpine
docker network create royalty-net
docker network connect royalty-net royalty-pg
docker run -d --name royalty-proxy --network royalty-net -p 54331:4444 \
  -e PG_CONNECTION_STRING="postgres://postgres:example@royalty-pg:5432/threews" \
  ghcr.io/timowilhelm/local-neon-http-proxy:main

# Load the schema plus the migrations the ledger path needs.
docker cp api/_lib/schema.sql royalty-pg:/schema.sql
docker exec royalty-pg psql -U postgres -d threews -f /schema.sql
for m in 2026-04-30-agent-monetization.sql \
         20260619000000_royalty_settling_status.sql \
         20260812120000_skill_call_royalties.sql; do
  docker cp "api/_lib/migrations/$m" royalty-pg:/m.sql
  docker exec royalty-pg psql -U postgres -d threews -f /m.sql
done

ROYALTY_PROOF_DATABASE_URL="postgres://postgres:example@localhost:54331/threews" \
ROYALTY_PROOF_FETCH_ENDPOINT="http://localhost:54331/sql" \
  node scripts/royalty-proof.mjs
```

It seeds an author and a priced skill, accrues one settled call on the Solana
rail, and asserts the split conserves value, the ledger row credits the author
share (not the gross), the platform cut is recorded, the row is tagged to the
x402 rail with its chain and payer, the accrual reaches the earnings surface with
its provenance intact, and a free skill accrues nothing. Exit code 0 means every
check passed.

The settlement fields it supplies are tagged `PROOF-LANE-NOT-A-REAL-SETTLEMENT`
so a proof row can never be mistaken for a real payment.

---

## Activation (owner-gated)

The per-call x402 rail is live: accruals happen on real settled payments today,
and the money reaches authors at settle time because the payee is their own
wallet.

The **in-app runtime lane settles through EIP-7710 delegated permissions**, and
that leg is deliberately inert until switched on:

| Variable | Default | Effect |
| --- | --- | --- |
| `SKILL_ROYALTIES_EVM_7710_ENABLED` | `false` | With it off, `settleRoyalties` and the daily `settle-royalties` cron leave pending rows untouched and report `skipped: evm_7710_disabled`. Nothing redeems, nothing pays. |
| `X402_SKILL_ROYALTY_PLATFORM_BPS` | `250` | The platform's share of a per-call payment, in basis points. Clamped to 5000. |

Turning the EVM leg on means real USDC starts moving on a schedule. Before
flipping it, confirm: the relayer behind `/api/permissions/redeem` is funded on
each chain in play, agents have `active`, unexpired delegations, and authors have
a primary EVM wallet on the matching chain. A group whose redeem fails is marked
`failed` rather than retried blindly, and rows are claimed atomically
(`pending → settling`) so two concurrent passes can never pay the same accrual
twice.

The cron (`/api/cron/settle-royalties`, daily at 03:00 UTC) only settles authors
whose pending balance clears $0.01, so nobody pays gas to move dust.

---

## Related

- [Skills marketplace](./skills.md): publishing, pricing, and installing skills
- [x402 endpoints](./x402-endpoints.md): every paid endpoint and who each one pays
- [Money map](./money-map.md): how value moves across the whole platform
- [Remix royalties](./remix.md): the parallel royalty rail for 3D creations
