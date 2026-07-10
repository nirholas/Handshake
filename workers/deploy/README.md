# Avatar pipeline — Google Cloud Run deploy runbook

Deploys the **Scan yourself to 3D** backend: selfie photos → textured 3D mesh →
auto-rigged GLB, served by Cloud Run GPU services and consumed by the site via
`api/_providers/gcp.js`.

```
/scan (browser)
   └─ POST /api/avatars/reconstruct      (three-ws-api on Cloud Run)
        └─ controller  /reconstruct      (Cloud Run, CPU)   ← GCP_RECONSTRUCTION_URL
             ├─ mesh model /infer        (Cloud Run, L4 GPU)  Hunyuan3D / TRELLIS / TripoSR
             └─ UniRig    /rig           (Cloud Run, L4 GPU)  skeleton + skinning + ARKit-52
                  └─ rigged GLB → GCS → materialized as an avatar the user downloads
```

The site talks **only** to the controller. The controller fans out to the model
+ rigging services and returns one rigged GLB.

---

## What you need before running

1. **A GCP project** with the credits / billing account linked.
2. **Cloud Run L4 GPU quota** in your region (default `us-central1`). This is the
   one thing that can block you and can take hours to approve — request it first:
   - Console → IAM & Admin → Quotas → filter “Cloud Run Admin API” →
     **`nvidia_l4_gpu_allocation_no_zonal_redundancy`** (and the zonal one) → request ≥ 1 per service you deploy concurrently.
3. **A Hugging Face token** (`HF_TOKEN`) — Hunyuan3D-2.1 is license-gated; accept the
   license on its HF page once, then the token can download it. TRELLIS/TripoSR/UniRig are open.
4. **~80 GB free disk** wherever you run `stage-weights.sh` (Cloud Shell has enough on a mounted scratch dir; use `STAGE_DIR=$HOME/weights` if `/tmp` is small).

---

## Fastest path — run it in Google Cloud Shell

Cloud Shell is pre-authenticated to your account, already has `gcloud`, `gsutil`,
`python3`, and `docker`. No credential sharing.

```bash
# in Cloud Shell, from a clone of this repo:
cd workers/deploy

# 1. stage model weights into gs://three-ws-model-weights  (run once)
#    In Cloud Shell, gcsfuse mode is REQUIRED: the full fleet is ~80 GB and
#    Cloud Shell has only ~5 GB local disk, so weights stream straight into the
#    bucket (gcsfuse is preinstalled). This is the default mode.
HF_TOKEN=hf_xxx SERVICES="hunyuan3d trellis triposr unirig" ./stage-weights.sh
#    (on a big-disk GCE VM instead, you can use LOCAL_STAGE=1 for download+rsync.)

# 2. provision + build + deploy everything, in order
PROJECT_ID=your-project-id SERVICES="hunyuan3d trellis triposr unirig" ./deploy-all.sh
```

`SERVICES` must match between the two commands so the weights you staged line up
with the services you deploy.

`deploy-all.sh` is idempotent — safe to re-run. It will:
enable APIs · create the two GCS buckets · create Firestore (native) · create the
`avatar-reconstruction-key` secret · grant the runtime service account its roles ·
build + deploy each GPU service · deploy the controller and **wire it to the
service URLs** · print the exact Vercel env vars to set.

---

## Default vs full fleet

| `SERVICES` | what you get | cost/complexity |
| --- | --- | --- |
| `hunyuan3d unirig` *(default)* | Textured mesh **+ rig** — matches the “rigged model” promise | 2 GPU services |
| `triposr unirig` | Fastest mesh (~5–15s, untextured) + rig | 2 GPU services, cheapest |
| `hunyuan3d trellis triposr unirig` | All mesh backends (controller load-balances) + rig | 4 GPU services |

Start with the default. The controller routes 100 % to whatever mesh backends are
wired, so adding more later is just another `deploy-all.sh` run with a wider `SERVICES`.

---

## After deploy — wire the site

`deploy-all.sh` prints these. Set them on the three.ws production service
(Cloud Run `three-ws-api`), then redeploy the site:

```
AVATAR_REGEN_PROVIDER = gcp
GCP_RECONSTRUCTION_URL = https://avatar-pipeline-controller-….run.app
GCP_RECONSTRUCTION_KEY = <printed key>
```

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars AVATAR_REGEN_PROVIDER=gcp,GCP_RECONSTRUCTION_URL=https://avatar-pipeline-controller-….run.app,GCP_RECONSTRUCTION_KEY=<printed key>
```

`AVATAR_REGEN_PROVIDER=gcp` pins the provider so the resolver never falls back to
the flaky free Hugging Face Space path. Full env/deploy runbook:
[`docs/ops/gcp-production.md`](../../docs/ops/gcp-production.md).

Verify: open `/scan`, capture a selfie, expect a downloadable **rigged** GLB in ~1–2 min.
Watch logs with `gcloud run services logs read avatar-pipeline-controller --region us-central1`.

---

## Editing workers — `deploy-editing.sh` (no GPU, no weights)

The mesh-editing services behind `/api/forge-stylize`, `/api/forge-remesh`,
`/api/forge-segment` and `/api/forge-rembg` are **CPU-only** — no GPU quota, no
staged weights. A clean project deploys in ~10 minutes:

```bash
# in Cloud Shell, from a clone of this repo:
PROJECT_ID=your-project-id ./workers/deploy/deploy-editing.sh

# just one service:
PROJECT_ID=your-project-id SERVICES="stylize" ./workers/deploy/deploy-editing.sh
```

It is idempotent and shares all infrastructure with `deploy-all.sh` (same
service account, output bucket, and `avatar-reconstruction-key` secret), so it
can run before, after, or instead of the avatar pipeline. It prints the env vars
the site needs: `GCP_STYLIZE_URL`, `GCP_REMESH_URL`, `GCP_SEGMENT_URL`,
`GCP_REMBG_URL`, `GCP_RECONSTRUCTION_KEY`. Set them on the production service
(Cloud Run `three-ws-api`, `gcloud run services update … --update-env-vars`) and
redeploy the site for the env to take effect.

GPU extras: `SERVICES="texture text2motion"` deploys the retexture and
text→animation workers too, but those need L4 quota and staged weights
(`stage-weights.sh`), like the avatar fleet.

---

## Cost (covered by credits)

GPU services scale to **zero** when idle (`min-instances=0`), so you pay L4 time
only while a scan runs (~1–2 min each). The controller runs `min-instances=1` (CPU,
cheap) so the first scan of the day isn’t blocked by a cold start. An L4 is ~\$0.71/hr
on-demand → a scan costs roughly **\$0.02–0.05** of GPU time. Weight storage is a few
GB-months. Well within the credits.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Build fails on `pip install hy3dgen/trellis/unirig` | The git-sourced CUDA package didn’t build. Check the Cloud Build log; TripoSR builds most reliably — deploy `SERVICES="triposr unirig"` first to prove the path, then add Hunyuan3D. |
| Service cold-starts then 503s on first request | Weights not staged for that model. Re-run `stage-weights.sh` for it. |
| `quota exceeded … nvidia_l4` at deploy | GPU quota not yet granted in the region — see step 2 above. |
| Controller `/health` shows empty `backends` | The controller’s `MODEL_*_URL` env wasn’t set — re-run `deploy-all.sh` (it re-wires), or set manually with `gcloud run services update`. |
| `/scan` still says “warming up” after env set | The site (Cloud Run `three-ws-api`) needs a redeploy for new env to take effect; confirm `/api/config` returns `avatarReconstructMode:"platform"` once the GCP provider is wired. |
