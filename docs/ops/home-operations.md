# Home operations: SLOs, the three alerts, and the incident runbook

The Home lane connects a person's real house (Home Assistant) to a three.ws
agent. Its operational problem is unlike every other lane here, and the whole of
this document follows from it:

> **Most failures in this lane are not ours.** A user's Home Assistant is powered
> off, their token expired, their broadband dropped, their reverse proxy
> certificate lapsed. From one connection, that looks exactly like an outage.

So the rule, stated once and enforced in code:

- **A per-tenant failure never alerts.** It is a state that user sees in their own
  UI and their own action log. Paging an operator because a stranger unplugged a
  router trains everyone to ignore the channel, and then the real outage arrives
  unread.
- **A correlated failure across tenants is an alert.** Ten houses do not go dark
  at the same moment on their own. That is a deploy, an egress change or DNS, and
  it is almost always us.
- **Confirmation integrity is neither.** A guarded physical action that executed
  without a human saying yes is a Sev 1 at a volume of one row.

## Where the numbers come from

| Piece | Location |
|---|---|
| The sensor | [`api/_lib/ops/home-health.js`](../../api/_lib/ops/home-health.js) |
| Surfaced as | the `home` subsystem in `GET /api/healthz` and `GET /api/status` |
| The alerts | [`api/cron/home-health-alert.js`](../../api/cron/home-health-alert.js), every 5 minutes |
| The pool gauges | `stats()` in [`api/_lib/home/runtime.js`](../../api/_lib/home/runtime.js) |
| The per-tenant view | [`api/_lib/home/health.js`](../../api/_lib/home/health.js), served by `GET /api/home/:id/health` |
| The tables | `home_connections`, `home_action_log`, `home_confirmations` |

Every rate is computed **across tenants** over a 15 minute window, and each one
has a floor below which it is reported but not scored:

| Rate | Floor | Why |
|---|---|---|
| Handshake success | 10 connected homes (`MIN_HOMES_FOR_A_VERDICT`) | With three homes, one holiday cottage losing power is a 33% failure rate. |
| Action success | 20 actions (`MIN_ACTIONS_FOR_A_VERDICT`), and failures in more than one home | A house whose Z-Wave stick fell out fails everything sent to it. Paging for that is paging for a loose USB port. Failures confined to one home do not move the verdict at all, and are still named in the detail. |
| Confirmation expiry | 10 decided confirmations (`MIN_CONFIRMATIONS_FOR_A_VERDICT`) | Three prompts in a quiet hour, two of them from someone who walked away from their laptop, is not a UI failure. |

Below a floor the subsystem reports the numbers and stays green, saying so:

```
14/14 homes connected; handshakes 100.0% over 3 homes in 15m; actions 93.3% of 30
across 5 homes, 2 failed in 1 home (that house, not us); confirmations 75.0%
expired of 4 (under the 10-confirmation floor, reported not scored); ...
```

### The thresholds

| Signal | Source | Green | Yellow | Red |
|---|---|---|---|---|
| Handshake success | `home_connections.last_ok_at` / `last_error_at` | over 95% | 80 to 95% | under 80% |
| Action success | `home_action_log.outcome` | over 98% | 95 to 98% | under 95% |
| Confirmation expiry | `home_confirmations` | under 20% | 20 to 40% | over 40% |
| Breaker-open homes | `runtime.stats()` | under 2% | 2 to 10% | over 10% |
| p95 action latency (our leg) | `home_action_log.detail->>'latencyMs'` | under 1.5 s | 1.5 to 4 s | over 4 s |
| Subscriber leak | `stats().subscribers` over three checks | flat or falling | climbing with flat connections | climbing with flat connections |
| Confirmation integrity | `home_action_log`, excluding standing grants | zero rows | n/a | any row |

A **refused** action counts as a success. The safety gate refusing to open a
front door is the product working, not a failure to deliver, and scoring it as an
error would make the safest houses look like the sickest ones.

A guarded action with no `confirmed_by` is **not** on its own a violation, and
finding that out against real rows is what stopped this alert from firing on
every legitimate unlock. A standing per-entity allowance in `home_entity_grants`
is a yes the user already gave, recorded once rather than re-asked every time, so
the act path clears the gate through the allow list and stamps
`detail.allowed_by_grant`. Those rows are counted and reported
(`integrity.grantBacked`), never paged. What remains a Sev 1 is the shape with no
yes behind it at all: guarded, executed, nobody confirmed it, and no grant
claimed.

### Why one broken house scores `ok` and not `degraded`

`degraded` looks like the cautious middle ground here. It is not.
[`api/cron/uptime-check.js`](../../api/cron/uptime-check.js) escalates a degraded
subsystem exactly like a down one and re-pages it roughly hourly for as long as
it lasts, so a single user whose Z-Wave stick fell out would page an operator
every hour indefinitely. That is the alert fatigue this whole lane is built to
avoid, arriving through the status field instead of through an alert.

Measured, not reasoned: on 2026-09-03 the live fleet sat at `degraded` from 1
failed action out of 23, in 1 home out of 25 connected.

The failure is not swallowed. It stays in the subsystem `detail`, it is in that
home's own action log, and its owner is told directly by the per-tenant surface
below. **A per-tenant fault has an audience of exactly one, and it is not the
operator.**

If you are about to raise this back to `degraded` to "make it visible", the thing
you want is the per-tenant surface, not the pager.

## The per-tenant surface: where one dark house is actually reported

Everything above is deliberately deaf to a single failing home. That is only
honest because the household itself is told, by:

| Piece | Location |
|---|---|
| The verdict | `tenantHealthVerdict` in [`api/_lib/home/health.js`](../../api/_lib/home/health.js) |
| The route | `GET /api/home/:id/health` ([`api/home/[id]/health.js`](../../api/home/[id]/health.js)) |
| The UI | `healthPanel` in [`src/home/manage.js`](../../src/home/manage.js), on `/smart-home` |

