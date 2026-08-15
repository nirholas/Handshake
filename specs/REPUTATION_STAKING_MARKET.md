# Spec: Reputation Staking Market v1 (`rsm.v1`)

Status: **active**. Contract version: 1. Load-bearing for
`src/shared/reputation-staking.js`, `api/_lib/reputation-market.js`,
`api/reputation/market*.js`, and the `/reputation/market` surface.

This is a contract, not a tutorial (for a walkthrough see
[`docs/reputation-staking-market.md`](../docs/reputation-staking-market.md)). It
pins the wire format of a stake position, the earnings function, and the
settlement rules that every implementation must reproduce bit-for-bit.

The market extends the existing reputation registry rather than replacing it.
Reputation is already attested on Solana as signed SPL-Memo envelopes indexed
into `solana_attestations` (see
[`docs/solana-reputation`](../docs/solana-reputation.md) and
`api/_lib/solana-attestations.js`). `threews.stake.v1` already exists there as a
conviction signal with lamports attached. This spec turns that signal into a
market: escrowed principal, an earnings function derived from the agent's
attested action history, and a withdrawal that returns principal plus earnings.

## 1. Subject and scope

A **subject** is an agent addressed by its Solana asset pubkey, the same
`agent_asset` the attestation index uses. A market is scoped to one `network`.

| Network | Status | Rule |
|---|---|---|
| `devnet` | open | The free proof path. Airdropped lamports, no real value. |
| `mainnet` | owner-gated | Every write refuses unless `REPUTATION_MARKET_ALLOW_MAINNET=1` is set on the service. Enabling it is an owner action, not an agent action. |

The market never signs a stake. A stake is a transaction the **staker** signs
and broadcasts. The market only signs settlements out of its own escrow, and
only on a network the table above permits.

## 2. The escrow account

One system account per deployment, `REPUTATION_MARKET_ESCROW_PUBKEY`, whose
secret key (`REPUTATION_MARKET_ESCROW_SECRET_KEY`, base58 or a JSON byte array)
is held server-side. It holds two disjoint pots:

- **Principal** — the sum of open positions' `principal_lamports`. Never spent
  on anything except returning that exact principal to its own staker.
- **Surplus** — everything above principal, minus a rent-exempt floor. This is
  the reward reserve that funds earnings.

> **Solvency is a hard invariant.** A settlement MUST NOT pay earnings that
> exceed the surplus at settlement time. When the accrued earnings of a
> settlement exceed the available surplus, the payout is clamped to the surplus
> and the settlement records `clamped: true`. Principal is always returned in
> full; it is never at risk from an under-funded reward reserve.

## 3. Wire format

### 3.1 Stake (staker-signed)

One transaction, two instructions, in this order:

1. `SystemProgram.transfer` from the staker to the escrow pubkey.
2. SPL Memo carrying the JSON envelope below.

```json
{
  "v": 1,
  "kind": "threews.stake.v1",
  "market": "rsm.v1",
  "agent": "<agent asset pubkey, base58>",
  "score": 4,
  "escrow": "<escrow pubkey, base58>"
}
```

`score` is the staker's 1-5 conviction rating and keeps `threews.stake.v1`
backward compatible with the pre-market envelope (`api/_lib/solana-attestations.js`
`validatePayload`). `market` and `escrow` are the two fields that make an
envelope a *market* stake rather than a bare conviction memo. An envelope
missing either is still indexed as reputation but is **not** a market position.

A transaction is a valid market stake iff **all** of:

- the memo parses and validates as `threews.stake.v1`;
- `payload.market === "rsm.v1"`;
- `payload.escrow` equals the configured escrow pubkey for the network;
- the escrow's balance delta in that transaction is `>= 1_000_000` lamports
  (`MIN_STAKE_LAMPORTS`, 0.001 SOL);
- the fee payer (the first signer) is not the escrow.

The **principal** is the escrow's balance delta, not the staker's debit. A
staker who pays fees or funds rent in the same transaction stakes only what the
escrow actually received.

The transaction signature is the position id. It is globally unique, so
recording the same stake twice is a no-op.

### 3.2 Unstake (escrow-signed)

One transaction, two instructions:

1. `SystemProgram.transfer` from the escrow back to the staker for
   `principal + earnings`.
2. SPL Memo:

```json
{
  "v": 1,
  "kind": "threews.unstake.v1",
  "market": "rsm.v1",
  "agent": "<agent asset pubkey, base58>",
  "stake": "<stake transaction signature>",
  "principal": "1000000",
  "earnings": "12345"
}
```

`threews.unstake.v1` is a new attestation kind added to `KIND_MAP`. `principal`
and `earnings` are decimal lamport strings (not numbers) so a payout larger than
`Number.MAX_SAFE_INTEGER` survives JSON round-trips.

An unstake envelope is valid iff `stake` is a 64-88 character base58 signature
and `principal` parses as a non-negative integer string.

