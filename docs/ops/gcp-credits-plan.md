# GCP credits: where the grant goes

Owner directive (2026-07-16): spend the Google Cloud credits freely on quality, reliability, and UX. Do not onboard new external APIs. This doc is the standing map of where credits buy real product improvement, what has been done, and what any agent should do next without asking. Project: `aerial-vehicle-466722-p5`, region `us-central1`, billing runs on the credit grant.

## The grant: Google for Startups Cloud Program, Web3 tier (confirmed 2026-08-04)

The welcome email from Google for Startups (received 2026-08-04) supersedes the earlier "~$100k" working number. Actual terms:

- **Up to $200,000 USD total over 2 years.**
- **Year 1: Google Cloud and Firebase usage covered up to $100,000.**
- **Year 2: 20% of usage costs covered, up to an additional $100,000.**
- **Issuance is metered, not lump-sum: an initial $10,000 landed up front, and each month Google issues additional credits based on the PRIOR month's usage.**
- Credits apply to Firebase and GCP services (BigQuery, Cloud Run, etc.) plus select offerings like Looker. Balance and usage are visible in the Cloud console billing page.

Two operational consequences every agent must respect:

1. **Burn can outrun issuance.** Because monthly credit grants trail usage by a month, a sudden scale-up (new warm GPU fleet, a big Vertex batch) can exceed the credit balance on the billing account before the matching credits arrive, and the overage bills to the real payment method. Ramp large new spend gradually across month boundaries rather than in one spike, and check the console credit balance before any change that adds more than roughly $1k/mo of steady burn.
2. **Year 2 is 20% coverage, not 100%.** The "never economize" directive stands for year 1. When year 1 of the program ends, steady-state burn costs real money at 5x the credit-covered rate, so the fleet's warm-instance footprint should be re-reviewed against revenue then. Do not pre-optimize for this now.

On-machine `gcloud billing` verification was blocked by the recurring Workspace reauth policy at the time of writing; the terms above come from the program email itself. The console (billing > credits) is the source of truth for the live balance.

## Audit and expand capacity with one command: `npm run gpu`

The audit below used to be manual, and it was re-derived by hand twice (2026-07-25, 2026-07-26) before landing the same conclusion each time: **the shortage is usually distribution, not supply.** One region gets pinned to zero headroom while another region's grant sits untouched, and the min-0 services in the pinned region 503 every cold start. [scripts/gpu-capacity.mjs](../../scripts/gpu-capacity.mjs) makes that a command:

```sh
npm run gpu                                              # every GPU region: grant, holders, headroom, ranked actions
npm run gpu -- --json                                    # machine-readable
npm run gpu -- --port model-triposr --to us-east4        # dry-run the cross-region move
npm run gpu -- --port model-triposr --to us-east4 --apply
npm run gpu -- --request 16 --region us-west1 --apply    # file/raise that region's L4 grant
```

It ranks by time-to-effect, and deliberately puts **using a grant we already hold above asking Google for more** — a port lands in minutes, a quota raise has been pending since 2026-07-16. `--port` automates the no-rebuild pattern documented under us-east4 below (export, retarget the location label, drop the read-only URLs annotation and the pinned revision name, replace, mirror the invoker IAM). Mutating modes are dry run unless `--apply`. Pure logic is covered by [tests/gpu-capacity.test.js](../../tests/gpu-capacity.test.js).

Things the tool surfaces that are easy to miss by hand:

- **The accelerator is in `spec.template.spec.nodeSelector['run.googleapis.com/accelerator']`, not in the template annotations.** There is no annotation of that name, so reading there silently defaults every service to L4. That mistake charged the RTX PRO 6000 service to the L4 pool and made us-central1 read "3/3 pinned, 0 free" when it actually had a spare L4. Pinned by `bucketUsage` in [tests/gpu-capacity.test.js](../../tests/gpu-capacity.test.js).
- **Zonal redundancy is a separate quota bucket.** `NvidiaL4GpuAllocPerProjectRegion` and `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion` are different grants. A region can read "full" against one and still have capacity under the other.
- **Every region is its own grant**, and unused regions are the cheapest capacity there is (see the 2026-07-28 result below).

Exit code is 1 when there is an action worth taking (idle grant, or a starved service), 0 when there is not, 3 when gcloud auth has lapsed.

### 2026-07-28: the grant went 6 → 22 L4s, and the blocker was a CLI flag

Two `gcloud` shapes were silently costing us capacity, both discovered by running the tool for real:

1. **`gcloud alpha quotas preferences create` rejects any INCREASE without `--email`**, with `Contact email must be set in order to increase quota value`. `npm run gpu -- --request` now defaults it to the active gcloud account.
2. **`update` takes the preference id POSITIONALLY**; only `create` uses `--preference-id`. Passing the flag to `update` fails with `unrecognized arguments`, which reads like a quota rejection but is pure CLI shape.

With those fixed, filing in unused regions returned grants **immediately, not asynchronously**:

