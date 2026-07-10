# agent-anchor — Newsroom Anchor worker

A long-lived Node process that turns three.ws's live market intel into a
rolling on-air broadcast. Every cadence tick (default 90s) it pulls the real
intel feeds, asks the brain to script a tight anchor read, and publishes it so a
lip-synced avatar on `/agent-screen` reads the bulletin aloud.

It is deliberately **not** a scheduled cron: it holds state across ticks (an
overlap guard, the boot frame, graceful shutdown) and runs continuously.

The package (`@three-ws/agent-anchor`) is `"private": true` — an internal
worker, **not published to npm**. Consume it by running the process, not by
`npm install`.

## What it does

Each bulletin (`index.js` → `runBulletin`) runs five stages, each of which
degrades gracefully so a dead feed narrows the read instead of going silent:

1. **Gather** (`anchor-client.js` → `gatherBrief`) — fetches three real feeds
   concurrently:
   - `GET /api/aixbt/intel?limit=12` — aixbt narrative intel, the spine of every
     bulletin.
   - `POST /api/social/sentiment-pulse` — pump.fun-comment sentiment for the
     house ticker ($THREE by default).
   - Dexscreener token API — a live price/volume snapshot for the house ticker
     (the same public, key-free source the `pump_snapshot` MCP tool uses),
     picking the highest-24h-volume pair.
2. **Merge** (`brief.js` → `mergeBrief`) — folds the raw payloads into a compact,
   anchor-ready briefing: top 3 narratives (official/most-observed first), a
   sentiment label, a market snapshot, and an `offline` list of feeds that
   didn't return (so the prompt never invents data for them).
3. **Script** (`scriptBulletin`) — streams `POST /api/brain/chat` (SSE),
   accumulating the fragments into a 2–4 sentence anchor read. Uses the free,
   anon-allowed `gpt-oss-120b` provider so it never burns a billed key. The
   system prompt forbids buy/sell calls and forbids naming any ticker other than
   $THREE.
4. **Split** (`splitScript`) — separates the read into a lower-third **headline**
   (≤120 chars) and a spoken **body** (≤700 chars), tolerant of the model
   dropping the `HEADLINE:` marker.
5. **Publish + push** —
   - `publishScript` → `POST /api/agent/anchor-script` stores the spoken body in
     Redis (TTL 180s) so viewers' browsers can fetch and speak it.
   - `screenPush` (`screen-push.js`) → `POST /api/agent-screen-push` pushes the
     headline as a `type:'analysis'` frame. If the optional `canvas` package is
     installed it also renders a broadcast-style lower-third PNG; otherwise it
     pushes a text-only frame (the `/agent-screen` client draws the real
     lower-third + talking avatar either way).

Viewers on `/agent-screen` subscribe to the frame stream
(`src/agent-screen-anchor.js`), fetch the matching script, synthesize real
speech, and lip-sync the avatar to it.

## Files

| File | Role |
|------|------|
| `index.js` | Entrypoint. Cadence loop, overlap guard, boot frame, JSON-line logging, graceful SIGINT/SIGTERM shutdown. |
| `anchor-client.js` | Live integrations — feed fetches, the streamed `/api/brain/chat` call, and the script publish. |
| `brief.js` | Pure, dependency-free feed-merge + prompt-build + script-split logic (unit-tested, no network). |
| `screen-push.js` | Fire-and-forget headline push; optional `canvas`-rendered broadcast frame. |

The pure core in `brief.js` is covered by `tests/anchor-brief.test.js`
(`mergeBrief`, `briefDigest`, `buildAnchorMessages`, `splitScript`).

## Public exports per module

`index.js` is the executable entrypoint (no exports); the other three modules
export the pieces of the pipeline so they can be reused and unit-tested:

**`anchor-client.js`** — live three.ws integrations:

| Export | Signature | Purpose |
|---|---|---|
| `gatherBrief` | `() → Promise<brief>` | Fetch the three feeds concurrently and return a merged briefing. |
| `scriptBulletin` | `(brief) → Promise<string>` | Stream `POST /api/brain/chat` (SSE) into the full anchor read; throws on an upstream error or empty script. |
| `publishScript` | `({ headline, body, brief }) → Promise<void>` | Store the spoken body via `POST /api/agent/anchor-script` (no-op without `AGENT_JWT`/`AGENT_ID`). |