It answers one question: **is this me or is it you.** The `fault` field is
`none`, `your_home`, `us`, or `unknown`, and `unknown` is a real answer we are
willing to give. Telling somebody "check your router" during our own outage costs
them an evening on hardware that was never broken, so `your_home` is only ever
returned when the fleet is provably fine.

The user-facing half of the correlation query lives here too: the response
carries `fleet.othersFailing`, a count of other homes failing right now, and
nothing else about them. A user is entitled to know whether they are alone in
this. They are not entitled to anything about a stranger's house.

Two load strategies, on purpose. A house that already looks unhealthy fetches its
health immediately, because somebody staring at a red dot should not have to find
and open a panel to learn why. A house that looks fine waits to be asked, so a
user with six working homes pays no extra round trips.

Checking one house by hand:

```bash
curl -s -b "$COOKIE" https://three.ws/api/home/$HOME_ID/health | jq .health
```

## The SLOs

| SLO | Target | Window | Error budget |
|---|---|---|---|
| Action availability (our side) | 99.5% of actions reach the house or return a designed error | 30 days | 3.6 hours |
| Action latency | p95 under 1.5 s, our leg only, excluding the house | 30 days | |
| State freshness | p95 under 2 s from a device change to the SSE event | 30 days | |
| **Confirmation integrity** | **100%. No exceptions.** | always | **zero** |

The last row is not an availability target, it is a correctness invariant. A
guarded action executing without a valid confirmation is a Sev 1 regardless of
volume, regardless of how many succeeded, and regardless of whether any user
noticed. There is no budget to spend and no rate at which it becomes acceptable.

**Pre-launch baseline (measured 2026-09-03, development database, not
production):** 14 connected homes, 30 actions in the window across 5 homes (93.3%
succeeding or refused, the 2 failures confined to one house), p95 our-leg latency
412 ms on the one action carrying a timing, 2 guarded actions cleared by a
standing grant, zero integrity violations. The act path does not yet stamp
`detail.latencyMs` on every action, so the p95 above rests on a single sample and
the sensor says `no action timings recorded` rather than inventing one.
Re-measure against production traffic in order 20.

---

## The scale envelope

Every number in this section was measured on 2026-09-03 against a fleet of **12
real Home Assistant containers** started by
[`scripts/home-fleet.mjs`](../../scripts/home-fleet.mjs): real onboarding, real
long-lived access tokens, real registries seeded with two floors and seven areas
each, and real WebSocket sessions opened through `home-assistant-js-websocket`,
the same client the product ships. The raw output is committed at
[`tasks/home/envelope-2026-09-03.json`](../../tasks/home/envelope-2026-09-03.json).

**What was real and what was not**, stated plainly because the difference decides
how much these numbers are worth:

- **Real:** every connection, every handshake, every registry read, every service
  call, every state push. Eleven houses of 115 to 123 entities and one of 624,
  all running `ghcr.io/home-assistant/home-assistant:stable` (reporting
  `2026.9.0`).
- **Not one-to-one:** 400 connections were spread round robin across 11 houses
  rather than opened against 400 separate houses. What is being measured is what
  a connection costs **this process**: a socket, an entity state map and a room
  graph. Which container answers is the fixture.
- **The box was busy, and badly.** The harness shares a 16 core machine with
  other work, and the committed run was taken at a **load average between 206
  and 233**. Memory, descriptor, coalescing and byte counts are unaffected by
  that and were stable to within a few percent across four separate runs at loads
  from 22 to 233. **The latency and timing figures are inflated by it**, heavily,
  which is why every row records the load average it was taken at, why the quieter
  readings are given alongside where they exist, and why none of these numbers is
  an SLO. The SLO targets are in the table above and are measured against
  production, not against this harness.

### The envelope

| Volume | Connections per instance | Heap | p95 action | Behaviour |
|---|---|---|---|---|
| **10 homes** | 10, all pooled | **4.1 MB** (407 KB each) | 12.3 ms at load 224 | Everything inline. Nothing to tune; no rung above 1 is ever reached, on any instance, ever. |
| **1,000 homes** | 167 at `minScale=6`; measured at 200 | **49 MB** (250 KB each) | 49.8 ms at load 227 | Still rung 1. The pool never fills, eviction never runs, the ladder stays dormant. Measured directly: 200 connections is above the 167 this volume implies. |
| **100,000 homes** | 600 (the cap), extrapolated | **143 MB heap, ~380 MB RSS** | not measured | **Does not fit as simultaneously live homes.** 100,000 *registered* homes is only rows and is comfortable; 100,000 *live at once* exceeds the fleet. The model and the ceiling are below. |

The 10 and 1,000 rows are measured. The 100,000 row is the extrapolation, and the
model behind it is stated in full below rather than hidden inside a number.

### The unit costs, each measured

