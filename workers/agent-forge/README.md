# agent-forge: headless Live Avatar Forge caster

Runs a text to 3D generation on a **free** forge lane and broadcasts it onto an
agent's live screen at `/agent-screen?agentId=…`. Each real pipeline stage is
pushed as a narration line; the final frame carries the generated GLB url and a
three.ws viewer link in its `meta` sidecar, so every viewer loads, rigs, and
animates the freshly-forged avatar.

This is the headless twin of the in-browser **Forge** button on the agent screen.
Both drive the same free lane and emit the same frames (shared logic in
[`src/shared/forge-frames.js`](../../src/shared/forge-frames.js)): no payment, no
API key, no wallet on the generation side.

## How and where it runs

It is a **CLI, not a service.** Nothing schedules it, there is no Dockerfile or
`cloudbuild.yaml`, and it is not deployed to Cloud Run. An operator runs it on
demand from anywhere with network access to three.ws (a laptop, this workspace, a
one-off Cloud Shell). It forges each prompt in sequence, then exits.

Node 22+, no dependencies, no install step:

```bash
cd workers/agent-forge
AGENT_ID=<agent-uuid> \
AGENT_JWT=<sk_live_… API key> \
FORGE_PROMPT="a friendly round robot mascot, glossy white plastic" \
npm start
```

Forge several in a row (split on newline or `|`):

```bash
FORGE_PROMPTS="a red origami crane|a tiny brass steampunk owl" npm start
```

A run prints the lane narration it is pushing, then the durable GLB url:

```
[agent-forge] casting onto agent f6355888-… via https://three.ws (tier=draft); 1 prompt(s).
[agent-forge] Forging on the free lane…
[agent-forge] Model ready - loading into the cam
[agent-forge] forged GLB: https://pub-….r2.dev/forge/anon/8aa84db7-….glb
[agent-forge] done.
```

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `AGENT_ID` | yes | none | Agent whose screen to cast onto |
| `AGENT_JWT` | yes | none | Bearer credential for `/api/agent-screen-push`: an API key (`sk_live_…`) or OAuth access token belonging to the account that **owns** that agent. A key for another account gets a 403 |
| `FORGE_PROMPT` | one of these | none | A single prompt |
| `FORGE_PROMPTS` | one of these | none | List split on newline or `\|` |
| `FORGE_TIER` | no | `draft` | `draft` or `standard`. Both are free and ungated. `high` is **not** selectable here: it is $THREE hold-or-pay gated on `/api/forge` and this worker forges unauthenticated, so it would only 402. Setting it logs a warning and falls back to `draft` |
| `PUSH_URL` | no | `https://three.ws/api/agent-screen-push` | Frame push endpoint |
| `FORGE_BASE` | no | derived from `PUSH_URL` | three.ws origin for `/api/forge` and viewer links |

Mint `AGENT_JWT` at [/dashboard/api](https://three.ws/dashboard/api) while signed
in as the agent's owner, or `POST /api/keys`. The push endpoint checks ownership
of `AGENT_ID`, not the key's scope.

## Which lane actually runs

The worker asks `/api/forge` for the free NVIDIA NIM (Microsoft TRELLIS) lane
(`backend: 'nvidia'`, `path: 'image'`). The API's free-first router may serve a
**different free engine** instead when NIM is down or one of our own GPU workers
is warm: self-host TRELLIS, self-host Hunyuan3D, or the HuggingFace lane. Every
response names the engine that really ran in `backend`, and the worker narrates
and records that one, never the requested one. A live run on 2026-08-11 asked for
`nvidia` and was served by `huggingface` in about 120s.

Consequences worth knowing before you watch a cast:

- A warm lane can finish **inside the submit POST**, returning `status: 'done'`
  with no job to poll. The screen then shows one "Forging…" line for the whole
  generation and no intermediate stages. That is the API blocking, not a stall.
- A scale-to-zero GPU worker that has to boot is narrated honestly ("Waking up
  the Hunyuan3D GPU worker (about 90s), then sculpting starts") from the lane's
  own `cold_start_seconds`, never an invented timer.
- Generations from this worker are unauthenticated, so the durable GLB lands
  under the anonymous prefix and is not attributed to the agent's owner in the
  forge gallery.

The free lane conditions on ~77 characters, so lead with the subject plus its key
materials and colors. Longer prompts are trimmed to fit on a word boundary and
the trim is logged. `$THREE` is the only coin three.ws promotes; avatar forging
has no token surface.

## Failure modes

Every error is pushed to the live screen as a narration line and printed to
stderr, then the worker moves to the next prompt. A failed forge never aborts the
run, and a failed **push** never aborts a forge.

| What you see | Meaning |
|---|---|
| `free 3D lane unreachable: …` | `FORGE_BASE` is wrong or the network is down |
| `the free 3D lane is not configured on this deployment` | 503: no free engine wired on that origin |
| `free 3D lane busy, try again shortly` | 429: rate limited |
| `… Run this worker at FORGE_TIER=draft or standard, which are ungated.` | 402: the High tier gate |
| `generation did not finish within 180s` | The poll budget elapsed; the job may still land in the gallery |
| `[agent-forge] push 403: …` | `AGENT_JWT` does not own `AGENT_ID` |

## Tests

`tests/agent-forge-run.test.js` covers the driver's whole state machine against
the `/api/forge` contract: the synchronous done, the queued-then-poll walk, the
cold-start translation, the served-lane reporting, retry through a blip and a
5xx, the poll budget, and every error above.

```bash
npx vitest run tests/agent-forge-run.test.js
```
