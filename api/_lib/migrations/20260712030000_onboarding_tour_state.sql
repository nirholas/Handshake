-- Onboarding guided-tour state, per account.
--
-- Powers the auto-start decision for the self-referential onboarding tour
-- (wired via src/feature-tour/*, curriculum stops tagged section: "onboarding"
-- in public/tour/curriculum.json): a brand-new account with zero creations and
-- no recorded "seen" timestamp gets offered the tour once; a completed or
-- dismissed tour never auto-starts again. The persistent "Replay tour" entry
-- point (public/getting-started.js) always remains available regardless of
-- these columns.
--
-- Two nullable timestamps on `users`, mirroring the existing additive-column
-- pattern in this file set (e.g. 20260628120000_referral_activation.sql's
-- activated_at) rather than a new one-row-per-user table — the wave 6
-- streaks/badges migration already established `user_streaks` for per-user
-- rows that need multiple columns; this is a single flag pair, so it lives
-- directly on `users` per _shared.md's "reuse an existing user-state surface"
-- guidance.
--
-- Fully idempotent — safe to re-run. Mirrored into api/_lib/schema.sql.

alter table users add column if not exists onboarding_tour_seen_at timestamptz;
alter table users add column if not exists onboarding_tour_completed_at timestamptz;
