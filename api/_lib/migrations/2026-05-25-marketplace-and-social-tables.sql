-- Migration: agent_reviews, x_triggers, x_scheduled_posts, x_pending_reviews
-- Also: club_tips.amount_atomics column if missing
-- All idempotent.

BEGIN;

-- ── agent_reviews — marketplace ratings and reviews ──────────────────────────
CREATE TABLE IF NOT EXISTS agent_reviews (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id     uuid        NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating       int         NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review       text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, user_id)
);
CREATE INDEX IF NOT EXISTS agent_reviews_agent_id ON agent_reviews(agent_id);
CREATE INDEX IF NOT EXISTS agent_reviews_user_id  ON agent_reviews(user_id);

-- ── x_triggers — social automation triggers ───────────────────────────────────
CREATE TABLE IF NOT EXISTS x_triggers (
    id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id       uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    kind           text        NOT NULL,
    config         jsonb       NOT NULL DEFAULT '{}',
    auto_publish   boolean     NOT NULL DEFAULT false,
    enabled        boolean     NOT NULL DEFAULT true,
    last_fired_at  timestamptz,
    last_state     jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_triggers_user_id ON x_triggers(user_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS x_triggers_agent_id ON x_triggers(agent_id) WHERE enabled;

-- ── x_scheduled_posts — queued social posts ───────────────────────────────────
CREATE TABLE IF NOT EXISTS x_scheduled_posts (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id     uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    text         text        NOT NULL,
    scheduled_at timestamptz NOT NULL,
    published_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_scheduled_posts_pending
    ON x_scheduled_posts(scheduled_at) WHERE published_at IS NULL;

-- ── x_pending_reviews — posts awaiting human approval ─────────────────────────
CREATE TABLE IF NOT EXISTS x_pending_reviews (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trigger_id   uuid        REFERENCES x_triggers(id) ON DELETE SET NULL,
    agent_id     uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    text         text        NOT NULL,
    reviewed_at  timestamptz,
    approved     boolean,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_pending_reviews_user_pending
    ON x_pending_reviews(user_id) WHERE reviewed_at IS NULL;

-- ── club_tips — backfill amount_atomics if column absent ─────────────────────
ALTER TABLE club_tips ADD COLUMN IF NOT EXISTS amount_atomics numeric;

COMMIT;
