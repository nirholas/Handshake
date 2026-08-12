# GCP model workers — the self-host generation lanes

three.ws runs open 3D models on our **own** Google Cloud Run GPU workers, against
the project's GCP credits. These self-host lanes are the resilient default for
`/api/forge`: every generation we can serve on our own hardware costs no vendor
money and carries no BYOK dependency. This runbook covers what is deployed, the
env that wires it in, how routing picks a lane, and how to (re)start a worker.

> Scope: routing + operations for the **forge** generation lanes. The avatar
> reconstruction pipeline (controller + the `model-rig` auto-rigger) is documented in
> `workers/deploy/README.md`; only its shared bearer secret overlaps here.

---

## The workers

Each model runs as its own Cloud Run service (NVIDIA L4 GPU, `us-central1`),
built and deployed from `workers/<dir>/cloudbuild.yaml`. They all speak the same
task shape — `POST /<endpoint> → { task_id }`, `GET /tasks/:id → { status,
result_* }` — and authenticate with one shared bearer secret.

| Lane (`backend` id) | Worker dir            | Cloud Run service  | Path served | What it does |
|---------------------|-----------------------|--------------------|-------------|--------------|
| `trellis_selfhost`  | `workers/model-trellis`  | `model-trellis`  | `image`  | Native single-hop image→3D (Microsoft TRELLIS). Accepts user photos and the FLUX-synthesized view for text prompts. Textured GLB. |
| `hunyuan3d`         | `workers/model-hunyuan3d`| `model-hunyuan3d`| `image`  | High-poly image-conditioned reconstruction (Tencent Hunyuan3D). Poly-budget aware. |
| `triposg`           | `workers/model-triposg`  | `model-triposg`  | `sketch` | Sketch→3D (TripoSG-scribble): a drawing + a prompt naming it → untextured geometry. |

All three are `provider: 'gcp'`, `free: true`. `model-trellis` pins one
always-warm instance and bursts to three under load (`_MIN_INSTANCES: "1"`,
`_MAX_INSTANCES: "3"`): a cold FUSE-mounted weight load can stall for many
minutes, and the GCP credit budget covers the standing GPU-hour.
`model-hunyuan3d`'s cloudbuild default is also min 1, but the live service was
set to `--min-instances=0` on 2026-07-26 to free the shared us-central1 L4 pool
(3 granted; see the `gpu-quota-starved` signature in
`docs/ops/production-log-triage.md`); `model-triposg` scales to zero. A
**cold start** on a scale-to-zero worker pays a one-time model-load before the
job runs. We surface that honestly (see *Cold start*), never as a fake timer,
and the `gpu-keepwarm` cron (`api/cron/gpu-keepwarm.js`, every 10 min during
peak hours via Cloud Scheduler) holds allowlisted scale-to-zero lanes resident
where warming them does not contend for that L4 pool (`FORGE_KEEPWARM_LANES`
overrides the set without a deploy). A lane id in that override that matches no
known lane comes back in the tick's `unknown_lanes` and drops its `ok` to false,
so a typo in the env var fails visibly instead of quietly warming nothing.

`us-east4` has its own grant of 3 L4s and the same arithmetic applies there. It
runs standbys of `model-trellis` (pinned at min 1), `model-hunyuan3d`,
`model-triposr`, and `model-text2motion`, which is that region's production lane
(`GCP_TEXT2MOTION_URL`, max 2) and the only one of the four carrying user
traffic. The `model-triposr` standby was pinned at min 1 until 2026-08-11, which
left text2motion a single slot to burst into; it now scales to zero, as does the
`model-triposr-warm` Cloud Scheduler probe in `us-central1` (paused the same
day, since each 10-minute ping cold-booted an L4 for a lane with no traffic).
Re-pinning either one is a quota decision: name the lane giving up the slot.

Wire shapes: `model-trellis` and `model-hunyuan3d` both speak the standard task
shape (`POST /infer` → `{ task_id }`, `GET /tasks/:id` → `result_gcs_url`);
the gcp provider drives them with modes `trellis` and `hunyuan` respectively.
The Hunyuan worker also aliases `/reconstruct` + `/jobs/:id` (returning
`glb_url`) for callers still on the avatar-controller contract; new code should
use the `hunyuan` mode.

The `remesh`, `stylize`, `texture`, `rembg`, `segment` workers back
post-generation tools (Game-Ready export, retexture, etc.), not the primary
generation lanes; they follow the same task shape and bearer secret.

---

## Environment

A self-host lane is **configured** only when its worker URL **and** the shared
key are present; a deployment missing either degrades cleanly — the lane drops
out of routing and the catalog reports it `configured: false`. Nothing is ever
faked.

