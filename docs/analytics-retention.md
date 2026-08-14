# Week-2 retention on minted agents

The README roadmap gates phase 2 on one number:

> **Verification:** users return to converse with their own agent; >=30% week-2 retention on minted agents.

Until this landed, the platform could not produce that number. `usage_events` recorded that a chat happened but the chat path never attached the agent id, and nothing anywhere recorded an owner coming *back* to an agent they already owned. This page documents the measurement that closes that gap: what is collected, what it means, where it is stored, and how to read it.

Nothing here uses a third-party analytics tag. The signal is written by our own API handlers into our own Postgres, and it is deliberately coarse.

---

## What counts as a return visit

A return visit is recorded when **the owner of an agent** either:

- **opens it** (`GET /api/agents/:id` resolves the caller as the owner), or
- **converses with it** (`POST /api/chat` with an `agentId` the caller owns).

Visitors, anonymous callers, and people chatting with someone else's published agent are never recorded here. The write is detached (`queueMicrotask`) and swallows its own failures, so it can never slow down or break the request that triggered it.

### What is stored, exactly

One row per **(owner, agent, UTC day)**, in `agent_owner_visits`:

| Column | Meaning |
| --- | --- |
| `user_id`, `agent_id` | Who, and which agent of theirs. |
| `visit_day` | The UTC calendar day. Day granularity, nothing finer. |
| `viewed` | They opened the agent that day. |
| `conversed` | They sent it a message that day. |
| `first_seen_at`, `last_seen_at` | Absolute timestamps for the first and most recent write of that day. |

That is the entire footprint. No IP address, no user agent, no session id, no device fingerprint, no referrer, no per-request row, no page path. Repeat activity on the same day collapses into the same row through an upsert, and the write is additionally deduped per owner/agent/day through the shared Redis lock, so a dashboard left open all afternoon is one row.

The table can answer "did this owner come back on this day, and did they talk to their agent" and it structurally cannot answer anything more invasive than that.

---

## The metric

**Cohort.** Owners are grouped by the ISO week (Monday, UTC) in which they minted their **first** agent on-chain. "Minted" is the same predicate `/api/agents?onchain=true` uses: a Metaplex Core asset on Solana (the home chain) or an ERC-8004 identity on an EVM leg. The mint instant is the `confirmed_at` stamped by the on-chain writer, falling back to when the row was created.

**Window.** An owner is retained if they came back during **days 7 through 13** after their own mint instant. Days 0 to 6 are the honeymoon week that essentially every minter is active in, so counting them would measure nothing. The window is computed from each owner's own mint, not from the cohort week boundary, so a Saturday minter is not judged on a one-day window.

**Two metrics** are stored per cohort week:

| Metric | Retained means |
| --- | --- |
| `week2_converse` | Came back and **conversed** with a minted agent of theirs. This is the roadmap's number. |
| `week2_return` | Came back at all, conversation or not. Useful as the ceiling the converse rate is chasing. |

**Completeness.** A cohort's number keeps moving until every member's 14-day window has closed, which is up to 20 days after the cohort week starts. Rows carry `is_complete` for exactly that reason: only a complete cohort is a final number, and the dashboard draws the open ones muted so nobody quotes a half-formed week.

---

## The rollup

`api/cron/retention-rollup.js` runs weekly (`35 9 * * 1`, registered in `vercel.json` and synced to Cloud Scheduler by `scripts/create-gcp-scheduler.mjs`). Each run recomputes the trailing 26 cohort weeks from the live tables and upserts one row per (cohort week, metric) into `agent_retention_cohorts`.

Recomputing the whole tail rather than just the newest week is deliberate: a visit recorded today can legitimately move a cohort that was rolled up last week, and the upsert is idempotent, so a re-run (or a retry after a partial failure) converges instead of double-counting. A skipped week needs no backfill step; the next run repairs it.

Every stored date is absolute:

| Column | Meaning |
| --- | --- |
| `cohort_week` | Monday (UTC) of the mint week. |
| `minted_owners` / `retained_owners` | Cohort size and how many came back. |
| `retention_rate` | `retained_owners / minted_owners`. |
| `window_start` / `window_end` | The absolute span the cohort was measured over (`window_end` exclusive). |
| `is_complete` | Every member's window has closed. |
| `computed_at` | When this row was last written. |

Nothing is stored relative to "now", so a row read six months later still means what it meant when it was written.

---

## Reading the number

### API

```
GET /api/analytics/retention?metric=week2_converse&weeks=12
```

