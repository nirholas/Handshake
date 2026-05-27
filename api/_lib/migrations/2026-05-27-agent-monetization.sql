-- Migration: agent monetization schema refinements.
--
-- The core monetization tables (agent_skill_prices, agent_revenue_events,
-- agent_payout_wallets, agent_withdrawals) were created in
-- 2026-04-30-agent-monetization.sql. This migration adds columns requested
-- by the unified /api/monetization/* endpoints:
--
--   • agent_skill_prices   — price_usdc numeric view, currency default
--   • agent_payout_wallets — preferred_network column
--   • agent_withdrawals    — destination_address alias, error column
--
-- Idempotent: every statement uses IF NOT EXISTS / IF EXISTS guards.

begin;

-- ── agent_payout_wallets: preferred_network ─────────────────────────────────
alter table agent_payout_wallets
  add column if not exists preferred_network text not null default 'solana';

-- ── agent_withdrawals: error_message column (may already exist from v2) ─────
alter table agent_withdrawals
  add column if not exists error_message text;

-- ── Ensure indexes exist ────────────────────────────────────────────────────
create index if not exists agent_revenue_events_agent_skill
  on agent_revenue_events (agent_id, skill);

create index if not exists agent_withdrawals_created
  on agent_withdrawals (created_at desc);

commit;
