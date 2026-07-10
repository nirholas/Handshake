# Task 02 — The life engine (autonomous citizens)

**Goal:** Build `workers/agora-citizens` — the heartbeat that makes Agora *alive*.
N real agents, registered on devnet AgenC, run the **daily loop** on their own
cadence: discover work → claim it on-chain → do real work → submit a real proof →
earn → reputation climbs → idle. Every transition is a real on-chain action,
projected into `agora_citizens` / `agora_activity` and the live feed. This task
ships the loop end-to-end with **one** real profession (**Fetcher** — calls an
x402/HTTP service and proves the result). More professions come in Task 04.

**Depends on:** Task 01 (tables applied, SDK importable).

## Context to read first
- `docs/agora.md` (§ The daily loop, § The on-chain economy) and `00-INDEX.md`.
- `examples/agenc-task-roundtrip/run.mjs` — **the proven reference.** Your loop is
  a generalization of this. Reuse its keypair-cache + airdrop-backoff approach.
- `solana-agent-sdk/src/actions/agenc/*` — the write SDK you'll call.
- `api/_lib/migrations/20260629020000_agora_world.sql` — exact columns to project.
- `workers/agent-mm/` (`index.js`, `engine.js`, `config.js`, `store.js`,
  `Dockerfile`, `cloudbuild.yaml`) — the worker structure/deploy pattern to mirror.
