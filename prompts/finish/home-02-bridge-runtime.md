# 02. Bridge runtime: the multi-tenant connection manager

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Order
[01](home-01-connection-store.md) must have landed: this order reads its store.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated. Every architectural decision here is already made; implement it
and note disagreement in your report rather than stopping.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
ls api/_lib/home/                                        # expect store.js and verify.js from order 01
npx vitest run packages/home-bridge tests/home-store.test.js
grep -rn "minScale\|min-instances" docs/ops/gcp-production.md | head
gcloud run services describe three-ws-api --region us-central1 --format='value(spec.template.metadata.annotations)' 2>/dev/null | tr ',' '\n' | grep -i scale
```

That last command is the one that decides this order's design. Read it before you write code.

## The problem this order exists to solve

`packages/home-bridge` opens one WebSocket per `HomeBridge` and holds it. Cloud Run runs many
instances, scales to zero, and recycles containers. Naively constructing a `HomeBridge` per
request would open and tear down a socket per call, hammer the user's house, and lose the live
state stream that the 3D scene depends on. Naively holding one forever per user would leak
sockets across instance recycles and pin a user to an instance that may not receive their next
request.

**The design: a per-instance, lazily-opened, reference-counted, idle-evicted connection pool,
with the socket treated as a cache and never as the source of truth.**

Every consumer (an SSE stream, a chat tool call, an MCP call) checks out a bridge, uses it, and
checks it back in. The pool opens a real connection on the first checkout and closes it after a
bounded idle period with no subscribers. A request that arrives at an instance holding no
connection opens one; that is a cold start of a few hundred milliseconds, not an error.

## The contract

New file `api/_lib/home/runtime.js`.

| Export | Contract |
|---|---|
| `acquire(homeId, userId)` | returns `{ bridge, release }`. Opens the connection if this instance holds none, reusing it otherwise. Increments the refcount. `release()` is idempotent and must be called in a `finally`. |
| `withHome(homeId, userId, fn)` | the shape every caller should use: acquires, runs `fn(bridge)`, releases in a `finally`, and never leaks a socket on a throw. |
| `snapshot(homeId, userId)` | the current room graph without holding the connection open past the call. Serves a page load. |
| `subscribe(homeId, userId, onGraph)` | a live subscription for SSE. Returns an unsubscribe. Holds a reference for its lifetime. |
| `evictIdle(now)` | closes connections with zero subscribers past the idle window. Called on a timer and exported so a test can drive it deterministically. |
| `stats()` | `{ open, subscribers, byStatus }` for the health probe in order 13. |

### The numbers, and why

| Knob | Value | Reason |
|---|---|---|
| Idle eviction | 90 s after the last subscriber releases | Long enough that a page navigation or a chat turn reuses the socket; short enough that an abandoned tab does not hold a stranger's house open. |
| Max open connections per instance | 200, configurable by `HOME_MAX_CONNECTIONS` | A socket plus a state map is roughly 1 to 3 MB of heap for a large house. Past the cap, `acquire` serves from a fresh short-lived connection and does not admit to the pool, so behaviour degrades in latency, never in correctness. |
| Connect timeout | 15 s | A house behind a slow tunnel is common; a hang is not. |
| Reconnect backoff | delegated to `home-assistant-js-websocket`, which reconnects and resubscribes on its own | Do not write a second reconnect loop on top of it. |
| Circuit breaker | 5 consecutive connect failures opens it for 5 minutes for that home id | Stops a revoked token or an offline house from being retried on every page load. `status` in the store is updated so the UI can explain it. |
| Graph rebuild coalescing | already 80 ms inside `HomeBridge` | Do not add a second debounce. |

### Failure behaviour, per hop

| Hop | Slow | Down | Garbage | Nothing |
|---|---|---|---|---|
| Store read (order 01) | normal DB latency | `acquire` throws a coded error, the caller returns 503 | a revoked row is not acquirable at all | unknown home id to this user is a 404, never a 403 that leaks existence |
| Token decrypt | n/a | a decrypt failure marks the connection `auth_failed` and is reported to the user as "reconnect your home", never as a server error | n/a | a scrubbed (revoked) ciphertext returns the revoked path |
| HA handshake | 15 s cap, then `unreachable` with the elapsed time | breaker opens after 5, store status updated, UI explains | an HTTP endpoint that is not Home Assistant returns `unreachable` with the detail | empty entity set is a valid house, not an error |
| Live socket after connect | the library reconnects itself; subscribers see stale-then-fresh, never an error toast | subscribers are told `disconnected` and the graph is marked stale rather than emptied | a malformed message is dropped and logged once, not per message | no state within 5 s of connect resolves with an empty graph, and the UI shows its empty state |
| Instance recycle | n/a | every connection dies at once; the next request reopens. This is normal and must never page anyone. | n/a | n/a |

**The graph must never be emptied on disconnect.** A user watching their 3D home should see it
go grey and stale, not watch their house vanish. That distinction is the whole difference between
a product and a demo.

## Tasks, in risk order

| # | Task | Files |
|---|---|---|
| 1 | The pool itself: `acquire`, `release`, refcounting, the cap, idle eviction, `stats`. Pure enough to test without a network by injecting the bridge factory. | `api/_lib/home/runtime.js` |
| 2 | The circuit breaker, keyed by home id, with the store status write on open. | same |
| 3 | `subscribe` and `snapshot` on top of the pool. | same |
| 4 | The eviction timer, started once per process, cleared on shutdown, and safe under Cloud Run's SIGTERM. | same |
| 5 | Tests: refcount correctness, no socket leak on a throwing `fn`, eviction at the boundary, breaker open and close, cap behaviour, stale-not-empty on disconnect. | `tests/home-runtime.test.js` |
| 6 | A live test against a real HA proving reuse: two `withHome` calls in a row open exactly one socket. | `tests/home-runtime-live.test.js`, self-skipping on `HOME_ASSISTANT_URL` |

## Definition of done

- [ ] Two sequential `withHome` calls against a real instance open one socket, proved by a counter on the injected factory and by the HA side (`gauge` the connection count via the instance's own logs or `docker logs`).
- [ ] A `withHome` whose callback throws still releases: `stats().subscribers` returns to 0.
- [ ] After the idle window with no subscribers, `evictIdle` closes the socket and `stats().open` drops.
- [ ] Five consecutive failed connects open the breaker; the sixth `acquire` fails fast (under 50 ms) rather than waiting out a 15 s timeout. Assert the elapsed time.
- [ ] The store's `status` and `status_detail` reflect the breaker state, so order 05's UI can render a real reason.
- [ ] Killing the HA container mid-subscription leaves the last graph readable and marked stale; restarting it restores live updates with no client action.
- [ ] `stats()` is exported and shaped for order 13.
- [ ] `npx vitest run tests/home-runtime.test.js packages/home-bridge` passes.
- [ ] `npm run check:rules -- --paths <your files>` is clean.

## Never blocked

| Blocker | Do this |
|---|---|
| Cloud Run scales to zero and kills connections | That is expected and designed for. The pool is a cache, not state. Never add a `minScale` to keep sockets warm without reading `docs/ops/gcp-credits-plan.md` first, and never as a fix for a design that assumed persistence. |
| You want a global connection registry across instances | You do not, and it would need a second datastore. The house is the source of truth; a cold instance reopens in a few hundred milliseconds. Revisit only with a measured latency complaint. |
| A house has thousands of entities and the graph rebuild is slow | Measure it before optimizing. `buildHomeGraph` is a pure function over arrays; if it is genuinely hot, memoize per registry version, not per state change. |
| The reconnect logic seems to need improving | It lives in `home-assistant-js-websocket`, is first-party, and reconnects and resubscribes on its own. Fixing it means a PR upstream, per the CLAUDE.md open-source rule, not a wrapper here. |
| SIGTERM handling looks like someone else's problem | It is this order's. A container that dies without closing sockets leaves the user's Home Assistant holding dead connections until its own timeout. Close them. |

## Report format

1. The socket-reuse proof, with the counter output and the HA-side observation.
2. The breaker timing measurement.
3. The kill-and-restart transcript showing stale-not-empty.
4. `stats()` output under load.
5. Test output, verbatim.
6. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every Definition of done line against real output, append to
`prompts/finish/home-PROGRESS.md`, then commit with explicit paths and delete this file in the
same commit:

       git rm prompts/finish/home-02-bridge-runtime.md

Never delete it on a partial.