### 3.3 Effect on the reputation aggregate

A verified `threews.unstake.v1` retires the conviction its `stake` expressed.
`GET /api/agents/solana-reputation` reports **net** stake: the sum of verified,
non-revoked `threews.stake.v1` lamports minus the principal of every verified
`threews.unstake.v1` that names one of them. Withdrawn conviction is not
conviction.

A settlement only retires conviction when its attester is the market escrow of
§2. Settlements are escrow-signed by construction (§3.2), so honouring any
structurally valid unstake memo would let a stranger deflate an agent's standing
with a memo naming somebody else's stake signature. A deployment with no escrow
configured retires nothing and reports the gross figure.

Retirement is applied per stake signature and clamped to that stake's own
principal, so an over-stated `principal` can never consume a different staker's
conviction and net stake can never go negative. Two settlements naming one stake
retire it once, at the larger of the two, never at their sum.

The endpoint reports the retired history alongside the net figure rather than
erasing it: `stake.total_lamports` is net, `stake.gross_lamports` is everything
ever staked, and `stake.retired_lamports` / `stake.retired_count` are what
settlement gave back. `stake.count`, `stake.unique_stakers` and
`stake.top_stakers` all count net conviction, so a fully withdrawn staker is not
listed as backing the agent.

Implemented by `netConviction` in `api/_lib/reputation-market.js`, which is pure
and reproduces this rule without a database (`tests/reputation-net-conviction.test.js`).

## 4. Epochs

An epoch is one UTC day: `epoch = floor(unixSeconds / 86400)`. Epoch `e` spans
`[e * 86400, (e + 1) * 86400)`.

A position accrues over the **overlap** between its open interval
`[openedAt, closedAt|now)` and the epoch. Overlap is measured in seconds and
divided by 86400 to give `epochFraction ∈ [0, 1]`. The epoch in which a position
opens therefore accrues only its fraction of the day; there is no free full-day
credit for a stake placed one second before midnight.

The current epoch accrues in real time. Its earnings are quoted as `pending` and
are recomputed on every read; they are only fixed when a settlement lands.

## 5. The earnings function

All of the following is implemented once, purely, in
`src/shared/reputation-staking.js`, and is the only place these constants exist.

### 5.1 Action weights

The inputs are the agent's verified, non-revoked attestations whose `block_time`
falls in the epoch. Each contributes to `work` or `faults`:

| Attestation | Condition | Contributes |
|---|---|---|
| `threews.accept.v1` | verified | `work += 1.00` |
| `threews.task.v1` | verified | `work += 0.60` |
| `threews.validation.v1` | `payload.passed === true` | `work += 1.00` |
| `threews.feedback.v1` | linked to an accepted task | `work += 0.75` |
| `threews.feedback.v1` | not task-linked | `work += 0.35` |
| `threews.validation.v1` | `payload.passed === false` | `faults += 1.00` |
| `threews.dispute.v1` | verified | `faults += 1.00` |
| `threews.revoke.v1` | verified | `faults += 1.00` |

Stake and unstake attestations contribute nothing. Conviction is not work;
letting stake feed the yield it earns would be a self-referential loop.

### 5.2 Performance

```
quality   = feedbackCount > 0 ? clamp01((meanFeedbackScore - 1) / 4) : 0.5
integrity = work + faults > 0 ? work / (work + 2 * faults) : 1
performance = quality * integrity                       // [0, 1]
agentWeight = performance * log2(1 + work)              // >= 0, unbounded
```

- `quality` maps the 1-5 feedback scale onto [0, 1]. An agent with no feedback
  in the epoch sits at the neutral 0.5 rather than at 0: silence is not a
  negative review.
- `integrity` penalises faults at double the rate work earns, so a failed
  validation costs more than a passed one pays.
- `log2(1 + work)` makes yield concave in activity. Doubling output does not
  double yield, which removes the incentive to spray cheap attestations.
- An agent with zero attested work in an epoch has `agentWeight === 0` and its
  stakers earn nothing that epoch. Staking on an idle agent is free of risk to
  principal and free of return.

Every intermediate value is rounded to 9 decimal places before use so that a
server and a browser computing the same epoch agree exactly.

### 5.3 Distribution

Per epoch, with `pool` the epoch's reward budget in lamports
(`REPUTATION_MARKET_EPOCH_POOL_LAMPORTS`, default `0`):

```
posWeight(p) = principal(p) * epochFraction(p) * agentWeight(agent(p))
total        = Σ posWeight over every position open in the epoch
earnings(p)  = total > 0 ? floor(pool * posWeight(p) / total) : 0
```

The pool is a fixed budget, never a rate, so the market can never owe more than
it holds. Positions on the same agent split that agent's share strictly in
proportion to principal and time. `floor` guarantees `Σ earnings <= pool`; the
remainder stays in the escrow surplus and rolls into the next epoch.

A position's total earnings is the sum over every epoch it overlapped.

