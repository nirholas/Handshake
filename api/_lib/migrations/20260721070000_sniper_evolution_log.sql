-- Sniper self-improvement (evolution) audit log.
--
-- The evolution engine (scripts/sniper-evolve.mjs) reads each arm's real+paper
-- trading evidence and the ground-truth base rate, then autonomously mutates the
-- fleet's STRATEGY PARAMETERS (budget allocation, thresholds, which arm is on,
-- spawned variants) to push the population toward what actually wins. Every
-- proposal it makes, applied or dry-run, is appended here so the autonomy is
-- fully auditable and reversible: each row carries the before/after of the exact
-- fields it touched and the evidence that justified the change.
--
-- It NEVER writes a safety field (stop_loss_pct, firewall_level, max_price_impact,
-- the daily-loss cap) — those live in code and are out of the optimizer's reach by
-- construction. This table records only what it is allowed to move.
--
-- Additive and idempotent, safe to re-run.
CREATE TABLE IF NOT EXISTS sniper_evolution_log (
	id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	run_id      TEXT NOT NULL,
	network     TEXT NOT NULL DEFAULT 'mainnet',
	strategy_id UUID,
	label       TEXT,
	action      TEXT NOT NULL,          -- reallocate | retire | revive | tune | spawn
	field       TEXT,                   -- the parameter changed (null for multi-field spawn)
	before_val  TEXT,
	after_val   TEXT,
	fitness     NUMERIC,                -- the arm's fitness at decision time
	evidence    JSONB,                  -- samples, win rate, base rate, wilson bounds, etc.
	applied     BOOLEAN NOT NULL DEFAULT false,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sniper_evolution_log_run  ON sniper_evolution_log (network, created_at DESC);
CREATE INDEX IF NOT EXISTS sniper_evolution_log_arm  ON sniper_evolution_log (strategy_id, created_at DESC);
