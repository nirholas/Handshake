# agent-screen-worker

Long-lived Node.js worker that drives a real browser via [Stagehand](https://github.com/browserbasehq/stagehand), captures screenshots on every meaningful state change, and pushes frames to the three.ws live agent screen stream.

## Where this runs

**It is owner-run, not a three.ws service.** There is no Cloud Run deployment and no `cloudbuild.yaml` on purpose: this worker authenticates *as one specific agent* with that agent's own `AGENT_JWT`, and it browses under the agent owner's own Browserbase and Anthropic keys. The platform never holds those, so the process runs wherever the owner wants it: a laptop, a VM, or a container they operate.

The `/agent-screen` setup wizard mints a real `AGENT_JWT` for a selected agent and hands the owner the exact command to run, for all three runtimes below (see [src/agent-screen-runcmd.js](../../src/agent-screen-runcmd.js)).

For a *platform-operated* caster that spins browsers on demand for whichever agents viewers are watching, see the sibling [workers/agent-screen-pool](../agent-screen-pool) instead. That one is a first-party service with a shared secret; this one is per-agent and owner-run.

## Architecture

```
index.js          boot Stagehand, resolve the page handle, wire graceful shutdown, start the task loop
config.js         env loading + validation + local Chrome launch options
capture.js        screenshot + push-to-API with per-interval throttling
task-runner.js    poll for user-queued tasks, execute them, idle neutrally in between
```

Frames land at `/api/agent-screen-push` -> Redis TTL key -> SSE stream at `/api/agent-screen-stream` -> rendered by `/agent-screen?agentId=<uuid>` and the 3D desk in `/play`.

Tasks flow the other way: a user queues one from `/agent-screen` -> `POST /api/agent-task` -> Redis list -> the worker's `GET /api/agent-task` poll -> Stagehand `act()` / `extract()`.

## Quick start

### Local browser (development)

Stagehand v3 launches Chrome over CDP through `chrome-launcher`. It does **not** use Playwright's bundled browsers, so local mode needs a real Chrome or Chromium on the machine. `chrome-launcher` finds a system install on its own; point `CHROME_PATH` at anything else, including a Playwright-installed Chromium:

```bash
cd workers/agent-screen-worker
npm install
export AGENT_ID=<uuid-from-db>
export AGENT_JWT=<bearer-token>
export ANTHROPIC_API_KEY=<your-key>
# only if you have no system Chrome:
export CHROME_PATH=$(node -e "console.log(require('playwright').chromium.executablePath())")
npm start
```

Open `https://three.ws/agent-screen?agentId=<uuid>`; frames appear within seconds.

### Docker (self-hosted)

```bash
docker build -t agent-screen-worker .
docker run --env-file .env agent-screen-worker
```

The image installs Chromium and sets `CHROME_PATH` for you. It runs as root, where Chrome refuses to start its sandbox, so the worker drops the sandbox automatically in that case (see `CHROME_NO_SANDBOX` below).

### Browserbase cloud (zero-infra)

No Docker and no local browser needed. Run as a plain Node process or in any VM:

```bash
export BROWSERBASE_API_KEY=...   # the only Browserbase value; no project id needed
export ANTHROPIC_API_KEY=...     # drives act()/extract(), see below
export AGENT_ID=...
export AGENT_JWT=...
npm start
```

> **`ANTHROPIC_API_KEY` is what makes the agent *do* things.** Stagehand's
> `act()` (type, click, submit) and `extract()` (read the page) are LLM-driven.
> Without a key the agent still opens the browser, navigates, and screenshots,
> but every interactive step fails with a missing-key error that the worker
> narrates into the activity log. Set it to see the agent actually work a task,
> not just load pages.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENT_ID` | yes | none | UUID of the agent that owns this screen stream |
| `AGENT_JWT` | yes | none | Bearer token for that agent |
| `PUSH_URL` | no | `https://three.ws/api/agent-screen-push` | Frame push endpoint override |
| `TASK_URL` | no | `https://three.ws/api/agent-task` | Task poll endpoint override |
| `HOME_URL` | no | `https://three.ws` | Page the agent rests on while idle |
| `BROWSERBASE_API_KEY` | no | none | Browserbase API key. Setting it switches the worker to cloud mode |
| `BROWSERBASE_PROJECT_ID` | no | none | Not required. Browserbase resolves the project from the API key. Leave unset |
| `ANTHROPIC_API_KEY` | recommended | none | Drives `act()`/`extract()`. Without it the agent navigates and screenshots but can't type, click, or read pages |
| `STAGEHAND_MODEL` | no | `anthropic/claude-opus-4-8` | Model for act/extract. Keep the `anthropic/` prefix. Use `anthropic/claude-haiku-4-5` for cheaper, faster casting at high volume |
| `CHROME_PATH` | no | auto-detected | Chrome/Chromium executable for local browser mode. Ignored in Browserbase mode |
| `CHROME_HEADLESS` | no | `1` | Set to `0` to watch the browser in a visible window |
| `CHROME_NO_SANDBOX` | no | auto | The Chrome sandbox stays on wherever it works, and is dropped automatically when running as uid 0 (the container default), where Chrome refuses to start with it. Set to `1` to force it off on a host whose kernel blocks user namespaces |
| `CHROME_CONNECT_TIMEOUT_MS` | no | `60000` | How long to wait for Chrome to open its debug port at boot. Stagehand's own 15s default is too tight for a cold start on a loaded host, where overrunning it kills the worker with a bare `ECONNREFUSED` |
| `CYCLE_MS` | no | `30000` | Idle loop cycle time in ms |
| `SCREENSHOT_INTERVAL_MS` | no | `5000` | Minimum ms between full screenshots (text-only pushes fill the gap) |

## What the agent does

**Queued tasks.** The worker polls `GET /api/agent-task` every cycle. When a user queues a task from `/agent-screen`, the worker picks a start URL for it, navigates, then runs `observe` / `act` / `extract` steps through Stagehand, narrating each step into the live feed. A step that fails is narrated and the task continues; it never takes the worker down.

**Idle.** With no task queued, the worker rests on `HOME_URL` and pushes a "standing by" frame each cycle. The idle mission is deliberately content-agnostic: it never scans, ranks, or narrates third-party tokens or markets. Every real action is user-directed. [tests/agent-screen-worker-compliance.test.js](../../tests/agent-screen-worker-compliance.test.js) pins that invariant.

## Customising the task

Edit `task-runner.js`. `pickStartUrl()` routes a task's text to a starting site and `breakTaskIntoSteps()` turns it into the step plan; replace or extend either for your agent's actual mission.

The `push()` helper accepts `type` values that control how the dashboard styles the entry:

| type | meaning |
|---|---|
| `screenshot` | Full frame; triggers a screenshot if the interval has elapsed |
| `activity` | Text-only log entry |
| `trade` | Trade-related event (styled differently in the log) |
| `analysis` | Research / analysis step |

Note that `act()` and `extract()` are methods on the **Stagehand instance** in v3, not on the page, and take the target page as an option: `stagehand.act(instruction, { page })`.

## Dockerfile build args

| Arg | Default | Description |
|---|---|---|
| `SKIP_BROWSERS` | `0` | Set to `1` to skip the Chromium install for Browserbase-only deployments. Produces a much smaller image |

## Tests

Run from the repo root:

```bash
npx vitest run tests/agent-screen-worker-smoke.test.js tests/agent-screen-worker-compliance.test.js
```

[tests/agent-screen-worker-smoke.test.js](../../tests/agent-screen-worker-smoke.test.js) exercises the real transport: capture.js and task-runner.js run over real `fetch` against a local stand-in for `/api/agent-screen-push` and `/api/agent-task`, asserting every frame carries its agent id, that act/extract are driven through the Stagehand instance, and that a failing step is narrated rather than fatal.
