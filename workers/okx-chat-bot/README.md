# okx-chat-bot

Always-on host for the OKX.AI marketplace chat bot (agent **#2632**).

Buyers message our marketplace listing over XMTP. That chat is delivered to a
local `okx-a2a` daemon, which reads agent identities through an `onchainos`
wallet session and spawns an AI subsession to author the reply and drive the
task lifecycle (accept, negotiate, deliver). Both CLIs used to run on a
developer codespace, which cannot stay up: a rebuild wipes the CLIs and an idle
nap kills the daemon (observed alive at 21:09, dead by 03:13 the same night).
OKX's own chat test then reports "no delivery in 30 minutes" and flags the
listing offline.

This worker is the durable host for that pair. It restores the wallet identity,
supervises the daemon, rebuilds the AI subsession's world knowledge on every
boot, and makes the one failure a human must clear (an expired OKX session) page
loudly with the exact commands to fix it.

## The failure it exists to kill

The dangerous outage here is **silent**. The process stays up, the container
reports healthy, and chat is simply never delivered because the wallet session
expired or no XMTP client came online. From the outside that is
indistinguishable from "nobody messaged us".

So readiness is deliberately strict: a bot that cannot receive a message is
**not ready**, even though the process is perfectly alive. `/readyz` returns 503
in every state below except `online`.

| `reason` | Status | Ready | What it means |
|---|---|---|---|
| `daemon_down` | down | no | `okx-a2a` is not running. No chat is delivered. |
| `wallet_unreadable` | unknown | no | `onchainos wallet status` did not answer. Session state unknown. |
| `session_logged_out` | down | no | Session expired. Every XMTP client is offline. **Needs a human OTP.** |
| `no_active_client` | degraded | no | Logged in, but 0 XMTP clients serving. The daemon retries every minute. |
| `ai_provider_uncredentialed` | degraded | no | Chat arrives but the subsession has no key, so it cannot author a reply. |
| `online` | ok | yes | At least one XMTP client is serving at least one agent identity. |

`classify()` in [session.js](session.js) is pure, so this state machine is
testable without a daemon, a wallet, or a network.

## Architecture

| File | Role |
|------|------|
| `index.js` | Entrypoint. Boot order, session probe, heartbeat, ops alerts, graceful shutdown. |
| `config.js` | Env-driven config (`loadConfig`, `paths`) and AI-provider selection (`resolveProvider`). |
| `cli.js` | Timeout-bounded, non-throwing wrappers around the `okx-a2a` and `onchainos` binaries. |
| `session.js` | Pure health `classify()` plus `loginInstructions()`, the exact commands a human runs. |
| `health-server.js` | The HTTP surface: strict `/readyz`, always-200 liveness, and the `remedy` payload. |
| `state.js` | Tar the wallet/XMTP identity to GCS and restore it on boot (`snapshotState`, `restoreState`). |
| `supervisor.js` | Owns the `okx-a2a run` child with capped exponential backoff restarts. |
| `workspace.js` | Rebuilds the AI subsession's briefing and skills from the image on every boot. |
| `log.js` | Structured JSON lines for Cloud Logging. |

### Four things that are load-bearing

**The daemon runs in the foreground, never via `daemon start`.** `okx-a2a daemon
start` delegates to an OS autostart unit (systemd/launchd). There is no systemd
in a container, so that call installs a unit and silently leaves the daemon
**down**: the exact trap that made the local bot look staged but offline. The
supported foreground entrypoint is `okx-a2a run`, and `supervisor.js` owns that
child directly. It also clears the lock file before every spawn, because a
crashed daemon leaves one behind that blocks the next start.

**Identity lives on disk, not in a database.** `~/.onchainos/keyring.enc` plus
`session.json` and `machine-identity` are what make the wallet session survive,
and `~/.okx-agent-task/` holds the XMTP client database. Cloud Run's filesystem
is in-memory and dies with the revision, so `state.js` tars both trees to one
GCS object and restores it on boot. Without that, every deploy would log the bot
out and need a fresh human OTP.

**A daemon that cannot be spawned must not take the host with it.** A missing or
unrunnable `okx-a2a` binary raises `error` on the child, not just `exit`. Node
throws on an unhandled `error` event, so without a listener the whole worker dies
and "the daemon binary is missing" surfaces as "the host is gone": no health
verdict, no heartbeat, no alert naming the real problem. `supervisor.js` handles
both events through one restart path, and a spawn that raises both never
schedules two restarts.

**The AI workspace is rebuilt from the image, not from the snapshot.** The
adapter spawns the AI CLI with cwd set to `~/.okx-agent-task/workspace`, and
whatever is in that directory **is** the subsession's world knowledge. A naive
containerisation ships an agent that knows nothing about three.ws and improvises
answers to paying buyers. `workspace.js` writes a briefing (as both `CLAUDE.md`
and `AGENTS.md`, since which one is read depends on the spawned CLI) and copies
12 skills in on every boot, so a redeploy always ships the current catalog.

## Configuration

Every knob is env-driven, so the same image runs on Cloud Run, on a plain VM, and
locally with no code change. Defaults are the production posture.

| Env | Default | Purpose |
|---|---|---|
| `OKX_BOT_HOME` | `$HOME` | HOME for both CLIs. Decides where all durable state lands. |
| `PORT` | unset | Health server port. Unset means no health server (fine locally, never on Cloud Run). |
| `OKX_BOT_AGENT_ID` | `2632` | The marketplace agent this bot answers for. |
| `OKX_BOT_STATE_BUCKET` | unset | GCS bucket for the state snapshot. Unset means ephemeral mode. |
| `OKX_BOT_STATE_OBJECT` | `okx-chat-bot/state.tar.gz` | Object name within that bucket. |
| `OKX_BOT_REPO_ROOT` | `/app` | Where the briefing and skills are read from. |
| `OKX_BOT_AI_PROVIDER` | auto | Pin the provider (`claude`, `codex`, `hermes`, `openclaw`). |
| `OKX_BOT_HOST_LABEL` | auto | Name this host on every beat. Cloud Run names itself from `K_SERVICE`. |
| `OKX_BOT_HOST_DURABLE` | unset | Set to `1` to claim a non-Cloud-Run host stays up on its own. |
| `OKX_BOT_DAEMON_BIN` | `okx-a2a` | The XMTP daemon binary the supervisor owns. |
| `OKX_BOT_HEARTBEAT_MS` | `30000` | How often the `bot_heartbeat` row is written. Its own timer, not the probe's. |
| `OKX_BOT_SESSION_PROBE_MS` | `60000` | How often health is re-probed. |
| `OKX_BOT_SNAPSHOT_MS` | `300000` | Periodic state snapshot cadence. |
| `OKX_BOT_ALERT_REPEAT_MS` | `21600000` | Re-alert ceiling while a bad state persists (6 h). |
| `OKX_BOT_RESTART_BASE_MS` | `2000` | Daemon restart backoff floor. |
| `OKX_BOT_RESTART_MAX_MS` | `60000` | Daemon restart backoff ceiling. |

**Provider selection is by credential, not by preference.** A provider CLI with
no key spawns, fails to authenticate, and produces exactly the symptom this
worker exists to kill: silence on the buyer's side. So an explicit
`OKX_BOT_AI_PROVIDER` wins; otherwise `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` selects `claude`, and `OPENAI_API_KEY` selects
`codex`. A developer host carries no key at all: its claude CLI was logged in by
a human, so an existing `$OKX_BOT_HOME/.claude/.credentials.json` also counts as
a credential. With no credential at all the worker boots, logs an error, and
reports `ai_provider_uncredentialed` rather than pretending to be healthy.

`DATABASE_URL` is also required, for the heartbeat row.

## Running it

Both CLIs must be on `PATH`. `cliEnv()` prepends `$HOME/.local/bin` (where the
`onchainos` installer drops its binary) so a local run works whether or not the
binary has been relocated to `/usr/local/bin`.

```bash
# Local, ephemeral: no state bucket, no health server.
npm run worker:okx-bot

# Local, with a health server and an explicit provider.
PORT=8080 OKX_BOT_AI_PROVIDER=claude npm run worker:okx-bot
```

Then read the health verdict:

```bash
curl -s localhost:8080/readyz | jq '{ready: .health.ready, reason: .health.reason, agents}'
```

To stage the same workspace on a developer machine without running the worker,
use [scripts/okx-bot-revive.mjs](../../scripts/okx-bot-revive.mjs), which keeps
the identical skill list.

## HTTP surface

| Path | Behaviour |
|---|---|
| `/readyz` | **Strict.** 200 only when `health.ready` is true, 503 otherwise. |
| any other path | Liveness. Always 200, with the same status body under `ok: true`. |

Liveness is deliberately always-200: Cloud Run must **not** restart the
container for a logged-out session. A restart cannot fix it (only a human OTP
can) and a restart loop would destroy the state snapshot cadence.

When a human is needed, the response carries a `remedy` array with the real
commands, so the fix travels with the status instead of living in a runbook
someone has to go find.

## Deploying

**Status: running as a stopgap on a developer codespace, not yet deployed.**
There is no `okx-chat-bot` Cloud Run service in `aerial-vehicle-466722-p5`.
Two of the three one-time prerequisites now exist (created 2026-09-02):
`gs://three-ws-okx-bot-state` (versioned, `three-ws@` holds `objectAdmin`) and
the `okx-chat-bot-database-url` secret (copied from the project's existing
`DATABASE_URL` secret so the two cannot drift, `three-ws@` holds
`secretAccessor`). **The one thing still missing is the AI-provider secret**,
`anthropic-api-key`, whose value exists nowhere on this machine. The deploy
references it in `--set-secrets` and will fail loudly without it, which is the
intended trade: a bot that receives buyer chat and cannot answer is worse than a
refused deploy.

Since 2026-09-02 this worker has beat for the first time, from a codespace, so
`/api/healthz` reports the `okx_chat_bot` subsystem instead of `unknown`. That
is a stopgap and says so on the wire: every beat carries `host` and
`hostDurable`, and a beat whose host cannot survive on its own reads as
**degraded**, never `ok`, with the deploy command as its hint. Calling a
codespace green would rebuild, one level up, the false-green this worker exists
to kill.

### The first boot pages for an OTP, unless the state object is seeded

`gs://three-ws-okx-bot-state` holds no snapshot yet, so the first revision boots
logged out and alerts for a human email OTP as `claude@three.ws`. That round trip
is avoidable: a machine already holding a live session (the codespace stopgap
does) can write the same archive this worker writes, and the new host then
restores an authenticated session and comes up online.

```bash
# On the machine holding the live session, with its daemon STOPPED so the sqlite
# files are quiesced. The worker's SIGTERM path stops it for you.
OKX_BOT_STATE_BUCKET=three-ws-okx-bot-state node -e "
  import('./workers/okx-chat-bot/state.js').then(async ({ snapshotState }) => {
    const { loadConfig } = await import('./workers/okx-chat-bot/config.js');
    console.log(await snapshotState(loadConfig(), { reason: 'seed' }));
  })"
```

Two caveats. The archive carries the wallet keyring and session, so it belongs in
this private bucket and nowhere else, and `snapshotState` needs
`GCP_SERVICE_ACCOUNT_JSON` on a machine that is not already on GCP. And the
bucket has exactly one writer: stop the seeding host before the Cloud Run service
starts, or the two interleave snapshots. Skipping the seed is not a failure, it
just leaves the OTP that the first boot would have asked for anyway.

The service must run `--min-instances=1 --max-instances=1`. This is not a
capacity choice: the GCS snapshot has exactly one writer, and concurrent
revisions would interleave snapshots and corrupt the identity.

Shipping is one command once the setup below exists:

```bash
gcloud builds submit --config workers/okx-chat-bot/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s) .
```

The build pins `three-ws-build@` and the service runs as `three-ws@`; the
project's default compute service account was deleted, so both pins are
required. The bucket and secret commands are at the top of
[cloudbuild.yaml](cloudbuild.yaml).

Cloud Run's startup probe is wired to `/healthz` and deliberately **not** to
`/readyz`, for the same reason liveness is always-200.

One-time setup (none of it has run yet; the exact commands are at the top of
[cloudbuild.yaml](cloudbuild.yaml)):

1. Create the state bucket and grant the runtime service account
   `roles/storage.objectAdmin` on it.
2. Create the `okx-chat-bot-database-url` and `anthropic-api-key` secrets and
   grant the runtime service account `roles/secretmanager.secretAccessor` on
   both. The deploy step wires them by name and **fails if either is missing**,
   which is deliberate: a bot with no AI credential receives buyer chat and
   never answers it. `OKX_BOT_STATE_BUCKET` needs no manual step, the deploy
   sets it.
3. Confirm the image has both CLIs installed and the repo at `OKX_BOT_REPO_ROOT`.

Never patch the AI key onto the service by hand. `--set-secrets` in the deploy
step replaces the whole secret set, so a hand-added key survives exactly until
the next deploy and then vanishes without a single error line.

The first boot logs `no state snapshot yet: first boot for this bucket` and
comes up logged out, which pages a human to complete the initial OTP as
`claude@three.ws`. Every boot after that restores the session.

Shutdown order matters and is handled on SIGTERM: the daemon is stopped
**before** the final snapshot, so the sqlite files are quiesced rather than
copied mid-write. The periodic timer snapshot is a live copy and is
best-effort by design, so an ungraceful kill loses minutes, not the identity.

## Monitoring

The worker writes a `bot_heartbeat` row (keyed on `worker = 'okx-chat-bot'`)
carrying the current verdict, agent and client counts, provider, and restart
count. [api/_lib/ops/subsystem-health.js](../../api/_lib/ops/subsystem-health.js)
turns it into the `okx_chat_bot` subsystem, so the bot's reachability shows up
next to every other platform dependency:

```bash
curl -s https://three.ws/api/healthz \
  | jq '.subsystems.subsystems[] | select(.name=="okx_chat_bot")'
```

A host that stops beating reads as `down` rather than silently vanishing, which
is the whole point: a dead host cannot report that it is dead. The beat runs on
its own timer (`OKX_BOT_HEARTBEAT_MS`) rather than at the end of a probe,
because a probe is bounded at 15s + 30s + 90s of CLI calls and can outlast the
two-minute freshness window `/api/healthz` judges the host by. One slow wallet
call must not read as "the host is gone".

What a human has to do, read off the service itself:

```bash
URL=$(gcloud run services describe okx-chat-bot --region us-central1 \
  --project aerial-vehicle-466722-p5 --format='value(status.url)')
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/readyz" | jq .remedy
```

Two signatures are classified in
[scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), so `npm run triage:gcp`
explains them instead of filing them as unknown: `okx-bot-session-logged-out`
(owner action, needs the OTP) and `okx-bot-daemon-restart` (self-healing unless
the restart count climbs continuously).

A transition into a bad state fires an ops alert through `sendOpsAlert`, at most
once per `OKX_BOT_ALERT_REPEAT_MS` while it persists, so one overnight expiry
does not become a hundred notifications. Recovery fires a matching info alert.

Daemon stdout and stderr are forwarded into the worker's own log stream under a
`daemon` prefix, since that output is the only window into XMTP delivery.

## Related

- [scripts/okx-bot-revive.mjs](../../scripts/okx-bot-revive.mjs) stages the same workspace locally.
- [api/_lib/okx-chat-briefing.js](../../api/_lib/okx-chat-briefing.js) generates the subsession briefing.
- [workers/README.md](../README.md) is the worker index.
