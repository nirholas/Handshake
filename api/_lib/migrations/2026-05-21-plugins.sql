-- Plugin marketplace table.
-- Stores LobeHub/pai-chat ToolManifest plugins published by users.
-- Referenced by api/plugins/[action].js and api/users/[username].js.

CREATE TABLE IF NOT EXISTS plugins (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id     uuid          REFERENCES users(id) ON DELETE SET NULL,
    identifier    text          NOT NULL,
    manifest_url  text,
    manifest_json jsonb         NOT NULL,
    name          text          NOT NULL,
    description   text          NOT NULL DEFAULT '',
    category      text          NOT NULL DEFAULT 'general',
    tags          text[]        NOT NULL DEFAULT '{}',
    is_public     boolean       NOT NULL DEFAULT true,
    install_count int           NOT NULL DEFAULT 0,
    avg_rating    numeric(3,2)  NOT NULL DEFAULT 0,
    rating_count  int           NOT NULL DEFAULT 0,
    deleted_at    timestamptz,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (identifier, author_id)
);

CREATE INDEX IF NOT EXISTS idx_plugins_author    ON plugins (author_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugins_public    ON plugins (install_count DESC, created_at DESC) WHERE is_public = true AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugins_category  ON plugins (category, install_count DESC) WHERE is_public = true AND deleted_at IS NULL;