| Cost | Measured | How |
|---|---|---|
| Heap per idle connection, small house (123 entities) | **245 KB** at 400 connections; 250 KB at 200, 260 KB at 100, 280 KB at 50 | Two forced collections either side of opening N connections, in a process that has done nothing else. The figure falls with N because a fixed baseline amortizes, so 245 KB is the asymptote and the one to size on. Stable to 4 KB across four runs. |
| Heap per connection, large house (624 entities) | **856 KB** | Same method against the 624 entity house: 3.5x the small house for 5.1x the entities, because the room graph is shared per house and the state map is not. |
| RSS per connection, small house | **643 KB** at 400, 716 KB at 200 | Same window as the heap reading. |
| RSS per connection, large house | **~1.1 MB** (estimate) | Not measured at a high enough connection count to amortize the baseline. Scaling the 400 connection small-house RSS by the measured large/small ratio at equal count gives 1.09 MB; scaling by the heap ratio gives 2.3 MB. The cap below is sized on the conservative one. |
| File descriptors per connection | **exactly 1**, and back to the baseline of 22 after close | `/proc/self/fd`, before, during and after, at every tier from 10 to 400. |
| Heap retained after close | **5 KB per connection** at 400, 10 KB at 200 | Two forced collections and a five second settle, with the harness's own references dropped first. This is noise, not a leak, and the descriptor count returning to exactly its baseline is the corroborating half. |
| Idle CPU per connection | **3.0 to 4.6 ms per connection per minute** at 100 to 400 connections | A ten second window with the connections open and nothing asked of them. Under 0.008% of one core per connection, on a box at load 220, and Home Assistant's demo integration is pushing state on its own throughout. |
| CPU per burst of 100 entity updates | **44.1 ms total, 0.441 ms per update** | 100 real `input_number.set_value` calls against the 624 entity house, measured across the whole absorb window: the outbound calls, the state pushes they caused, and every graph rebuild that survived coalescing. |
| Graph rebuilds per 100 updates | **1** (a 100:1 coalescing ratio) | The 80 ms coalescing window in `HomeBridge` doing its job. |
| One graph rebuild, 624 entities | **p50 0.49 ms, p95 1.02 ms** | `buildHomeGraph` called 30 times against the live state map. A thirtieth of a 16.7 ms frame. |
| Connection open time | **6 to 83 ms per connection** in waves of 20 | Wall clock across the wave, divided by connections. The high end is the 10 connection tier, where a single wave carries the whole warm-up. |
| Cold start to the first connected home | **270 to 552 ms of Home Assistant handshake**, on top of node boot | A freshly spawned process. Node plus this harness's module graph read 147 ms on a quiet box, 758 ms at load 70 and 3,165 ms at load 224, so the total ranges from **260 ms to 3.7 s** almost entirely as a function of how contended the machine is. The handshake itself, which is the part this lane owns, never exceeded 552 ms. |
| **SSE: heap per subscriber** | **39 KB** | 200 real HTTP subscribers against a real server, fed by a real house that is being changed throughout. |
| **SSE: RSS per subscriber** | **143 KB** (upper bound: both ends of every socket are in the one process) | Same window. |
| **SSE: descriptors per subscriber** | **1 server side** (2 measured, both ends in one process) | Same window. |
| **SSE: bytes per frame per subscriber** | **25,168 bytes** | 20 real state changes fanned to 200 subscribers: 4,000 frames and **100.7 MB in ten seconds**. |
| **SSE: CPU per subscriber per minute** | **36.2 ms** at two state changes a second | 1,207 ms of CPU in the same ten second window: 12% of one core for one house with 200 watchers. |

Two of those deserve to be read twice.

**The SSE frame is 25 KB and it is the whole room graph.** A house that changes
once a second, watched by 200 people, is 5 MB a second of egress from one
instance for one house. That is the single most expensive thing in this lane and
it is not the socket, it is what goes down it. The state channel should send a
diff rather than a graph; until it does, the stream cap below is set by bandwidth
rather than by memory.

**Coalescing is doing an enormous amount of work.** One hundred entity updates
collapse into one graph rebuild. Without the 80 ms window the same burst would be
100 rebuilds and 100 SSE frames, which at 25 KB each is 2.5 MB per subscriber for
a burst a user would experience as one event. Chaos scenario 7 shows the same
thing at a sustained rate: ten updates a second for a minute against a 624 entity
house became 61 rebuilds, not 600.

### Where the single-instance model breaks, and what replaces it

The extrapolation, stated as a model so it can be checked rather than believed:

```
live homes the fleet can hold  =  P x I / D

  P  pooled connections per instance   = 600   (HOME_MAX_CONNECTIONS, derived below)
  I  instances                         = 6 to 100   (minScale to maxScale, read off the service)
  D  duplicate factor                  = how many instances hold a socket to the SAME house
```

`P` is measured. `I` is configuration. **`D` is the one that is not measured**,
and it is the term that decides the answer. `sessionAffinity=false` on
three-ws-api, so two requests about the same home land on arbitrary instances and
each one opens its own socket to that house. `D` is therefore somewhere between
1 (a home used from a single long-lived stream) and `I` (a home hammered from
many short requests inside its 90 second idle window). Measuring it needs the
order 03 endpoints deployed and real traffic on them; it is the first thing to
measure after launch.

At `D = 1` the fleet holds **60,000 simultaneously live homes**. At `D = 3` it
holds 20,000. Either way:

> **100,000 simultaneously live homes does not fit the single-instance pool
> model, and it is the duplicate sockets rather than the memory that breaks it
> first.** 100,000 *registered* homes is not the hard part: a registered home is
> a row, and a home only occupies a socket while somebody is looking at it or
> acting on it plus a 90 second idle window. At a 5% concurrent share, 100,000
> registered homes is 5,000 live ones, which is nine instances and entirely
> comfortable.

**The named successor**, for when concurrency really does reach five figures:
route by home id. One instance owns one house's socket, and every other instance
reaches it over an internal call rather than opening a second socket. Cloud Run's
own session affinity does **not** do this, because it pins a client to an
instance rather than a resource, so this is a consistent-hash router in front of
a dedicated home-connection service, with the API instances as its clients. That
change makes `D = 1` by construction and moves the ceiling to `P x I`, which at
the measured `P` is 60,000 per region before any of the numbers above have to be
revisited.


---

## The backpressure ladder

The lane runs out of room in a way a request/response lane never does: not as a
latency curve but as a wall, because both of its resources (a socket to a house,
a stream to a browser) are held rather than served. The ladder is where that wall
is decided, and it is deliberately a separate module from the pool that hits it:
[`api/_lib/home/admission.js`](../../api/_lib/home/admission.js) is a pure
counter with no I/O and no timers, so its policy is testable exhaustively.

