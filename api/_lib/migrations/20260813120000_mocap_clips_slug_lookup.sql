-- Index mocap clip slugs so /api/mocap/clips/:idOrSlug can resolve the slug form.
--
-- The table's only slug index is the UNIQUE (owner_id, slug) constraint, whose
-- leading column is the owner. A slug lookup that does not know the owner (the
-- share-link path: GET /api/mocap/clips/<slug> from a signed-out visitor) cannot
-- use it and degrades to a sequential scan over every clip ever recorded. This
-- index makes the lookup a direct probe, and mirrors the partial-on-deleted_at
-- pattern the table's other indexes already use so soft-deleted rows stay out.

CREATE INDEX IF NOT EXISTS mocap_clips_slug_idx
    ON mocap_clips (slug)
    WHERE deleted_at IS NULL;
