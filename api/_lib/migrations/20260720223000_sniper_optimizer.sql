-- Autonomous sniper optimizer: closes the learn-from-outcomes loop.
--
-- The optimizer cron (api/cron/sniper-optimize.js) reads each arm's REAL trading
-- record (agent_sniper_positions) over a trailing window and proposes bounded
-- adjustments to the strategy's own knobs (stops, take-profit, hold, sizing,
-- entry-quality thresholds). It runs in one of two modes:
--
--   shadow (default): compute + persist proposals, mutate NOTHING. This is how
--          you watch it make tuning calls before it ever touches a live arm.
--   apply:  additionally UPDATE the strategy fields, but ONLY for arms that
--           explicitly opted in via auto_optimize = true. Every applied change is
--           bounded (small step per run) and logged both here and, for the
--           agent, in the tamper-evident Reasoning Ledger (agent_decisions).
--
-- The deterministic safety rails are never touched by the optimizer: it only
-- moves fields a human owner already tunes, each clamped to a hard range. The
-- trade firewall, Mayhem exclusion, budgets, and concurrency stay sovereign.
--
-- Additive and idempotent, safe to re-run.

ALTER TABLE agent_sniper_strategies
	ADD COLUMN IF NOT EXISTS auto_optimize BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS agent_sniper_optimizer_runs (
	id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	strategy_id    UUID NOT NULL REFERENCES agent_sniper_strategies(id) ON DELETE CASCADE,
	agent_id       UUID NOT NULL,
	network        TEXT NOT NULL DEFAULT 'mainnet',
	mode           TEXT NOT NULL,                 -- 'shadow' | 'apply'
	window_label   TEXT NOT NULL,                 -- e.g. '7d'
	sample_size    INTEGER NOT NULL DEFAULT 0,    -- closed real trades in window
	evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the per-arm stats the decision used
	proposals      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ field, from, to, reason }]
	applied        BOOLEAN NOT NULL DEFAULT false,
	ledger_seq     BIGINT,                        -- agent_decisions.seq when applied+logged
	created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sniper_optimizer_runs_strategy
	ON agent_sniper_optimizer_runs (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sniper_optimizer_runs_agent
	ON agent_sniper_optimizer_runs (agent_id, created_at DESC);
