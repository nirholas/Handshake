# agent-screen-pool

On-demand live-browser caster for the [agent wall](https://three.ws/agents-live).

## Why this exists

Every agent on three.ws has a **live screen 24/7 at zero cost** already: the wall
streams each agent's real `agent_actions` activity from the database and renders
it as a live terminal. No browser required.

This worker adds the *optional* layer on top: a **real Chromium browser feed** for
the agents people are **actively watching right now**. It does not run a browser
per agent forever (that doesn't scale and isn't free): it casts only what's on
someone's screen, and tears each browser down when the last viewer leaves. Cost
scales with concurrent viewers, not with the number of agents.

## What the browser actually does

A watched agent isn't just screenshotted on a static page. It does **real,
multi-step web work** you can watch happen:

- **Task-driven mode (default).** For a normal agent the caster runs a real task
  from [`tasks/index.js`](./tasks/index.js): it navigates to a real public site
  (Wikipedia, Hacker News, MDN), types into a real search box, submits, waits for
  the real results to load, and reads them back. Each action is **narrated a beat
  before it happens** and a screenshot lands **after** it. That lead-then-land
  cadence ([`task-runner.js`](./task-runner.js)) is what makes it feel like the
  agent is thinking. Narration lines are written by the real LLM router
  (`/api/brain/chat`, free anon tier) so the words match the page, with the task's
  own declarative lines as a guaranteed fallback when the brain is unreachable.
  The plan is cached per task, so a fleet of casts costs one brain call per task.
- **Coin World Tour mode.** When the cast page is a walkable world exposing
  `window.__tour`, the caster instead walks the guide through the world's waypoint
  loop, narrating the platform's own launch feed at each stop.

$THREE is the only coin. The task library researches neutral public topics: it
never browses to, names, or transacts any token.

## How it works

```
viewer (browser)                  this worker                      three.ws API
-----------------                 ------------                     ------------
POST /api/agent/watch-intent ->   GET /api/agent/watch-wanted ->    { agents:[...] }
   (every ~20s per card)            (poll every POLL_MS)
                                  launch <= MAX_BROWSERS pages
                                  screenshot each every FRAME_MS
                                  POST /api/agent-screen-push  ->   Redis frame
viewer SSE  <-- /api/agent-screen-stream  <-------------------------  live frames
```

Authentication is a single shared secret, `SCREEN_WORKER_SECRET`, set on both the
API (the Cloud Run service env) and this worker. With it the worker may push
frames for **any** agent (it casts on viewers' behalf, it doesn't own the agents).

Each authenticated `watch-wanted` poll also refreshes the pool's liveness key, and
[api/agent/watch-status.js](../../api/agent/watch-status.js) reads it: with no
pool running, a watched card stays on the honest zero-cost activity view instead
of promising a browser that is never coming.

## Run it

```bash
cd workers/agent-screen-pool
npm ci
npx playwright install chromium      # local only; the Docker image bakes it in
SCREEN_WORKER_SECRET=<same-as-api> node index.js
```

Docker (the image the Cloud Run service runs):

```bash
docker build -t three-ws/agent-screen-pool .
docker run --rm -e SCREEN_WORKER_SECRET=<secret> three-ws/agent-screen-pool
```

The Dockerfile's base image tag and the `playwright` version in
`package-lock.json` must move together: the base bakes exactly the browser build
that playwright release expects, and a drifted pair boots fine and then dies on
the first cast with `Executable doesn't exist at /ms-playwright/chromium-<rev>`.

## Config (env)

| Var | Default | Notes |
| --- | --- | --- |
| `SCREEN_WORKER_SECRET` | none | **Required.** Must match the API. 16+ chars. |
| `BASE_URL` | `https://three.ws` | API + page origin. |
| `WANTED_URL` | `$BASE_URL/api/agent/watch-wanted` | Watch-set source. |
| `PUSH_URL` | `$BASE_URL/api/agent-screen-push` | Frame sink (wall convention). |
| `PORT` | unset | When set, bind the liveness endpoint. Cloud Run sets it. |
| `MAX_BROWSERS` | `6` | Concurrency cap = max simultaneous casts. |
| `POLL_MS` | `3000` | How often to reconcile the watch set. |
| `FRAME_MS` | `700` | Screenshot cadence per page (~1.4 fps). |
| `JPEG_QUALITY` | `58` | Frame quality vs. bandwidth. |
| `VIEWPORT_W` / `VIEWPORT_H` | `1280` / `720` | Cast viewport, in pixels. |
| `LEAD_MS` | `900` | How long a narration line leads its action. |
| `DWELL_MS` | `6000` | How long to hold on the result between task runs. |
| `CONTROL_URL` | `$BASE_URL/api/agent-screen-control-drain` | Control-channel drain (owner input). |
| `CONTROL_POLL_MS` | `250` | How often to drain queued owner input. |
| `MANUAL_HOLD_MS` | `2500` | How long the autonomous task stays paused after the last manual signal. |
| `TOUR_DWELL_MS` | `6500` | Pause per world-tour waypoint. |
| `TOUR_READY_MS` | `30000` | Max wait for a walkable scene to become ready. |
| `LAUNCH_FEED_URL` | `$BASE_URL/api/pump/launches?limit=8` | Tour commentary source (the platform's own launch records). |
| `LAUNCH_FEED_TTL_MS` | `20000` | Launch-feed cache, shared across concurrent tours. |

## Take the wheel (owner control)

The caster is not just an outbound screen: an agent's **owner** can drive its live
browser. Each tick this worker also calls `CONTROL_URL` for the agents it is
casting, learns whether a human holds the control lease, and dispatches their
queued input (mouse, drag, scroll, keyboard, navigation) into the real page via
[`control.js`](./control.js). While a human is driving, the autonomous task/tour
stands down (`isManual`) so the two never fight over the cursor, and resumes once
the lease lapses. Input is sanitized and SSRF-guarded on the API boundary; the
dispatcher re-clamps coordinates and re-guards navigation as defense in depth. See
[docs/agent-screen-control.md](../../docs/agent-screen-control.md) for the full
channel and safety model.

## Liveness

With `PORT` set the worker serves one JSON endpoint on `/`, which is both the
Cloud Run startup probe and the ops view of the pool:

```json
{ "ok": true, "worker": "agent-screen-pool", "bootAt": "...", "baseUrl": "https://three.ws",
  "max": 6, "casting": [{ "agentId": "...", "name": "...", "mode": "task", "task": "hn-scan" }] }
```

## Where it runs

A long-lived Cloud Run service, built and deployed by
[`cloudbuild.yaml`](./cloudbuild.yaml) in one submit (build, push, deploy):

```bash
gcloud builds submit workers/agent-screen-pool \
  --config workers/agent-screen-pool/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5
```

It deploys with `--no-cpu-throttling` (the reconcile loop must keep ticking
between probes), `--min-instances=1` and `--max-instances=1`: two instances would
both claim the same watched agents and double-push frames. Budget ~350 MB per
concurrent page, so raise `--memory` alongside `MAX_BROWSERS`.

The shared secret lives in Secret Manager as `screen-worker-secret` and is mounted
by the deploy step. The API side must carry the same value, and the order matters:

1. Deploy the API image first, so the running revision carries the pool-liveness
   gate in [api/agent/watch-status.js](../../api/agent/watch-status.js).
2. Then hand the API the secret (config-only update, merges into the env set):

   ```bash
   gcloud run services update three-ws-api --region us-central1 \
     --project aerial-vehicle-466722-p5 \
     --update-secrets=SCREEN_WORKER_SECRET=screen-worker-secret:latest
   ```

3. Then submit the build above.

Setting the secret on an API revision that predates the liveness gate would make
watched cards claim "warming up" with no pool running, which is the exact thing
the gate exists to prevent.

Any other always-on container host works the same way (one process is plenty).
There is no GitHub Actions path: this repo does not use GitHub Actions.

## Proof

```bash
node scripts/agent-screen-pool-proof.mjs
```

Runs the real worker against a real local server speaking the production wire
contract and asserts the whole core path: authenticated polling, real JPEG frames
from real Chromium, narration leading the screenshot that lands after it, the
control drain, the liveness endpoint, and teardown once nobody is watching. The
pure sequencer and task library are unit-tested in
[tests/agent-screen-task-sequencer.test.js](../../tests/agent-screen-task-sequencer.test.js).
