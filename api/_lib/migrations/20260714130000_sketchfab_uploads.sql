-- Sketchfab showcase ledger (api/cron/sketchfab-showcase.js).
--
-- Tracks which forge creations have been pushed to the official three.ws
-- Sketchfab account so a model is never uploaded twice and a failing upload
-- retries at most 3 times before being parked.
--
-- Lifecycle: pending (claimed by a cron run) -> uploaded (201 from Sketchfab,
-- async processing underway) -> live (processing SUCCEEDED) | failed
-- (upload error or processing FAILED; `error` holds the reason).

CREATE TABLE IF NOT EXISTS sketchfab_uploads (
	id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
	creation_id   uuid        NOT NULL UNIQUE REFERENCES forge_creations(id) ON DELETE CASCADE,
	source        text        NOT NULL DEFAULT 'top_voted', -- board_winner | top_voted
	status        text        NOT NULL DEFAULT 'pending',   -- pending | uploaded | live | failed
	attempts      integer     NOT NULL DEFAULT 1,
	sketchfab_uid text,
	sketchfab_url text,
	error         text,
	prompt        text,
	glb_url       text,
	created_at    timestamptz NOT NULL DEFAULT now(),
	updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sketchfab_uploads_status
	ON sketchfab_uploads (status, updated_at DESC);
