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

## The mechanism that makes the next rotation survivable (2026-08-01)

The takeaway below ("carry the old key forward") had no mechanism behind it, so it was a
rule a human had to remember at exactly the moment they were busy migrating hosts. It is
now enforced by the code.

`WALLET_ENCRYPTION_KEY_PREVIOUS` holds retired keys, newest first, comma or whitespace
separated. `secret-box.js` tries the current dedicated key, then every retired key, then
`JWT_SECRET`, for both v2 and legacy v1 ciphertexts. **Encryption is unchanged**: new
writes always use the current key, so a rotation upgrades records as they are rewritten and
a retired key can be dropped once an audit shows nothing opens with it.

Rotating safely is now three steps:

```sh
# 1. Keep the outgoing key readable BEFORE the new one takes over.
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars WALLET_ENCRYPTION_KEY_PREVIOUS=<the outgoing key>

# 2. Rotate.
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars WALLET_ENCRYPTION_KEY=<the new key>

# 3. Confirm nothing is stranded, then (later) drop the retired key.
node scripts/audit-custodial-key-health.mjs
```

Never `--set-env-vars` here: it replaces the entire environment set. Covered by
`tests/secret-box.test.js` (retired-key read, stacked rotations, and a case proving new
writes never use a retired key).

**What this does not do:** it cannot recover the keys already lost. A re-measure on
2026-08-01 (`scripts/audit-custodial-key-health.mjs`) found 8 of 565 custodial wallets
still unopenable, holding **0.49 SOL, of which 0.35 SOL is customer money** in two
user-owned agents. Those users cannot withdraw. Re-keying a customer wallet would abandon
their balance, so that decision is the owner's, not an agent's.

## Still stranded, and a blind spot in how we knew that (2026-08-09)

A production triage sweep hit this incident again from a new angle: `treasury-topup`'s
live agent-reclaim leg tried to sweep two platform pool wallets (Atlas #22, Echo #22,
both created 2026-06-26, the same batch as the original 12) that showed real balances
(0.068 and 0.054 SOL) and failed with `secret_undecryptable` on both. Same root cause,
same unresolved batch, not a new incident.

What was new: `scripts/audit-custodial-key-health.mjs`, run locally in this codespace at
the same time, reported "0 SOL stranded" for the whole fleet, flatly contradicting the
live reclaim failure. The audit was wrong for two independent reasons, both now fixed:

1. It hit exactly one hardcoded `SOLANA_RPC_URL` lane (`rpc.magicblock.app`) with no
   fallback. That lane returned `403 Forbidden` for this caller's IP, so every balance
   read failed. The script now uses `solanaConnection()` from
   `api/_lib/solana/connection.js`, the same rotating multi-lane connection production
   reads balances through, so one blocked or rate-limited lane no longer blinds the
   whole audit.
2. Worse, an unread balance was silently summed as zero (`balances.get(addr) || 0`), so
   a total RPC failure printed a confident "SOL stranded: 0" instead of "unknown." The
   script now tracks reads with `balances.has()` and refuses to print a stranded total
   while any undecryptable wallet's balance is unconfirmed; `scripts/gcp-triage.mjs`'s
   `custodial-keys` probe carries the same guard, so the deep sweep no longer reports
   `ok` off an unread balance either.

A third blind spot of the same family closed on 2026-09-02: the audit needs a
decryption key of its own, and it had no idea whether it had one. Run in a shell with
no `WALLET_ENCRYPTION_KEY` (a fresh clone, or this codespace, whose `.env.local`
carries only `DATABASE_URL`), it decrypted nothing, reported **725 of 725 wallets
undecryptable and 8.57 SOL stranded**, and printed the customer-escalation banner. Every
number was an artifact of the missing key, not a measurement of production. The script now
calls `secretBoxKeyCandidates()` before it touches the database and aborts with exit 3 and
the places to find the key when the candidate list is empty, and when a key IS configured
but opens nothing at all it says a fleet-wide 100% failure is one wrong key rather than a
mass incident. Reading a stranded verdict off a keyless run is no longer possible.

