---
venue: NVIDIA Developer Forums (community showcase / Cloud & Data Center)
account: three.ws (official)
suggested_title: "Running a free text-to-3D service on L4s: cold starts, keep-warm crons, and the quota arithmetic nobody publishes"
description: "The fourth three.ws write-up for the NVIDIA developer community: how a free, keyless text-to-3D and avatar service is served from a self-hosted Cloud Run GPU fleet of L4s plus an RTX PRO 6000 Blackwell, what a FUSE-mounted weight load costs on a cold start, why min-instances is a quota decision and not a performance one, and how the NIM free tier fits into a chain that must never have an empty rung."
tags: [l4, blackwell, nim, nemotron, inception, inference, cloud]
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# Running a free text-to-3D service on L4s: cold starts, keep-warm crons, and the quota arithmetic nobody publishes

I run [three.ws](https://three.ws), an open-source platform where you type a sentence and get a textured, rigged, animated 3D character. I have written here three times before: [Nemotron in front of the text-to-3D generator](https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445), [NIM driving a 100-language i18n pipeline](https://forums.developer.nvidia.com/t/how-three-ws-translates-a-web-app-into-100-languages-with-nvidia-nim-an-llm-powered-i18n-pipeline/377379), and a browser-tab digital human streaming Audio2Face-3D onto whatever rig the visitor brought.

This one is about the boring half that keeps the free lane free: the fleet. three.ws is an NVIDIA Inception member; that is a startup programme, not a partnership or an endorsement, and nothing below is an NVIDIA statement.

The thing I want to write down is the arithmetic, because every other "we run open models in production" post I read skipped it, and the arithmetic is where the design lives.

## The fleet

Every generation lane runs as its own Cloud Run service on an **NVIDIA L4** in `us-central1`, plus one **RTX PRO 6000 Blackwell** for the heaviest work. They all speak one task shape (`POST /<endpoint>` returns a task id, `GET /tasks/:id` returns status and result) and share one bearer secret, which means the router does not care which model is behind a lane.

The lanes, and what each is for:

- **TRELLIS** (`model-trellis`): native single-hop image to 3D. Accepts a user's photo, and also the synthesized view that the text lane produces. Textured GLB out.
- **Hunyuan3D** (`model-hunyuan3d`): high-poly image-conditioned reconstruction, poly-budget aware.
- **TripoSG** (`model-triposg`): sketch to 3D. A drawing plus a prompt naming it, untextured geometry out.
- **TripoSR**, plus the mesh pipeline around all of them: rigging, remeshing, texturing, segmentation, stylization, background removal, garment generation, avatar reconstruction from photos, text to motion, video to motion, video to scene, and sign-language synthesis.

Thirty-two workers in total, most of them Docker images you can build and run yourself. The point of self-hosting was never cost alone: it is that a lane we host is a lane we can debug, and a free-tier vendor lane is a lane that changes under you.

## Cold starts are a model-load problem, not a container problem

The single most misleading metric in serverless GPU work is container start time. Ours is fine. The cost is the **weight load**, and on a FUSE-mounted weight volume a cold load can stall for minutes before the job even begins.

Three consequences that shaped the product:

**1. `min-instances` is a quota decision, not a performance one.** The obvious move is min 1 everywhere. You cannot: a regional L4 grant is small (ours is 3 in `us-central1`, with a separate grant of 3 in `us-east4`), and pinning warm instances on every lane starves the lanes that need to burst. So one lane pins an always-warm instance and bursts to three, another was moved to min 0 explicitly to free the shared pool, and the sketch lane scales to zero because its traffic is spiky and its users are patient. Those are three different answers to the same question, and the right answer is per-lane.

**2. A keep-warm cron beats a bigger floor.** A scheduled tick during peak hours holds an allowlist of scale-to-zero lanes resident, and the allowlist is an environment variable so it can change without a deploy. One detail worth stealing: **a lane id in that override that matches no known lane is reported back and fails the tick**, rather than quietly warming nothing. A typo in a keep-warm config is otherwise invisible until somebody complains about latency two weeks later.

**3. Surface the cold start honestly.** When a lane is cold, the user is told a real thing (the model is loading) with a real estimate, not a fake progress bar that fills at a constant rate regardless of what is happening. Our text-to-3D path goes through an intermediate image, so we can also show the concept art the geometry model is about to sculpt. Showing something true makes the wait feel shorter than animating something false.

## Quota starvation looks exactly like a bug

Worth naming because it cost us a debugging session. When the regional L4 pool is exhausted, requests do not fail in a way that says "quota". They fail slowly, in a pattern that reads like a model problem or a network problem. We now have a named signature for it in our triage runbook, and the first check on any "generation is slow" report is the pool, not the model.

The corollary, and this is the operational rule I would give anyone building on a granted GPU pool: **file the quota increase the moment you hit the ceiling, then route around it in the same hour.** Lower a min-instance somewhere else, use the other region's grant, queue behind existing capacity. Parking the feature on the quota request is how a two-day problem becomes a two-week one.

## Failover per lane, and the rung that must never be empty

Every generation lane has a failover chain, so an unavailable model degrades quality rather than failing the request. The same discipline runs on the text side, and that chain is the one where NIM sits.

The text chain tries free rungs first, in order, and only touches a paid key as a last resort. NVIDIA NIM is one of the free rungs (Nemotron, on the free developer tier). Two hard-won notes for anyone building a similar chain:

**Model end-of-life is a silent outage.** When a family we depended on reached end of life on NIM, the rung answered `410`. Our chain fell through correctly, but the deeper lesson was that a chain is only as good as its awareness of upstream catalogue changes, so a scheduled job now diffs our hardcoded model ids against the live catalogues and tells us before users do.

**Reasoning models need an explicit flag.** The Nemotron rung is a reasoning family, so it sends `enable_thinking: false` to keep the answer in `content` rather than in a reasoning field the caller does not read. A chain that treats every provider as interchangeable will produce empty answers on exactly the rungs that are working.

**Never let the chain be empty.** Two rungs in ours are keyless on purpose, so there is always something at the bottom. A failover chain whose last rung requires a key that might be unset is a chain with a hole in it.

## What "free and keyless" actually costs

The free 3D lane needs no account, no key, and no payment. That is a product decision with an infrastructure bill behind it, and the bill is manageable for three specific reasons:

1. **Scale to zero where the traffic is spiky**, and pay standing GPU-hours only where a cold load would be visibly bad.
2. **Self-host the lanes we can**, so the marginal generation costs compute rather than vendor margin.
3. **Grade before you spend.** Two of our free endpoints exist to *avoid* GPU work: a physics-readiness grade that tells a caller whether an asset is usable before they invest in it, and a vision tool that lets an agent look at what it generated and decide whether to iterate. A check that costs money is a check nobody runs, and a caller who cannot evaluate a result will re-generate blindly, which costs everyone more.

## Try it, and check the claims

Free, keyless, no account:

```bash
# text to a textured GLB
curl -s -X POST https://three.ws/api/3d/studio \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic robot figurine"}'

# is the result usable as a rigid body?
curl "https://three.ws/api/sim-readiness?src=<glb url>"
```

The workers, the routing, the keep-warm cron, and the failover chains are all in the open repository at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws) (Apache-2.0), and `GET https://three.ws/api/version` returns the exact commit production is running, so anything above can be checked against the code that serves it.

If you run generation lanes on granted GPU capacity, I would like to compare notes on two things: how you decide which lanes deserve a warm floor, and whether anyone has found a better answer to cold weight loads than "pay for a floor and be honest about the wait".
