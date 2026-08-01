-- forge_seed_jobs: record what the catalog quality gate decided, which backend
-- actually generated the mesh, and whether the keeper was rigged before publish.
--
-- Before this, a seed job only recorded pending/done/failed, so "accept rate"
-- and "cost per accepted asset" were unanswerable: a rejected blob and a clean
-- humanoid both landed as 'done'. The gate verdict is stored verbatim (the same
-- object evaluateSeedAsset returns) so thresholds can be re-tuned against real
-- historical decisions instead of re-generating the batch.
--
-- status gains two values: 'rejected' (generated fine, failed the gate, mesh
-- quarantined under forge/rejected/) and 'gate_error' (the gate itself could not
-- run: an infrastructure fault, never counted against accept rate).

ALTER TABLE forge_seed_jobs ADD COLUMN IF NOT EXISTS backend         text;
ALTER TABLE forge_seed_jobs ADD COLUMN IF NOT EXISTS gate            jsonb;
ALTER TABLE forge_seed_jobs ADD COLUMN IF NOT EXISTS gate_reasons    text[];
ALTER TABLE forge_seed_jobs ADD COLUMN IF NOT EXISTS rig_job_id      text;
ALTER TABLE forge_seed_jobs ADD COLUMN IF NOT EXISTS rig_creation_id uuid;
ALTER TABLE forge_seed_jobs ADD COLUMN IF NOT EXISTS avatar_id       uuid;
ALTER TABLE forge_seed_jobs ADD COLUMN IF NOT EXISTS batch           text;

-- Accept-rate + cost reporting reads (status, backend) over a date window; the
-- batch runner reads its own rows by batch label to resume.
CREATE INDEX IF NOT EXISTS forge_seed_jobs_report_idx
    ON forge_seed_jobs (started_at DESC, status);
CREATE INDEX IF NOT EXISTS forge_seed_jobs_batch_idx
    ON forge_seed_jobs (batch, started_at DESC)
    WHERE batch IS NOT NULL;
