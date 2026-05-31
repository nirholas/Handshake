-- Animation clip storage — keyframe animations users author in the Animation
-- Studio (/pose), save to their account, share, sell, and replay on any
-- three.ws avatar.
--
-- A clip is the JSON-serialized output of THREE.AnimationClip.toJSON() (canonical
-- Avaturn/Mixamo bone track names — see public/animations/clips/*.json). We also
-- persist the editable keyframe document (`editor_doc`) so the studio can reopen
-- a saved clip and continue editing losslessly, not just replay a baked clip.
--
-- Clips are small (quaternion tracks resampled at fps for a few seconds are tens
-- of KB), so the baked clip lives inline as JSONB. Anything over the inline cap
-- is offloaded to R2 and we keep just the pointer in `storage_key`.
--
-- Mirrors mocap_clips (api/_lib/migrations/2026-05-24-mocap-clips.sql) for auth,
-- ownership, slugs, visibility, soft-delete, and pricing. The monetization
-- columns (price_*, artifact_*, creator_payto_*, listed) are populated by the
-- sell flow; null/false here means "not for sale".

CREATE TABLE IF NOT EXISTS animation_clips (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    avatar_id       uuid REFERENCES avatars(id) ON DELETE SET NULL,
    slug            text NOT NULL,
    name            text NOT NULL,
    description     text,
    -- 'animation' (one-shot), 'loop' (cyclic, e.g. walk cycle), 'sequence'.
    kind            text NOT NULL DEFAULT 'animation' CHECK (kind IN ('animation','loop','sequence')),
    -- Wire format identifier so the runtime can refuse incompatible clips.
    format          text NOT NULL DEFAULT 'three.ws.animation.v1',
    duration_ms     int NOT NULL DEFAULT 0,
    frame_count     int NOT NULL DEFAULT 0,
    fps             int,
    loop            boolean NOT NULL DEFAULT true,
    -- Baked THREE.AnimationClip.toJSON() — { name, duration, tracks[] }. For
    -- clips larger than the inline cap, this is null and the payload lives at
    -- storage_key (R2).
    clip            jsonb,
    storage_key     text,
    -- Editable keyframe document ({ name, duration, fps, loop, keyframes[] }) so
    -- a saved clip can be reopened in the studio for lossless re-editing.
    editor_doc      jsonb,
    thumbnail_key   text,
    tags            text[] NOT NULL DEFAULT '{}',
    visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','unlisted','public')),
    -- Optional pricing — when set + listed, the clip sells via the x402 paid
    -- download endpoint (api/x402/animation-download.js). Mirrors mocap/avatars.
    price_amount    numeric(30,9),
    price_currency  text,
    -- Sellable artifact (GLB with embedded animation) staged in R2 + its payout
    -- routing. Populated by the sell flow; gate the file behind payment, not
    -- behind listing visibility.
    artifact_key        text,
    artifact_bytes      bigint,
    artifact_mime       text,
    creator_payto_base  text,
    creator_payto_solana text,
    creator_payto_bsc   text,
    listed          boolean NOT NULL DEFAULT false,
    play_count      bigint NOT NULL DEFAULT 0,
    purchase_count  bigint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    UNIQUE (owner_id, slug)
);

CREATE INDEX IF NOT EXISTS animation_clips_owner_idx
    ON animation_clips (owner_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS animation_clips_public_idx
    ON animation_clips (visibility, created_at DESC)
    WHERE visibility = 'public' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS animation_clips_kind_idx
    ON animation_clips (kind, created_at DESC)
    WHERE deleted_at IS NULL;

-- Priced + listed clips, newest first — feeds the marketplace animations surface.
CREATE INDEX IF NOT EXISTS animation_clips_listed_idx
    ON animation_clips (listed, created_at DESC)
    WHERE listed = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS animation_clips_tags_idx
    ON animation_clips USING gin (tags);

-- updated_at trigger
DO $$ BEGIN
    CREATE TRIGGER animation_clips_set_updated_at
    BEFORE UPDATE ON animation_clips
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
