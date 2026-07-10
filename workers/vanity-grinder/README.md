# vanity-grinder (batch) — premium inventory producer

Grinds long, brandable Solana vanity addresses **ahead of time** on cheap batch
CPU (GCP spot), so the platform can sell them from stock instantly via the
premium tier (`/api/x402/vanity-premium`). The live `vanity_grinder` MCP tool and
`/api/x402/vanity` still grind a fresh ≤3‑char keypair per request — this is the
separate 4–5+‑char sell-from-stock lane.

It runs the exact same Rust/ed25519 WASM engine as the serverless grinder
(`src/solana/vanity/wasm`), one worker per vCPU, and — critically — **seals every
found key in-process before any write**. Plaintext keys never touch disk, a log,
or the network.

## What it does

1. Loads a **target list** (brandable prefixes/suffixes — see `targets.mjs`, or
   supply `TARGETS_FILE`). Every pattern is brand-neutral (commit-gate safe).
2. Grinds each target to completion across all cores.
3. For each hit: computes rarity + a difficulty-scaled price
   (`api/_lib/vanity-inventory-pricing.js`), **seals** the keypair
   (`api/_lib/vanity-vault.js` → AES‑256‑GCM, or a GCP‑KMS envelope when
   `VANITY_KMS_KEY` is set), and writes the **ciphertext** to an encrypted JSONL
   and/or straight into the `vanity_inventory` table (`WRITE_DB=1`).
4. Checkpoints completed targets so it is **resumable** — a spot preemption
   (SIGTERM) flushes and exits; the next run skips finished targets.

## Run locally

```bash
# from the repo root
export WALLET_ENCRYPTION_KEY=…            # required (or set VANITY_KMS_KEY)
export JWT_SECRET=…                       # secret-box reads it as a decrypt fallback
node workers/vanity-grinder/grind.mjs     # grinds the built-in target list
```

Output: encrypted `workers/vanity-grinder/out/inventory.jsonl` + `summary.json`
(throughput). Load it into the DB later with
`node scripts/vanity-inventory-load.mjs --file <inventory.jsonl>`.

### Useful env

| var | default | meaning |
|-----|---------|---------|
| `WALLET_ENCRYPTION_KEY` | — | secret-box master key (required unless KMS) |
| `VANITY_KMS_KEY` | — | KMS crypto-key resource → envelope encryption |
| `TARGETS_FILE` | built-in | JSON array of `{prefix?,suffix?,ignoreCase}` |
| `INCLUDE_5` | `0` | include slow 5‑char stretch targets |
| `IGNORE_CASE` | `0` | fold case on prefix targets (≈½ difficulty/char) |
| `MAX_FOUND` | ∞ | stop after N addresses |
| `WORKERS` | all vCPUs | worker thread count |
| `RETENTION_DAYS` | `0` | ciphertext retention after reveal (0 = delete-on-reveal) |
| `WRITE_DB` | `0` | `1` to upsert into `vanity_inventory` (needs `DATABASE_URL`) |
| `SHARD_INDEX`/`SHARD_COUNT` | `0`/`1` | partition targets across parallel instances |

## Build the image

```bash
# build context MUST be the repo root
docker build -f workers/vanity-grinder/Dockerfile -t vanity-grinder .
docker run --rm -e WALLET_ENCRYPTION_KEY=… -e JWT_SECRET=… -e MAX_FOUND=20 \
  -v "$PWD/out:/tmp" vanity-grinder
```

## Deploy to GCP spot CPU

Two supported runners; pick per the trade-off (see `docs/ops/gcp-credits.md`):

- **Cloud Run Job** (simplest, recommended) — `scripts/gcp/vanity-grind-deploy.sh`
  builds + pushes the image and creates a spot-billed Job you execute on demand.
  Write straight to Neon with `WRITE_DB=1` for durable output.
- **GCE spot MIG** (max cores/$ for very large runs) — the same script's
  `--mig` mode; each instance takes a `SHARD_INDEX` of the target list.

KMS envelope encryption (recommended for production inventory) is provisioned by
`scripts/gcp/vanity-kms-setup.sh`, which creates the keyring/key and grants
decrypt **only** to the delivery service identity.

## Security

- Keys are sealed **before** the first write; the DB and JSONL hold ciphertext
  only. A dump reveals no spendable key.
- Nothing in this worker logs secret material — the only "found" log line is the
  public address + attempt count.
- Single-use delivery + delete-after-reveal are enforced downstream in
  `api/_lib/vanity-inventory-store.js` / `api/x402/vanity-premium.js`.
- See the threat model in `docs/ops/gcp-credits.md` (§ Premium vanity inventory).
