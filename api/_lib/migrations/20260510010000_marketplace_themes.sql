-- Weekly themes for the marketplace hero ("This week: cyberpunk", etc.).
-- Each theme covers a date range; the active theme is the one whose range
-- contains now(). Curated manually by admins via direct SQL or a future
-- admin panel. Multiple overlapping themes are allowed; the most recently
-- created one wins.

CREATE TABLE IF NOT EXISTS marketplace_themes (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    title        text          NOT NULL,
    blurb        text,
    tag          text,                       -- avatar/agent tag to filter by
    starts_at    timestamptz   NOT NULL DEFAULT now(),
    ends_at      timestamptz   NOT NULL,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    created_by   uuid          REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_themes_active
    ON marketplace_themes (starts_at DESC, ends_at DESC);

-- Seed an opening theme so the banner has content to display today.
INSERT INTO marketplace_themes (title, blurb, tag, starts_at, ends_at)
VALUES (
    'Community Spotlight',
    'Real 3D avatars built by the community this week. Click any to fork into your own agent.',
    NULL,
    now() - interval '1 day',
    now() + interval '7 days'
)
ON CONFLICT DO NOTHING;
