-- Never sell 100% of a winner: every profitable exit keeps a moon bag.
--
-- Owner rule. Once a position's cost basis has been recovered, the remainder is
-- free: a bag that goes to zero cost us nothing, and a bag that runs is the whole
-- upside. Selling the last slice to bank a few thousandths of a SOL trades all of
-- that away for a rounding error. So a terminal exit that is IN PROFIT now sells
-- down to the moon-bag floor instead of to zero, and the retained tokens ride
-- indefinitely.
--
-- The position still books status='closed' when that happens. That is deliberate:
-- its realized P&L lands in every existing report unchanged, and its
-- max_concurrent_positions slot is released so a held bag can never stop an arm
-- from taking the next trade. Only the tokens stay behind, recorded here.
--
-- A stop-loss on money still at risk (initials not yet recovered) remains a FULL
-- exit. Nothing about that position is free yet, so the hard downside cap stands.
--
-- Additive and idempotent, safe to re-run.

ALTER TABLE agent_sniper_positions
	ADD COLUMN IF NOT EXISTS moonbag_base_amount         NUMERIC(40, 0) NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS moonbag_entry_lamports      NUMERIC(40, 0) NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS moonbag_last_value_lamports NUMERIC(40, 0) NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS moonbag_opened_at           TIMESTAMPTZ,
	ADD COLUMN IF NOT EXISTS moonbag_last_quoted_at      TIMESTAMPTZ;

COMMENT ON COLUMN agent_sniper_positions.moonbag_base_amount IS
	'Tokens deliberately retained at close and left riding. 0 = the position fully exited (a loss exit, or the rule was switched off).';
COMMENT ON COLUMN agent_sniper_positions.moonbag_entry_lamports IS
	'Cost basis still carried by the retained tokens. ~0 once initials were recovered, which is what makes the bag free.';
COMMENT ON COLUMN agent_sniper_positions.moonbag_last_value_lamports IS
	'Last re-quoted SOL value of the retained bag. Refreshed on a slow cadence; never drives an exit.';

-- The moon-bag ledger: every bag still riding, newest first.
CREATE INDEX IF NOT EXISTS idx_sniper_positions_moonbag
	ON agent_sniper_positions (network, closed_at DESC)
	WHERE moonbag_base_amount > 0;

-- Per-strategy escape hatch. Default TRUE: the rule is fleet-wide policy, and a
-- null on an existing row is treated as ON by the worker, so no backfill is
-- needed. Set FALSE only for a strategy that genuinely must exit completely.
ALTER TABLE agent_sniper_strategies
	ADD COLUMN IF NOT EXISTS moonbag_always BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN agent_sniper_strategies.moonbag_always IS
	'When true (default), a terminal exit in profit sells down to moonbag_min_pct instead of to zero and the remainder rides indefinitely.';