| Region | Before | After | State |
|---|---|---|---|
| us-central1 | 3 | 3 | raise to 16 still reconciling (filed 2026-07-16) |
| us-east4 | 3 | 3 | raise to 8 now reconciling |
| europe-west4 | none | **8** | granted instantly |
| asia-southeast1 | none | **8** | granted instantly |
| us-west1 | none | 0 | requested 8, granted 0 (no capacity for us there) |

**The lesson: file in a new region before escalating an existing one.** The us-central1 raise has been under human review for twelve days; europe-west4 and asia-southeast1 handed over 8 each in seconds.

Two caveats on spending the new EU/APAC grant:

- **`gs://three-ws-model-weights` is a us-central1 REGIONAL bucket.** A worker in europe-west4 or asia-southeast1 gcsfuse-mounts it cross-continent, so weight loading is slow and egress is charged. Before pinning a lane there, either dual-region the bucket or accept the cold-start cost. us-east4 is already proven against this bucket (hunyuan3d and trellis run there today).
- **RTX PRO 6000 is still enforced at 1 instance** despite `grantedValue: 1000`, re-tested 2026-07-28: `--max-instances=4` fails with `requested: 4 allowed: 1`. Treat the preference number as aspirational, exactly as the 2026-07-17 note said.

### 2026-08-11: the same starvation reappeared in us-east4, same fix

The 2026-07-26 lesson repeated verbatim one region over. us-east4's L4 grant is also **3**, and by 2026-08-11 three warm pins held all of it: `model-hunyuan3d` (min 1), `model-trellis` (min 1), and `model-triposr` (min 1, the warm copy ported there 2026-07-28). That left the one us-east4 service production actually routes to, `model-text2motion` (min 0), with zero headroom to cold-start: 13 allocation denials in 7 days, each logged as `exceeded its quota limit for run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy`, most of them the 10-minute keep-warm probe.

Measured before touching anything: over 7 days `model-hunyuan3d`, `model-trellis` and `model-triposr` in us-east4 served **zero** `/infer` requests (only gcsfuse GC noise), because every one of their production URLs points at us-central1 (`MODEL_TRELLIS_URL`, and `GCP_HUNYUAN3D_URL` at the RTX build). Only `GCP_TEXT2MOTION_URL` points at us-east4.

Fix applied (config-only, pre-approved): `gcloud run services update model-hunyuan3d --region us-east4 --min-instances=0` → revision `model-hunyuan3d-00002-srg`. Hunyuan's real lane is `model-hunyuan3d-21-rtx` on the RTX PRO 6000 quota, so an L4 warm standby for it bought nothing anywhere.

**The generalized rule: warm pins are per region, and an idle standby in a region starves the lane that region actually serves.** Before pinning a GPU service warm in any region, check which env var routes production traffic there. `trellis` and `triposr` still hold two of the three us-east4 L4s as idle standbys; the next lane that needs headroom there should measure them the same way and unpin rather than wait on the raise (preference `l4-no-zonal-us-east4-8`, filed 2026-07-28, still reconciling).

## The one constraint that matters: L4 GPU quota

Every 3D generation engine runs on Cloud Run NVIDIA L4s, and all six GPU services draw from ONE quota: `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`, currently **granted 3** for us-central1.

Six GPU services share those 3 GPUs:

| Service | Role | minScale | maxScale |
|---|---|---|---|
| model-trellis | free text-to-3D lane (quality already maxed: steps 40, 4K textures) | 1 | 3 |
| model-hunyuan3d | high-fidelity reconstruction + multi-view fusion (min 0 since 2026-07-26: zero jobs in 3 days while its warm L4 starved model-text2motion; see below) | 0 | 2 |
| model-rig | auto-rigging lane (workers/rig; ~10 jobs/day) | 1 | 2 |
| model-text2motion | text-to-motion clips for the animation library | 0 | 2 |
| model-triposr | fast image-to-3D fallback (us-central1 copy stays min 0; the WARM copy runs in us-east4 since 2026-07-28) | 0 | 2 |
| model-triposg | image-to-3D | 0 | 2 |
| ~~unirig~~ | retired (superseded by `workers/rig`) — **holds no GPU**, minScale 0 | 0 | — |
| ~~avatar-reconstruction~~ | photo-to-avatar: **moved to CPU-only 2026-07-25, holds no GPU** (see below); sized for the 10k avatars/day launch target 2026-08-12 (min 1, max 12, 4 jobs per instance: docs/ops/avatar-reconstruction-capacity.md) | 1 | 12 |
| model-hunyuan3d-21 | PBR realism lane, L4 build (min 0 since 2026-07-17; a pinned min 1 here starved every other rollout). KNOWN-BROKEN for actual jobs: 18 GiB tmpfs weight staging + 14 GiB model OOMs the 32 Gi L4 ceiling (signal 9 mid-load); see workers/model-hunyuan3d/README.md | 0 | 1 |

`model-hunyuan3d-21-rtx` (same 2.1 PBR lane, warm min 1 / max 4) does NOT draw
from this pool; it runs on the RTX PRO 6000 quota below.