- `api/_lib/feed.js` — `publishFeedEvent` + `ALLOWED_TYPES` (you'll extend it).

## Background
AgenC agents have a `capabilities` u64 bitmap, a slashable stake, an endpoint, and
on-chain `reputation`. A task carries `requiredCapabilities`, `minReputation`, a
reward (SOL on devnet; $THREE SPL mint on mainnet), `maxWorkers`, a deadline, and a
type. Completion submits a 32-byte `proofHash` + 64-byte `resultData`. The engine
is a long-running Node process (Cloud Run, like `agent-mm`). Workers run outside
`api/`, so use a local `neon(process.env.DATABASE_URL)` client and the public feed
via a small direct Redis write **or** by POSTing an internal endpoint — prefer a
direct `@neondatabase/serverless` + `ioredis`/Upstash client mirroring
`api/_lib/redis.js` config, so the worker shares the same `feed:events` bus.

## Build (scope)
1. **Roster + identity.** A config (`workers/agora-citizens/roster.js`) of citizen
   definitions: `{ label, professionBits, displayName, homeDistrict }`. Derive each
   citizen's canonical AgenC id from its label via the identity bridge
   (`toAgenCAgentId` / `getCanonicalThreewsAgenCId`). Cache devnet keypairs under
   `.cache/` (gitignored) exactly like the roundtrip. **Seed citizens from real
   platform agents** where possible: if `agent_identities` rows exist, prefer
   linking those (set `agora_citizens.agent_id`); otherwise create standalone
   agent citizens. Never invent a human citizen here.
2. **Register on AgenC (idempotent).** For each citizen: ensure devnet balance
   (airdrop-with-backoff), `registerAgenCAgent` if not already registered, with the
   profession bitmap + a real `endpoint` (`https://three.ws/agora/citizens/<id>`)
   + `metadataUri` from `buildThreewsMetadataUri`. Upsert the `agora_citizens` row
   (`agenc_agent_id`, `agenc_agent_pda`, `agenc_cluster='devnet'`,
   `capability_bits`, `identity_source`, `status`). Project a `registered`
   activity row + an `agora-registered` feed event.
3. **The daily loop** (`engine.js`), one tick per citizen on a jittered interval:
   - **IDLE → SEEK:** read the board (`GET /api/agora/board` or the AgenC bridge
     directly). Pick an open task whose `requiredCapabilities` ⊆ my `capability_bits`
     and whose `minReputation ≤ my reputation`. For a Fetcher, an x402 service from
     the bazaar lane is valid work. If nothing matches, stay idle (and, if Task 03
     is present, optionally post a sub-task).
   - **CLAIM:** `claimAgenCTask` on-chain → set citizen `status='busy'`, project
     `claimed_task` (+ feed). (For an x402-only job with no on-chain task, skip the
     claim and proceed to work — record it as a `paid_service` activity instead.)
   - **WORK (Fetcher):** actually call the service/URL. For an x402 paid service,
     perform the real x402 pay-and-fetch (USDC) using the platform x402 client; for
     a free HTTP resource, fetch it. Capture the response bytes.
   - **PROVE:** `proofHash = sha256(canonical(result))`; `completeAgenCTask` with
     the proof + a 64-byte `resultData` (a CID/short pointer). Project
     `completed_task` + `earned` (+ feed), update citizen `reputation`,
     `tasks_completed`, `earned_three_atomic` (devnet: track SOL/synthetic; label
     mainnet rewards as `$THREE`). Set `status='idle'`.
   - Persist last-known position; jitter the next tick.
4. **Resilience.** Every on-chain call wrapped with retry/backoff; a single
   citizen's failure never halts the fleet. Reconcile on restart from on-chain
   state (don't double-project — the `agora_activity_tx_uniq` index enforces it).
   Honour a `AGORA_MAX_CITIZENS` / dry-run env for safe local runs.
5. **Feed types.** Add `agora-registered`, `agora-task-claimed`,
   `agora-task-completed`, `agora-earned` to `ALLOWED_TYPES` in `api/_lib/feed.js`
   (document each in that file's header comment like the existing ones).
6. **Deploy shell.** `Dockerfile` + `cloudbuild.yaml` mirroring `agent-mm`, plus a
   `README.md` (env vars, how to run one tick locally, how to scale citizen count).

## Out of scope
Posting bounties / agent-to-agent hiring (Task 03). Sculptor/Scribe/Verifier work
(Task 04). Any 3D/UI. Mainnet $THREE escrow (devnet only here).

## Contracts
- New: `workers/agora-citizens/{index.js,engine.js,roster.js,config.js,store.js,
  work/fetcher.js,Dockerfile,cloudbuild.yaml,README.md,package.json}`.
- Writes: `agora_citizens` (upsert per citizen), `agora_activity` (append, cite
  `tx_signature`/`task_pda`), `feed:events` (new Agora types).
- Reads: `/api/agora/board` or the AgenC bridge; on-chain via `@three-ws/solana-agent`.
- Env: `DATABASE_URL`, `AGENC_DEVNET_RPC_URL` (optional), `REDIS_URL`/Upstash creds,
  `AGORA_MAX_CITIZENS`, `AGORA_DRY_RUN`.

## Definition of Done
- [ ] Running the engine against devnet registers ≥3 citizens on AgenC and
  produces **real** completed tasks — paste Solana Explorer tx URLs for a
  register, a claim, and a complete.
- [ ] After a run, `/api/agora/citizens` shows those citizens with non-empty
  `agenc.agentPda`; `/api/agora/pulse` shows non-zero population + recent
  narration; `/api/agora/passport?id=…` shows their activity with real
  `txSignature`s.
- [ ] Every `agora_activity` row cites a real action; re-running the engine does
  **not** duplicate rows (idempotency holds).
- [ ] A forced single-citizen failure (e.g. bad RPC) is retried and does not stop
  the others.
- [ ] New feed types render in the site-wide ticker (`/api/feed`).
- [ ] No fake data, no `setTimeout` progress, no hardcoded results.

## Verification
```bash
cd workers/agora-citizens
AGORA_DRY_RUN=1 node index.js           # one tick, no writes — inspect the plan
node index.js                            # real devnet run (funded keypairs)
# then:
curl -s localhost:3000/api/agora/pulse
curl -s "localhost:3000/api/agora/passport?agentId=<hex>"
```
Confirm tx signatures on `https://explorer.solana.com/?cluster=devnet`.

## Guardrails
- **No real non-$THREE mint** in code/tests — devnet reward = SOL or a synthetic
  placeholder; mainnet reward label = `$THREE`.
- `.cache/` keypairs are gitignored; never commit a secret key.
- Worker is a long-running process — bound memory, jitter ticks, respect faucet
  rate limits.
- Push to `threews` only; **changelog: yes** (user-visible — "agents now live and work
  on-chain in Agora"), added after deploy.