**The system degrades in latency and in features. It never degrades in
correctness and it never degrades in safety.**

| Rung | Trigger | What happens | The user sees |
|---|---|---|---|
| **1 Normal** | pooled connections under `HOME_MAX_CONNECTIONS` | Everything pooled. | Nothing. |
| **2 Unpooled** | pooled connections at the cap | A new acquisition gets a short-lived connection that closes on release. One full handshake, no hold. | A page that takes ~270 ms longer to show their home. |
| **3 Degraded read** | the database rejects a query | Reads serve from the in-memory graph this process already holds. **Writes still go through**, because a write is somebody pressing a button. Only the audit row waits. | "Showing live state from this instance. Saved history is briefly unavailable." |
| **4 Shed streams** | actions in flight at 75% of their ceiling, or streams at theirs | **SSE stream admission stops before action admission does.** | A dashboard that stops updating and reconnects on its own, while the door still locks. |
| **5 Shed** | actions in flight at their ceiling | `503` with `Retry-After`. Nothing was sent to any house, so nothing is half applied. | "This instance is busy. Nothing was sent to your home, so nothing is half done." |

Rung 4 is the whole point and it is worth saying without hedging: **a user who
asks to unlock a door is served before a user who is watching a dashboard.**

### Each rung, demonstrated

Run `node scripts/home-load.mjs ladder` for this live. Recorded on 2026-09-03
with a controller of 4 pooled, 2 unpooled, 6 streams and 8 actions:

| Step | Admitted | Rung | Detail |
|---|---|---|---|
| acquire under the cap | yes | `normal` | `connection: pooled` |
| acquire at the cap | yes | `unpooled` | `connection: unpooled` |
| read, database up | yes | `unpooled` | `source: database` |
| read, database down | yes | `degraded_read` | `source: graph` |
| write, database down | attempted | `degraded_read` | `{ attempt: true, persistAudit: false }` |
| stream, 3 of 8 actions in flight | **yes** | `unpooled` | below the yield floor |
| stream, past the yield floor | **no** | `shed_streams` | `Retry-After: 5` |
| **an action at that same moment** | **yes** | `shed_streams` | the door beats the dashboard |
| action, every slot taken | no | `shed` | `Retry-After: 5` |
| **a guarded action, every slot taken** | **no** | `shed` | **`requiresConfirmation: true`** |

### The gate never degrades

The last row is the invariant this lane is built around, and it is enforced
structurally rather than by discipline. `admitAction` returns two values that are
computed independently:

- `admitted` is a function of load.
- `requiresConfirmation` is a function of the request, and of nothing else. It is
  exported as a standalone function that **takes no controller**, so there is no
  load state a caller could pass it even by accident.

A saturated instance can therefore refuse a guarded action outright and can never
confirm one. If shedding load would require weakening the gate, the action is
shed instead.

Two proofs, both run rather than argued:

1. **Exhaustive, in `tests/home-admission.test.js`:** every reachable state of
   the controller (connections held x streams open x actions in flight x database
   health) is walked, a guarded unconfirmed action is classified at each one, and
   `requiresConfirmation` is asserted true at all of them. The sweep is checked
   to have actually reached `shed` and `shed_streams`, or it would prove nothing
   about them.
2. **Live, against a real lock:** `node scripts/home-load.mjs gate` drives the
   controller from empty to fully shed while classifying a real `lock.front_door`
   in a real house at every step. Recorded 2026-09-03: **400 guarded actions, 0
   ever waved through**, rungs `degraded_read`, `shed_streams` and `shed` all
   reached, 226 shed by load, 174 admitted and then refused by the gate, and the
   real call at the top of the ladder returned `needs_confirmation` with the lock
   still reading `locked` afterwards.


---

## Chaos: the seven failures, each run for real

Run them with `npm run home:chaos` (needs `npm run home:fleet` first). Each one
injects a real failure against the real fleet: containers are stopped, sockets
are cut, tokens are deleted in Home Assistant, the process is sent SIGTERM, the
database is pointed at a host that cannot exist. The transcripts below are from
the run committed at
[`tasks/home/chaos-2026-09-03.json`](../../tasks/home/chaos-2026-09-03.json).

| # | Failure | Injected how | Result |
|---|---|---|---|
| 1 | House goes offline mid-session | `docker stop`, then `docker start` | **PASS** |
| 2 | House flaps up, down, up every 5 s for 2 minutes | a TCP gate slammed shut and reopened in front of the container | **PASS** |
| 3 | Token revoked while connected | a token deleted through Home Assistant's own WebSocket API | **PASS** |
| 4 | Our instance recycled mid-stream | SIGTERM to a real child process holding a real stream | **PASS** |
| 5 | Database unavailable | the real store pointed at a host in the reserved `.invalid` TLD | **PASS** |
| 6 | Slow house (2 s per response) | a latency shim delaying the response direction only | **PASS** |
| 7 | 624 entity house at ten updates a second | 600 real `input_number` writes over 62 seconds | **PASS** |

### 1. A house goes offline mid-session

```
connected: 7 rooms, stale=false
docker stop threews-ha-1
while down: stale=true status=unreachable rooms=7
docker start threews-ha-1
recovered: 7 rooms, stale=false, no re-subscribe
```

The graph went **stale, not empty**: the same seven rooms stayed on screen, greyed
rather than deleted, and came back when the container did. The same subscription
callback saw the whole sequence, so a browser watching this never reloaded.

### 2. A house flaps up, down, up

```
connected through the flap gate; 26 file descriptors held
24 up-down-up cycles at 5000ms; 26 file descriptors held
pool still holds 1 connection(s) for 1 home
breaker opened on attempt 6; subsequent attempts fail in 0ms or less
```

