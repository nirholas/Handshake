-- Unstoppable Agent tables
-- Provisions treasury, activity log, and daily reflection log for the
-- self-sustaining agent that funds itself through x402 micropayments.

-- Treasury snapshot — single row, upserted on each tick
CREATE TABLE IF NOT EXISTS unstoppable_treasury (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance_usdc_atomics BIGINT NOT NULL DEFAULT 0,
  lifetime_earned_atomics BIGINT NOT NULL DEFAULT 0,
  lifetime_spent_atomics BIGINT NOT NULL DEFAULT 0,
  runway_days NUMERIC(6,2) NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'normal',  -- 'normal'|'conservation'|'halted'
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Activity log — one row per agent action
CREATE TABLE IF NOT EXISTS unstoppable_activity (
  id BIGSERIAL PRIMARY KEY,
  tick_id TEXT NOT NULL,
  action_type TEXT NOT NULL,  -- 'think'|'search'|'earn'|'reflect'|'status_check'|'idle'|'post_status'
  description TEXT NOT NULL,
  cost_atomics BIGINT NOT NULL DEFAULT 0,
  revenue_atomics BIGINT NOT NULL DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unstoppable_activity_created_at
  ON unstoppable_activity (created_at DESC);

-- Reflection log — one row per calendar day
CREATE TABLE IF NOT EXISTS unstoppable_reflections (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  earnings_24h_atomics BIGINT NOT NULL DEFAULT 0,
  costs_24h_atomics BIGINT NOT NULL DEFAULT 0,
  actions_count INTEGER NOT NULL DEFAULT 0,
  strategy_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
