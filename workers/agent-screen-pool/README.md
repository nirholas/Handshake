# agent-screen-pool

On-demand live-browser caster for the [agent wall](https://three.ws/agents-live).

## Why this exists

Every agent on three.ws has a **live screen 24/7 at zero cost** already: the wall
streams each agent's real `agent_actions` activity from the database and renders
it as a live terminal. No browser required.

This worker adds the *optional* layer on top: a **real Chromium browser feed** for
the agents people are **actively watching right now**. It does not run a browser
per agent forever (that doesn't scale and isn't free) — it casts only what's on
someone's screen, and tears each browser down when the last viewer leaves. Cost
scales with concurrent viewers, not with the number of agents.

## What the browser actually does

A watched agent isn't just screenshotted on a static page — it does **real,
multi-step web work** you can watch happen:

- **Task-driven mode (default).** For a normal agent the caster runs a real task
  from [`tasks/`](./tasks/index.js): it navigates to a real public site
  (Wikipedia, Hacker News, MDN), types into a real search box, submits, waits for
  the real results to load, and reads them back. Each action is **narrated a beat
  before it happens** and a screenshot lands **after** it — the lead-then-land
  cadence ([`task-runner.js`](./task-runner.js)) is what makes it feel like the
  agent is thinking. Narration lines are written by the real LLM router
  (`/api/brain/chat`, free anon tier) so the words match the page, with the task's
  own declarative lines as a guaranteed fallback when the brain is unreachable.
  The plan is cached per task, so a fleet of casts costs one brain call per task.
- **Coin World Tour mode.** When the cast page is a walkable world exposing
  `window.__tour`, the caster instead walks the guide through the world's waypoint
  loop, narrating the platform's own launch feed at each stop.

$THREE is the only coin. The task library researches neutral public topics — it
never browses to, names, or transacts any token.

## How it works

```
viewer (browser)                  this worker                      three.ws API
─────────────────                 ────────────                     ────────────
POST /api/agent/watch-intent ──▶  GET /api/agent/watch-wanted ──▶  { agents:[…] }
   (every ~20s per card)            (poll every POLL_MS)
                                  launch ≤ MAX_BROWSERS pages
                                  screenshot each every FRAME_MS
                                  POST /api/agent-screen-push  ──▶  Redis frame
viewer SSE  ◀── /api/agent-screen-stream  ◀────────────────────────  live frames
```

Authentication is a single shared secret, `SCREEN_WORKER_SECRET`, set on both the
API (the Cloud Run service env) and this worker. With it the worker may push frames for **any**
agent (it casts on viewers' behalf, it doesn't own the agents).

## Run it

```bash
cd workers/agent-screen-pool
npm install
npx playwright install chromium      # local only; the Docker image bakes it in
SCREEN_WORKER_SECRET=<same-as-api> node index.js
```

Docker:

```bash
docker build -t three-ws/agent-screen-pool .
docker run --rm -e SCREEN_WORKER_SECRET=<secret> three-ws/agent-screen-pool
```

## Config (env)

| Var | Default | Notes |
| --- | --- | --- |
| `SCREEN_WORKER_SECRET` | — | **Required.** Must match the API. ≥16 chars. |
| `BASE_URL` | `https://three.ws` | API + page origin. |
| `WANTED_URL` | `$BASE_URL/api/agent/watch-wanted` | Watch-set source. |
| `PUSH_URL` | `$BASE_URL/api/agent-screen-push` | Frame sink (wall convention). |
| `MAX_BROWSERS` | `6` | Concurrency cap = max simultaneous casts. |
| `POLL_MS` | `3000` | How often to reconcile the watch set. |
| `FRAME_MS` | `700` | Screenshot cadence per page (~1.4 fps). |
| `JPEG_QUALITY` | `58` | Frame quality vs. bandwidth. |
| `LEAD_MS` | `900` | How long a narration line leads its action. |
| `DWELL_MS` | `6000` | How long to hold on the result between task runs. |

## Where to run it

- **Best:** build the bundled `Dockerfile` and deploy it as a long-lived Cloud
  Run service (`--no-cpu-throttling`), the same place the platform's other
  workers run.
- **Alternative:** any small always-on VM or container host works too (one
  process is plenty; raise `MAX_BROWSERS` with RAM — budget ~350 MB per
  concurrent page).
