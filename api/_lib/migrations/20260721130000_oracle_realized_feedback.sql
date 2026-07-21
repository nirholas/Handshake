-- Oracle realized-outcome feedback: close the loop between the sniper's real
-- money and the Oracle/intel that decides what to buy.
--
-- Until now two learning systems ran in separate silos:
--   * Oracle/intel learned "which launch signals predict a coin PUMPING" from
--     coarse chart labels (pump_coin_outcomes: ATH >= 3x = a win).
--   * The sniper optimizer learned "which config makes money" from realized PnL.
-- Neither fed the other, and Oracle never saw a single real trade result. A coin
-- can ATH 3x on the chart and the sniper still LOSE (bought late, timed-out
-- exit). Realized PnL is scarcer but far higher-fidelity ground truth.
--
-- Two additive tables:
--   oracle_realized_outcomes: per mint, the fleet's REAL realized result
--       (win/loss + avg PnL%), derived from agent_sniper_positions by the
--       api/cron/oracle-realized-labels cron. trainWeights (intel/learn.js)
--       LEFT JOINs this and PREFERS the realized label when present, so Oracle
--       trains on real money, not just price history. (Bridge 1)
--   oracle_calibration: per conviction bucket, how the Oracle's score
--       lined up with the REALIZED win rate (does an 80 actually win ~80%?),
--       plus a bounded correction_factor the scorer can apply. Written by
--       api/cron/oracle-calibrate. (Bridge 3)
--
-- Additive and idempotent, safe to re-run.

CREATE TABLE IF NOT EXISTS oracle_realized_outcomes (
	mint             TEXT NOT NULL,
	network          TEXT NOT NULL DEFAULT 'mainnet',
	realized_win     INTEGER NOT NULL,          -- 1 if net realized PnL > 0 across the fleet's closes, else 0
	realized_pnl_pct NUMERIC,                    -- avg realized_pnl_pct across closed real positions on this mint
	samples          INTEGER NOT NULL DEFAULT 0, -- number of closed real positions backing the label
	updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (mint, network)
);

CREATE INDEX IF NOT EXISTS oracle_realized_outcomes_net
	ON oracle_realized_outcomes (network, updated_at DESC);

CREATE TABLE IF NOT EXISTS oracle_calibration (
	network           TEXT NOT NULL DEFAULT 'mainnet',
	bucket_lo         INTEGER NOT NULL,          -- conviction band floor (inclusive)
	bucket_hi         INTEGER NOT NULL,          -- conviction band ceiling (exclusive; 101 for the top band)
	samples           INTEGER NOT NULL DEFAULT 0,
	wins              INTEGER NOT NULL DEFAULT 0,
	observed_rate     NUMERIC,                    -- realized win rate in this band (0..1)
	avg_conviction    NUMERIC,                    -- mean conviction score of coins in this band
	avg_realized_pct  NUMERIC,                    -- mean realized PnL% in this band
	correction_factor NUMERIC NOT NULL DEFAULT 1, -- bounded multiplier for future scores in this band
	updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (network, bucket_lo)
);