**`brief.js`** — pure, dependency-free merge/split logic:

| Export | Kind | Purpose |
|---|---|---|
| `HEADLINE_MAX` | `120` | Lower-third headline char cap. |
| `BODY_MAX` | `700` | Spoken-body char cap. |
| `ACTIVITY_MAX` | `320` | Screen-frame `activity` field cap (mirrors the push endpoint). |
| `MAX_ITEMS` | `3` | Narratives read on air per bulletin. |
| `sentimentLabel` | `(score) → string\|null` | Human label for a `[-1,1]` sentiment score. |
| `fmtUsd` | `(v) → string\|null` | Compact USD formatting (`$1.2M`, `$940K`, `$0.04`). |
| `mergeBrief` | `(feeds) → brief` | Fold raw `{ intel, sentiment, pump }` payloads into the anchor briefing. |
| `briefDigest` | `(brief) → string` | Deterministic plain-text digest handed to the brain. |
| `buildAnchorMessages` | `(brief) → { system, messages }` | Build the `POST /api/brain/chat` payload. |
| `splitScript` | `(script) → { headline, body }` | Split a scripted read into headline + spoken body. |

**`screen-push.js`**:

| Export | Signature | Purpose |
|---|---|---|
| `screenPush` | `(activity, type = 'analysis') → void` | Fire-and-forget frame push to `POST /api/agent-screen-push`; optionally renders a `canvas` broadcast frame. No-op without `AGENT_JWT`/`AGENT_ID`. |

## Env

| var | default | meaning |
|-----|---------|---------|
| `AGENT_JWT` | — | Anchor agent's bearer JWT. **Required to push** — without it, script/frame pushes are skipped (gather + script still run). |
| `AGENT_ID` | — | Anchor agent's UUID. **Required to push.** |
| `ANCHOR_CADENCE_MS` | `90000` | ms between bulletins (floored at 15000). |
| `ANCHOR_API_BASE` / `API_BASE` | `https://three.ws` | three.ws API origin. |
| `ANCHOR_TOKEN_MINT` | `$THREE` mint (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) | House ticker for sentiment + flow. |
| `ANCHOR_BRAIN_PROVIDER` | `gpt-oss-120b` | Brain provider (must be an anon-allowed free model to run signed-out). |
| `PUSH_URL` | `https://three.ws/api/agent-screen-push` | Screen-push endpoint. |

`canvas` is an **optional** dependency: install it to render the desk/lower-third
PNG frame; omit it for text-only frames.

## Run

The worker has no compiled build and no HTTP port — it's a plain long-lived Node
process (Node ≥ 22). From the repo root:

```bash
AGENT_JWT=<anchor-agent-jwt> AGENT_ID=<anchor-agent-uuid> \
  node workers/agent-anchor
```

or, from this directory, `npm start` (`node index.js`). Point it at a local
stack with `ANCHOR_API_BASE=http://localhost:3000` while `npm run dev` is up.

It fires the first bulletin immediately, then every `ANCHOR_CADENCE_MS`, and logs
one JSON line per event to stdout/stderr (`{ t, level, tag: "agent-anchor", msg,
… }`) for grep-friendly log search.

## Endpoints it consumes

All are real three.ws API calls (no mocks):

- `GET  /api/aixbt/intel?limit=12`
- `POST /api/social/sentiment-pulse` — `{ token, limit }`
- `POST /api/brain/chat` — SSE, `{ provider, system, messages, maxTokens }`
- `POST /api/agent/anchor-script` — `{ agentId, headline, body, offline }` (auth: agent JWT)
- `POST /api/agent-screen-push` — `{ agentId, frame }` (auth: agent JWT)
- `https://api.dexscreener.com/latest/dex/tokens/<mint>` — public price/volume

## Verify the pipeline

Read back the last script the running anchor stored (the GET side is public):

```bash
curl "https://three.ws/api/agent/anchor-script?agentId=<anchor-agent-uuid>"
# → { "ok": true, "script": { "ts": …, "headline": "…", "body": "…", "offline": [] } }
```

A `null` script means no bulletin has published in the last 180s (the worker is
stopped, or every feed and the brain were down that cycle).
