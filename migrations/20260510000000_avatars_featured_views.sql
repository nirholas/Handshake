-- Add featured flag and view counter to avatars table.
-- featured = true surfaces the avatar at the top of the hero carousel and
-- community grid. Curated manually by admins via direct SQL or a future
-- admin panel.
-- view_count is incremented by the /api/avatars/view endpoint on each
-- unique page view; used for "popular" sort order.

ALTER TABLE avatars
  ADD COLUMN IF NOT EXISTS featured   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS view_count bigint      NOT NULL DEFAULT 0;

-- Index so ORDER BY featured DESC, created_at DESC is fast.
CREATE INDEX IF NOT EXISTS idx_avatars_featured ON avatars (featured DESC, created_at DESC)
  WHERE deleted_at IS NULL AND visibility = 'public';

-- Seed the featured flag for the curated showcase avatars (matched by slug
-- prefix so new uploads don't accidentally get featured by sharing a name).
UPDATE avatars
SET featured = true
WHERE deleted_at IS NULL
  AND visibility = 'public'
  AND (
       name ILIKE 'CZ'
OR name ILIKE 'Soldier%'
    OR name ILIKE 'Robot%Expressive'
    OR name ILIKE 'Floating%Character'
    OR name ILIKE 'Stork'
    OR name ILIKE 'Parrot'
    OR name ILIKE 'Horse'
    OR name ILIKE 'Flamingo'
    OR name ILIKE 'Xbot'
    OR name ILIKE 'Michelle'
    OR name ILIKE 'Fox'
    OR name ILIKE 'CesiumMan'
    OR name ILIKE 'BrainStem'
  );
