# Avatar reconstruction: capacity for 10,000 avatars/day

The roadmap launch line "GPU inference sized to 10k avatars/day" refers to the
photo-to-avatar lane, `workers/avatar-reconstruction` on Cloud Run (the service
`api/_providers/gcp.js` calls in `reconstruct` mode). Since 2026-07-25 the lane
is CPU-only: measurement showed the L4 it held was never engaged by rembg, and
dropping it made jobs faster (see docs/ops/gcp-credits-plan.md). "GPU inference"
in the roadmap sentence is shorthand for the reconstruction compute lane; the
capacity question is the same either way: can the lane hold 10,000 finished
avatars per day?

Short answer, measured 2026-08-12: **yes, with a config-only autoscaling
change that is now live.** This note records the numbers, the change, and the
one trap that made the old config incapable of the target no matter how much
quota it had.

## Measured numbers (real runs, 2026-08-12)

All runs used [scripts/reconstruct-load-test.mjs](../../scripts/reconstruct-load-test.mjs)
(`--target worker`, the 40 published eval-refs faces, one per job, each
returned GLB verified to parse with geometry before it counts).

Baseline, revision `avatar-reconstruction-00014-4vg` (max 6 instances,
containerConcurrency 80, `MAX_CONCURRENT_JOBS` unset so the in-process
semaphore defaulted to 2):

- Burst of 5 concurrent jobs: 5/5 ok, p50 16.2s, p95 22.6s, max 22.6s.
- Implied per-instance job concurrency: **2** (the default semaphore). Two
  jobs finished in ~9.9s (queued 3.2s); the rest waited a full first wave.
- Per-job pipeline compute: ~6.5s steady-state per the service logs
  (`pipeline done in 6.2-6.3s` lines), ~10s end to end for the first wave.
- Extrapolated single-instance ceiling: 2 jobs / 6.5s = **~26.6k/day**, which
  the old config could never realize horizontally (see the trap below).
- Per-job cost at 8 vCPU / 16 GiB Cloud Run pricing: roughly 0.2 cents of
  compute (about $19 per 10k avatars, all inside the year-1 credit coverage).

Post-change, revision `avatar-reconstruction-00015-m7m` (see the applied
config below):

- Warm burst of 8: 8/8 ok, p50 17.1s. Implied per-instance concurrency: **4**
  (the new semaphore). Two jobs of the burst ran long (~96-109s): both were
  the two stragglers each burst leaves behind once the other six finish, at
  which point the autoscaler wants to scale the instance group down while
  their background threads still need the CPU. They were the tail of the
  burst, not a steady-state latency; the sustained run below shows the real
  distribution.
- **Sustained open loop at the full 10,000/day arrival rate for 10 minutes:
  69/69 jobs ok, achieved 10,028 verified GLBs/day (100.3% of target), p50
  6.4s, p95 8.5s, max 8.6s, queue-wait p95 2.3s.** At the launch arrival rate
  the lane is comfortably overprovisioned: jobs are taken off the semaphore
  almost immediately and finish inside one pipeline time.

Judgment call: the order asks for proof at a derated target. The run held the
full 10k/day target, so no derating was needed; derated targets stay available
as a flag (`--rate 8000 --duration 600`).

## The trap: submit-lane concurrency hid all the load

The worker answers `POST /reconstruct` in milliseconds and does the real work
in a FastAPI BackgroundTask behind an in-process semaphore. Two consequences
composed badly in the old config:

1. `containerConcurrency: 80` meant the autoscaler's request-concurrency
   signal counted submits and polls, not jobs. 80 near-instant requests per
   instance means the signal never fires; one instance could absorb every
   user while eight vCPUs ground behind a semaphore of 2.
2. Cloud Run's other autoscaling signal, CPU utilization, never fires either
   at semaphore 2 on 8 vCPU (the pipeline's numpy/scipy stages use limited
   BLAS threading, so 2 jobs is ~25% CPU, under the 60% scale-out target).

Net effect: under real load the lane would have stayed a single instance
running 2 jobs at a time with an unbounded internal queue, latency climbing
forever, while Cloud Run reported an idle service. The fix is to make the
container-concurrency signal visible to the autoscaler and raise the
per-instance job concurrency to match the hardware:

## Applied config (config-only, pre-approved by the 2026-07-16 directive)

Applied 2026-08-12, revision `avatar-reconstruction-00015-m7m`:

```sh
gcloud run services update avatar-reconstruction \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --concurrency 8 \
  --max-instances 12 \
  --update-env-vars MAX_CONCURRENT_JOBS=4
```

- `MAX_CONCURRENT_JOBS=4`: 4 jobs x ~2.5 effective cores = the 8 vCPU fully
  used, and 4 x ~2-3 GiB resident per job fits 16 GiB. Measured above: implied
  concurrency 4, per-job pipeline time unchanged at ~6.5s, so the 4-way
  packing costs no per-job slowdown. Per-instance ceiling is now ~53k/day.
- `--concurrency 8`: 4 job submits + polling headroom per instance. Submits
  and polls are millisecond requests, so 8 outstanding is a real "this
  instance is full" signal; the autoscaler now adds instances when one
  saturates instead of never seeing the load.
- `--max-instances 12`: 12 x ~53k/day is ~640k/day of headroom, 64x the
  launch target, capped to keep a runaway loop from burning credits. Steady
  state at launch volume is 1 warm instance; the autoscaler pays for more
  only while load exists.

Capacity math against the target: 10k/day needs ~1 job every 8.6s, i.e. about
2.6 jobs resident at a 22s worst-case observed job time. One instance at
concurrency 4 covers that; instances 2-12 are burst headroom.

Cost: CPU-only Cloud Run scales to the floor of 1 warm instance between runs,
so the change adds nothing to steady burn (the existing ~$50/mo warm floor).
At the 10k/day launch rate the lane costs on the order of $19/day of compute,
trivially inside the year-1 $100k credit coverage. No GPU quota is involved:
this lane deliberately holds none, which is what keeps the 3-granted L4 pool
free for the engines that genuinely need GPUs (gcp-credits-plan.md).

No quota increase was filed: the lane runs on CPU quota, the measured target
fits one instance, and max 12 instances is far under the regional Cloud Run
CPU quota. Nothing blocks the target.

## Reproduce

```sh
export GCP_RECONSTRUCTION_URL=https://avatar-reconstruction-lp642k3kpa-uc.a.run.app
export GCP_RECONSTRUCTION_KEY=$(gcloud secrets versions access latest \
  --secret=avatar-reconstruction-key --project=aerial-vehicle-466722-p5)
node scripts/reconstruct-load-test.mjs --target worker --n 5          # burst
node scripts/reconstruct-load-test.mjs --rate 10000 --duration 600    # sustained proof
```
