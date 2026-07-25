-- Tag platform-created machine accounts so user metrics mean humans.
--
-- Three seed/bot crons create users with synthetic *.three.ws emails
-- (avaturn-seed-cron, forge-seed-cron, circulation's agent personas; a
-- retired fleet seeder left @fleet.three.ws rows). As of 2026-07-25 they are
-- 19,282 of the 20,337 rows in users: 95%: so every "total users" or
-- "signups this week" read was measuring cron output, not people.
-- (@wallet.local is NOT tagged: those are real humans signing in with a
-- wallet, given a placeholder email by the SIWS/SIWE flow.)
--
-- The seed crons now set the flag at insert; this backfills history and gives
-- metrics a single honest predicate: WHERE NOT service_account.

alter table users add column if not exists service_account boolean not null default false;

update users
set service_account = true
where service_account = false
  and email::text ~ '@(avaturn|forge|agents|fleet)\.three\.ws$';

-- Metrics queries filter on it constantly; the flag is 95% true, so index the
-- small human side only.
create index if not exists users_human_idx on users (created_at) where not service_account;
