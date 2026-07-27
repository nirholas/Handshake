-- A settled position can never return to 'open'. Enforced in the database.
--
-- The worker's reconcile park wrote `SET status = 'open', error =
-- 'reconcile_pending'` with no status guard, so it also resurrected rows that
-- had been CLOSED concurrently — by a reconcile that landed in another sweep, or
-- by an operator clearing a wedge. A resurrected row keeps its sell_sig,
-- closed_at, exit_reason and realized P&L while reading status='open': the trade
-- is settled and its proceeds are already booked, yet it counts as live risk,
-- renders as an open position on trader pages, and permanently holds one of its
-- arm's max_concurrent_positions slots. Observed twice in production on the same
-- rows within 24 hours.
--
-- The code-side guard ships in the worker (executor.js), but the worker is a
-- separately deployed service and the invariant is not code-specific: nothing
-- should ever move a settled position back to open, whatever is running. So the
-- rule lives here, where every writer is subject to it and no deploy is needed.
--
-- Coerce rather than raise: a resurrection attempt is a bug in the caller, not a
-- reason to fail its transaction and abandon the rest of the sweep. The row
-- keeps its settled status, every other column in the UPDATE still applies, and
-- the attempt is visible in the sniper_resurrect_attempts counter below.
--
-- Idempotent, safe to re-run.

CREATE TABLE IF NOT EXISTS sniper_resurrect_attempts (
	id           BIGSERIAL PRIMARY KEY,
	position_id  UUID        NOT NULL,
	attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	from_status  TEXT,
	to_status    TEXT
);

COMMENT ON TABLE sniper_resurrect_attempts IS
	'Audit of blocked attempts to move a settled (closed) position back to an open state. A non-empty recent window means some writer still carries the unguarded reconcile park.';

CREATE INDEX IF NOT EXISTS idx_sniper_resurrect_attempts_at
	ON sniper_resurrect_attempts (attempted_at DESC);

CREATE OR REPLACE FUNCTION sniper_block_resurrect() RETURNS TRIGGER AS $$
BEGIN
	-- Only a genuinely settled row is protected: closed AND stamped with when it
	-- closed. A row merely marked 'closed' with no closed_at is mid-write and left
	-- alone, so no legitimate close path is affected.
	IF OLD.status = 'closed' AND OLD.closed_at IS NOT NULL AND NEW.status <> 'closed' THEN
		INSERT INTO sniper_resurrect_attempts (position_id, from_status, to_status)
		VALUES (OLD.id, OLD.status, NEW.status);
		NEW.status := 'closed';
		NEW.closed_at := OLD.closed_at;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sniper_block_resurrect ON agent_sniper_positions;
CREATE TRIGGER trg_sniper_block_resurrect
	BEFORE UPDATE ON agent_sniper_positions
	FOR EACH ROW
	EXECUTE FUNCTION sniper_block_resurrect();

-- Repair anything already resurrected: a row carrying a real exit is settled,
-- whatever overwrote its status.
UPDATE agent_sniper_positions
SET status = 'closed'
WHERE status <> 'closed'
  AND closed_at IS NOT NULL
  AND sell_sig IS NOT NULL
  AND realized_pnl_lamports IS NOT NULL;
