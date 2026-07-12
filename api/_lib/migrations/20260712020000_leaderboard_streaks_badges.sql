-- Cross-surface leaderboard: daily-activity streaks + earned badges.
--
-- Powers GET /api/leaderboard/unified (creations, remixes received, launches,
-- followers, walk distance — each a real query over existing tables) and the
-- streak/badge widgets on /u/:username (see api/_lib/streaks.js).
--
-- A "qualifying action" that extends a streak is any of: a session
-- login/refresh (api/_lib/auth.js createSession), a finished forge model or
-- saved world (api/_lib/forge-store.js materializeCreation,
-- api/_lib/diorama-store.js saveDiorama), or a /walk activity batch
-- (api/walk/metrics.js) — all funnel through recordDailyActivity(userId) in
-- api/_lib/streaks.js so the streak logic lives in exactly one place.
--
-- Fully idempotent — safe to re-run. Mirrored into api/_lib/schema.sql.

-- ── user_streaks — one row per user, the running daily-activity streak ──────
create table if not exists user_streaks (
    user_id         uuid primary key references users(id) on delete cascade,
    current_streak  integer not null default 0,
    longest_streak  integer not null default 0,
    last_active_day date,
    updated_at      timestamptz not null default now(),
    created_at      timestamptz not null default now()
);

-- ── user_badges — unlocked achievement records, one row per (user, code) ────
-- Mirrors the walk_achievements pattern (api/_lib/migrations/
-- 20260621140000_walk_metrics.sql): server-persisted, awarded once, never
-- computed fresh on every read.
create table if not exists user_badges (
    id          bigserial primary key,
    user_id     uuid not null references users(id) on delete cascade,
    code        text not null,               -- first_creation | first_remix_received | streak_7 | top10_<metric>
    context     jsonb,                       -- optional detail (e.g. { "metric": "creations", "rank": 4 })
    unlocked_at timestamptz not null default now()
);

create unique index if not exists user_badges_uniq on user_badges (user_id, code);
create index if not exists user_badges_user on user_badges (user_id, unlocked_at desc);