With the fix, the audit reads correctly again: **8 undecryptable wallets, 0.49 SOL
stranded (0.35 SOL customer, 0.14 SOL platform)**, matching the 2026-08-01 measurement
almost exactly. Nothing changed in the underlying incident: the customer-fund decision
documented above (re-keying abandons the balance; that call is the owner's) is still
open, and no funds were moved.

## Where the wallet secrets live now, and how to rotate one (2026-09-02)

The incident above is about a key we could not read any more. This section is about the
opposite failure: a key that was readable by too many people.

`ECONOMY_MASTER_SECRET_BASE58` is the base58 secret key of the economy master wallet
(`WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`), the funding root every other Solana
engine is topped up from (`api/_lib/economy-master.js`, cron `api/cron/treasury-topup.js`).
It sat on the `three-ws-api` Cloud Run service as a **plaintext literal**, so any principal
holding `run.services.get` on `aerial-vehicle-466722-p5` could read the private key of a
funded mainnet wallet straight out of the service config, without ever touching Secret
Manager. It is now a `secretKeyRef`.

### The end state

| | |
|---|---|
| Secret | `wallet-economy-master-b58` (it already held this exact value, so no new version was minted) |
| Reference | `ECONOMY_MASTER_SECRET_BASE58 = wallet-economy-master-b58:latest` |
| Who can read it | `three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com`, granted `roles/secretmanager.secretAccessor` **on that one secret**, never project-wide |
| Landed on | revision `three-ws-api-00405-z6c`, 100% of traffic |

Read the current state at any time with `node scripts/migrate-plaintext-secrets.mjs --verify`.

### The tool, and the Cloud Run gotcha it encodes

`scripts/migrate-plaintext-secrets.mjs` does the whole move: it classifies every env var on
the service, reuses the Secret Manager secret that already holds a value rather than minting
a second copy of it, grants the runtime service account access to that one secret, flips the
service in a single update, and then re-reads the service to prove no plaintext literal
survived and that the new revision serves 100% of traffic. It is a dry run unless you pass
`--apply`, and it never prints, logs, or writes a secret value.

The gotcha it exists to encode: **Cloud Run refuses to retype an env var in place.** An
update that only sets `--update-secrets` on a name that is currently a literal fails with

```
Cannot update environment variable [X] to the given type because it has already been set with a different type.
```

The literal has to be dropped in the SAME update (`--remove-env-vars X --update-secrets
X=<secret>:latest`), which lands as one revision, so the variable is never missing from a
serving container. Two separate updates would ship a revision with the var absent.

### Adding a new version of an existing secret

```sh
# Never pass a secret as a CLI argument; feed it on stdin.
printf %s "<the new value>" | gcloud secrets versions add wallet-economy-master-b58 \
  --data-file=- --project aerial-vehicle-466722-p5
```

The service points at `:latest`, so a new version takes effect on the **next revision**, not
immediately. Force one with a config-only update:

```sh
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-secrets ECONOMY_MASTER_SECRET_BASE58=wallet-economy-master-b58:latest
```

### Rotating the master wallet (owner-gated, do not run unattended)

Migrating storage is config work. **Rotating is not**: it generates a new keypair and moves
real mainnet SOL, which is CLAUDE.md stop-and-ask gate 1. An agent prepares this and stops;
the owner runs it, or explicitly approves each transfer.

The old value was a plaintext literal for some window, so it should be treated as exposed to
everyone who has held project viewer access in that period. Whether that warrants a rotation
is a judgment call about who those principals are: it is logged as an owner decision in
`prompts/finish/production-100-OWNER-ACTIONS.md`.

If the owner decides to rotate:

```sh
# 1. Generate the new keypair OFFLINE and keep a durable copy. Nothing here reads
#    it back later: a secret version's value is unreadable to anyone without the
#    accessor role, and a lost key is a stranded wallet (see the top of this file).
solana-keygen new --no-bip39-passphrase --outfile new-master.json
solana-keygen pubkey new-master.json          # the address funds will move TO

# 2. Fund the new wallet and drain the old one. OWNER-GATED, every transfer
#    confirmed individually: this is real mainnet SOL leaving a funded wallet.
#    Leave the old wallet enough SOL to pay its own transaction fees.

# 3. Publish the new secret as a version of the SAME secret, so nothing else has
#    to be re-pointed.
printf %s "<new base58 secret>" | gcloud secrets versions add wallet-economy-master-b58 \
  --data-file=- --project aerial-vehicle-466722-p5

# 4. Update the advertised address in the same update as the new revision, so the
#    key and the address it derives to never disagree on a serving container.
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars ECONOMY_MASTER_ADDRESS=<new pubkey> \
  --update-secrets ECONOMY_MASTER_SECRET_BASE58=wallet-economy-master-b58:latest

# 5. Prove the new key is the one production signs with: the treasury sweep writes
#    a heartbeat row to economy_master_ledger on every run, carrying the pubkey it
#    derived from the loaded secret.
node --env-file=.env.local -e "import('./api/_lib/db.js').then(async(m)=>{const sql=m.sql||m.default;\
  console.log(await sql\`select ts,event,master_pubkey from economy_master_ledger order by ts desc limit 3\`);process.exit(0)})"

# 6. Only once step 5 shows the NEW pubkey and the old wallet is empty, disable the
#    old version so a rollback cannot silently resurrect a drained wallet.
gcloud secrets versions disable <old version number> --secret=wallet-economy-master-b58 \
  --project aerial-vehicle-466722-p5
```

Never `--set-env-vars` in any of these: it replaces the whole environment set.

### Verifying a migration did not break anything

Storage moves are invisible until they are not, so both readings below are taken against the
live site, not assumed:

1. **`/api/healthz` before and after.** Compare the `subsystems` block entry by entry. A
   fresh revision resets in-process counters (RPC quota cooldowns, uptime), so expect those
   to move; what must not move is a subsystem going from `ok` to `degraded` or `down`.
2. **A real signing path.** For the master wallet that is the treasury sweep: a row in
   `economy_master_ledger` timestamped after the new revision's `creationTimestamp`, carrying
   the master's pubkey, proves the container read the secret, decoded 64 bytes, and derived
   the right wallet. On 2026-09-02 revision `three-ws-api-00405-z6c` was created at
   `19:15:17Z` and the ledger kept writing through `19:25:23Z` under
   `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`.

If a migration does regress the service, roll traffic back first and diagnose after:

```sh
gcloud run services update-traffic three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --to-revisions <prior revision>=100
```

## Takeaways

- **A key rotation must carry the old key forward, or accompany a sweep.** This is now
  mechanized: set `WALLET_ENCRYPTION_KEY_PREVIOUS` before rotating (see the section above).
  Archiving the retiring key durably is still worth doing, but forgetting it no longer
  destroys custody on its own.
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
- `scripts/audit-custodial-key-health.mjs`: read-only sweep of every custodial wallet,
  how many still decrypt, how much SOL sits behind the ones that do not, and which
  addresses they are. Needs `DATABASE_URL` and `WALLET_ENCRYPTION_KEY`; it exits 3 rather
  than reporting a stranded total when no decryption key is configured.