| Env var                 | Used by                | Notes |
|-------------------------|------------------------|-------|
| `MODEL_TRELLIS_URL`     | `trellis_selfhost`     | Cloud Run URL of `model-trellis`. |
| `GCP_HUNYUAN3D_URL`     | `hunyuan3d`            | Cloud Run URL of `model-hunyuan3d`. **Not** `GCP_RECONSTRUCTION_URL` — that is the avatar face pipeline, which rejects non-face images. |
| `GCP_TRIPOSG_URL`       | `triposg` (sketch)     | Cloud Run URL of `model-triposg`. |
| `GCP_UNIRIG_URL`        | auto-rig (`rerig`)     | Cloud Run URL of `model-rig` (the env name predates the engine swap that retired the old `unirig` service). Required for rigging: without it, `rerig` falls back to `GCP_RECONSTRUCTION_URL`, whose deployed service exposes no `/rig`, so every rig submit 404s. The provider speaks the worker's native schema (`mesh_gcs_url` in, `rigged_gcs_url` out) when this is set. |
| `GCP_RECONSTRUCTION_KEY`| all of the above       | Shared bearer secret every worker checks (`avatar-reconstruction-key` in Secret Manager; `model-rig`'s `API_KEY` references the same secret). |
| `GCP_REMESH_URL`        | Game-Ready export      | `model`/`remesh` worker (post-gen). |
| `FORGE_PREFER_FREE`     | routing (optional)     | Defaults on. Set `false` only to restore the paid-default ordering once the paid account is funded. |

The URL each worker registers on the `three-ws-api` Cloud Run service env is
printed at the end of `workers/deploy/deploy-all.sh`, or read it from
`gcloud run services describe <service> --region us-central1 --format='value(status.url)'`.

Secrets never appear in logs or the public catalog.

---

## How routing picks a lane

Routing is health-aware and free-first. For a request with no explicitly chosen
backend, `/api/forge` builds the ordered list of free lanes that can serve the
`(path, tier, userImages)` request (`freeLaneCandidates` in
`api/_lib/forge-tiers.js`), then picks with a cached liveness snapshot
(`api/_lib/forge-lane-health.js`):

1. **Healthy self-host first.** The first lane the liveness probe confirms `ok`,
   and our own GPU workers lead the ordering — so a healthy `trellis_selfhost`
   (then `hunyuan3d`) wins before any external free lane.
2. **Then another healthy free lane.** NVIDIA NIM (native text→3D, draft/standard)
   or HuggingFace Spaces (photos + high tier) when no self-host lane is healthy.
3. **Only then the paid default.** The standing Replicate TRELLIS lane is the
   last resort, used solely when **every** free lane is confirmed down or none is
   configured. BYOK vendors (Meshy/Tripo/Rodin) are never auto-selected — they
   stay explicitly selectable in the catalog.

Liveness combines two signals, both fail-open (missing telemetry never blocks a
lane — an unknown lane is treated as usable):

- A recent submit failure records a short **cooldown** in the shared cache, so
  every instance skips a just-failed lane until it expires.
- A cheap **authenticated GET** against the worker root (Cloud Run answers
  `<500` once routable). Round-trip latency doubles as a warmth signal.

The snapshot is cached per instance (~20s), so a burst of generations shares one
probe and the hot path usually pays no probe latency.

### Submit-time failover

Health routing skips a lane known-bad *before* submit. As a safety net, if the
chosen self-host worker still errors or times out at submit (cold, restarting,
throttled), the handler cools that lane and transparently retries the next
configured lane for the path — `trellis_selfhost` → `hunyuan3d` → HuggingFace →
paid Replicate — before surfacing any error. The `sketch` path has a single lane,
so a TripoSG failure returns a designed, retryable `503` rather than a dead error.
Every response reports the `backend` that actually served it, so a failover is
never silent.

### Poll-time failover

A worker can also accept a task and then fail it asynchronously — the failure
only surfaces on a later `GET /api/forge?job=<id>` poll. That poll
(`api/_lib/forge-failover.js`) cools the failed lane, recovers the original
inputs from the creation row (prompt + reference image), resubmits to the next
configured async lane (`trellis_selfhost` → `hunyuan3d` → paid Replicate, up to
3 backups per job), and binds old-handle → new-handle in Redis. The client
keeps polling the same id and sees `status: "running"` with the new `backend`
plus `failover_from` — the failure never reaches the user. When no automatic
lane remains, the terminal `failed` response names the still-configured lanes
in `retry_backends` so the forge UI offers one-click engine switches (and hops
to the first one automatically). HuggingFace can't be driven from a poll (its
provider blocks through the generation), so it appears only in the
suggestions, served by the client's fresh resubmit. Without Redis the
successor chain disables cleanly and only the suggestion layer applies.

### Cold start

