-- Bound how long a position may sit unreconcilable, and stop resurrecting closed rows.
--
-- When a sell's confirmation times out but the tx landed, the wallet's bag is
-- already gone. The executor detects that (real balance 0), tries to find the
-- emptying tx, and when it cannot yet, parks the position as
-- error='reconcile_pending' for the next sweep. Two things went wrong with that
-- park in production:
--
--   1. The park had no time bound. A position whose emptying tx could not be
--      found kept re-parking every sweep forever. Because countOpenPositions()
--      counts 'opening'/'open'/'closing', each wedged position permanently held
--      one of its arm's max_concurrent_positions slots — five positions had the
--      fleet down to almost no capacity, some parked for over 40 hours.
--
--   2. The park wrote status='open' with no status guard, so it also resurrected
--      positions that had been CLOSED concurrently (by a reconcile that landed in
--      another sweep, or by an operator). Those rows kept closed_at, sell_sig,
--      exit_reason and realized P&L while reading status='open': counted as live
--      risk, shown as open on trader pages, and holding a slot despite being
--      settled. The guard lives in code; this column makes the timeout possible.
--
-- Records when a position FIRST entered reconcile_pending, so the executor can
-- give up after a bounded wait and free the slot instead of parking forever.
-- Cleared whenever the position reconciles or sells normally.
--
-- Additive and idempotent, safe to re-run.

ALTER TABLE agent_sniper_positions
	ADD COLUMN IF NOT EXISTS reconcile_pending_since TIMESTAMPTZ;

COMMENT ON COLUMN agent_sniper_positions.reconcile_pending_since IS
	'When the position first parked as reconcile_pending (bag confirmed gone on-chain, emptying tx not yet found). NULL once it reconciles. Drives the bounded give-up that frees the arm concurrency slot.';

-- Find the wedged set fast; the give-up check runs every sweep.
CREATE INDEX IF NOT EXISTS idx_sniper_positions_reconcile_pending
	ON agent_sniper_positions (reconcile_pending_since)
	WHERE reconcile_pending_since IS NOT NULL;

-- Repair rows the missing status guard already resurrected: a row carrying a
-- real exit (sell_sig + closed_at + realized P&L) is settled, whatever the
-- resurrection wrote over its status.
UPDATE agent_sniper_positions
SET status = 'closed'
WHERE status <> 'closed'
  AND closed_at IS NOT NULL
  AND sell_sig IS NOT NULL
  AND realized_pnl_lamports IS NOT NULL;
