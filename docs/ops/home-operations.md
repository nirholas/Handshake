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
| The tables | `home_connections`, `home_action_log`, `home_confirmations` |

Every rate is computed **across tenants** over a 15 minute window, and each one
has a floor below which it is reported but not scored:

| Rate | Floor | Why |
|---|---|---|
| Handshake success | 10 connected homes (`MIN_HOMES_FOR_A_VERDICT`) | With three homes, one holiday cottage losing power is a 33% failure rate. |
| Action success | 20 actions (`MIN_ACTIONS_FOR_A_VERDICT`), and failures in more than one home | A house whose Z-Wave stick fell out fails everything sent to it. Paging for that is paging for a loose USB port. Failures confined to one home cap at `degraded` and the hint names the house. |
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