**No socket leak** across 24 cycles: the descriptor count is identical before and
after. **No connect storm:** the circuit breaker opened on the sixth consecutive
failure and every attempt after that failed in **1 ms or less** instead of
dialling a house that is not there. **No alert storm:** zero warnings emitted
across the whole run, counted in the evidence file rather than sampled by eye.

#### What this scenario found, before any of that was true

The first time it ran, it **killed the process at the fifth flap.**

`home-assistant-js-websocket` re-establishes its subscriptions after a reconnect
with `info.subscribe().then(...)` and no rejection handler, and tears them down
with `unsubProm.then((unsub) => unsub())`, also with no rejection handler. A
house that drops its socket again with either command in flight produces an
unhandled rejection, and under Node's default `--unhandled-rejections=throw` an
unhandled rejection **terminates the process**. On a server holding one
connection per house, one bad uplink takes every other house down with it, and
nothing in the logs says why: the process is simply gone.

Two fixes, both shipped:

- [`guardSubscriptions`](../../packages/home-bridge/src/bridge.js) wraps
  `subscribeMessage` on the connection the library uses, covering both the
  subscribe and the unsubscribe. The failure is reported on the bridge's `error`
  event rather than swallowed, and the library retries the same subscription on
  the next `ready`, so recovery is unaffected.
- `withTimeout` in [the runtime](../../api/_lib/home/runtime.js) had the same
  shape: `Promise.race` observes only the winner, so a connect that rejected
  after its timeout had already fired was an unhandled rejection too.

The upstream bug and the fix we would like to see are written up in
[docs/upstream/home-assistant-js-websocket-resubscribe-rejection.md](../upstream/home-assistant-js-websocket-resubscribe-rejection.md).

**This is the single most valuable thing the chaos suite produced**, and it is
worth saying why it could not have been found any other way: every unit test
passed, every live test passed, the envelope measurements at 400 connections
passed, and production would have died the first time somebody's router started
rebooting itself.

### 3. The token is revoked while we are connected

```
minted a disposable long-lived token for this run
connected with it; 123 entities, 7 rooms
revoked in Home Assistant: 1 of 1 token(s) deleted (listed with auth/refresh_tokens)
re-acquire: auth "Home Assistant rejected that access token. Create a new
            long-lived token in your profile and try again."
store row: status=auth_failed detail="<the same sentence>"
the fleet credential for threews-ha-3 still works: true
```

The scenario mints a **disposable** long-lived token, connects with it, and
revokes that one. The obvious version revokes the house's own credential, which
works exactly once and leaves every later run testing an auth failure it caused
itself; the transcript asserts the fleet credential still works afterwards.

The user must be told to reconnect, not that their house is offline: a re-acquire
returns the `auth` code (which maps to 400, never 401, so a browser does not log
anyone out because their house's token expired), the message names the token, and
the connection row records `auth_failed` with the same wording so the connect
screen can explain it without dialling the house again.

### 4. Our instance is recycled mid-stream

```
established sockets to threews-ha-4 before: 0
while the child streamed: 2
child exited 0 and reported: CLOSED 1
established sockets after: 0
a fresh instance re-subscribed in 30.5ms
```

Counted from the kernel rather than from our own bookkeeping, because the claim
is about what the **house** saw. SIGTERM ran the runtime's shutdown hook, which
closed the pooled connection, and the socket count returned to zero: the user's
Home Assistant sees a clean disconnect instead of a dead connection it has to
time out. A new instance was streaming again in **31 ms**, which is what a
browser's `EventSource` reconnect gets.

### 5. The database is unavailable

```
real store against a dead host: NeonDbError: Error connecting to database: fetch failed
connected with the database up: 7 rooms, readPlan=database
a cold acquire with the database down: Error connecting to database: fetch failed
readPlan is now source=graph rung=degraded_read
with the database down: 7 rooms still readable, write to light.bed_light went through
writePolicy: {"attempt":true,"persistAudit":false}
after the database answers again: readPlan=database
```

Rung 3, working. **Reads degraded to the in-memory graph**, the seven rooms
stayed readable, and **a real light really turned on with the database down**,
because a write is somebody pressing a button. Only the audit row waits. A cold
acquire failed with a designed error rather than hanging, there was no crash
loop, and the flag cleared itself on the first query that answered rather than
after a poll interval.

### 6. A slow house, beside a fast one

This is the scenario that finds shared-resource bugs, so it was run with a second
fast house connected throughout.

```
a 2000ms delay on every response from threews-ha-7, injected at the socket
fast house alone:            p50 1.97 ms, p95 6.80 ms over 30 calls
slow house at the default 15s connect timeout: connected after 14058 ms
slow house under load:       p50 2005.16 ms, p95 2021.04 ms
fast house beside it:        p50 2.39 ms, p95 6.99 ms
```

**Isolation, in two numbers: the fast house's p95 was 6.80 ms alone and 6.99 ms
with a house answering 2,000 times slower connected beside it. A drift of 0.19
ms.** Each home has its own socket and its own event loop work; nothing is shared
between them but the process, and that run was taken while the harness machine
sat at a load average of 190, so the noise floor was far above the effect being
looked for.

The slow house's own latency is exactly the injected delay (p50 2,005 ms for a
2,000 ms shim), so the slowness was real and it stayed where it was put.

**One thing to watch:** it connected in 14.06 seconds, against a 15 second
default connect timeout. A house this slow is 0.9 seconds from being refused
outright, and on a worse day it would be. That is the correct behaviour (a house
that cannot answer a handshake in fifteen seconds cannot serve a voice command
either) but it means the timeout, not the ladder, is what bounds this failure,
and it is the number to revisit if real users on slow uplinks start seeing
`unreachable`.

