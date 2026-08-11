# Cloud Run fleet deploy runbook

Three bash runbooks that provision and deploy the three.ws GPU/CPU worker fleet
to Google Cloud Run, idempotently and in the right order. They are operator
tools: nothing here is deployed as a service of its own, and nothing runs on a
schedule. You run them by hand from a shell with `gcloud` authenticated.

| Script | What it deploys | GPU? |
| --- | --- | --- |
| [`stage-weights.sh`](./stage-weights.sh) | nothing: stages model weights into `gs://three-ws-model-weights` | no |
| [`deploy-all.sh`](./deploy-all.sh) | the avatar reconstruction pipeline: mesh models + rigging + the CPU controller | yes |
| [`deploy-editing.sh`](./deploy-editing.sh) | the mesh-editing workers behind `/forge`: stylize, remesh, segment, rembg (+ texture, text2motion) | CPU by default |

The scripts share infrastructure: the same runtime service account, the same
output bucket, and the same `avatar-reconstruction-key` secret. Running one
before, after, or instead of the others is fine.

---

## The avatar pipeline

```
/scan (browser)
   └─ POST /api/avatars/reconstruct      (three-ws-api on Cloud Run)
        └─ controller  /reconstruct      (Cloud Run, CPU)   ← GCP_RECONSTRUCTION_URL
             ├─ mesh model /infer        (Cloud Run, L4 GPU)  Hunyuan3D / TRELLIS / TripoSR / TripoSG
             └─ model-rig  /rig          (Cloud Run, L4 GPU)  skeleton + skinning + ARKit-52
                  └─ rigged GLB → GCS → materialized as an avatar the user downloads
```

The site talks **only** to the controller. The controller fans out to the model
and rigging services and returns one rigged GLB.

**What production runs today.** `three-ws-api` points `GCP_RECONSTRUCTION_URL`
at the standalone [`avatar-reconstruction`](../avatar-reconstruction/) worker,
not at `avatar-pipeline-controller`, and `GCP_UNIRIG_URL` at `model-rig`.
`deploy-all.sh` stands the controller pipeline up as its own set of services and
prints the wiring command; it does not repoint the live site. Switching the site
over is the deliberate `gcloud run services update` at the end of the run.

### What you need before running

1. **A GCP project** with the credits / billing account linked.
2. **Cloud Run L4 GPU quota** in your region (default `us-central1`). This is the
   one thing that can block you and can take hours to approve, so request it
   first: Console → IAM & Admin → Quotas → filter "Cloud Run Admin API" →
   `nvidia_l4_gpu_allocation_no_zonal_redundancy` (and the zonal one) → request
   at least 1 per service you deploy concurrently.
3. **A Hugging Face token** (`HF_TOKEN`) for license-gated repos. TRELLIS,
   TripoSR, TripoSG and the Make-It-Animatable assets are open; the Mixamo bone
   dataset the rig worker needs is auto-gated and still wants a token.
4. **~80 GB free disk** wherever you run `stage-weights.sh` in local mode. Cloud
   Shell has ~5 GB, which is why gcsfuse mode is the default there.

### Fastest path: Google Cloud Shell

Cloud Shell is pre-authenticated to your account and already has `gcloud`,
`gsutil`, `python3`, `docker`, and `gcsfuse`. No credential sharing.

```bash
# in Cloud Shell, from a clone of this repo:
cd workers/deploy

# 1. stage the mesh-model weights into gs://three-ws-model-weights  (run once)
#    gcsfuse mode is the default and is REQUIRED in Cloud Shell: the fleet is
#    ~80 GB and Cloud Shell has ~5 GB of local disk, so weights stream straight
#    into the bucket. On a big-disk GCE VM you can use LOCAL_STAGE=1 instead.
HF_TOKEN=hf_xxx SERVICES="hunyuan3d trellis triposr triposg" ./stage-weights.sh

# 2. stage the rig worker's assets (separate script, see below)
HF_TOKEN=hf_xxx bash ../rig/stage-assets.sh

# 3. provision + build + deploy everything, in order
PROJECT_ID=your-project-id SERVICES="hunyuan3d trellis triposr rig" ./deploy-all.sh
```

`deploy-all.sh` is idempotent, so it is safe to re-run. It enables the APIs,
creates the two GCS buckets, creates Firestore (native mode), creates the
`avatar-reconstruction-key` secret, grants the runtime service account its
roles, builds and deploys each GPU service, deploys the controller and **wires
it to the service URLs**, then prints the exact `gcloud run services update`
command for the site.

### Default vs full fleet

| `SERVICES` | what you get | cost/complexity |
| --- | --- | --- |
| `hunyuan3d rig` *(default)* | Textured mesh plus a rig, which is the "rigged model" promise | 2 GPU services |
| `triposr rig` | Fastest mesh (~5-15 s, untextured) plus a rig | 2 GPU services, cheapest |
| `hunyuan3d trellis triposr triposg rig` | All mesh backends (the controller load-balances) plus a rig | 5 GPU services |

