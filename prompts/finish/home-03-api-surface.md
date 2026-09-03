# 03. The `/api/home/*` surface: REST, SSE, error contract

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[01](home-01-connection-store.md) and [02](home-02-bridge-runtime.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
ls api/_lib/home/                                        # store.js, verify.js, runtime.js
npx vitest run tests/home-store.test.js tests/home-runtime.test.js
sed -n '1,40p' api/agent-actions.js                      # the boundary pattern to copy verbatim
grep -rn "text/event-stream" api/feed-stream.js | head -3 # the SSE pattern to copy
grep -n "export const limits" -A 30 api/_lib/rate-limit.js | head -40
```

## The routes

Filesystem-routed under `api/home/`. No `vercel.json` entry is needed for `api/**` handlers; a
route entry IS needed for the page in order 05.

| Method + path | Auth | Does |
|---|---|---|
| `POST /api/home/connect` | session + CSRF | verify a `{ label, baseUrl, token }` against the real instance, then store it. Returns the connection and its measured capabilities. |
| `GET /api/home` | session or bearer | list the caller's homes, credential-free. |
| `GET /api/home/:id` | session or bearer | one home plus its current room graph snapshot. |
| `DELETE /api/home/:id` | session + CSRF | revoke. Idempotent. |
| `GET /api/home/:id/stream` | session | SSE. `graph`, `status` and `heartbeat` events. |
| `POST /api/home/:id/call` | session or bearer | a gated service call. Body `{ domain, service, data, confirmed }`. |
| `POST /api/home/:id/activate` | session or bearer | a phrase to a scene. Body `{ phrase, dryRun, confirmed }`. |
| `GET /api/home/:id/macros` | session or bearer | the house's scenes and scripts, for the UI and the agent. |
| `GET /api/home/:id/grants` / `POST` / `DELETE /api/home/:id/grants/:entityId` | session + CSRF | standing allowances. |
| `GET /api/home/:id/log` | session | the action log, paginated, newest first. |

Every handler: `wrap` + `cors({ methods, credentials: true })` + `method()` from
[`api/_lib/http.js`](../../api/_lib/http.js), exactly as
[`api/agent-actions.js`](../../api/agent-actions.js) does. Every mutating route: `requireCsrf`
for session callers. Every route: ownership through the store, never a post-fetch check.

## The error contract

One shape everywhere, because order 05 renders it and order 04 hands it to a model.

```json
{ "error": "human readable sentence", "code": "needs_confirmation", "pending": { } }
```

`code` is the `packages/home-bridge` `ERR` vocabulary plus the transport codes, so the client
needs one table and not two:

| `code` | HTTP | When | What the UI says |
|---|---|---|---|
| `bad_url` | 400 | not a URL, or plain http from an https origin | use your remote https URL |
| `auth` | 401 from HA, surfaced as 400 | HA rejected the token | create a new long-lived token |
| `unreachable` | 502 | no answer | your home may be LAN-only; offer order 10's path |
| `needs_confirmation` | **409** | a guarded action with no explicit yes | render `pending` and ask |
| `no_mcp` | 200 with a flag, never an error | `mcp_server` not enabled | optional upgrade, with the setting path |
| `call_failed` | 502 | connected, request failed | the message, verbatim |
| `not_connected` | 503 | breaker open or connecting | retry, with the reason |
| `not_found` | 404 | not the caller's home | nothing about existence |

**409 for `needs_confirmation` is deliberate.** It is a conflict with the current authorization
state, it is retryable with the same body plus a confirmation, and it must never be a 403 (which
clients treat as terminal) or a 200 (which a model would read as success).

## The SSE stream

Copy the framing in [`api/feed-stream.js`](../../api/feed-stream.js). Requirements:

- `event: graph` with the room graph, on every coalesced rebuild.
- `event: status` on connect, disconnect, reconnect and breaker state, carrying `{ status, detail, stale }`.
- `event: heartbeat` every 25 s, because idle proxies close silent streams.
- The first `graph` is sent immediately on open from the snapshot, so the page paints without waiting for a device to change.
- `req.on('close')` unsubscribes and releases. Verify no leak with `stats()` after a client disconnects mid-stream.
- One stream per home per connection. A second stream from the same session is allowed but must share the pooled bridge, not open a second socket.

## Rate limits

Use `limits` from [`api/_lib/rate-limit.js`](../../api/_lib/rate-limit.js). Three buckets, and the
reason each is separate:

| Bucket | Routes | Why |
|---|---|---|
| read | `GET /api/home*`, `macros`, `log` | cheap, cache-backed |
| act | `call`, `activate` | touches physical hardware; a runaway loop is a real-world event, not a bill |
| connect | `connect`, verification | expensive, opens a socket to a third party, and is the credential-stuffing surface |

The `act` bucket must be tight enough that a broken client cannot cycle a garage door. State the
chosen numbers in your report with the reasoning.

## Tasks, in risk order

| # | Task | Files |
|---|---|---|
| 1 | The error contract as a shared module, so handlers and order 04's tools cannot disagree. | `api/_lib/home/errors.js` |
| 2 | `POST /api/home/connect` with real verification, and `GET`/`DELETE`. | `api/home/index.js`, `api/home/[id].js` |
| 3 | The gated `call` and `activate` routes, returning 409 with `pending` intact. | `api/home/[id]/call.js`, `api/home/[id]/activate.js` |
| 4 | The SSE stream with heartbeat, close handling and the stale flag. | `api/home/[id]/stream.js` |
| 5 | Grants and the action log routes. | `api/home/[id]/grants.js`, `api/home/[id]/log.js` |
| 6 | Every write path calls `logHomeAction` with the verdict, including refusals. A refused unlock is the most important row in the table. | all of the above |
| 7 | Tests: contract tests per route, an SSE lifecycle test, an ownership matrix, and a live test that drives a real house end to end. | `tests/api-home.test.js`, `tests/api-home-live.test.js` |
| 8 | Document every route in `docs/api-reference.md` following the neighbouring entries. | `docs/api-reference.md` |

## Definition of done

- [ ] `curl` transcripts in your report for: connect, list, snapshot, a plain call, a guarded call refused with 409, the same call confirmed, activate with `dryRun`, revoke, and revoke again.
- [ ] The guarded 409 body carries `pending` with the resolved `entityId` and `risk`.
- [ ] An unauthenticated request to every route returns 401 and never leaks whether the id exists.
- [ ] User B gets 404 (not 403) on user A's home id, on every route.
- [ ] A CSRF-less mutating request from a session is refused.
- [ ] SSE: open a stream, change a real light in Home Assistant, and the `graph` event arrives with the new state. Paste the raw stream.
- [ ] SSE: kill the client mid-stream, then `stats()` shows the subscriber released and, after the idle window, the socket evicted.
- [ ] SSE: stop the HA container and the stream emits `status` with `stale: true` and keeps the last graph, rather than closing or emptying.
- [ ] Rate limits: exceed the `act` bucket and get a designed 429 with a `retry-after`.
- [ ] Every write, including refusals, produced a `home_action_log` row. Paste the table.
- [ ] `npx vitest run tests/api-home.test.js` passes, plus the whole suite: `npx vitest run --root .` with no new failures.
- [ ] `npm run check:rules -- --paths <your files>` clean, `npm run audit:docs` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| Deciding between 403 and 404 for another user's home | 404. Never confirm the existence of a resource across a tenancy boundary. |
| Wanting to return 200 with an error field for a guarded action | Refuse. A model reads 200 as success. 409 with a `code` is the contract. |
| SSE behind the CDN | The purge and cache rules are in `docs/ops/gcp-production.md`. Set `cache-control: no-store` and `x-accel-buffering: no` on the stream, and verify against production, not localhost. |
| A route needs an entry in `vercel.json` | `api/**` handlers are filesystem-routed and do not. Pages do. Read the file before adding anything to it: it is live config the server parses on boot. |
| Tempted to add an unauthenticated public read | There is no such thing here. Every row is somebody's house. |

## Report format

1. Every curl transcript listed above.
2. The raw SSE capture across a real device change and a real disconnect.
3. The `home_action_log` rows produced, including the refusal.
4. The chosen rate-limit numbers and the reasoning.
5. Full-suite test output.
6. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-03-api-surface.md

Never delete it on a partial.
