-- Migration: recurring-payment lifecycle (pause/resume + a real charge ledger).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260813191500_recurring_payment_lifecycle.sql
-- Idempotent.
--
-- Before this migration, `agent_subscriptions` recorded only `last_error`: one
-- overwritten string per schedule. A creator could not see what a schedule had
-- ever paid, and any failure (including a transient RPC blip) pinned the row to
-- status='paused' with no way back, because no endpoint could set it to
-- 'active' again. DCA schedules had the same one-way door plus a ledger
-- (`dca_executions`) that nothing surfaced.
--
-- This adds:
--   * subscription_charges  — one row per charge attempt, the mirror of
--     dca_executions, so incoming revenue is queryable and every failure is
--     recorded with the classification the cron acted on.
--   * consecutive_failures / last_error_code / paused_at / resumed_at on both
--     schedule tables, so a retryable failure can be retried a bounded number
--     of times before the schedule is paused, and a resume is auditable.

begin;

-- ── subscription_charges — per-tick charge attempt log ──────────────────────
create table if not exists subscription_charges (
    id                  uuid primary key default gen_random_uuid(),
    subscription_id     uuid not null references agent_subscriptions(id) on delete cascade,
    -- Denormalized so the creator-side incoming view can aggregate earnings
    -- without joining back through a subscription that may since be canceled.
    agent_id            uuid not null references agent_identities(id) on delete cascade,
    payer_user_id       uuid references users(id) on delete set null,
    chain_id            integer,
    amount              text not null,
    tx_hash             text,
    status              text not null default 'pending',
    -- The machine code the cron classified this outcome as. `outcome` is the
    -- classification bucket that drove what happened to the schedule.
    code                text,
    outcome             text,
    error               text,
    period_start_at     timestamptz,
    charged_at          timestamptz not null default now(),

    constraint subscription_charges_status_check
        check (status in ('success', 'failed', 'aborted', 'unknown')),
    constraint subscription_charges_outcome_check
        check (outcome is null or outcome in ('charged', 'fatal', 'retryable', 'ambiguous'))
);

create index if not exists idx_subscription_charges_subscription
    on subscription_charges(subscription_id, charged_at desc);
create index if not exists idx_subscription_charges_agent
    on subscription_charges(agent_id, charged_at desc);
create unique index if not exists uq_subscription_charges_period
    on subscription_charges(subscription_id, period_start_at)
    where status = 'success' and period_start_at is not null;

-- ── agent_subscriptions — lifecycle columns ─────────────────────────────────
alter table agent_subscriptions add column if not exists consecutive_failures integer not null default 0;
alter table agent_subscriptions add column if not exists last_error_code      text;
alter table agent_subscriptions add column if not exists last_tx_hash         text;
alter table agent_subscriptions add column if not exists paused_at            timestamptz;
alter table agent_subscriptions add column if not exists resumed_at           timestamptz;

-- ── dca_strategies — lifecycle columns ──────────────────────────────────────
alter table dca_strategies add column if not exists consecutive_failures integer not null default 0;
alter table dca_strategies add column if not exists last_error           text;
alter table dca_strategies add column if not exists last_error_code      text;
alter table dca_strategies add column if not exists paused_at            timestamptz;
alter table dca_strategies add column if not exists resumed_at           timestamptz;

commit;
