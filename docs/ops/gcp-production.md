# three.ws production on Google Cloud — operations runbook

**This is the complete operational record of the production platform.** If the
machine that performed the migration is gone, this document + `gcloud` access
to the project is everything needed to operate, deploy, debug, and recover the
site. Written 2026-07-07, the day production moved off Vercel (Vercel disabled
the deployment with `402 DEPLOYMENT_DISABLED`; the site was dark until DNS
cutover to Google Cloud the same day).

Related: [server/README.md](../../server/README.md) (the server code itself),
[STRUCTURE.md](../../STRUCTURE.md) (surface map),
[docs/ops/gcp-model-workers.md](gcp-model-workers.md) (the 3D model workers,
which were already on Cloud Run before this migration).

---

## Architecture

```
Namecheap DNS (three.ws)
  A @   → 136.68.246.178      (global static IP: compute address "three-ws-ip")
  A www → 136.68.246.178
        │
Global External Application Load Balancer (EXTERNAL_MANAGED)
  :80  forwarding rule "three-ws-http"  → target-http-proxy  "three-ws-http-proxy"
        → url-map "three-ws-http-redirect" (301 → https)
  :443 forwarding rule "three-ws-https" → target-https-proxy "three-ws-https-proxy"
        → ssl-certificate "three-ws-cert" (Google-managed, three.ws + www.three.ws,
          auto-renews) → url-map "three-ws-lb"
        → backend-service "three-ws-backend" (Cloud CDN ON, cache mode
          USE_ORIGIN_HEADERS)
        → serverless NEG "three-ws-api-neg" (us-central1)
        │
Cloud Run service "three-ws-api" (us-central1, min 0, 2 vCPU / 2 Gi, timeout 900s,
allow-unauthenticated, runtime SA three-ws@…)
  └─ one Express container (server/index.mjs) serving:
       • static frontend from dist/ (baked into the image)
       • the 1,047-rule vercel.json route table (headers/rewrites/redirects/404)
       • all api/** handlers with Vercel-parity filesystem routing
        │
Data layer (unchanged by the migration — all vendor-neutral HTTP):
  Neon Postgres (DATABASE_URL) · Upstash Redis · Cloudflare R2 (S3_* / R2_*)
Cloud Scheduler: 76 jobs (one per vercel.json cron) → GET /api/cron/* with
  `Authorization: Bearer $CRON_SECRET`
```

- **GCP project:** `aerial-vehicle-466722-p5` (billing account "Sperax",
  `01B467-A61905-9A97D2` — the $100k credits pool; owner-confirmed 2026-07-07).
- **Region:** `us-central1` for everything (same as the model workers).
- **Image:** `us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/cloud-run-source-deploy/three-ws-api:latest`

### Production database (verified 2026-07-07)

The DB is **Neon Postgres, not hosted on Vercel** — the migration did not and
could not "move" it; Cloud Run connects to the same instance via `DATABASE_URL`.

- **Production DB:** Neon host `ep-muddy-morning-af1v1xpa-pooler.c-2.us-west-2.aws.neon.tech`
  — the live one, verified holding **344 tables / ~676k rows / 13.7k users /
  13.3k avatars**. This is the value `DATABASE_URL` carries on the Cloud Run
  service (and it was among the few vars the Vercel pull returned non-empty).
- **NOT production:** `ep-rapid-surf-ak9p7occ` (Neon project `wild-river-11025097`)
  appears in old env archives — it is a **stale/smaller copy** (85 tables /
  ~127k rows / 224 avatars). Do not point production at it.
