---
venue: Google Cloud Community (Medium publication) / Google Cloud Community forums
account: three.ws (official)
suggested_title: "One container, 115 scheduled jobs, and a GPU fleet that sleeps: an AI platform on Cloud Run"
description: "How three.ws serves a static frontend, a route table, every API handler, and a fleet of open 3D model GPUs from Cloud Run: the single-container decision, Cloud Scheduler as the cron plane, Vertex AI as the reliability anchor in a free-first model chain, and the three deploy gates we added after each one caught a real outage."
tags: [cloud-run, cloud-scheduler, vertex-ai, gpu, generative-ai]
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# One container, 115 scheduled jobs, and a GPU fleet that sleeps

three.ws is an open-source platform where you describe a character and get a rigged, animated 3D agent you can embed anywhere. It runs on Google Cloud, and three.ws is a member of Google Cloud for Web3 Startups. This is the infrastructure write-up: what runs where, which decisions have held up, and the three deploy gates we added only after each one had already cost us an outage.

Everything is Apache-2.0 at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws), and `GET https://three.ws/api/version` returns the exact commit and Cloud Run revision production is serving, so any claim here is checkable against the code that serves it.

## The single-container decision

One Cloud Run service serves three things that are usually three deployments: the **static frontend**, the **route table**, and **every API handler**.

The route table is the part worth explaining. Our routes live in a JSON config that the server reads on boot and splits into pre-filesystem and post-filesystem phases, which means a route change is a config change rather than a code change, and the same file is the source of truth for the scheduler sync described below. It is a slightly unusual shape and it has paid for itself repeatedly: there is exactly one place to answer "what serves this path".

Why one container rather than a service per concern:

- **A page and the API it calls share a deploy**, so a frontend that expects a new field cannot ship ahead of the field.
- **Cold-start count is one**, not seven. With serverless services, every additional service is another cold path for a user to hit.
- **The revision is the unit of truth.** "Which revision is serving this?" has one answer, and a rollback is one command.

The trade is real: the container is larger than a per-endpoint function would be, and a hot path shares CPU with a cold one. For a product where the frontend and the API change together in almost every commit, it has been the right trade.

## Cloud Scheduler as the cron plane

There are 115 scheduled jobs. They are declared in the same config file the server reads for routes, and a script syncs that declaration into Cloud Scheduler, so adding a job is a config change reviewed like any other.

Two lessons from operating that many:

**A dispatcher beats 115 schedule entries with independent opinions.** Several of our high-frequency jobs are invoked by one economy tick that fans out, with per-entry cooldowns deciding what actually fires. Sixty jobs each waking on their own minute boundary is sixty simultaneous cold starts on the same minute.

**Declare the schedule where the code lives.** A cron that exists only in the console is invisible to code review, invisible to `git log`, and impossible to recreate after an account change.

## The GPU fleet, and why min-instances is a quota decision

The generation lanes run open 3D model families on their own Cloud Run GPU services (NVIDIA L4s, plus one RTX PRO 6000 Blackwell for the heaviest work): TRELLIS for image to 3D, Hunyuan3D for high-poly reconstruction, TripoSG for sketch to 3D, and around them the mesh pipeline (rigging, remeshing, texturing, segmentation, stylization, background removal, avatar reconstruction, text to motion, video to motion, video to scene). Thirty-two workers in total, most published as Docker images.

The interesting cost is not the container start. It is the **weight load**: on a FUSE-mounted volume a cold load can stall for minutes before the job begins. Which produces the counter-intuitive rule:

**`min-instances` is a quota decision, not a performance one.** A regional L4 grant is finite. Pinning a warm instance on every lane starves the lanes that need to burst. So one lane pins one always-warm instance and bursts to three, another was explicitly moved to zero to free the shared regional pool, and the spiky lane scales to zero. Three different answers to the same question, correct per lane.

A keep-warm job holds an allowlist of scale-to-zero lanes resident during peak hours, with the allowlist in an environment variable so it changes without a deploy. One detail worth copying: **a lane id in that allowlist that matches no known lane fails the tick loudly** rather than warming nothing silently. A typo in a keep-warm config is otherwise invisible until someone complains about latency a fortnight later.

And when the regional pool is exhausted, requests do not fail with a message that says "quota". They fail slowly, in a pattern that reads like a model problem. We keep a named signature for it in the triage runbook, and the first check on any "generation is slow" report is the pool, not the model.

## Vertex AI as the anchor at the bottom of a free-first chain

Every text completion on the platform runs through one shared failover chain that tries free providers first and only reaches a paid key last. That chain is a dozen rungs deep, and two design rules matter more than the ordering:

**The chain can never have an empty rung.** Two rungs are keyless on purpose, so the bottom always exists even when every keyed provider is unset or throttled.

**Vertex Gemini is the reliability anchor**, billed to our own cloud budget rather than a third-party free tier, which means the chain's floor does not depend on somebody else's quota reset. That is the specific reason to put a first-party cloud model in a free-first chain: not because it is cheapest, but because it is the rung whose failure mode you control.

A related trap, which is not cloud-specific but bit us here: **model end-of-life is a silent outage.** An upstream family reached end of life and its rung began answering `410`. The chain fell through correctly, but the real fix was a scheduled job that diffs our hardcoded model ids against live provider catalogues, so we learn before users do. If you hardcode model ids anywhere, you owe yourself that job.

## Three deploy gates, each added after it would have saved us

Our build is a fixed chain and the order is load-bearing: conflict check, browser-graph check, a temporal-dead-zone check, sub-artifact builds, the frontend build, then the steps that write into the output directory *after* the frontend build wipes it. That last ordering fact has broken us more than once, so it is encoded in one command rather than in anyone's memory.

The three gates that matter most, and what each one caught:

**1. A migration gate before submit.** The build refuses to submit when a database migration is pending. Without it, new code shipped over an old schema, and production served handlers querying a column whose migration had never been applied. The error a user sees in that situation looks nothing like "we forgot a migration".

**2. An upload-context simulation.** Before submitting, we simulate the build-context upload and fail if a file the server imports at runtime would be excluded by ignore rules. This exists because a revision shipped with one omitted module and answered every request, health check included, with a module-not-found error. The build was green. The container started. Nothing was wrong except one file that never got uploaded.

**3. A synchronous CDN purge.** Our purge used to run asynchronously, and post-deploy checks then read stale edge content and reported phantom failures. Making it synchronous costs a minute and removes an entire category of "is it deployed or not" confusion.

The fourth, cheaper than all of them: a version endpoint that returns the running commit and revision. Nearly every "is this live?" conversation ends in one curl.

## What I would tell someone starting the same build

- **Put the route table in a file the server reads,** and let other tooling read the same file. One source of truth beats one convention.
- **Decide per lane whether a warm floor is worth it,** and write down why, because the reasoning is not recoverable from the config six months later.
- **Give every failover chain a keyless bottom rung.**
- **Add a gate the day after an incident, not the week after.** Each of the three above was written in the hours following the outage it now prevents, which is the only time the exact failure is still fresh enough to encode.
- **Publish the version.** It costs an afternoon and it retires an entire genre of conversation.

Free to try, no account and no key: [three.ws/forge](https://three.ws/forge) for 3D generation, `https://three.ws/api/mcp-studio` for the eleven-tool MCP server, and [three.ws/docs](https://three.ws/docs) for the rest.
