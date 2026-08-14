-- Collapse the duplicated built-in plugins and make the duplication impossible.
--
-- `plugins` carries `unique (identifier, author_id)` and both seed migrations
-- (2026-05-01-plugins.sql, 2026-05-21-plugins.sql) end their seed insert with
-- `on conflict (identifier, author_id) do nothing`. That guard never fires for
-- the built-ins, because they are platform-owned rows with `author_id IS NULL`
-- and in a unique index NULL never equals NULL. So the second seed run inserted
-- a complete second copy of all seven built-ins instead of skipping them.
--
-- The result was visible to every visitor: /api/plugins/list and the marketplace
-- grid rendered "Calculator", "Weather", "Web Search" and the rest twice each,
-- 14 rows where there are 7 plugins, and /api/plugins/categories reported
-- doubled per-category counts.
--
-- The seed files are not edited. scripts/apply-migrations.mjs records a sha256
-- per applied file and refuses to run when an applied migration's bytes change,
-- so this rolls the fix forward instead.
--
-- Nothing references plugins(id) by foreign key, so collapsing a duplicate pair
-- is a pure delete: keep the oldest row (the id that has existed longest and is
-- therefore the one any bookmark or shared link points at) and carry the highest
-- install_count of the group onto it so no counted install is lost.

WITH ranked AS (
    SELECT id,
           identifier,
           install_count,
           row_number() OVER (PARTITION BY identifier ORDER BY created_at, id) AS rn
    FROM plugins
    WHERE author_id IS NULL
),
survivors AS (
    SELECT identifier, id FROM ranked WHERE rn = 1
),
merged AS (
    SELECT s.id, max(r.install_count) AS install_count
    FROM survivors s
    JOIN ranked r ON r.identifier = s.identifier
    GROUP BY s.id
)
UPDATE plugins p
SET install_count = m.install_count
FROM merged m
WHERE p.id = m.id AND p.install_count <> m.install_count;

DELETE FROM plugins p
USING (
    SELECT id,
           row_number() OVER (PARTITION BY identifier ORDER BY created_at, id) AS rn
    FROM plugins
    WHERE author_id IS NULL
) d
WHERE p.id = d.id AND d.rn > 1;

-- The guarantee the composite unique key cannot give: one live platform-owned
-- row per identifier. Scoped to `deleted_at IS NULL` so retiring a built-in
-- never blocks re-seeding it later. A future seed must target this index
-- explicitly: `on conflict (identifier) where author_id is null do nothing`.
CREATE UNIQUE INDEX IF NOT EXISTS plugins_platform_identifier_uniq
    ON plugins (identifier)
    WHERE author_id IS NULL AND deleted_at IS NULL;
