# Stranded custodial wallets: the standing owner decision

Some custodial Solana wallets on three.ws are sealed under an encryption key the
platform no longer holds. Their SOL is visible on chain, keeps rendering in the
product, and can never be signed for again. Two of those wallets belong to
customers who cannot withdraw.

This is the decision brief. It carries the measurement, why recovery is
impossible, what each option costs, and the exact commands for whichever option
the owner picks. It does not move money: crediting, contacting, or writing off a
customer balance is the owner's call.

The incident that created them is recorded in
[wallet-key-migration.md](wallet-key-migration.md). This file is the standing
decision that incident left open.

## What happened

The 2026-07 Vercel to Cloud Run migration rotated `WALLET_ENCRYPTION_KEY`. Every
custodial secret written under the retired value became permanently unopenable
the moment the new key went live, because nothing kept a copy of the old one.

`api/_lib/secret-box.js` has since gained a retired-key read path
(`WALLET_ENCRYPTION_KEY_PREVIOUS`, comma separated, tried newest first, and a
legacy `JWT_SECRET` candidate for v1 records). That path works. It has nothing to
put in it:

- Secret Manager holds exactly ONE version of `WALLET_ENCRYPTION_KEY`, created on
  migration day. There is no prior version to roll back to.
- The migration-era `JWT_SECRET` and the current one were both tried against the
  sealed ciphertext during the 2026-07 investigation. Neither decrypted.
- AES-GCM authenticates, so there is no "try harder" path: a wrong key throws
  rather than returning plausible-but-wrong material. There is no brute force
  worth attempting against a >=32-character master secret.

Recovery is therefore not slow or expensive. It is impossible. The only open
questions are what we owe the affected customers and what we do with the
platform's own sealed dust.

## Measured state

Re-derive before acting. On a machine with the production key:

```bash
node scripts/audit-custodial-key-health.mjs            # human table
node scripts/audit-custodial-key-health.mjs --json     # same numbers, machine readable
```

The script exits 3 without touching the database when no decryption key is
configured, because a keyless run can only report 100% undecryptable and says
nothing about production. The same measurement is served continuously at
`GET /api/ops/payment-outcomes` under `stranded_custody` (see
[payment-outcomes.md](payment-outcomes.md)), so an operator without the key can
still read the current count from the running service.

### Platform wallets (measured 2026-09-02, live)

These two are confirmed sealed by production itself: the treasury-topup reclaim
leg has attempted them on every run and recorded `secret_undecryptable` in
`economy_master_ledger` 35,736 and 35,739 times respectively, most recently
2026-09-02.

| Agent | Agent id | Address | SOL on chain | Owner |
|---|---|---|---|---|
| Atlas #22 | `00bf4380-a6dd-4693-80d3-52bf23a8855b` | `6FL9viFy2WrYMWPd3HAQA4Bxm5qxQWoQMn3T9GbcwxEB` | 0.078390963 | `ashaatlas2@agents.three.ws` (platform bot) |
| Echo #22 | `73da6b13-223a-481e-ab4c-4c293a462d62` | `8u5raEaz7Qjm5hRzNxwzXiZtjTkdgQ3Co6G6S5WNxFTs` | 0.064484542 | `zaneecho4@agents.three.ws` (platform bot) |

Platform total: **0.142875505 SOL**. This is the number the treasury dry run used
to advertise as reclaimable; it no longer does (see "What was already fixed").

### Customer wallets (support obligation)

The last keyed audit (2026-08-09, recorded in
[wallet-key-migration.md](wallet-key-migration.md)) measured **8 sealed wallets
holding 0.49 SOL, of which 0.35 SOL belongs to customers**. One of those customer
agents is confirmed independently by production: it hit the withdraw path and
`agent_custody_events` recorded `wallet_key_retired` against it.

Both funded customer wallets are now named. The keyed audit was run against
production on 2026-09-04 (`node scripts/audit-custodial-key-health.mjs --json`,
read-only, key pulled from Secret Manager and never written to disk), which
resolved the second one this table previously left blank.

| Agent | Agent id | Address | SOL on chain (2026-09-04) | Owner |
|---|---|---|---|---|
| My First Agent | `5e05f68f-eead-4ef9-b6b4-fc85ea73bbe9` | `GemVS5fT958FKRe5fpgizohUYUKE8cUDueEdmB1bmXnm` | 0.250001 | `sol-240f8dec53dc5d72@wallet.local` (wallet-auth customer) |
| Swarm Treasury (test) | `a20829e1-6dd7-4495-9141-8f5d69be86a9` | `HPL1LfuTdYDwtzJDzsnrmR2ngrrQwLTQyxJszCC4DHsN` | 0.100001 | `sol-4ac625e9b4d3ff8e@wallet.local` (wallet-auth customer) |

Customer total: **0.350002 SOL**, across exactly **two** accounts. That is the
whole support obligation: two people, two destinations, one decision.

The 2026-09-04 sweep covered 735 custodial wallets and found 9 undecryptable (up
one from the 8 measured 2026-08-09, because the sealed set grows only when an old
record is newly touched, never because a new wallet is written under a dead key).
Seven of the nine are customer wallets, but five of those hold nothing: only the
two above carry a balance. The platform's own two are unchanged at 0.142875505
SOL. `stranded_unread` is empty, so nothing is unaccounted for.