- ⚠️ **DECOMMISSION HAZARD (confirmed 2026-07-08):** this Neon project was
  provisioned via Vercel's Postgres integration. If it's the **Vercel-Managed
  Integration** (billing inside Vercel), Neon's own docs state that deleting
  the database from Vercel's interface **removes the underlying Neon project
  permanently**, and Neon does **not** offer a self-serve transfer for
  Vercel-integrated projects ("projects with Vercel integrations cannot be
  transferred" — [neon.com/docs/manage/orgs-project-transfer](https://neon.com/docs/manage/orgs-project-transfer)).
  There is no dashboard "claim it" button — do not assume one exists.
  Two real paths before the Vercel account is closed:
  1. Open a Neon support ticket asking to detach/transfer `ep-muddy-morning`
     into a standalone (non-Vercel) Neon org — some users have gotten this
     handled manually by support even though it isn't self-serve.
  2. Cut over independently: provision a fresh standalone Postgres (Neon-native
     org or Cloud SQL), restore into it, swap `DATABASE_URL` on the Cloud Run
     service, verify, then let the old Vercel-linked project go.
  - **Safety net taken 2026-07-08:** full `pg_dump -Fc` of `neondb` (344
    tables, 673 MB live / 47 MB compressed) uploaded to Cloudflare R2 at
    `s3://chatty-storage/db-backups/neondb-2026-07-08.dump` — durable, off
    both Neon and Vercel. This is a point-in-time backup for disaster
    recovery, not a replacement for resolving ownership above; retention/
    rotation isn't automated yet.

### Service accounts (IMPORTANT — the project's default compute SA was deleted)

Every build and deploy MUST pin these explicitly or it fails with
"service account does not exist":

- **Build SA:** `three-ws-build@aerial-vehicle-466722-p5.iam.gserviceaccount.com`
  (pass via `--build-service-account` / `serviceAccount:` in cloudbuild.yaml)
- **Runtime SA:** `three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com`
  (pass via `--service-account` on every `gcloud run deploy`)

Known gap: the build SA lacks `roles/run.admin` + `iam.serviceAccountUser` on
the runtime SA, so the **deploy step inside `server/cloudbuild.yaml` fails**;
the build+push steps succeed. Until an owner grants those two roles, finish
deploys from a human-authed CLI (command below).

---

## Deploying

```bash
# Frontend changed? Build first — dist/ ships from the local build.
# build:gcp = site build + agent-3d CDN lib (build:lib:full + publish:lib) +
# check:dist. Plain `npm run build` is NOT enough: it skips the lib publish,
# so /agent-3d/latest/agent-3d.js 404s in prod and the hero avatar dies
# ("agent-3d element never registered").
npm run build:gcp

# Build image on Cloud Build (32-vCPU + BuildKit layer cache) + push + deploy.
# Gated on check:dist AND db:check so an incomplete dist/ or an out-of-date
# database can no longer ship.
npm run deploy:gcp
```

**Database migrations** live in `api/_lib/migrations/*.sql` and are tracked in
the `schema_migrations` table (filename + sha256). Nothing applies them
automatically — the flow is:

```bash
npm run db:status    # dry run: list applied/pending against DATABASE_URL
npm run db:migrate   # apply pending migrations (do this BEFORE deploy:gcp)
npm run db:check     # what deploy:gcp runs: exits 4 if anything is pending
```

- `DATABASE_URL` comes from `.env.local` and must point at the production Neon
  DB (the same value the Cloud Run service uses).
- Never edit a migration file after it has been applied — the runner detects
  the sha256 drift and refuses (exit 3). Roll forward with a new file.
- Apply migrations before deploying the code that needs them: migrations are
  additive, so old code + new schema is safe; new code + old schema is not.

- Lockfile unchanged → layer cache skips the workspace `npm ci`: **~3–5 min**.
- Lockfile changed → full install: **~12 min**.
- If the pipeline's deploy step fails on IAM (see above), deploy the pushed
  image directly:

```bash
gcloud run deploy three-ws-api \
  --image us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/cloud-run-source-deploy/three-ws-api:latest \
  --project aerial-vehicle-466722-p5 --region us-central1 \
  --allow-unauthenticated --memory 2Gi --cpu 2 --timeout 900 \
  --service-account three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com
```

**Rollback (instant):**
```bash
gcloud run revisions list --service three-ws-api --region us-central1 --project aerial-vehicle-466722-p5
gcloud run services update-traffic three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --to-revisions <good-revision>=100
```

**Logs:**
```bash
gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" severity>=ERROR' \
  --project aerial-vehicle-466722-p5 --freshness=1h --limit 20 --format="value(textPayload)"
```

**Build-context gotcha:** the upload is governed by the **allowlist** in
[.gcloudignore](../../.gcloudignore). If a handler starts reading a directory
at runtime that isn't allowlisted, it will be missing from the image — add the
directory there. `animation-sources/` (2.6 GB) is deliberately excluded; the
few endpoints reading it degrade until it moves to object storage.

**Not yet created:** a Cloud Build GitHub trigger (push-to-deploy like Vercel
had). Requires connecting the `nirholas/three.ws` repo in Cloud Build and
adding the vite build into the Docker build. This is Cloud Build's own GitHub
integration — not GitHub Actions, which this repo does not use.

**`/ingest/*` (PostHog proxy):** on Vercel, `vercel.json` routes whose `dest`
is an absolute URL (`/ingest/static/*` → `us-assets.i.posthog.com`, `/ingest/*`
→ `us.i.posthog.com`) were proxied by the platform itself. `server/index.mjs`
now replicates this with its own external-dest middleware (mounted before the
body parsers, so POST event bodies stream through unconsumed) — added
2026-07-07 after prod was serving 404s + a MIME-sniffing block on
`/ingest/static/array.js`. If a future `vercel.json` route gets an
`http(s)://` dest and analytics start 404ing again, check that this
middleware's `phase1Routes` walk still matches it before the API/static
phases.

---

## Crons (Cloud Scheduler)

The 76 schedules in `vercel.json` `crons` are mirrored 1:1 to Cloud Scheduler
jobs in us-central1, named `cron-api-cron-<name>`. All 76 are **ENABLED**
(Vercel's crons died with the deployment, so there is no double-fire risk).

```bash
# Sync after editing crons in vercel.json (idempotent create-or-update):
CRON_SECRET=<value> node scripts/create-gcp-scheduler.mjs --resume

# List / pause / force-run:
gcloud scheduler jobs list --location us-central1 --project aerial-vehicle-466722-p5
gcloud scheduler jobs pause  cron-api-cron-economy-tick --location us-central1 --project aerial-vehicle-466722-p5
gcloud scheduler jobs run    cron-api-cron-uptime-check --location us-central1 --project aerial-vehicle-466722-p5
```

**CRON_SECRET:** was EMPTY on Vercel (every cron guard fail-closed with 503 —
Vercel crons had been silently dead). A real secret was generated 2026-07-07
and set in two places: the Cloud Run service env and every Scheduler job's
Authorization header. **Recover it any time from either place:**

```bash
gcloud scheduler jobs describe cron-api-cron-uptime-check --location us-central1 \
  --project aerial-vehicle-466722-p5 --format="value(httpTarget.headers)"
```

---

## Environment variables

All service env lives on the Cloud Run service (view/edit):

```bash
gcloud run services describe three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --format=yaml | grep -A2 'name:'
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --update-env-vars KEY=value
```

### ⚠️ THE MIGRATION TRAP — read this before trusting any env export

`vercel env pull` silently returns **EMPTY values for secret-type vars** —
144 of 173 keys pulled blank (only integration-injected vars like
`DATABASE_URL` came through). The plaintexts are not retrievable from Vercel
by CLI at all. Consequences and current state:

1. The initial 157-var application contained mostly empty strings.
2. The `S3_*` group + real values for ~90 keys were recovered from the owner's
   own env archives (owner-provided dump, 2026-07-07) and staged as an 89-var
   validated set (deduped, other-project keys pruned, JWKS verified). **If the
   staging machine is lost before application, the set must be rebuilt from
   the owner's archives** — the sources are the owner's saved env dumps; the
   selection rules are: skip `VERCEL*`/`NX_*`/`TURBO_*`/`PG*`/`POSTGRES_*`/
   `NEON_*`/`DATABASE_URL*`/`REDIS_URL`, skip keys not referenced by this
   codebase, last-occurrence-wins on duplicates.
3. Verify state empirically, not from dashboards: an endpoint returning
   `503 {"error":"not_configured"}` means a `Missing required env var: X`
   line in the logs names the exact var.

### Known-missing (blocked on owner)

| What | Vars | Impact | Recovery |
|---|---|---|---|
| Collection authority | `SOLANA_AGENT_COLLECTION_AUTHORITY_KEY` | Agent NFT collection ops can't sign | Intentionally excluded from `scripts/wire-master-wallet.mjs` (on-chain update authority must stay its original wallet). Owner holds the key. |
| R2/S3 storage creds | `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_PUBLIC_DOMAIN` | `/api/marketplace`, `/api/explore`, `/api/avatars/:id` — every route that resolves an asset URL — 503 `not_configured` | Real values already sit in the repo's `.env.local` (never committed). Apply with `scripts/gcp/apply-s3-env.sh` (needs a human-authed `gcloud auth login` first — the 89-var apply is still blocked on reauth per above). |

### Resolved: x402 sponsor co-signing key (2026-07-09)

`/api/healthz` reported `x402.sponsor_cosign: "missing"` and every sponsor-mode
settlement (club-cover, dance-tip) failed with `sponsor_key_unconfigured`.

Root cause: `X402_FEE_PAYER_SOLANA` advertised
`2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4` — a **third-party facilitator's
shared fee-payer account that three.ws has never controlled**, left over from
when Solana settlement went through an external facilitator (see
`ARCHITECTURE.md`). The self-hosted facilitator cannot co-sign for a key it does
not hold, so it 502'd at settle while passing every other health check.

An earlier revision of the table above described that address as a three.ws ring
wallet that "custodies funds — do NOT regenerate." **That was wrong**, and it
would have blocked the correct fix indefinitely. Evidence: the account fee-pays
~200 tx/hour for many unrelated co-signer wallets, none of them involving our
`payTo`, while our own cosign was provably unconfigured. Its balance was never
ours. `scripts/audit-service-wallets.mjs` has always flagged it correctly and
told operators to override the var.

Fix applied:

- Generated a three.ws-controlled sponsor with `scripts/x402-ring-setup.mjs --roles=sponsor`
  (sponsor role **only** — the funded `payTo` treasury was never touched):
  `GGf9qBhJDCe1UUz4s4Vxq1uPPvcv7UW7sJTuj2Yo5XQj`.
- Stored the secret in **Secret Manager** as `x402-fee-payer-secret-base58`
  (granted `roles/secretmanager.secretAccessor` to `three-ws@…`) and wired it as a
  `secretKeyRef`, rather than a plaintext env value on the service. This also
  removes the "secret only exists on whatever machine ran the script" fragility.
- Funded it with 0.05 SOL (floors: `X402_SPONSOR_SOL_FLOOR_LAMPORTS` = 0.02 hard
  refuse-to-settle, 0.03 audit/topup).

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars X402_FEE_PAYER_SOLANA=GGf9qBhJDCe1UUz4s4Vxq1uPPvcv7UW7sJTuj2Yo5XQj \
  --update-secrets X402_FEE_PAYER_SECRET_BASE58=x402-fee-payer-secret-base58:latest
```

Verified by a real $0.01 USDC mainnet sponsor-mode settlement through
`POST /api/x402-facilitator/settle` (tx
`5rmLnLUmWK7jJCjP6RJPLmwT2oiifQMmTnQmhoQKeZcVogxnTMvxB77fpb5BqMyV6VzbawXdPgWz2N7C5kXqqbQ5`):
the sponsor signed as fee payer, paid the 10001-lamport fee, and $0.01 landed in
`payTo`. `sponsor_cosign` now reports `ready`.

### Resolved: Upstash Redis + full signer wiring (2026-07-09, same day, later)

Owner supplied the Upstash database and the wallet secrets. Applied on revision
`three-ws-api-00029-c45`:

- **Upstash Redis live**: `UPSTASH_REDIS_REST_URL` (plaintext) +
  `UPSTASH_REDIS_REST_TOKEN` (Secret Manager `upstash-redis-rest-token`).
  `X402_ALLOW_MEMORY_FALLBACK` **removed** per the escape-hatch's own
  instructions. healthz cache backend now reports `upstash healthy`; money
  limiters rate-limit for real instead of failing closed.
- **Signer slots wired** per `scripts/wire-master-wallet.mjs` ASSIGNMENTS, from
  the three economy wallets (`wwwww…ccrU` x402 loop, `wwwqv…HGUn` SOL engines,
  `WwwuGbq…3WwW` treasury face). Secrets live in Secret Manager
  (`wallet-x402-treasury-b58/b64`, `wallet-sol-engines-b58/b64`,
  `wallet-economy-master-b58/b64`) as `secretKeyRef`s — no longer only on one
  machine. `ECONOMY_MASTER_SECRET_BASE58`, `X402_TREASURY_SECRET_BASE58`,
  `X402_SEED_SOLANA_SECRET_BASE58`, `A2A_PAYER_SOLANA_SECRET` were concurrently
  set (same wallets) by another session and left as-is.
  `LAUNCHER_MASTER_SECRET_KEY_B64` deviates from the map (deployed on
  `X4o2…astML`, map says `wwwqv`) — left deployed value; `LABOR_ESCROW` skipped
  per the script's own live-funds guard.
- **Proof, full user path** (not just the facilitator): real paid calls through
  the live endpoints returned 200 + product content —
  club-cover $0.01 (tx `54FQ4rAFjfgF9b5pDRCB5dnhWNoTK7RrvJm2EJAuNGQDiMAPcLGptXpWzdBys49KHEASH7JrKb8sHL3AFwZT36gF`, pass issued)
  and dance-tip $0.001 (tx `2hSvvR17hpawE1ZjhgHisaEpRzYkh6jyWtWBgsoCKAhunQkhcUCfQQ49aY2QmfsCYNBaMpvVTxSBfky5t7tstUZ6`, thriller ticket).
  `scripts/audit-service-wallets.mjs` against the live revision: **all checked
  wallets configured, funded, and consistent** (14/15 signers; only the
  intentionally-excluded collection authority remains).

| What | Vars | Impact | Recovery |
|---|---|---|---|
| OKX X Layer facilitator creds | `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` (or, as a no-OKX-account fallback, `X402_XLAYER_RELAYER_KEY`) | `xlayerSettleable()` (`api/_lib/x402-xlayer-okx.js`) is false without one of these, so **no 402 challenge on any endpoint advertises the `eip155:196` (X Layer) rail** — confirmed live 2026-07-08 via `/api/okx/3d/health` (`payment-rail.settleable:false, facilitator_configured:false`) and by inspecting the raw 402 `accepts[]` on `/api/okx/3d/identity-studio` and `/api/okx/3d/pose-seed` (Solana + Base only, no X Layer entry). `X402_PAY_TO_XLAYER` and `X402_ASSET_ADDRESS_XLAYER` **are** set in prod — this is the only missing piece. This is the exact rail OKX's listing review requires (agent #2632 rejection reason); the relisting (`prompts/okx-ai/05-relisting-resubmission.md`) cannot proceed until it's live. | OKX Web3 developer console (owner) for the three real creds, or generate `X402_XLAYER_RELAYER_KEY` as a fresh EVM keypair + fund it with OKB gas as a stopgap that needs no OKX account. |

---

## DNS / TLS / CDN

- Registrar + DNS: **Namecheap** (nameservers `registrar-servers.com`).
  Web records: `A @ → 136.68.246.178`, `A www → 136.68.246.178`. Everything
  else there (privy/world CNAMEs, TXT/DKIM) is mail/verification — untouched
  by the migration.
- TLS: Google-managed cert `three-ws-cert` (three.ws, www.three.ws) — went
  ACTIVE 2026-07-07 ~18:40 UTC, auto-renews. Status:
  `gcloud compute ssl-certificates describe three-ws-cert --global --project aerial-vehicle-466722-p5`
- CDN: Cloud CDN on `three-ws-backend`, `USE_ORIGIN_HEADERS` — the vercel.json
  asset rule (7-day cache on glb/png/woff2/…) is what the CDN honors.
- The Cloud Run URL `https://three-ws-api-lp642k3kpa-uc.a.run.app` serves the
  identical site and bypasses the LB — useful for isolating LB vs service
  issues.

---

## Verifying after any change

```bash
B=https://three.ws
for p in / /3d /changelog /api/healthz /api/feed /api/explore?limit=4; do
  curl -s -m 25 -o /dev/null -w "%{http_code}  $p\n" "$B$p"; done
curl -s -o /dev/null -w "%{http_code} → %{redirect_url}\n" http://three.ws/   # expect 301 → https
```

`/api/healthz` is designed to stay green through dependency outages — read its
JSON body (x402 block, monitor block) for subsystem truth.

---

## What Vercel still holds (decommission checklist)

- The project + its env vars (plaintexts unreadable, but delete only after the
  ring secrets question is settled — the dashboard may still be useful to a
  human with owner access).
- `@vercel/og` remains a code dependency (runs fine on Cloud Run — plain Node).
- `vercel.json` is now a **live config file consumed by server/index.mjs**
  (routes + crons) — do NOT delete it as "Vercel leftovers".
- The `deploy` npm script still points at Vercel; superseded by `deploy:gcp`.
