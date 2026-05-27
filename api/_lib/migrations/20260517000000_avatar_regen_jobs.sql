-- Avatar regeneration job table.
--
-- Tracks the lifecycle of asynchronous ML regeneration jobs (re-mesh, re-texture,
-- re-rig, re-style). The persistence here is the source of truth; provider-side
-- IDs (Replicate prediction id, Meshy task id, etc.) live in ext_job_id so the
-- status endpoint can re-query the provider.

CREATE TABLE IF NOT EXISTS avatar_regen_jobs (
	job_id            text PRIMARY KEY,
	user_id           uuid NOT NULL,
	source_avatar_id  uuid NOT NULL,
	mode              text NOT NULL,        -- remesh | retex | rerig | restyle
	params            jsonb,
	status            text NOT NULL,        -- queued | running | done | failed
	provider          text,                 -- replicate | meshy | stub | …
	ext_job_id        text,                 -- provider-side job id
	result_glb_url    text,                 -- temporary URL returned by provider
	result_avatar_id  uuid,                 -- our avatar id after import
	error             text,
	created_at        timestamptz NOT NULL DEFAULT now(),
	updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_avatar_regen_jobs_user
	ON avatar_regen_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_avatar_regen_jobs_status
	ON avatar_regen_jobs (status)
	WHERE status IN ('queued', 'running');
