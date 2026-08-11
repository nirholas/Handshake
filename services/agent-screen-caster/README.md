# agent-screen-caster

Standalone Node service that gives a three.ws agent a live, watchable screen.
It drives a real Playwright Chromium session, captures JPEG frames on an
interval (and after every navigation and action), and POSTs them with structured
activity records to `https://three.ws/api/agent-screen-push`, where any
connected watch panel or 3D desk renders the agent's screen in real time.

It runs as a separate always-on process because it holds a browser and a frame
loop open indefinitely, which does not fit the request/response shape of the
`api/` functions (see [services/README.md](../README.md)).

**This service is self-hosted, by design.** three.ws runs no managed instance of
it: an agent owner starts it on their own machine, VPS, or container host with
their own agent id and key, and it pushes into the same live stream every other
producer uses. The platform's always-on casting is done by
[workers/agent-screen-pool](../../workers/agent-screen-pool) (on-demand,
multi-agent) and [workers/agent-screen-worker](../../workers/agent-screen-worker)
(one owner-run worker per agent). Reach for this service when you want a real
browser under your own control driving your agent's screen.

## Files

| File | Role |
|---|---|
| [index.js](./index.js) | CLI entrypoint: loads env (optionally from a `--env` file), resolves the task module, boots the caster, runs the task, pushes errors as activity, shuts down cleanly on SIGINT/SIGTERM. |
| [caster.js](./caster.js) | The `AgentScreenCaster` class: Playwright lifecycle, `navigate()`, `act()`, the frame loop, and the authenticated push primitives (`pushFrame`, `pushActivity`). |
| [tasks/pump-monitor.js](./tasks/pump-monitor.js) | Task: watch a pump.fun coin page via DOM mutation observers and stream price/market-cap/transaction activity. With no `TASK_ARG` it defaults to the $THREE mint. |
| [tasks/trade.js](./tasks/trade.js) | Task: drive a DEX swap UI (Jupiter, Raydium, or pump.fun quick-buy) from a JSON trade spec. Requires a pre-authenticated wallet session via Playwright `storageState`. |
| [Dockerfile](./Dockerfile) | `mcr.microsoft.com/playwright:v1.60.0-jammy` base (Chromium baked in), runs as the non-root `pwuser`. |

The Playwright dependency is pinned to an exact version (`1.60.0`) rather than a
range, and the Dockerfile tag must move with it. The base image bakes exactly one
Chromium build into `/ms-playwright`, and the npm package only looks for the
revision it shipped with, so a floating range resolves to a newer package that
cannot find a browser inside the older image.

## Run it

```bash
cd services/agent-screen-caster
npm install

AGENT_ID=<agent uuid> AGENT_BEARER_TOKEN=<jwt or api key> \
TASK=pump-monitor TASK_ARG=<mint> node index.js

# or with a local env file, and a visible browser window:
node index.js --env .env.local
HEADLESS=false node index.js
```

As a container:

```bash
docker build -t agent-screen-caster services/agent-screen-caster
docker run -e AGENT_ID=... -e AGENT_BEARER_TOKEN=... -e TASK=pump-monitor agent-screen-caster
```

## Env vars

| Var | Default | Description |
|---|---|---|
| `AGENT_ID` | (required) | UUID of the agent identity. |
| `AGENT_BEARER_TOKEN` | (required) | JWT or API key for `/api/agent-screen-push`. |
| `PUSH_URL` | `https://three.ws/api/agent-screen-push` | Override the push endpoint. |
| `FRAME_INTERVAL_MS` | `400` | Milliseconds between frame captures. |
| `JPEG_QUALITY` | `72` | JPEG quality 1-100. |
| `HEADLESS` | `true` | `false` opens a visible browser window. |
| `TASK` | `pump-monitor` | Task module: `pump-monitor` or `trade`. |
| `TASK_ARG` | (empty) | Primary task argument (mint address for pump-monitor; JSON trade spec for trade). |
| `WALLET_STORAGE_STATE_PATH` | (empty) | `trade` task only: path to a Playwright `storageState` JSON from a prior authenticated wallet session. Without it the swap UI opens with no wallet connected. |

`AGENT_ID` and `AGENT_BEARER_TOKEN` are the only two you have to source
yourself, and you do not have to hand-assemble them: `POST /api/agent/caster-config`
with `{ "agentId": "<uuid>" }` (signed in, or with a `profile`-scoped bearer)
mints a scoped `agents:read agents:write` key for that agent and answers with a
ready-to-paste `.env` block and `docker run` command. That is the same flow the
agent detail page in the dashboard uses.

## Using `AgentScreenCaster` directly

The class is importable for custom tasks or for running several agents in one
process (each instance gets its own `agentId`/`bearerToken`):

```js
import { AgentScreenCaster } from './caster.js';

const caster = new AgentScreenCaster({ agentId, bearerToken });
await caster.launch();
await caster.navigate('https://pump.fun');
await caster.act('analysis', 'Reading the board', async () => {
	await caster.page.waitForTimeout(2000);
});
caster.startFrameLoop();
// ...later
await caster.close();
```

A custom task module only needs to export `run(caster, taskArg)`; add it to the
`TASK_MAP` in [index.js](./index.js) to make it selectable via `TASK`.

## Tests

`tests/agent-screen-caster.test.js` (run from the repo root with
`npx vitest run tests/agent-screen-caster.test.js`) exercises the real core
path: it launches Chromium, serves a page and a stand-in push endpoint from one
local HTTP server, and asserts that `navigate()` and `act()` narrate before they
capture, that every push carries the agent id and bearer token, that the frames
are genuine JPEGs, and that the frame loop starts and stops on demand. It also
pins the transport policy: an activity push retries through a 429/5xx, a 4xx
fails immediately, and a screenshot is never retried.

## Server side

Frames land in [api/agent-screen-push.js](../../api/agent-screen-push.js);
watchers consume them through the agent-screen stream/control endpoints in
`api/`. Screenshot pushes carry a `data:image/jpeg;base64,...` frame; activity
pushes carry a text summary that the API appends to the agent's activity log.

Only a push that carries something readable (activity text, or a structured
PnL / forge / market-maker ride-along) is written to that log. The periodic
screenshots stay out of it on purpose: the log keeps the last 50 entries, and a
caster running at the default 400 ms interval would otherwise flush the agent's
real narration out of it in about 20 seconds.
