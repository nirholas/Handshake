-- world_docs — generic per-world persistence index (T3 of the 3D-world roadmap).
--
-- Stores one durable JSON document per world, keyed by an opaque world id
-- (a coin mint, a "<mint>#holders" tier key, a realm id, etc.). The building
-- system (T11/T12) and the creator economy (T21/T24) layer on top of this.
--
-- Storage split (mirrors the documented split in api/_lib/world-store.js):
--   • Small docs live INLINE in `inline_doc` (jsonb) so the common case is a
--     single indexed round-trip with no object-store hop.
--   • Large docs (placed-object payloads past the inline cap) are written to R2
--     at a content-addressed key in `r2_key`; this row is the queryable index +
--     the optimistic-concurrency gate.
--
-- Optimistic concurrency: `etag` is a content hash of the stored bytes. A writer
-- passes the etag it last read; a conditional UPDATE that no longer matches means
-- someone else wrote first (HTTP 409). `doc_version` is a monotonic counter for
-- humans/telemetry.

CREATE TABLE IF NOT EXISTS world_docs (
	world_id       text        PRIMARY KEY,
	schema_version int         NOT NULL DEFAULT 1,
	doc_version    bigint      NOT NULL DEFAULT 1,
	etag           text        NOT NULL,
	size_bytes     int         NOT NULL DEFAULT 0,
	inline_doc     jsonb,
	r2_key         text,
	owner_id       text,
	updated_by     text,
	created_at     timestamptz NOT NULL DEFAULT now(),
	updated_at     timestamptz NOT NULL DEFAULT now(),
	-- A row always carries its body exactly one way: inline or offloaded to R2.
	CONSTRAINT world_docs_body_present CHECK (inline_doc IS NOT NULL OR r2_key IS NOT NULL)
);

-- "What worlds does this account own?" (permission model, T16/T24).
CREATE INDEX IF NOT EXISTS world_docs_owner_idx ON world_docs (owner_id) WHERE owner_id IS NOT NULL;

-- "Most recently edited worlds" (activity feeds, admin tooling).
CREATE INDEX IF NOT EXISTS world_docs_updated_idx ON world_docs (updated_at DESC);