When the liveness probe reaches a self-host worker but it answers slowly (a
scale-to-zero container spinning up), the response carries `cold_start: true` and
the `eta_seconds` is widened by that worker's cold-start budget
(`coldStartSeconds` in the registry). This only widens the **estimate** — actual
progress still comes from real polling of `GET /api/forge?job=<id>`.

---

## The realism pipeline (text→3D)

Everything below runs on GCP credits; no third-party API is involved.

1. **Prompt direction.** The Granite art-director pass runs by default on text
   prompts (`director: false` opts out): it rewrites the raw prompt into a
   single-subject spec with photoreal-by-default material cues
   (`api/_lib/forge-director-prompts.js`). Fail-soft: a dead LLM lane keeps
   the raw prompt.
2. **Reference image.** `textToImage()` leads with the Vertex Gemini image
   model (`gemini-2.5-flash-image`) when `GOOGLE_CLOUD_PROJECT` is set,
   materially more photoreal than 4-step distilled FLUX. `VERTEX_IMAGEN_FIRST=0`
   restores the legacy NIM-first order. `enhanceFluxPrompt()` appends realism +
   isolation cues unless the caller named an art style or composition.
3. **Turnaround views.** For the fusing self-host TRELLIS lane at standard/high
   tier, `synthesizeTurnaroundViews()` rotates the reference into side + back
   views via the Vertex Gemini edit lane (identity-preserving instructions).
   Best-effort: a failed view means fewer views, never a failed job.
4. **Multi-view fusion.** `workers/model-trellis` fuses all supplied views of
   one subject (`TrellisImageTo3DPipeline.run_multi_image`) so unseen sides
   stop being hallucinated. Single view uses the plain `run()` path.
5. **Per-tier sampler/export budgets.** `SELFHOST_TRELLIS_QUALITY`
   (`api/_lib/forge-tiers.js`) scales diffusion steps, kept geometry and baked
   texture size per tier (draft 12 steps/1K, standard 35/2K, high 50/4K;
   texture sizes must be powers of two or the nvdiffrast bake hard-fails); the
   worker clamps every knob server-side (`_clamped_quality`, defaults 40 steps
   / 4K texture / 0.75 simplify). The Hunyuan3D worker maps `tier` +
   `target_polycount` to its own generation budgets.

---

## Health & cost observability

- **Live health:** `GET /api/forge?health` probes every lane (auth/quota gates,
  zero vendor spend), the limiter store, and recent real generation outcomes.
- **Free-vs-paid serve counts:** the same payload's `metrics.by_cost` reports how
  many generations were served `free` (our GPU workers + free external lanes) vs
  `paid` (Replicate platform credits / BYOK), plus `metrics.free_share`. This is
  the headline number proving the vendor-cost reduction. Counters are the rolling
  buckets in `api/_lib/forge-events.js`; they need Redis (omitted otherwise).
- **Structured logs:** every terminal generation logs one `evt:"forge_gen"` JSON
  line with `backend`, so a log drain can compute the same split with no Redis.

---

## (Re)starting a GPU worker

The workers scale to zero; they do not need a manual "start" for normal traffic —
the first request wakes a container (cold start). You restart/redeploy when
shipping a new image or recovering a wedged service.

**Redeploy a single worker** (Cloud Build builds the image and deploys the
service in one step):

```bash
gcloud builds submit --config workers/model-trellis/cloudbuild.yaml . \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
# swap in workers/model-hunyuan3d/… or workers/model-triposg/… as needed
```

`SHORT_SHA` is only populated for trigger-driven builds. A manual submit must
pass it, because these configs tag and deploy `.../server:$SHORT_SHA`, and an
empty tag fails the deploy step after the whole image has already built.

**Provision/redeploy the whole pipeline** (idempotent; prints the URLs to set on
the `three-ws-api` Cloud Run service env):

```bash
PROJECT_ID=<gcp-project> SERVICES="hunyuan3d trellis triposg rig" \
  workers/deploy/deploy-all.sh
```

**Force a fresh revision / clear a wedged container** without a code change:

```bash
gcloud run services update model-trellis --region us-central1 \
  --update-env-vars OPS_BUMP="$(git rev-parse --short HEAD)"
```

**Keep a worker warm** (eliminates cold starts at a standing GPU cost — use only
under sustained load):

```bash
gcloud run services update model-trellis --region us-central1 --min-instances 1
```

**Verify a worker is live** (same check the router's liveness probe makes):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "authorization: Bearer $GCP_RECONSTRUCTION_KEY" "$MODEL_TRELLIS_URL"
# any <500 means up and routable
```

> Note: GPU-backed Cloud Run requires L4 quota in the region (`us-central1`).
> Quota approval can take hours — request it before a first deploy. The shared
> A100 workbench used for experiments is separate from these serving workers and
> may be stopped without affecting them.
