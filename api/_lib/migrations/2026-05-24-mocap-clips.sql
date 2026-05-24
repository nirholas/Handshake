-- Mocap clip storage — face/body motion recordings users can save, share, and
-- replay on any three.ws avatar.
--
-- A clip is the JSON-serialized output of FaceMocap.getRecording() (or its
-- pose / hand siblings when those land). Format string carries the version
-- so the runtime can refuse incompatible clips rather than silently mangle
-- them.
--
-- Frames are stored inline as JSONB. Typical 30s @ 30Hz face capture is ~50KB
-- compressed; well within Postgres comfort zone. Anything larger (multi-minute
-- full-body) belongs in R2 and we keep just the pointer.

CREATE TABLE IF NOT EXISTS mocap_clips (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    avatar_id       uuid REFERENCES avatars(id) ON DELETE SET NULL,
    slug            text NOT NULL,
    name            text NOT NULL,
    description     text,
    -- 'face' | 'pose' | 'hand' | 'composite'. Future: 'vmc'.
    kind            text NOT NULL DEFAULT 'face' CHECK (kind IN ('face','pose','hand','composite','vmc')),
    -- Wire format identifier — three.ws.face-mocap.v1, etc. The runtime asserts
    -- on this before replaying so a v2 clip can't silently load on a v1 player.
    format          text NOT NULL DEFAULT 'three.ws.face-mocap.v1',
    duration_ms     int NOT NULL DEFAULT 0,
    frame_count     int NOT NULL DEFAULT 0,
    -- Inline frame array — { t, shapes, mat? }[] for face clips. For clips
    -- larger than ~256KB, store a JSONB stub like { external: true } and put
    -- the payload at storage_key.
    frames          jsonb,
    storage_key     text,
    thumbnail_key   text,
    tags            text[] NOT NULL DEFAULT '{}',
    visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','unlisted','public')),
    -- Optional pricing — when set, the clip is for sale via the marketplace
    -- pipeline. Mirrors avatars' price model: null = free.
    price_amount    numeric(30,9),
    price_currency  text,
    play_count      bigint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    UNIQUE (owner_id, slug)
);

CREATE INDEX IF NOT EXISTS mocap_clips_owner_idx
    ON mocap_clips (owner_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mocap_clips_public_idx
    ON mocap_clips (visibility, created_at DESC)
    WHERE visibility = 'public' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mocap_clips_kind_idx
    ON mocap_clips (kind, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mocap_clips_tags_idx
    ON mocap_clips USING gin (tags);

-- updated_at trigger
DO $$ BEGIN
    CREATE TRIGGER mocap_clips_set_updated_at
    BEFORE UPDATE ON mocap_clips
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