### 5.4 Quoted yield

The market surface quotes a **realized** rate, never a projection:

```
apr = principal > 0 && elapsedDays > 0
    ? (earnings / principal) * (365 / elapsedDays)
    : 0
```

Computed from settled and pending earnings that have actually accrued. There is
no forward-looking APY in this market.

## 6. Position lifecycle

```
(none) --stake tx--> open --withdraw--> settling --unstake tx confirmed--> closed
```

| State | Meaning |
|---|---|
| `open` | Principal is in escrow, earnings accrue each epoch. |
| `settling` | A withdrawal is in flight. Set before the payout transaction is signed, so a crash cannot double-pay. |
| `closed` | The unstake transaction confirmed. `closed_at` freezes accrual. |

Rules:

1. Only the staker who opened a position may withdraw it. Ownership is proven by
   the stake transaction's fee payer, not by a session.
2. There is no lockup. A position can be withdrawn in the epoch it opened; it
   accrues that epoch's fraction and no more.
3. Withdrawal is idempotent per position. A second withdrawal of a `closed`
   position returns the original settlement, not a second payout.
4. A position is never slashed. Reputation staking expresses conviction; it does
   not underwrite the agent's losses. Bad conviction is punished by zero yield,
   not by confiscated principal.

## 7. Storage

`api/_lib/migrations/20260811140000_reputation_staking_market.sql` creates:

- `reputation_stake_positions` — one row per stake transaction. `signature` is
  the primary key, so the chain, not the database, defines identity. Carries
  `network`, `agent_asset`, `staker`, `principal_lamports`, `score`,
  `opened_at`, `status`, `closed_at`, `settle_signature`, `earnings_lamports`.
- `reputation_stake_settlements` — one row per payout, keyed by the stake
  signature, recording `principal_lamports`, `earnings_lamports`, `clamped`, the
  per-epoch breakdown as JSONB, and the settlement transaction signature.

The database is an **index, not the ledger**. Every row is derivable by
replaying the chain: `reputation_stake_positions` from `threews.stake.v1`
memos to the escrow, `reputation_stake_settlements` from `threews.unstake.v1`
memos out of it. A reader that distrusts the index can verify any position
against `getTransaction(signature)` alone.

## 8. HTTP surface

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/reputation/market` | GET | none | Agents ranked by net staked conviction, with epoch weight and realized yield. |
| `/api/reputation/market-positions` | GET | none (`staker` query param) | Every position a wallet holds, with pending earnings. |
| `/api/reputation/market-stake` | POST | none | Record a stake transaction the staker already broadcast. Body: `{ signature, network }`. Verification is a chain read; the caller cannot assert a principal. |
| `/api/reputation/market-withdraw` | POST | none | Settle a position. Body: `{ signature, network }`. The payout goes to the staker recorded on-chain, so an attacker calling this for someone else's position only causes that person to be paid. |

Every write refuses on `mainnet` unless the owner gate in §1 is open, with
`code: "mainnet_gated"`.

## 9. Failure codes

| Code | HTTP | Meaning |
|---|---|---|
| `market_not_configured` | 503 | No escrow pubkey configured for the network. |
| `mainnet_gated` | 403 | Mainnet write attempted without the owner gate. |
| `tx_not_found` | 404 | The signature is not on the given network (or not yet confirmed). |
| `not_a_market_stake` | 400 | Memo missing, wrong kind, wrong `market`, or wrong `escrow`. |
| `stake_below_minimum` | 400 | Escrow delta below `MIN_STAKE_LAMPORTS`. |
| `unknown_position` | 404 | No indexed position for that signature. |
| `already_closed` | 200 | Idempotent: returns the original settlement. |
| `escrow_unsigned` | 503 | Escrow secret key not configured, so no payout can be signed. |

## 10. Reference cycle

`scripts/reputation-market-proof.mjs` runs the whole contract against Solana
devnet: fund, stake, verify, accrue against real attested action history,
withdraw, and re-read the chain to confirm the settlement. It is the executable
form of this spec and takes no arguments:

```bash
node scripts/reputation-market-proof.mjs
```

Funding has two rungs, in order: `REPUTATION_MARKET_PROOF_FUNDER_SECRET_KEY` (a
keypair funded once, out of band) and the public devnet faucet. The faucet
rate-limits per source IP, so it is the fallback rather than the contract; a run
from an IP the faucet has cut off is a funding problem, never a statement about
the market itself. When neither rung is available, the same proof runs against a
local `solana-test-validator` with no credentials and no faucet; the docs carry
that command and the two RPC details it depends on.

The attestations the proof writes in step 2 name the agent account AND are
co-signed by it. SPL Memo v3 rejects any account handed to it that did not sign,
while `readActionHistoryFromChain` finds an agent's history through
`getSignaturesForAddress(agentAsset)`, which only returns transactions that
account appears in. Both constraints hold at once only when the agent signs.
