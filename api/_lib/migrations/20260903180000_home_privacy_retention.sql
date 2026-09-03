begin;

-- three.ws Home: retention, and the two schema facts that made "delete my
-- account" and "delete my house" incomplete.
--
-- This migration is the schema half of the privacy lane (docs/home-privacy.md).
-- It changes three things, and every one of them was measured against the live
-- database rather than assumed.
--
-- 1. THE ACTION LOG NEEDS A RETENTION WINDOW, AND IT HAS TO BE THE OWNER'S.
--
--    home_action_log is the answer to "what did my agent do in my house last
--    Tuesday". It is also, read the other way round, a behavioural record of a
--    household: when someone came home, which rooms they lit, what time the
--    bedroom light went off. Those are the same rows. Keeping them forever
--    turns an audit trail into a surveillance archive, and keeping them for a
--    day makes the audit trail useless.
--
--    The default is 90 days. Long enough to answer "what happened last month",
--    short enough that the archive never becomes a history of someone's life.
--    It is per home and it is the owner's to change, down to a single day for
--    a household that wants no trail, and up for an operator (a hotel, an
--    office) whose compliance obligation is longer than ours. An extension past
--    the default has to carry a written reason, because "why does this building
--    keep two years of occupancy data" is a question somebody will be asked.
--
-- 2. A GRANT COULD BLOCK ACCOUNT DELETION.
--
--    home_entity_grants.granted_by referenced users(id) with NO action. The
--    owner's own deletion happens to work (their homes cascade, which cascades
--    their grants, in the same statement), but a grant made by a household
--    MEMBER on someone else's home has no such cascade: that member's account
--    deletion fails outright on a foreign-key violation. Deleting the grant is
--    also the privacy-correct behaviour on its own terms. The person who
--    granted the standing allowance is gone; the allowance goes with them,
--    rather than outliving the human who authorised it.
--
-- 3. THE PURGE NEEDS AN INDEX IT CAN ACTUALLY USE.
--
--    The sweep asks one question per home, "which rows here are older than this
--    home's own window", and the existing (home_id, created_at desc) index
--    answers it directly. No new index: the ascending scan the purge wants is
--    the same index read backwards, which Postgres does natively.
--
-- Deliberately NOT here: any table that would persist entity STATE. The room
-- graph and every entity's state live in the bridge runtime's memory and die
-- with the instance, on purpose. A persisted history of "the bedroom light went
-- on at 23:14" is an occupancy record for a building, and this campaign does not
-- create one. See docs/home-privacy.md.

alter table home_connections
    add column if not exists action_log_retention_days integer not null default 90;

alter table home_connections
    add column if not exists action_log_retention_reason text;

alter table home_connections
    add column if not exists action_log_retention_set_by uuid;

alter table home_connections
    add column if not exists action_log_retention_set_at timestamptz;

-- 1 day is "keep essentially nothing"; 3650 is ten years, past any retention
-- obligation an operator has actually cited to us. Both ends are guard rails
-- against a typo in an API call, not product opinions.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'home_connections_retention_days_chk'
    ) then
        alter table home_connections
            add constraint home_connections_retention_days_chk
            check (action_log_retention_days between 1 and 3650);
    end if;
end $$;

-- An extension past the 90-day default must say why. Shortening never needs a
-- reason: keeping less of someone's data is never the decision that has to be
-- justified.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'home_connections_retention_reason_chk'
    ) then
        alter table home_connections
            add constraint home_connections_retention_reason_chk
            check (
                action_log_retention_days <= 90
                or (action_log_retention_reason is not null
                    and length(btrim(action_log_retention_reason)) >= 8)
            );
    end if;
end $$;

-- (2) above: a grant must not be able to pin a user row in place.
alter table home_entity_grants
    drop constraint if exists home_entity_grants_granted_by_fkey;

alter table home_entity_grants
    add constraint home_entity_grants_granted_by_fkey
    foreign key (granted_by) references users(id) on delete cascade;

commit;
