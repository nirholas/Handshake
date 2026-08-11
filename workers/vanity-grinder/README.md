# vanity-grinder (batch): premium inventory producer

Grinds long, brandable Solana vanity addresses **ahead of time** on cheap batch
CPU (GCP spot), so the platform can sell them from stock instantly via the
premium tier (`/api/x402/vanity-premium`). The live `vanity_grinder` MCP tool and
`/api/x402/vanity` still grind a fresh keypair per request, but only up to
`MAX_SERVER_PATTERN_LENGTH` (3 chars, `src/solana/vanity/grinder-node.js`). This
worker is the separate 4 to 5 char sell-from-stock lane.

It runs the exact same Rust/ed25519 WASM engine as the serverless grinder
(`src/solana/vanity/wasm`), one worker thread per vCPU, and, critically, **seals
every found key in-process before any write**. Plaintext keys never touch disk, a
log, or the network.

## What it does

1. Loads a **target list** (brandable prefixes/suffixes, see `targets.mjs`, or
   supply `TARGETS_FILE`). Every pattern is brand-neutral (commit-gate safe).
2. Grinds each target to completion across all cores. A target that survives
   `MAX_ATTEMPTS_PER_TARGET` tries is abandoned permanently, so an unreachable
   Base58 pattern can never pin a worker forever.
3. For each hit: computes rarity + a difficulty-scaled price
   (`api/_lib/vanity-inventory-pricing.js`), **seals** the keypair
   (`api/_lib/vanity-vault.js`, AES-256-GCM, or a GCP-KMS envelope when
   `VANITY_KMS_KEY` is set), and writes the **ciphertext** to an encrypted JSONL
   and/or straight into the `vanity_inventory` table (`WRITE_DB=1`).
4. Checkpoints completed targets so it is **resumable** (see below).

## Resume, and why it has two layers

A spot task is disposable, and its filesystem goes with it. So the worker resumes
from two independent sources:

- **The checkpoint file** (`CHECKPOINT_FILE`) records the targets this container
  finished. Enough for a local run or a MIG VM with a persistent disk.
- **The inventory table** (`WRITE_DB=1`) is consulted at startup for every pattern
  that still has stock, and those targets are skipped. This is the only state that
  survives a Cloud Run task, whose checkpoint lives in a per-task `/tmp`. A
  pattern that has since sold out is deliberately *not* skipped: re-grinding it is
  exactly what the replenish cron wants.

Two things wind a run down cleanly, both writing the checkpoint and the summary
and exiting 0:

- **SIGTERM**, the spot preemption signal, which arrives about 30s before the
  shutdown.
- **`MAX_RUNTIME_SEC`**, a self-imposed wall-clock budget. Set it below the
  platform's task timeout so a long shard finishes as a *successful* execution
  instead of being killed mid-grind and reported as a failure. The deploy script
  sets it to `TASK_TIMEOUT - 300` automatically.

An interrupted target simply restarts from scratch next run. A random search has
no resumable inner state, so the expected work is unchanged.

## Run locally

```bash
# from the repo root
export WALLET_ENCRYPTION_KEY=…            # required (or set VANITY_KMS_KEY)
node workers/vanity-grinder/grind.mjs     # grinds the built-in target list
```

Output: encrypted `workers/vanity-grinder/out/inventory.jsonl` + `summary.json`
(throughput). Load it into the DB later with
`node scripts/vanity-inventory-load.mjs --file <inventory.jsonl>`, or inspect the
shelf with `node scripts/vanity-inventory-load.mjs --stats`.

To try it without waiting on the real target list, point `TARGETS_FILE` at a few
one-char patterns; every one lands inside a single WASM batch:

```bash
echo '[{"prefix":"A"},{"suffix":"z"},{"prefix":"b","ignoreCase":true}]' > /tmp/targets.json
WALLET_ENCRYPTION_KEY=…  TARGETS_FILE=/tmp/targets.json \
  OUTPUT_FILE=/tmp/inventory.jsonl CHECKPOINT_FILE=/tmp/checkpoint.json \
  SUMMARY_FILE=/tmp/summary.json node workers/vanity-grinder/grind.mjs
```

### Useful env

