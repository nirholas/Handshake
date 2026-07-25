-- Take-initials-at-2x becomes fleet-wide default (owner rule, 2026-07-25).
--
-- The owner's complaint: watching an arm ride a winner and give it all back, or
-- exit a winner entirely. The laddered exit already encodes the fix (the FIRST
-- time a position reaches initials_out_multiple x entry, sell exactly enough to
-- recover the cost basis and let the remainder ride behind the trailing stop),
-- but it was opt-in and most arms never opted in. From now on every strategy is
-- born with the ladder armed at 2x: once a coin doubles, the initial buy-in is
-- back in the wallet and whatever happens next costs nothing.
--
-- Explicit opt-out is preserved: setting initials_out_multiple to null through
-- the strategy API restores the classic single-shot exit for that arm, and the
-- earned-autonomy optimizer keeps tuning the multiple on trusted arms within
-- its bounds (1.5-5x trusted, 1.5-10x autonomous).
--
-- Additive and idempotent, safe to re-run.

ALTER TABLE agent_sniper_strategies
	ALTER COLUMN initials_out_multiple SET DEFAULT 2;

COMMENT ON COLUMN agent_sniper_strategies.initials_out_multiple IS
	'Entry multiple at which the ladder sells exactly enough to recover the cost basis and lets the rest ride (fleet default 2). Null = classic single-shot exit, explicit opt-out.';

-- Arm the ladder on every strategy that never chose a value. Rows with an
-- optimizer-tuned or hand-set multiple keep it.
UPDATE agent_sniper_strategies
SET initials_out_multiple = 2, updated_at = NOW()
WHERE initials_out_multiple IS NULL;