Start with the default. The controller routes across whatever mesh backends are
wired, so adding more later is another `deploy-all.sh` run with a wider
`SERVICES`.

### Service keys

The key you pass in `SERVICES` is not always the Cloud Run service name:

| key | worker dir | Cloud Run service | controller env var |
| --- | --- | --- | --- |
| `hunyuan3d` | [`model-hunyuan3d/`](../model-hunyuan3d/) | `model-hunyuan3d` | `MODEL_HUNYUAN3D_URL` |
| `trellis` | [`model-trellis/`](../model-trellis/) | `model-trellis` | `MODEL_TRELLIS_URL` |
| `triposr` | [`model-triposr/`](../model-triposr/) | `model-triposr` | `MODEL_TRIPOSR_URL` |
| `triposg` | [`model-triposg/`](../model-triposg/) | `model-triposg` | `MODEL_TRIPOSG_URL` |
| `rig` | [`rig/`](../rig/) | `model-rig` | `UNIRIG_URL` |

`UNIRIG_URL` is a historical name. It is live on the running services and on
`three-ws-api` (as `GCP_UNIRIG_URL`), and it now points at the Make-It-Animatable
rig worker. The `unirig` worker it was named for was retired in favour of
[`rig/`](../rig/); there is no `unirig` Cloud Run service and no service key for
it here.

### After deploy: wire the site