Admin-only (`api/_lib/admin.js` — an admin wallet in `ADMIN_ADDRESSES`, the built-in owner address, or `users.is_admin`). These are platform-wide business metrics rather than the caller's own data, so a signed-in non-admin gets a `403`.

| Param | Values |
| --- | --- |
| `metric` | `week2_converse` (default) or `week2_return`. |
| `weeks` | How many cohort weeks to return, 1..104. Default 26. |

Response:

```json
{
  "metric": "week2_converse",
  "metric_label": "Returned to converse",
  "target": 0.3,
  "cohorts": [
    {
      "cohort_week": "2026-07-27",
      "minted_owners": 40,
      "retained_owners": 14,
      "retention_rate": 0.35,
      "window_start": "2026-08-03",
      "window_end": "2026-08-17",
      "is_complete": true,
      "computed_at": "2026-08-17T09:35:02.114Z"
    }
  ],
  "summary": {
    "latestCompleteWeek": "2026-07-27",
    "latestRate": 0.35,
    "pooledRate": 0.33,
    "completeCohorts": 6,
    "mintedOwners": 210,
    "retainedOwners": 70,
    "target": 0.3,
    "meetsTarget": true
  }
}
```

`cohorts` is ordered oldest first, which is chart order. `summary.pooledRate` is owner-weighted across every complete cohort, not a mean of the weekly rates: a naive mean lets one tiny week swing the headline.

### Dashboard

`/dashboard/analytics` renders a **Week-2 Retention · Minted Agents** panel under the revenue chart: one column per cohort week, a dashed line at the 30% target, green columns at or above it, amber below, and muted columns for cohorts whose window is still open. Hovering a column gives the exact `retained/minted` split and, for an open cohort, the date its window closes. The panel is fetched alongside everything else on the page, and a `403` simply means the panel is not appended, so a non-admin sees no error and no empty shell.

---

## Working on it

| Piece | File |
| --- | --- |
| Signal + cohort math | [api/_lib/retention.js](../api/_lib/retention.js) |
| Tables | [api/_lib/migrations/20260811130000_agent_retention.sql](../api/_lib/migrations/20260811130000_agent_retention.sql) |
| Weekly rollup | [api/cron/retention-rollup.js](../api/cron/retention-rollup.js) |
| Read API | [api/analytics/retention.js](../api/analytics/retention.js) |
| Chart | [src/dashboard-next/pages/analytics.js](../src/dashboard-next/pages/analytics.js) |
| Tests | [tests/retention-cohorts.test.js](../tests/retention-cohorts.test.js) |
| End-to-end proof | [scripts/retention-metric-proof.mjs](../scripts/retention-metric-proof.mjs) |

Apply the migration with `npm run db:status` to preview and `npm run db:migrate` to apply (it applies every pending migration immediately, with no dry run).

To force a rollup outside the weekly schedule, call the cron with the cron credential:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" https://three.ws/api/cron/retention-rollup
```

It answers with the cohort count it wrote and the newest complete cohort's rate.

### Verifying it end to end

The unit tests cover the arithmetic against in-memory rows. The parts only a real
database can answer (the four-CTE cohort aggregate, the jsonb regex guard on the
mint stamp, the upsert on the composite key, and whether Postgres `date_trunc`
agrees with the JavaScript `isoWeekStart`) are covered by a proof script that
runs the whole path for real:

```bash
node scripts/retention-metric-proof.mjs
```

It starts a throwaway Postgres in Docker, applies the schema and every
migration, boots the real server, registers real users through `/api/auth/register`,
creates real agents, writes the visit through the real `GET /api/agents/:id`
handler, runs the real rollup behind the real cron gate, and reads the number
back from the real admin-gated endpoint. Nothing is mocked and nothing is minted
on-chain: the two cohort owners get the same `meta.onchain.confirmed_at` stamp an
on-chain registration writes, at an absolute date, in a database that is deleted
when the run ends. Add `--keep` to leave the stack up and curl it by hand.

Beyond the happy path it pins the properties that make the number trustworthy: a
second open on the same day does not add a row, a non-owner viewing the agent is
not tracked at all, an owner who visits during the honeymoon week does not count
as retained, a second rollup run is idempotent, and the read endpoint answers 401
anonymous and 403 to a signed-in non-admin.

If you extend the metric, keep two properties: the retention window must stay anchored to each owner's own mint instant, and every stored date must stay absolute. Both are what make a cohort row still readable a year later.
