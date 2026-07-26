# GCP credits: where the $100k goes

Owner directive (2026-07-16): spend the Google Cloud credits freely on quality, reliability, and UX. Do not onboard new external APIs. This doc is the standing map of where credits buy real product improvement, what has been done, and what any agent should do next without asking. Project: `aerial-vehicle-466722-p5`, region `us-central1`, billing runs on the credit grant.

## The one constraint that matters: L4 GPU quota

Every 3D generation engine runs on Cloud Run NVIDIA L4s, and all six GPU services draw from ONE quota: `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`, currently **granted 3** for us-central1.

Six GPU services share those 3 GPUs:

| Service | Role | minScale | maxScale |
|---|---|---|---|
| model-trellis | free text-to-3D lane (quality already maxed: steps 40, 4K textures) | 1 | 3 |
| model-hunyuan3d | high-fidelity reconstruction + multi-view fusion | 1 | 2 |
| model-triposr | fast image-to-3D fallback | 0 | 2 |
| model-triposg | image-to-3D | 0 | 2 |
| ~~unirig~~ | retired (superseded by `workers/rig`) — **holds no GPU**, minScale 0 | 0 | — |
| ~~avatar-reconstruction~~ | photo-to-avatar — **moved to CPU-only 2026-07-25, holds no GPU** (see below) | 1 | 6 |
| model-hunyuan3d-21 | PBR realism lane, L4 build (min 0 since 2026-07-17; a pinned min 1 here starved every other rollout). KNOWN-BROKEN for actual jobs: 18 GiB tmpfs weight staging + 14 GiB model OOMs the 32 Gi L4 ceiling (signal 9 mid-load); see workers/model-hunyuan3d/README.md | 0 | 1 |

`model-hunyuan3d-21-rtx` (same 2.1 PBR lane, warm min 1 / max 4) does NOT draw
from this pool; it runs on the RTX PRO 6000 quota below.

**Resolved 2026-07-25 by returning a GPU nobody was using.** `avatar-reconstruction` held one of the three L4s solely for background removal (rembg / onnxruntime-gpu); every other stage (MediaPipe, TPS, GLB ops) is CPU-bound. Measured: rembg took **~2.2 s per job with the L4 attached versus ~1.9 s on a plain CPU box** — the CUDA provider was never engaging and the GPU was buying nothing. It now runs `--gpu=0 --cpu=8`, which is *faster* (end-to-end 4.2-4.7 s, was 4.8-5.8 s) at identical output quality (mean ISE 0.1595 both ways).

Warm GPU demand therefore went from **3 of 3 (zero headroom)** to **2 of 3**. `model-trellis` (maxScale 3) and `model-hunyuan3d` (maxScale 2) were already permitted to burst and simply could not; that headroom is now real with no further config change. The lesson generalises: **before requesting more GPU quota, verify each holder actually uses its GPU.** A worker whose only GPU stage is an ONNX/rembg step is a prime suspect — check stage timings in its logs against the same stage on CPU.

- A quota preference exists: `l4-no-zonal-us-central1-8`, raised to **preferred 16** on 2026-07-16 (was 8). Still reconciling as of 2026-07-17. Google reviews asynchronously; check with:
  `gcloud alpha quotas preferences list --project=aerial-vehicle-466722-p5`

### The escape hatch that is ALREADY GRANTED: RTX PRO 6000

The preference `rtx-pro-6000-uscentral1-3dpbr` shows
`NvidiaRtxPro6000GpuAllocNoZonalRedundancyPerProjectRegion` granted at
**1000** for us-central1, BUT live deploy enforcement allows **1** RTX GPU
(2026-07-17, deploy error: "requested: 4 allowed: 1"); treat the preference
number as aspirational until a multi-instance deploy succeeds. Cloud Run does
deploy with `--gpu-type=nvidia-rtx-pro-6000` there today (validated live);
platform minimums for the type are **20 CPU / 80 Gi memory** per instance.
Blackwell is compute capability 12.0, so images built for the L4 (cu121/cu124
stacks) do NOT run on it; a worker needs a CUDA 12.8 + torch 2.7 (cu128)
rebuild. First mover: `workers/model-hunyuan3d/Dockerfile.hunyuan21rtx`
(service `model-hunyuan3d-21-rtx`, warm min 1 / max 1). One warm RTX PRO 6000
(96 GB VRAM) still beats what the whole L4 pool could give the 2.1 PBR lane:
the L4 build cannot even load (see the fleet table). When an L4 lane needs
headroom before the L4 grant lands, port it the same way rather than parking
work on the quota.
- **When granted ≥ 8, execute immediately (no owner input needed):**
  ```sh
  gcloud run services update model-trellis   --region us-central1 --max-instances=3
  gcloud run services update model-hunyuan3d --region us-central1 --max-instances=2
  gcloud run services update model-triposr   --region us-central1 --min-instances=1
  gcloud run services update model-triposg   --region us-central1 --min-instances=1
  ```
  That gives every engine a warm instance (no cold-start failures on fallback lanes) and lets the two primary engines scale under load instead of failing over.