### 7. A 624 entity house at ten updates a second

```
624 entities, 7 rooms
600 real state changes in 62.1s (9.7/s), 0 failed
61 graph rebuilds: 9.8 updates coalesced into each
graph rebuild p95 0.5ms against a 16.7ms frame budget
heap 17.8MB -> 17.6MB
```

**Coalescing works** (9.8 updates per rebuild), **the frame budget holds** (p95
0.5 ms against 16.7 ms for 60 fps), **the heap is flat** (it ended 214 KB lower
than it started across 600 real state changes), and the whole minute cost **0.6%
of one core**.

The frame budget measured here is the data half, which is the half this lane
owns: how long it takes to rebuild the room graph the 3D scene renders. What the
scene then does with it belongs to the surface that draws it.


---

## The Cloud Run configuration, and why

Read off `three-ws-api` on 2026-09-03, then changed. Every decision below has a
measurement behind it and none of them was made by reasoning about how Cloud Run
probably behaves.

### What was changed

| Setting | Was | Is | Why, with the number |
|---|---|---|---|
| `--memory` | 4 GiB | **8 GiB** | Cloud Monitoring, `container/memory/utilizations`, 24 hours at 60 second buckets, per-bucket p99 across instances: **median 0.799, p95 0.839, max 0.919 of the 4 GiB limit, with zero home connections.** The service was already running at 3.2 GiB typical and 3.7 GiB peak. Adding any home connection budget at 4 GiB risks an OOM kill, and an OOM kill here takes the whole API container down rather than one lane. At 8 GiB the same peak is 46%, and 600 home connections take it to about 53%. |
| `HOME_MAX_CONNECTIONS` | unset (the code default, 200) | **600** | 600 x the measured per-connection RSS. A 90/10 mix of small and large houses costs 643 KB x 0.9 + 1.09 MB x 0.1 = **0.69 MB each, so 414 MB**, or 500 MB if the large house is scaled by its heap ratio instead. Sized on the conservative 500 MB, which is **6% of an 8 GiB instance** and would have been 12% of a 4 GiB one that was already peaking at 92%. |

Applied with a config-only update, which creates a revision from the same image:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --memory 8Gi --update-env-vars HOME_MAX_CONNECTIONS=600
```

Revision `three-ws-api-00411-m6h`, verified serving 100% of traffic with
`/api/healthz` returning 200.

### What was deliberately left alone

| Setting | Value | Why it stays |
|---|---|---|
| `--cpu` | 2 | `container/cpu/utilizations` p99 is 0.25 to 0.29 over the last hour. The lane's marginal CPU is small: 0.555 ms per entity update and at worst 0.012% of a core per idle connection. CPU is not the binding constraint; memory is. |
| `--min-instances` | 6 | **This is why the lane needs no cold-start spending.** The measured cold start to a first connected home is 270 ms of handshake on top of an already-warm process, and 591 to 1,028 ms from a genuinely cold node. Both are under a second, and `minScale=6` means the process is usually warm anyway. Raising `minScale` to hide a sub-second cold start would be paying to solve a problem that was measured and found not to exist. |
| `--max-instances` | 100 | The ceiling in the envelope model above. Raising it does not help until the duplicate-socket problem is solved, because a bigger fleet multiplies duplicate sockets against the user's own house. |
| `--concurrency` | 160 | See the stream cap below. |
| `--cpu-throttling` | on | Measured, not assumed. See below. |

### CPU throttling with a stream open: measured

This is the setting most likely to be wrong for this workload, so it was tested
against the running production service rather than reasoned about. The test:
hold a real SSE stream open against an endpoint already deployed there
(`/api/feed-stream`, which emits a heartbeat on a fixed 15 second interval) and
time every heartbeat. A timer inside a held request is exactly the shape order
03's home stream has; if `cpu-throttling=true` starved it, the intervals would
drift.

Two runs, `node scripts/home-load.mjs cloudrun`:

| Endpoint | Held | Heartbeats | Interval p50 | Worst late | Ended by |
|---|---|---|---|---|---|
| `/api/pump/trades-stream` | 90.1 s | 5 at 15 s | 15,000 ms | **+4 ms** | the endpoint's own 90 s cap |
| `/api/feed-stream` | 288.1 s | 19 at 15 s | 15,001 ms | **+1,589 ms** | the endpoint's own 275 s cap |

**Verdict: CPU throttling does not starve a timer inside a held stream.** Over
23 intervals the median drift is 1 ms and the single worst outlier is 1.6
seconds. Neither stream was cut by the platform: both ended at their own
application cap, well inside the 900 second request timeout.

The concern the runtime's own header raises is a different one and it still
stands: a **WebSocket to a house outlives the request that opened it**, and
outside a request an instance genuinely does get close to no CPU. That is why
the pool is treated as a cache, why eviction runs opportunistically on every
acquire rather than only on a timer, and why a pooled graph is always treated as
possibly stale.

### The stream cap is set by concurrency, not by memory

`containerConcurrency` is **160**. A held SSE stream is an in-flight request for
its whole life, so it occupies one of those 160 slots the entire time somebody is
watching their home, and it shares that budget with every other request the
container serves.

That is measured, not assumed. `node scripts/home-load.mjs concurrency` held
about 200 real SSE streams against `/api/feed-stream` for five minutes and read
Cloud Run's own `container/max_request_concurrencies` gauge either side of it:

```
before the streams   03:55 = 8.9   03:57 = 11.9   03:59 = 11.8
while they were held 04:00 = 45.9  04:01 = 79.8   04:02 = 99.8
                     04:03 = 94.7  04:04 = 84.8   04:05 = 89.7
