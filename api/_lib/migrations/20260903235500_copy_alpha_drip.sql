-- Migration: alpha-drip, the tiered release of a leader's own copy signal.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260903235500_copy_alpha_drip.sql
-- Idempotent.
--
-- A leader's edge decays in seconds, so the leader can sell the LATENCY of their
-- own signal instead of only a share of the profit: $THREE holders in higher
-- tiers receive the copy intent first, everyone else after a leader-set delay.
--
-- Non-negotiable: this gates only WHEN a copier is shown the intent. Every trade
-- is still recorded in full at fanout time and still lands in the leader's public
-- on-chain track record, so downside-transparency is untouched. There are no
-- hidden trades, only delayed reveals.

begin;

create table if not exists copy_alpha_drip (
    leader_agent_id  uuid primary key references agent_identities(id) on delete cascade,
    owner_user_id    uuid not null references users(id) on delete cascade,
    enabled          boolean not null default false,
    -- [{ "tier": "gold", "delay_sec": 0, "max_copy_size_sol": 0.5|null }, ...]
    -- One entry per $THREE tier the leader prices; tiers left out inherit the
    -- nearest lower tier, and anything below the lowest priced tier waits
    -- public_delay_sec.
    schedule         jsonb   not null default '[]'::jsonb,
    public_delay_sec int     not null default 0,
    disclosure       text,
    capacity_note    text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    constraint copy_alpha_drip_public_delay_range check (public_delay_sec >= 0 and public_delay_sec <= 900),
    constraint copy_alpha_drip_schedule_is_array check (jsonb_typeof(schedule) = 'array')
);

create index if not exists copy_alpha_drip_owner
    on copy_alpha_drip (owner_user_id);
create index if not exists copy_alpha_drip_enabled
    on copy_alpha_drip (leader_agent_id)
    where enabled;

-- Per-intent release state. A null visible_at means "no drip applied" (every row
-- written before this migration, and every intent from a leader with drip off),
-- which every reader treats as immediately visible.
alter table copy_executions
    add column if not exists visible_at     timestamptz,
    add column if not exists drip_tier      text,
    add column if not exists drip_delay_sec int,
    add column if not exists notified_at    timestamptz;

comment on column copy_executions.visible_at is
    'When this intent is revealed to the copier. Null = immediately. The row itself
     is always written in full at fanout time; only the reveal is delayed.';
comment on column copy_executions.drip_tier is
    'The $THREE tier id the copier held when this intent was released.';
comment on column copy_executions.notified_at is
    'When the held Telegram alert was sent (or skipped because the subscription has
     no chat id). Null while an intent is still waiting on its release.';

-- Release scan: pending intents whose delayed alert has not gone out yet.
create index if not exists copy_executions_drip_release
    on copy_executions (visible_at)
    where status = 'pending' and notified_at is null;

commit;