Re-running the audit needs `WALLET_ENCRYPTION_KEY` from the `three-ws-api`
service (`node scripts/read-service-env.mjs '^WALLET_ENCRYPTION_KEY$' --raw`).
That is the only step in this brief that needs the key, and it is read-only. The
decision below does not wait on it: the table above is the measurement.

### What the customer sees today

Not a silent lie, as of the 2026-08 fixes: `GET /api/agents/:id/solana-wallet`
attempts a local decrypt on the owner's own read and returns
`signable: false, signable_reason: "key_retired"` beside the balance, and a
withdrawal attempt answers `409 wallet_key_retired` telling the owner that no
funds moved, that retrying will not help, and to contact support before creating a
replacement wallet (provisioning a new one abandons the balance at the old
address). Nobody is being invited to retry forever. Nobody has been made whole
either.

## The options

| Option | What it costs | What it settles |
|---|---|---|
| **1. Credit the customers from treasury** (recommended) | About 0.35 SOL from the economy master, plus the transfer fees. At the SOL price this is a rounding error against the fee wallet's daily burn. | Ends the obligation completely and quietly. The customer is whole, the balance they see becomes real again, and no support conversation is needed. |
| **2. Contact the customers first, then credit** | The same 0.35 SOL plus the support round trip. Both accounts are wallet-auth (`*@wallet.local`), so there is no email address on file: contact means an in-product notice, not a mail. | Same outcome as option 1, slower, and it advertises an internal key incident to a user who may not have noticed. |
| **3. Write the balance off** | Zero SOL. Costs the customer 0.35 SOL of their own money and leaves a permanently unspendable balance rendering in their wallet card. | Nothing. The wallet card keeps showing an amount that cannot move; the obligation stays open indefinitely. |

Recommendation: **option 1**. The amount is trivial against the treasury, it is
our defect rather than the customer's, and the alternative leaves a broken balance
on screen forever. The 2026-07 precedent supports it in spirit: when the same
rotation stranded 12 platform pool wallets holding 1.41 SOL, that money was
written off because it was ours to lose. Customer money is not.

### If the owner picks option 1 (credit)

Crediting is a fund transfer, so it stops at gate 1 in `CLAUDE.md`: recipient,
amount, and chain get rendered and confirmed before anything signs. The wallets
themselves cannot receive a "restore" (they cannot be signed for, so a deposit
into them is a second write-off). Credit the customer's OTHER agent wallet, or a
destination the customer names.

1. Confirm the current stranded set and its owners:
   ```bash
   node scripts/audit-custodial-key-health.mjs --json \
     | jq '{customer_sol: .sol.stranded_customer, wallets: [.top_stranded[] | select(.platform == false)]}'
   ```
2. For each affected user, pick the destination: another custodial agent wallet
   they own, or an address they supply. Never the sealed address.
3. Send from the economy master with the standard confirmation table (recipient,
   amount, token, chain) and the owner's explicit yes, per gate 1.
4. Record it: append the credit to [wallet-key-migration.md](wallet-key-migration.md)
   under the incident's timeline so the ledger and the incident record agree.

### If the owner picks option 3 (write-off)

Nothing needs to run. The wallets stay sealed and the product already tells the
owner they are unsignable. Note the decision in
[wallet-key-migration.md](wallet-key-migration.md) and delete the OWNER-ACTIONS
row so the question stops being re-litigated.

### The platform's own 0.14 SOL, either way

No decision needed: it is already gone, and nothing plans against it any more.
Leave the two bot wallets alone. Do NOT re-key them with
`scripts/rekey-stale-launch-wallets.mjs`: that script refuses a wallet holding
more than 0.01 SOL for a reason (`409 wallet_funds_stranded`), and forcing it
with `--force-drop-funds` abandons the balance at the old address for nothing.

## What was already fixed, so nobody re-diagnoses it

- **The treasury dry run no longer advertises sealed SOL.** `reclaimIdleAgentSol()`
  in `api/_lib/economy-sweepback.js` used to return its plan before ever touching
  a key, so `POST /api/cron/treasury-topup?dry=1` promised about 0.12 SOL that the
  real leg could never move. Two separate sessions read that plan and concluded the
  treasury would self-heal. The dry path now runs the same read-only key recovery
  the real path does: sealed wallets are excluded from `reclaimedSol` and reported
  in `failed` with `stage: "recover"` and a `secret_undecryptable` reason.
  Pinned by `tests/economy-reclaim-dryrun-key-gate.test.js`.
- **The wallet card and the withdraw path tell the truth** (`signable: false`,
  `409 wallet_key_retired`), as described above.
- **The audit refuses to guess.** A wallet whose balance was not read is never
  counted as a confirmed zero, and a keyless run aborts instead of reporting a
  fleet-wide phantom.
- **The number is visible without a CLI run.** `stranded_custody` on
  `/api/ops/payment-outcomes` carries count, SOL, and the platform/customer split,
  snapshot-cached for six hours.

## Preventing the next one

The rotation runbook in [wallet-key-migration.md](wallet-key-migration.md) is the
procedure: set `WALLET_ENCRYPTION_KEY_PREVIOUS` to the outgoing key BEFORE the new
key goes live, keep it there until an audit run reports zero undecryptable
wallets, and only then drop it. A rotation without that overlap is a one-way door,
and this brief is what the far side of one looks like.