```

Observed per-instance concurrency went from about **10 to about 100**, in
proportion to the two to six instances serving them, for exactly as long as the
streams were held. A stream is an in-flight request and it holds a slot.

This is why the admission defaults are shaped the way they are: the pooled
connection cap (600) and the stream cap (96) are **different resources**. A
pooled WebSocket is opened during a request and outlives it, so it costs memory
and no concurrency. A stream costs one concurrency slot and very little memory.
Sizing streams from memory would put the cap in the hundreds, and the platform
would start refusing requests long before the ladder ever shed one.

`maxStreams` is 96 (60% of the container's 160 request budget) and
`maxInflightActions` is 24 (15%), so a fully saturated home lane occupies 120 of
160 slots and leaves 40 for everything else the container serves, whose own
measured baseline is 10 to 14.

The 900 second request timeout is the other half of the same fact: **no SSE
stream can outlive 15 minutes**, whatever the client does. The stream must
therefore cap itself below that and let the browser's `EventSource` reconnect,
the way both endpoints measured above already do.

---

## Alert 1: correlated unreachability

**Fires when:** handshake success is under 80% across at least 10 distinct homes
inside 15 minutes. Pages on the first tick, then hourly while it persists, and
sends a recovery message when it clears.

**Symptom as reported:** several users at once say their home shows as offline,
or the `home` subsystem goes red on `/status`.

**First command:**

```bash
curl -s https://three.ws/api/healthz \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(JSON.stringify((j.subsystems?.subsystems||[]).find(s=>s.name==='home'),null,2))})"
```

**Is it them or us, in under two minutes:**

1. **Did anything ship?** `curl -s https://three.ws/api/version` and compare the
   SHA against the last deploy. A correlated home outage inside 20 minutes of a
   deploy is the deploy until proven otherwise.
2. **Did egress change?** Home Assistant instances are reached outbound over the
   VPC connector. If it went away, every remote house dies at once and nothing
   else on the platform notices:
   ```bash
   gcloud run services describe three-ws-api --region us-central1 \
     --format='value(spec.template.metadata.annotations)' | tr ',' '\n' | grep -i vpc
   ```
   Expect `run.googleapis.com/vpc-access-connector=three-ws-vpc` and
   `vpc-access-egress=private-ranges-only`.
3. **What do the instances say?**
   ```bash
   gcloud logging read 'resource.type="cloud_run_revision"
     resource.labels.service_name="three-ws-api"
     (textPayload:"home-runtime" OR textPayload:"home-health")' \
     --freshness=30m --limit=20 --format='value(timestamp,textPayload)'
   ```
4. **Run the correlation query below.** If `failing_last_15m` is a large share of
   `live_homes`, it is us. If it is one or two rows out of many, it is them and
   this alert should not have fired: check the home floor.

**Rollback:** the deploy path and its rollback are in
[gcp-production.md](gcp-production.md). A correlated home outage traced to a
release is a rollback, not a fix-forward: houses are physical and people are
standing in dark kitchens.

**What to tell the user:** "Your home is fine. We had a problem reaching homes
from our side and it is fixed / we are working on it now. Nothing in your house
changed and nothing was left unlocked." Never ask them to reconnect during a
correlated outage: it makes them mint a new token for a problem that was not
theirs.

---

## Alert 2: confirmation integrity violation

**Fires when:** any row in `home_action_log` has `guarded = true`,
`confirmed_by is null` and `outcome = 'ok'` in the last 24 hours. One row pages.
The alert signature carries the violation's timestamp, so a second incident
always pages even if an earlier one paged an hour ago.

**Symptom as reported:** usually nobody reports it. That is the point.

**First command:**

```sql
select id, home_id, user_id, actor, channel, action, entity_ids, risk, detail, created_at
from home_action_log
where guarded = true and confirmed_by is null and outcome = 'ok'
  and coalesce(detail->>'allowed_by_grant', 'false') <> 'true'
  and created_at > now() - interval '24 hours'
order by created_at desc;
```

Drop the `allowed_by_grant` line to see the grant-backed actions alongside them.
Those are legitimate and are the reason that line is there: without it, this
query returns every standing-grant unlock in the fleet and the alert becomes
noise within a day.

**Then, in this order:**

1. **Scope it.** How many rows, how many homes, which entities. A `lock.*`,
   `cover.*` or `alarm_control_panel.*` entity means a building may have been
   opened.
2. **Find the actor.** `actor` and `channel` say whether it came through chat,
   MCP, voice or an automation. `detail` carries the call.
3. **Read the gate.** `classifyCall` and `classifyMcpCall` in
   [`packages/home-bridge/src/safety.js`](../../packages/home-bridge/src/safety.js)
   are the only things standing between a model and a front door. A refactor that
   changed a domain list, or a caller that passed `confirmed: true` from
   somewhere other than a human, is the likely cause.
4. **Check the grant claim.** The alert already excludes actions that recorded
   `detail.allowed_by_grant`, so a row that reached you claimed no grant at all.
   Confirm that against `home_entity_grants` for the home and entity: a live
   grant with no claim on the row is a logging bug in the act path
   (`api/home/[id]/call.js`), which is a much smaller problem than the alternative
   and still worth fixing the same day. No grant and no claim is the real thing.
   `integrity.grantBackedWithoutGrant` on the health block counts rows that
   claimed a grant that no longer exists; that is usually a grant the user
   revoked afterwards, which is why it reports rather than pages.

**Rollback:** yes. Roll back to the last revision known to gate correctly before
diagnosing further.

**What to tell the user:** the truth, promptly, naming the entity and the time.
"At 03:37 your agent unlocked your front door without asking you first. That is a
bug on our side, it is fixed, and here is what was affected." Do not wait for a
full root cause to tell somebody their door was opened.

---

## Alert 3: subscriber leak

**Fires when:** on any instance, registered subscribers climb across three
consecutive checks while the number of open connections does not, at more than
four watchers per open connection.

