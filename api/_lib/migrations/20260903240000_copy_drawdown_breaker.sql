-- Migration: a copier-set drawdown circuit breaker on copy_subscriptions.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260903240000_copy_drawdown_breaker.sql
-- Idempotent.
--
-- Before this, a copier could cap the size of any single copy (per_trade_cap_sol)
-- and the SOL fanned out per day (daily_budget_sol), but nothing capped the one
-- risk that actually strands a follower: a leader whose realized equity curve
-- rolls over and keeps going. The subscription mirrored every new entry the
-- whole way down, and the only exit was the copier noticing and pausing by hand.
--
-- max_drawdown_pct is the copier's answer to "how far down do I ride this?",
-- measured as peak-to-trough realized loss over gross capital deployed, the same
-- definition api/_lib/meta-allocator.js ranks leaders on and the Trader Card
-- shows. api/cron/copy-fanout.js evaluates it per leader per tick and flips a
-- breached subscription to status='paused', recording why and when. Pausing (not
-- stopping) is deliberate: the copier's guards, sizing, and high-water mark
-- survive, so resuming is one deliberate action and never a silent restart.
--
-- NULL means the copier opted out of the breaker, which is the behavior every
-- existing row had, so no backfill is needed and no live subscription changes.
--
-- paused_reason / paused_at also cover the future auto-pause cases (a leader who
-- goes quiet, a copier whose safety gate keeps rejecting): any code path that
-- pauses a subscription on the copier's behalf owes them the reason.

begin;

alter table copy_subscriptions
    add column if not exists max_drawdown_pct numeric,
    add column if not exists paused_reason    text,
    add column if not exists paused_at        timestamptz;

-- 0 would mean "pause before the first losing trade", which is never what a
-- copier means; the engine treats <= 0 as opted out, so keep the column honest.
alter table copy_subscriptions
    drop constraint if exists copy_max_drawdown_range;

alter table copy_subscriptions
    add constraint copy_max_drawdown_range
    check (max_drawdown_pct is null or (max_drawdown_pct > 0 and max_drawdown_pct <= 100));

comment on column copy_subscriptions.max_drawdown_pct is
    'Copier-set circuit breaker: auto-pause when the leader''s realized peak-to-trough drawdown, as a share of capital deployed, reaches this percentage. NULL = no breaker.';
comment on column copy_subscriptions.paused_reason is
    'Machine reason a subscription was paused on the copier''s behalf (e.g. leader_drawdown_breach). NULL when the copier paused it themselves.';

commit;