## Done on 2026-07-16 (config-only revisions, same images)

- `three-ws-api` min-instances **0 → 2**: the main production API no longer cold-starts for real users. This was the single most user-visible UX defect fixable with money. Verified healthy post-change (healthz 200, traffic on the new revision).
- `rembg-service`, `remesh-service`, `segment-service`, `stylize-service` min-instances **0 → 1**: the photo-to-3D pipeline stages are 8-16 Gi Python containers whose cold starts added tens of seconds to first generations. All warm now.
- L4 quota preference raised to 16 (see above).

## Monthly burn estimate (all covered by credits)

- Warm L4 GPU instance: roughly $500-700/mo each. Six warm engines plus burst: ~$4-6k/mo.
- three-ws-api 2 warm + pipeline 4 warm CPU services: ~$300-500/mo.
- Vertex AI (Gemini LLM chain anchor, gemini-2.5-flash-image reference views for multi-view 3D): usage-based, currently small.
- Total steady state after quota grant: **~$5-7k/mo, i.e. more than a year of runway on $100k.** Do not economize; the owner explicitly prefers quality over credit conservation (see also memory: never downgrade model/effort to save credits).

## Remaining credit-funded opportunities, ranked

1. **GPU maxScale + warm fallbacks**: blocked only on the quota grant; commands above.
2. **Multi-view reference quality (Vertex)**: the forge director already generates front/side/back reference views via `gemini-2.5-flash-image` (Vertex) and fuses them in Hunyuan3D. Credits fund unlimited use; if quality tuning is needed, raise view count or resolution in the forge director rather than adding providers.
3. **model-video2scene worker** exists in `workers/` with a GPU cloudbuild config but is not deployed. Deploying it is new capability (video-to-scene) paid entirely by credits. Use the us-east4 pattern below; us-central1 has no headroom.
4. **us-east4 is LIVE as the second GPU region (2026-07-26).** Its own L4 grant (3, preference `l4-no-zonal-us-east4-8`) sat unused for 9 days while us-central1 ran 3-of-3 pinned (trellis, hunyuan3d, rig), which starved every min-0 L4 service there: `model-text2motion` could not cold-start and 503'd its warm probe every 10 minutes. Port pattern (no rebuild): `gcloud run services describe --format=export` in us-central1 → drop the `run.googleapis.com/urls` annotation, set `cloud.googleapis.com/location: us-east4` → `gcloud run services replace --region us-east4` → mirror the invoker IAM binding. Images pull cross-region from us-central1 Artifact Registry; weights mount from the `three-ws-model-weights` GCS bucket via gcsfuse either way. `model-text2motion` runs there now (`GCP_TEXT2MOTION_URL` on three-ws-api and the `model-text2motion-warm` scheduler probe both point at the us-east4 URL); verified end to end via POST /api/forge-motion. The us-central1 copy stays at min 0 as dormant burst for when the 16-GPU grant lands.
5. **BigQuery billing export + budget alerts** were half-wired (2026-07-07); finishing them gives spend observability against the grant. Console steps are owner-side; agent side is `docs/ops` runbooks.
6. **Cloud CDN / GCS** already serve the news archive and model assets; nothing to do.

## Rules for agents touching this

- Config-only `gcloud run services update` changes (min/max instances, concurrency) are pre-approved by the owner's 2026-07-16 directive; make them and log the revision in your report. Code deploys (`npm run deploy:gcp`, `gcloud builds submit`) still require explicit owner approval per the standing no-deploy rule.
- Never trade quality down to save credits. If a quality knob costs GPU time, turn it up and measure.
- GCP builds/deploys must pin the `three-ws-build@` (build) and `three-ws@` (runtime) service accounts; the default compute SA was deleted.
- Verify prod after any service update: `curl -s -o /dev/null -w "%{http_code}" https://three.ws/api/healthz` must return 200.
