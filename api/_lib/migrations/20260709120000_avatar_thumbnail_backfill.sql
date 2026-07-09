-- Avatar thumbnail backfill — claim + retry ledger.
--
-- `avatars.thumbnail_key` is the source of truth for "does this avatar have a
-- thumbnail". This table exists only to make the backfill *bounded*: without it
-- a handful of un-renderable GLBs would sit at the head of the priority order
-- and every cron tick would retry them forever, starving the 10k avatars behind
-- them.
--
-- One row per avatar the backfill has attempted. Rows are DELETEd on success
-- (the avatars row now carries the key, so the avatar drops out of the candidate
-- set on its own) and retained with a bumped `attempts` + `last_error` on
-- failure. Once attempts hits the runner's cap the avatar is skipped for good.
--
-- `claimed_at` doubles as a lease: a row claimed but never resolved (container
-- killed mid-render) becomes eligible again after the runner's lease window.

CREATE TABLE IF NOT EXISTS avatar_thumbnail_backfill (
	avatar_id  uuid        PRIMARY KEY REFERENCES avatars(id) ON DELETE CASCADE,
	attempts   int         NOT NULL DEFAULT 0,
	last_error text,
	claimed_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now()
);

-- The claim query filters on (attempts, claimed_at) for every candidate join.
CREATE INDEX IF NOT EXISTS avatar_thumbnail_backfill_claim_idx
	ON avatar_thumbnail_backfill (attempts, claimed_at);

-- The candidate scan is `thumbnail_key IS NULL` over live avatars, ordered by
-- how visible the avatar is. A partial index keeps that scan off the 12k-row
-- heap once most avatars have healed.
CREATE INDEX IF NOT EXISTS avatars_missing_thumbnail_idx
	ON avatars (featured DESC, view_count DESC, created_at DESC)
	WHERE thumbnail_key IS NULL AND deleted_at IS NULL AND storage_key IS NOT NULL;
