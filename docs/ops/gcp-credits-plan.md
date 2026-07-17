# GCP credits: where the $100k goes

Owner directive (2026-07-16): spend the Google Cloud credits freely on quality, reliability, and UX. Do not onboard new external APIs. This doc is the standing map of where credits buy real product improvement, what has been done, and what any agent should do next without asking. Project: `aerial-vehicle-466722-p5`, region `us-central1`, billing runs on the credit grant.

## The one constraint that matters: L4 GPU quota

Every 3D generation engine runs on Cloud Run NVIDIA L4s, and all six GPU services draw from ONE quota: `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`, currently **granted 3** for us-central1.

Six GPU services share those 3 GPUs:

| Service | Role | minScale | maxScale |
|---|---|---|---|
| model-trellis | free text-to-3D lane (quality already maxed: steps 40, 4K textures) | 1 | 1 |
| model-hunyuan3d | high-fidelity reconstruction + multi-view fusion | 1 | 1 |
| model-triposr | fast image-to-3D fallback | 0 | 2 |
| model-triposg | image-to-3D | 0 | 2 |
| unirig | auto-rigging | 1 | 2 |
| avatar-reconstruction | photo-to-avatar | 1 | 3 |
| model-hunyuan3d-21 | PBR realism lane, L4 fallback build (min 0 since 2026-07-17; a pinned min 1 here starved every other rollout) | 0 | 1 |

`model-hunyuan3d-21-rtx` (same 2.1 PBR lane, warm min 1 / max 4) does NOT draw
from this pool; it runs on the RTX PRO 6000 quota below.

Four warm instances against a quota of 3 means the fleet is permanently at its ceiling: any concurrent generation forces failover to lower-quality lanes or queues. **This quota, not model parameters, is the current cap on 3D output quality and reliability.**

- A quota preference exists: `l4-no-zonal-us-central1-8`, raised to **preferred 16** on 2026-07-16 (was 8). Still reconciling as of 2026-07-17. Google reviews asynchronously; check with:
  `gcloud alpha quotas preferences list --project=aerial-vehicle-466722-p5`

### The escape hatch that is ALREADY GRANTED: RTX PRO 6000

`NvidiaRtxPro6000GpuAllocNoZonalRedundancyPerProjectRegion` is granted at
**1000** for us-central1 (preference `rtx-pro-6000-uscentral1-3dpbr`). Cloud
Run deploys with `--gpu-type=nvidia-rtx-pro-6000` there today (validated
2026-07-17 with a live probe service); platform minimums for the type are
**20 CPU / 80 Gi memory** per instance. Blackwell is compute capability 12.0,
so images built for the L4 (cu121/cu124 stacks) do NOT run on it; a worker
needs a CUDA 12.8 + torch 2.7 (cu128) rebuild. First mover:
`workers/model-hunyuan3d/Dockerfile.hunyuan21rtx` (service
`model-hunyuan3d-21-rtx`, warm min 1 / max 4). When an L4 lane needs headroom
before the L4 grant lands, port it the same way rather than parking work on
the quota.
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
3. **model-video2scene / model-text2motion workers** exist in `workers/` with GPU cloudbuild configs but are not deployed. Deploying them is new capability (motion + video-to-scene) paid entirely by credits. Needs quota headroom first.
4. **A second GPU region (us-east4)** for latency/redundancy once us-central1 is saturated; same quota-preference dance.
5. **BigQuery billing export + budget alerts** were half-wired (2026-07-07); finishing them gives spend observability against the grant. Console steps are owner-side; agent side is `docs/ops` runbooks.
6. **Cloud CDN / GCS** already serve the news archive and model assets; nothing to do.

## Rules for agents touching this

- Config-only `gcloud run services update` changes (min/max instances, concurrency) are pre-approved by the owner's 2026-07-16 directive; make them and log the revision in your report. Code deploys (`npm run deploy:gcp`, `gcloud builds submit`) still require explicit owner approval per the standing no-deploy rule.
- Never trade quality down to save credits. If a quality knob costs GPU time, turn it up and measure.
- GCP builds/deploys must pin the `three-ws-build@` (build) and `three-ws@` (runtime) service accounts; the default compute SA was deleted.
- Verify prod after any service update: `curl -s -o /dev/null -w "%{http_code}" https://three.ws/api/healthz` must return 200.
