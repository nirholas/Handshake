# Incident: stranded pool-agent wallets after the WALLET_ENCRYPTION_KEY migration

Date range: keys introduced 2026-06-19, pool agents created 2026-06-26, migration to
Cloud Run 2026-07-07, diagnosed + resolved 2026-07-12.

## What happened

Custodial Solana wallets for the pump.fun launch-pool agents (`launcher_queue`, scope
`global`) are encrypted at rest with `WALLET_ENCRYPTION_KEY` (AES-256-GCM, `secret-box.js`).
The pool agents were created 2026-06-26, after the key scheme (introduced 2026-06-19) and
its production guard (added 2026-06-21, which requires a dedicated ≥32-char key and refuses
the `JWT_SECRET` fallback) were both already active — so those 12 wallets were sealed under
a dedicated key that existed only in the pre-migration Vercel runtime.

The 2026-07-07 Vercel → Cloud Run migration did not carry that key forward. Cloud Run's
Secret Manager `WALLET_ENCRYPTION_KEY` has only one version, created on the migration date
itself — a newly generated key, not the one the pool wallets were encrypted under. Every
autonomous launch attempt against those 12 wallets failed with a definitive AES-GCM
`OperationError` (auth-tag mismatch — proof of a wrong key, not a transient fault).

## Recovery attempt

Searched every place the pre-migration key could plausibly still exist:

- GCP Secret Manager — `WALLET_ENCRYPTION_KEY` and `JWT_SECRET`, all versions: only the
  2026-07-07 (post-migration) version exists for either.
- Vercel env (CLI export) — `WALLET_ENCRYPTION_KEY` was not present at all (never set, or
  deleted); `JWT_SECRET` was present but exported empty.
- Owner-supplied candidates (current deploy key, one manually recalled value) — both tried
  against the stranded wallets' ciphertext; neither decrypted.
- Prior scratch/staging notes from the migration itself — only the current key.

No copy of the pre-migration key was recoverable from any automated source. It exists only
in the pre-July-7 Vercel runtime's own secret store (source data, not exported as
plaintext) or a personal backup outside this codebase, and the owner did not have one on
hand.

## Fund-safety guard (shipped before any wallet was touched)

Before re-keying anything, a fail-closed guard went into `loadAgentForSigning`
(`api/_lib/agent-pumpfun.js`): on a definitive decrypt failure (`isUnrecoverableSecret`),
it checks the stranded wallet's on-chain SOL balance via public RPC before doing anything
else.

- Balance **read fails** (RPC error) → refuse to touch the wallet, return `503
  stale_balance_unverified`. Never mistake "can't check" for "empty."
- Balance **> 0.01 SOL** → refuse to re-key, return `409 wallet_funds_stranded` with the
  address and balance, so it surfaces for manual recovery instead of silently vanishing.
- Balance **≤ 0.01 SOL** (dust or empty) → safe to self-heal: mint a fresh wallet under the
  current key, keep the dead address in `meta.stale_solana_address` for the audit trail.

Same logic in the batch tool, `scripts/rekey-stale-launch-wallets.mjs`: dry-run by default,
skips any wallet holding more than dust unless `--force-drop-funds` is passed explicitly.
Covered by `tests/agent-wallet-rekey-guard.test.js` (4 cases) and
`tests/economy-rebalance.test.js`.

## Outcome

Total stranded across the 12 pool wallets: **1.41 SOL**, confirmed unrecoverable — no valid
key exists in any system this platform controls. The owner made the call to abandon that
balance (it cannot be spent or moved without the retired key regardless) and re-key the
pool so autonomous launches resume. `scripts/rekey-stale-launch-wallets.mjs --apply
--force-drop-funds` was run once that decision was made: every undecryptable wallet was
re-provisioned under the current `WALLET_ENCRYPTION_KEY`, the dead address preserved in
`meta.stale_solana_address` on each row, and wallets that already decrypted correctly were
left untouched.

## Takeaways

- **A key rotation must carry the old key forward, or accompany a sweep.** If
  `WALLET_ENCRYPTION_KEY` (or any at-rest secret key) is ever rotated again, either export
  and archive the retiring key somewhere durable first, or run a sweep of every custodial
  wallet under it *before* rotating — not after.
- **Fail closed beats fail silent.** The guard added here refuses to re-key a wallet it
  can't prove is empty. That property should hold for any future self-heal that touches
  custodial secrets.
- Launcher stayed paused (`launcher_config.mode = 'off'`) for the full diagnosis so nothing
  new could get stranded while the key search was underway.

## Related

- [Autonomous economy](../autonomous-economy.md) — the funding-root → engine loop this
  pool feeds.
- `api/_lib/agent-pumpfun.js` — the self-heal + fund-safety guard.
- `scripts/rekey-stale-launch-wallets.mjs` — the batch re-key tool.
