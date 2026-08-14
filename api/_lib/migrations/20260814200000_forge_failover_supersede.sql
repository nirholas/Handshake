-- Record that a failed generation attempt was automatically re-dispatched to
-- another lane, so the outcome ledger can tell a recovered attempt from a lost
-- one.
--
-- Both failover paths (the attended poll in api/forge.js and the unattended
-- sweep in api/cron/forge-finalize.js) already do the right thing: they mark
-- the failed attempt, resubmit the original inputs to the next healthy lane,
-- and create a successor row that carries the request to completion. What
-- neither recorded is the LINK, so every reader of the ledger counted the
-- recovered attempt as a user-visible failure.
--
-- Measured against production on 2026-08-14 over the prior 7 days: 14 of the 23
-- forge failures were `trellis_selfhost` orphans (the worker's runner instance
-- restarted mid-job), and 13 of those 14 were successfully recovered on
-- hunyuan3d seconds later. All 14 still counted against the lane in
-- /api/healthz and were rank 1 in `npm run forge:errors`, which sends a triager
-- to root-cause a failure mode the platform already handles.
--
-- Deliberately a plain uuid and not a foreign key: retention pruning
-- (docs/ops/db-retention.md) deletes old creation rows, and a FK would either
-- block that delete or need an ON DELETE rule to keep it working. A dangling
-- pointer to a pruned successor is harmless here; every reader only tests it
-- for NULL.
ALTER TABLE forge_creations
	ADD COLUMN IF NOT EXISTS superseded_by uuid;

COMMENT ON COLUMN forge_creations.superseded_by IS
	'Creation id of the successor row that re-ran this request on another lane after this attempt failed. NULL means this attempt was never failed over.';

-- Partial: only the failed-over minority is ever looked up by this, while the
-- readers that matter (the health sensor, the error report) filter on IS NULL
-- and are served by the existing created_at indexes.
CREATE INDEX IF NOT EXISTS idx_forge_creations_superseded_by
	ON forge_creations (superseded_by)
	WHERE superseded_by IS NOT NULL;