| var | default | meaning |
|-----|---------|---------|
| `WALLET_ENCRYPTION_KEY` | none | secret-box master key, 32+ chars (required unless KMS) |
| `VANITY_KMS_KEY` | none | KMS crypto-key resource, switches on envelope encryption |
| `JWT_SECRET` | none | optional; only a legacy decrypt candidate for pre-dedicated-key records |
| `TARGETS_FILE` | built-in | JSON array of `{prefix?,suffix?,ignoreCase}` |
| `OUTPUT_FILE` / `CHECKPOINT_FILE` / `SUMMARY_FILE` | `./out/*` | run artifacts |
| `INCLUDE_5` | `0` | include slow 5-char stretch targets |
| `IGNORE_CASE` | `0` | fold case on prefix targets (about half the difficulty per char) |
| `MAX_FOUND` | unlimited | stop after N addresses |
| `MAX_RUNTIME_SEC` | `0` (no budget) | wind down cleanly after N seconds and exit 0 |
| `MAX_ATTEMPTS_PER_TARGET` | `200000000` | give up on one target after N tries |
| `WORKERS` | all vCPUs | worker thread count |
| `RETENTION_DAYS` | `0` | ciphertext retention after reveal (0 = delete-on-reveal) |
| `BATCH_LABEL` | timestamped | label stamped on every record from this run |
| `RUNNER` | `local` | `local` / `cloud-run-job` / `gce-spot-mig` |
| `WRITE_DB` | `0` | `1` to upsert into `vanity_inventory` (needs `DATABASE_URL`) |
| `SHARD_INDEX` / `SHARD_COUNT` | `0` / `1` | partition targets across parallel instances |

## Sharding

`SHARD_COUNT` splits the target list; each instance grinds `i % SHARD_COUNT ===
SHARD_INDEX`. The index is resolved in this order:

1. An explicit `SHARD_INDEX`.
2. `CLOUD_RUN_TASK_INDEX`, which Cloud Run Jobs set on every task.
3. On `RUNNER=gce-spot-mig`, this VM's position in its own managed instance
   group, read from the GCE metadata server plus `listManagedInstances`
   (`gce-shard.mjs`). A MIG hands its VMs identical container-env and randomly
   suffixed names, so without this every VM would grind shard 0. Needs
   `roles/compute.viewer` on the grinder service account; the deploy script grants
   it. If the listing is unreachable the VM falls back to a stable hash of its own
   instance name, which still spreads the group across shards.

## Build the image

```bash
# build context MUST be the repo root, so ../../src and ../../api resolve
docker build -f workers/vanity-grinder/Dockerfile -t vanity-grinder .
docker run --rm -e WALLET_ENCRYPTION_KEY=… -e MAX_FOUND=20 \
  -v "$PWD/out:/tmp" vanity-grinder
```

`Dockerfile.dockerignore` scopes the build context to the four directories the
image actually copies. Without it a local build streams roughly 2.5 GB of `dist/`,
`public/` and `dist-lib/` into the daemon and dies on memory before it reaches the
first `COPY`.

## Deploy to GCP spot CPU

`scripts/gcp/vanity-grind-deploy.sh` builds and pushes the image and provisions
one of two runners (see `docs/ops/gcp-credits.md`):

- **Cloud Run Job** (default, recommended): a spot-billed Job you execute on
  demand. `--tasks` sets the shard count. Write straight to Neon with `WRITE_DB=1`
  for durable output.
- **GCE spot MIG** (`--mig`, max cores per dollar for very large runs): each VM
  resolves its own shard as described above.

KMS envelope encryption (recommended for production inventory) is provisioned by
`scripts/gcp/vanity-kms-setup.sh`, which creates the keyring/key and grants
decrypt **only** to the delivery service identity.

### What is running today

A Cloud Run Job named `vanity-grinder` is deployed in `us-central1` on project
`aerial-vehicle-466722-p5`: 4 tasks x 4 vCPU, spot-labelled, `WRITE_DB=1`,
`INCLUDE_5=1`, `IGNORE_CASE=1`, sealing under the `three-vanity/inventory-secrets`
KMS key. It is **not** on a schedule. `/api/cron/vanity-inventory-replenish` fires
an execution when the shelf drops below `VANITY_INVENTORY_LOW_WATERMARK` items or
`VANITY_INVENTORY_MIN_TIERS` distinct rarity tiers, and pages ops with the manual
command when the job trigger is not configured. To run it by hand:

```bash
gcloud run jobs execute vanity-grinder --region us-central1 \
  --project aerial-vehicle-466722-p5
```

## Tests

- `tests/vanity-grinder-batch.test.js` drives the real `grind.mjs` end to end:
  ciphertext-only output, the sealed record opening back to a keypair that signs
  for the ground address, resume, and shard partitioning.
- `tests/vanity-wasm-grinder.test.js` covers the grind loop itself (prefix match,
  signature validity, stop signal, exhaustion).
- `tests/vanity-premium-inventory.test.js` covers the sell side.

## Security

- Keys are sealed **before** the first write; the DB and JSONL hold ciphertext
  only. A dump reveals no spendable key.
- Nothing in this worker logs secret material. The only "found" log line is the
  public address plus an attempt count.
- The run refuses to start if it cannot seal (a preflight `sealSecret` call), so
  it never grinds keys it would have to drop or store in the clear.
- Single-use delivery and delete-after-reveal are enforced downstream in
  `api/_lib/vanity-inventory-store.js` / `api/x402/vanity-premium.js`.
- See the threat model in `docs/ops/gcp-credits.md` (section "Premium vanity
  inventory"), including the honest caveat about project owners and KMS.
