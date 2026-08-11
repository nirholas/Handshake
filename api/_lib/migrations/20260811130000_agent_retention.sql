-- Week-2 retention on minted agents (README Roadmap, phase 2 verification metric).
--
-- The phase-2 goal is "users return to converse with their own agent; >=30%
-- week-2 retention on minted agents". Nothing in the platform could answer that
-- question: usage_events records chat turns but never carried the agent id on the
-- chat path, and there was no owner-scoped return-visit signal at all. These two
-- tables close that gap without a third-party analytics tag.
--
-- agent_owner_visits — the return-visit signal, deliberately coarse.
-- One row per (owner, agent, UTC day) and nothing else: no IP, no user agent, no
-- session id, no fingerprint, no per-request row. It answers exactly one question
-- ("did this owner come back to this agent on this day, and did they converse?")
-- and cannot answer anything more invasive. Day granularity is all a week-2
-- retention cohort needs, and the composite primary key makes the write an upsert
-- so a heavy dashboard session is still a single row.
--
-- agent_retention_cohorts — the weekly rollup written by api/cron/retention-rollup.js.
-- Cohorts are keyed by the ISO week (Monday, UTC) in which an owner minted their
-- FIRST agent on-chain, and every stored date is absolute: cohort_week is a real
-- date, window_start/window_end bound the day-7..day-14 measurement window, and
-- computed_at stamps the run. Nothing in the table is relative to "now", so a row
-- read months later still means what it meant when it was written.

create table if not exists agent_owner_visits (
    user_id       uuid not null references users(id) on delete cascade,
    agent_id      uuid not null references agent_identities(id) on delete cascade,
    visit_day     date not null,
    viewed        boolean not null default false,
    conversed     boolean not null default false,
    first_seen_at timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    primary key (user_id, agent_id, visit_day)
);

-- The rollup walks a cohort's owners and asks "any visit in [day 7, day 14)?",
-- so owner + day is the driving access path.
create index if not exists agent_owner_visits_user_day
    on agent_owner_visits (user_id, visit_day);

-- Per-agent reads (an owner's own agent activity) stay cheap too.
create index if not exists agent_owner_visits_agent_day
    on agent_owner_visits (agent_id, visit_day desc);

create table if not exists agent_retention_cohorts (
    cohort_week     date not null,
    metric          text not null check (metric in ('week2_converse', 'week2_return')),
    minted_owners   int not null default 0,
    retained_owners int not null default 0,
    retention_rate  double precision not null default 0,
    window_start    date not null,
    window_end      date not null,
    is_complete     boolean not null default false,
    computed_at     timestamptz not null default now(),
    primary key (cohort_week, metric)
);

-- The dashboard reads the most recent cohorts for one metric at a time.
create index if not exists agent_retention_cohorts_metric_week
    on agent_retention_cohorts (metric, cohort_week desc);
