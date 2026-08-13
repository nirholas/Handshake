-- Repair the two referral columns a fresh database never gets.
--
-- `001_add_referrals.sql` declares `referred_by_id INTEGER REFERENCES users(id)`
-- while `users.id` is a uuid. Postgres refuses that foreign key outright
-- (42804: "Key columns referred_by_id and id are of incompatible types: integer
-- and uuid"), so the file dies on its second statement. The first statement has
-- already committed by then, which is why the damage is easy to miss: a fresh
-- database ends up with `referral_code` present and `referred_by_id` /
-- `referral_earnings_total` silently absent.
--
-- The consequence is not cosmetic. Registration inserts all three columns
-- (`insertUserWithUniqueReferralCode` in api/auth/[action].js), so on any
-- database built from schema.sql + migrations, every single signup fails with
-- 42703 "column referred_by_id of relation users does not exist" and returns a
-- 500. The referral-activation migration's partial index on the same column
-- fails behind it for the same reason.
--
-- 001 is not edited: scripts/apply-migrations.mjs records a sha256 per applied
-- file and refuses to run when an applied migration's bytes change, so rewriting
-- history there would block every future migration on production. This adds the
-- columns forward instead, with the type the code actually stores.
--
-- Idempotent by construction: `if not exists` makes this a no-op on production,
-- where the columns already exist, and a repair everywhere else.

-- Attribution: which member referred this one. uuid, matching users.id.
alter table users add column if not exists referred_by_id uuid references users(id);

-- Lifetime referral earnings. numeric(12,2) is the type 001 intended, kept so a
-- repaired database and production agree.
alter table users add column if not exists referral_earnings_total numeric(12, 2) default 0.00;

-- The lookup 001 wanted: "who did this member refer?".
create index if not exists idx_users_referred_by_id on users (referred_by_id);
