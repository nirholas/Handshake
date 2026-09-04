-- Migration: adversarial pre-trade Risk Officer for the agent-sniper fleet.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260904020000_sniper_risk_officer.sql
-- Additive and idempotent, safe to re-run.
--
-- The executor's existing gates (Mayhem exclusion, market-cap band, budget and
-- concurrency caps, spend policy, price-impact breaker, trade firewall) are all
-- mechanical. The Risk Officer (workers/agent-sniper/risk-officer.js) is the
-- independent second opinion that sits behind them: it is shown the trade the
-- agent wants to make plus the agent's own thesis, and is told to look for what
-- the agent missed.
--
-- This migration adds:
--
--   1. agent_sniper_strategies.risk_officer_level: per-strategy enforcement.
--      'shadow' (default): the review runs and is recorded, and changes nothing.
--      'enforce':          a 'block' severity aborts the buy; a smaller
--                          size_adjustment shrinks it.
--      'off':              never called.
--      Shadow is the default ON PURPOSE. Enforcement decides what the live fleet
--      buys with real SOL, so arming it is an owner decision, not a deploy-time
--      default, and shadow rows are the evidence that decision needs.
--
--   2. agent_sniper_strategies.risk_officer_model: optional per-strategy model
--      override. Left null, the officer uses SNIPER_RISK_OFFICER_MODEL, which
--      deliberately differs from the buy-side judge's model so the second
--      opinion is not an echo of the first.
--
--   3. sniper_risk_reviews: append-only ledger of every review, enforced or
--      not. A shadow row records the veto that WOULD have been cast against a
--      position that actually opened, so the position's realized P&L later says
--      whether the officer was right.

begin;

-- ── per-strategy enforcement mode ────────────────────────────────────────────
alter table agent_sniper_strategies
    add column if not exists risk_officer_level text not null default 'shadow'
        check (risk_officer_level in ('off', 'shadow', 'enforce'));

alter table agent_sniper_strategies
    add column if not exists risk_officer_model text;

-- ── review ledger ────────────────────────────────────────────────────────────
create table if not exists sniper_risk_reviews (
    id                bigint generated always as identity primary key,
    created_at        timestamptz not null default now(),
    agent_id          uuid not null,
    strategy_id       uuid,
    -- the position row the review is attached to; null when the buy never
    -- claimed a slot.
    position_id       uuid,
    network           text not null default 'mainnet' check (network in ('mainnet', 'devnet')),
    mint              text not null,
    symbol            text,
    -- the level in force when the review ran ('shadow' rows are counterfactual)
    level             text not null check (level in ('shadow', 'enforce')),
    veto              boolean not null default false,
    severity          text not null check (severity in ('none', 'caution', 'block')),
    reasons           text[] not null default '{}',
    proposed_lamports numeric(40, 0) not null,
    -- set when the officer asked for a smaller size (shadow: what it would have been)
    adjusted_lamports numeric(40, 0),
    -- true only when the review actually changed the trade (never true in shadow)
    enforced          boolean not null default false,
    model             text,
    answered_by       text,
    latency_ms        integer,
    -- the reviewer was unavailable / unparseable and the trade proceeded unreviewed
    degraded          boolean not null default false,
    agent_reason      text
);

-- An agent's own review history (owner-facing audit + the arm-it decision).
create index if not exists sniper_risk_reviews_agent
    on sniper_risk_reviews (agent_id, created_at desc);

-- Did the officer's call match what the position actually did?
create index if not exists sniper_risk_reviews_position
    on sniper_risk_reviews (position_id)
    where position_id is not null;

-- Veto-rate analytics across the fleet.
create index if not exists sniper_risk_reviews_severity
    on sniper_risk_reviews (network, severity, created_at desc);

commit;