**Resolved 2026-07-25 by returning a GPU nobody was using.** `avatar-reconstruction` held one of the three L4s solely for background removal (rembg / onnxruntime-gpu); every other stage (MediaPipe, TPS, GLB ops) is CPU-bound. Measured: rembg took **~2.2 s per job with the L4 attached versus ~1.9 s on a plain CPU box** — the CUDA provider was never engaging and the GPU was buying nothing. It now runs `--gpu=0 --cpu=8`, which is *faster* (end-to-end 4.2-4.7 s, was 4.8-5.8 s) at identical output quality (mean ISE 0.1595 both ways).

Warm GPU demand therefore went from **3 of 3 (zero headroom)** to **2 of 3**. `model-trellis` (maxScale 3) and `model-hunyuan3d` (maxScale 2) were already permitted to burst and simply could not; that headroom is now real with no further config change. The lesson generalises: **before requesting more GPU quota, verify each holder actually uses its GPU.** A worker whose only GPU stage is an ONNX/rembg step is a prime suspect — check stage timings in its logs against the same stage on CPU.

**Repeated 2026-07-26 with a second flavor of the same lesson: verify each warm holder actually gets jobs.** The pool had crept back to 3 of 3 pinned (`model-trellis`, `model-hunyuan3d`, `model-rig`), and `model-text2motion` (min 0) could not allocate at all — every request including the scheduler health ping 503'd with `exceeded its quota limit for … nvidia_l4_gpu_allocation_no_zonal_redundancy`, for hours. Measured real job traffic over 3 days: trellis 229 POSTs, rig 30, **hunyuan3d 0**. Setting `model-hunyuan3d --min-instances=0` freed its L4; text2motion came back immediately (health 200, ~14 s cold start). The triage monitor now classifies this signature (`gpu-quota-starved` in scripts/gcp-triage.mjs) so the diagnosis is automatic next time.

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
- Total steady state after quota grant: **~$5-7k/mo, comfortably inside the year-1 $100k coverage cap (see the grant section above).** Do not economize; the owner explicitly prefers quality over credit conservation (see also memory: never downgrade model/effort to save credits). One caveat from the metered issuance model: when adding a large NEW chunk of steady burn, ramp it across a month boundary so the prior-month-usage-based credit issuance keeps pace.

## Remaining credit-funded opportunities, ranked

1. **GPU maxScale + warm fallbacks**: blocked only on the quota grant; commands above.
2. **Multi-view reference quality (Vertex)**: the forge director already generates front/side/back reference views via `gemini-2.5-flash-image` (Vertex) and fuses them in Hunyuan3D. Credits fund unlimited use; if quality tuning is needed, raise view count or resolution in the forge director rather than adding providers.
3. **model-video2scene worker** exists in `workers/` with a GPU cloudbuild config but is not deployed. Deploying it is new capability (video-to-scene) paid entirely by credits. Prefer the us-east4 pattern below; us-central1 has at most one spare L4 (freed by the hunyuan3d unpin above) and the warm engines want it for burst.
4. **us-east4 is LIVE as the second GPU region (2026-07-26).** Its own L4 grant (3, preference `l4-no-zonal-us-east4-8`) sat unused for 9 days while us-central1 pinned all three of its L4s, which starved every min-0 L4 service there: `model-text2motion` could not cold-start and 503'd its warm probe every 10 minutes. Two composing fixes landed the same day: the idle `model-hunyuan3d` warm pin was dropped (see the 2026-07-26 note above), and text2motion was ported to us-east4. Port pattern (no rebuild): `gcloud run services describe --format=export` in us-central1 → drop the `run.googleapis.com/urls` annotation, set `cloud.googleapis.com/location: us-east4` → `gcloud run services replace --region us-east4` → mirror the invoker IAM binding. Images pull cross-region from us-central1 Artifact Registry; weights mount from the `three-ws-model-weights` GCS bucket via gcsfuse either way. **us-east4 is the primary motion lane**: `GCP_TEXT2MOTION_URL` on three-ws-api and the `model-text2motion-warm` scheduler probe both point at the us-east4 URL; verified end to end via POST /api/forge-motion (90-frame clip). The us-central1 copy stays at min 0 as dormant burst; with the hunyuan3d pin gone it can actually start again if failed back to.
5. **BigQuery billing export + budget alerts** were half-wired (2026-07-07); finishing them gives spend observability against the grant. Console steps are owner-side; agent side is `docs/ops` runbooks.
6. **Cloud CDN / GCS** already serve the news archive and model assets; nothing to do.

## Rules for agents touching this

- Config-only `gcloud run services update` changes (min/max instances, concurrency) are pre-approved by the owner's 2026-07-16 directive; make them and log the revision in your report. Code deploys (`npm run deploy:gcp`, `gcloud builds submit`) still require explicit owner approval per the standing no-deploy rule.
- Never trade quality down to save credits. If a quality knob costs GPU time, turn it up and measure.
- GCP builds/deploys must pin the `three-ws-build@` (build) and `three-ws@` (runtime) service accounts; the default compute SA was deleted.
- Verify prod after any service update: `curl -s -o /dev/null -w "%{http_code}" https://three.ws/api/healthz` must return 200.