**The obvious signal does not work, and this was measured rather than reasoned.**
The plan was to watch the margin between registered subscribers and open
streams. Against the real runtime that margin is always zero, because
`subscribe()` registers the subscriber and admits the stream in the same call, so
the two counters move in lockstep by construction. Six deliberately leaked
subscriptions produced `margins=[0,0,0]` and a detector built on the difference
would never have fired once. What actually leaks is the absolute count:
subscribers that climb and never come back down while the pool does not grow.
Honest traffic fluctuates, because people close tabs. A leak only ever rises. The
per-connection ceiling is what keeps a family all watching one house at once from
reading as a leak; the margin is still recorded, because a non-zero one is a
different bug (a stream admitted with no subscriber, or the reverse).

**Symptom as reported:** nothing, until instances start restarting. This failure
has no error signature: every request keeps succeeding while the process fills
with sockets into houses nobody is watching, and it ends as an out-of-memory
restart that looks like a platform blip.

**Why it is measured per instance:** the pool is per process, and Cloud Run runs
this service at `minScale=6` with `sessionAffinity=false`, so a cron tick lands
on an arbitrary instance and can only ever see its own pool. Each process parks
its own samples in the shared cache (`home:leak:instances`, 15 minute staleness
window) and the cron reads all of them.

**First command:**

```bash
gcloud logging read 'resource.type="cloud_run_revision"
  resource.labels.service_name="three-ws-api" textPayload:"home subscriber leak"' \
  --freshness=2h --limit=20 --format='value(timestamp,textPayload)'
```

**Is it them or us:** it is always us. A leaked subscription is a code path that
called `subscribe()` and did not call the returned unsubscribe, or an SSE handler
whose client disconnect never fires its cleanup. Look at every `subscribe(` call
site and confirm each one releases in a `finally` or on `req.on('close')`.

**Rollback:** if the leak arrived with a release, roll back. A leaking fleet
degrades over hours, so there is time to do it properly.

**What to tell the user:** nothing, unless instances actually restarted. If they
did: "some live home views briefly stopped updating and reconnected on their own."

---

## The four per-tenant reports (none of these alert)

Before working any of these by hand, look at what the user is already being
shown: `GET /api/home/:id/health` gives the same verdict their `/smart-home` page
is rendering, including whose fault it says the problem is and the count of other
homes failing right now. If it already says `fault: "us"`, this is not a support
conversation and the alerts above are the right place to be.

### "My home shows as unreachable"

```sql
select id, label, base_url, status, status_detail, last_ok_at, last_error_at
from home_connections
where user_id = '<user id>' and revoked_at is null;
```

`status_detail` is written by the runtime on every failed handshake and is meant
to be read verbatim to the user. Then run the correlation query: if they are the
only one, it is their house. The usual causes, in order: the instance is off,
their remote https URL stopped resolving, their reverse proxy certificate
expired, or they are on a LAN-only install and never had a reachable URL (in
which case they need the three.ws add-on, not a fix).

### "It says my token is invalid"

Status `auth_failed`. Home Assistant long-lived tokens are revoked from the
user's own profile page, and a token deleted there fails exactly this way. The
fix is theirs: create a new long-lived token and reconnect. There is nothing to
do on our side, and no way for us to repair it, because we deliberately cannot
read the old one back out.

### "The agent refused to unlock my door"

That is the product working. `home_action_log` will show `outcome = 'refused'`,
`guarded = true`, `risk = 'security'`. Home Assistant's own `HassTurnOff` tool
unlocks locks, which is why the gate classifies by what an action DOES rather
than by what it is called. The user can grant a standing per-entity allowance
(`home_entity_grants`), and it is deliberately per entity: letting the agent open
the office door is not letting it open the front door.

### "My 3D home is grey and not updating"

The graph is marked stale rather than emptied when the socket drops, which is
what grey means. Check whether their instance is reachable at all (first report
above). If it is, the SSE stream is the suspect: a reconnect from the browser is
the user-side fix, and a subscriber leak (alert 3) is the platform-side one.

---

## The correlation query

The one query to run when a single user complains, before doing anything else.
It answers "is anyone else affected right now?", which decides whether this is a
support conversation or an incident.

```sql
select
  count(*)::int                                                        as live_homes,
  count(*) filter (where last_ok_at > now() - interval '15 minutes')::int
                                                                       as ok_last_15m,
  count(*) filter (where last_error_at > now() - interval '15 minutes'
                     and (last_ok_at is null or last_error_at > last_ok_at))::int
                                                                       as failing_last_15m,
  count(*) filter (where status = 'auth_failed')::int                  as auth_failed,
  count(*) filter (where status = 'unreachable')::int                  as unreachable
from home_connections
where revoked_at is null;
```

Measured 2026-09-03 against the development database:

```
 live_homes | ok_last_15m | failing_last_15m | auth_failed | unreachable
------------+-------------+------------------+-------------+-------------
          3 |           1 |                0 |           0 |           0
```

`failing_last_15m` near zero with one complaint is their house. `failing_last_15m`
approaching `live_homes` is an incident: go to alert 1.

Then name the affected homes:

```sql
select id, label, status, left(coalesce(status_detail, ''), 60) as detail,
       last_ok_at, last_error_at
from home_connections
where revoked_at is null and status in ('unreachable', 'auth_failed')
order by last_error_at desc nulls last
limit 20;
```

And, for one house, what the agent actually did in it:

```sql
select action, outcome, guarded, risk, entity_ids, created_at
from home_action_log
where home_id = '<home id>'
order by created_at desc
limit 50;
```

That last query is the one an operator owes a user who asks "what did my agent do
in my house last Tuesday", and it is why the action log is its own table rather
than rows in the shared `audit_log`.