`deploy-all.sh` prints the command. Production runs on Cloud Run (since
2026-07-07), so the wiring is an env update on `three-ws-api`:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars AVATAR_REGEN_PROVIDER=gcp,GCP_RECONSTRUCTION_URL=https://avatar-pipeline-controller-....run.app
```

Use `--update-env-vars`, never `--set-env-vars`: the latter replaces the
service's entire env set and drops every other variable the site needs.
`GCP_RECONSTRUCTION_KEY` is already mounted on `three-ws-api` straight from
Secret Manager (`avatar-reconstruction-key`), the same secret the workers
authenticate against, so it does not need to be pasted anywhere.

`AVATAR_REGEN_PROVIDER=gcp` pins the provider so the resolver never falls back to
the flaky free Hugging Face Space path. Full env/deploy runbook:
[`docs/ops/gcp-production.md`](../../docs/ops/gcp-production.md).

Verify: open `/scan`, capture a selfie, expect a downloadable **rigged** GLB in
1-2 min. Watch logs with
`gcloud run services logs read avatar-pipeline-controller --region us-central1`.

---

## Weights: what each script stages, and what it does not

`stage-weights.sh` handles one thing well: Hugging Face repos that land in a
bucket prefix a worker reads. Its `weight_source` map is the source of truth for
those, and [`tests/workers-deploy-fleet.test.js`](../../tests/workers-deploy-fleet.test.js)
asserts every prefix matches the one the worker's `cloudbuild.yaml` actually
reads, because a mismatch surfaces only as a cold-start 503.

| key | Hugging Face repo(s) | bucket prefix |
| --- | --- | --- |
| `hunyuan3d` | `tencent/Hunyuan3D-2` | `hunyuan3d-2` |
| `hunyuan3d21` | `tencent/Hunyuan3D-2.1`, `facebook/dinov2-giant` | `hunyuan3d-2.1`, `dinov2-giant` |
| `trellis` | `microsoft/TRELLIS-image-large` | `trellis-large` |
| `triposr` | `stabilityai/TripoSR` | `triposr` |
| `triposg` | `VAST-AI/TripoSG`, `VAST-AI/TripoSG-scribble`, `briaai/RMBG-1.4` | `triposg`, `triposg-scribble`, `rmbg-1.4` |

`hunyuan3d` and `hunyuan3d21` are different models in different prefixes.
`model-hunyuan3d` runs Hunyuan3D-2.0 out of `hunyuan3d-2/`; `model-hunyuan3d-21`
and `model-hunyuan3d-21-rtx` run Hunyuan3D-2.1 out of `hunyuan3d-2.1/` and are
deployed from their own configs
([`cloudbuild.hunyuan21.yaml`](../model-hunyuan3d/cloudbuild.hunyuan21.yaml)),
not from `deploy-all.sh`.

Three workers are deliberately **not** staged by `stage-weights.sh`:

- **`rig`** stages via [`workers/rig/stage-assets.sh`](../rig/stage-assets.sh).
  Its assets span an LFS-filtered model repo, a gated Mixamo dataset, and a baked
  ARKit template, which a one-repo-per-service map cannot express.
- **`texture`** stages via
  [`workers/texture/stage_weights.py`](../texture/stage_weights.py)
  (`--prefix sdxl-texture`). It hands the staged directory to diffusers as
  `cache_dir`, so the tree has to be a Hugging Face *cache* tree, not the flat
  `--local-dir` layout `stage_repo` writes. Its image bakes ControlNet-Depth
  only, so skipping this leaves the service downloading SDXL inside the first
  request and burning the 600 s timeout.
- **`text2motion`** reads the MDM checkpoint from `gs://<bucket>/mdm/`
  (`model.pt` + `args.json`). That checkpoint is not a Hugging Face repo; it is
  the `humanml_trans_enc_512` release of
  [motion-diffusion-model](https://github.com/GuyTevet/motion-diffusion-model),
  copied into the prefix by hand.

---

## Editing workers: `deploy-editing.sh`

The mesh-editing services behind `/api/forge-stylize`, `/api/forge-remesh`,
`/api/forge-segment` and `/api/forge-rembg` are **CPU-only**: no GPU quota, no
staged weights. A clean project deploys in ~10 minutes:

```bash
# in Cloud Shell, from a clone of this repo:
PROJECT_ID=your-project-id ./workers/deploy/deploy-editing.sh

# just one service:
PROJECT_ID=your-project-id SERVICES="stylize" ./workers/deploy/deploy-editing.sh
```

It prints the env vars the site needs (`GCP_STYLIZE_URL`, `GCP_REMESH_URL`,
`GCP_SEGMENT_URL`, `GCP_REMBG_URL`) plus the `gcloud run services update`
command that sets them. Pass `WIRE_SITE=1` to have the script run that update
itself; it is opt-in because it mutates a running production service.

GPU extras: `SERVICES="texture text2motion"` deploys the retexture and
text-to-animation workers too. Both need L4 quota, and both need weights staged
by their own stager first (see the section above); the script warns about each
before it starts building.

---

## Cost (covered by credits)

Read this before a first deploy: **the default fleet does not scale to zero.**
`_MIN_INSTANCES` is `1` in `model-hunyuan3d`, `model-trellis`, `rig`, and the
controller, and `0` in `model-triposr`, `model-triposg`, `texture`, and
`model-text2motion`. A `min-instances=1` GPU service keeps an L4 allocated and
billing around the clock, not only while a job runs. At ~\$0.71/hr on-demand
that is roughly \$17/day per warm L4, so the default `hunyuan3d rig` fleet burns
continuously whether or not anyone scans.

That is a deliberate latency tradeoff (a cold L4 start on this image is minutes,
not seconds), but it is a choice you should make on purpose:

```bash
# deploy the whole fleet cold-start-only
PROJECT_ID=your-project-id MIN_INSTANCES=0 ./deploy-all.sh

# or scale one service down after the fact
gcloud run services update model-trellis --region us-central1 --min-instances=0
```

The controller itself is CPU-only and cheap, so leaving it warm is what keeps
the first scan of the day from waiting on a cold start. Once a service is warm,
the marginal GPU time of a scan is ~\$0.02-0.05, and weight storage is a few
GB-months. All of it is inside the credits; the burn rules and the pre-approved
scaling envelope are in
[`docs/ops/gcp-credits-plan.md`](../../docs/ops/gcp-credits-plan.md), and
[`scripts/gcp/revert-to-free.sh`](../../scripts/gcp/revert-to-free.sh) flips the
whole fleet back off its credit-funded lanes.

---

## Build identity

Every `workers/*/cloudbuild.yaml` pins `serviceAccount:` to
`three-ws-build@aerial-vehicle-466722-p5`, because this project has no default
compute service account. That pin hardcodes one project, so both deploy scripts
pass `--service-account` to re-point it at `$PROJECT_ID` (the CLI flag overrides
the config field). They default to `three-ws-build@$PROJECT_ID` when that account
exists and fall back to the runtime SA
(`avatar-reconstruction-sa@$PROJECT_ID`), which the IAM step grants
`roles/cloudbuild.builds.builder`. Override either with `BUILD_SA` / `RUN_SA`.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Build fails on `pip install hy3dgen`/`trellis` | The git-sourced CUDA package did not build. Check the Cloud Build log; TripoSR builds most reliably, so deploy `SERVICES="triposr rig"` first to prove the path, then add Hunyuan3D. |
| Service cold-starts then 503s on first request | Weights not staged for that model, or staged under the wrong prefix. Check the weights table above, then re-run `stage-weights.sh` with `FORCE=1`. |
| `quota exceeded … nvidia_l4` at deploy | GPU quota not yet granted in the region. See step 2 above. |
| Controller `/health` shows empty `backends` | The controller's `MODEL_*_URL` env was not set. Re-run `deploy-all.sh` (it re-wires), or set it manually with `gcloud run services update`. |
| Build fails with a service-account permission error | The target project has neither `three-ws-build@` nor a `cloudbuild.builds.builder` grant on the runtime SA. Pass `BUILD_SA=<an SA that can build>`. |
| `/scan` still says "warming up" after the env update | The env only applies to revisions created after the update. Confirm the new revision is serving, then check `/api/config` returns `avatarReconstructMode:"platform"`. |
