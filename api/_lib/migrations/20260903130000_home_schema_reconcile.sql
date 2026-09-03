begin;

-- Reconcile the home tables to every constraint their creating migration
-- declares, for a database where they were created by a concurrent duplicate.
--
-- Two agents built the home schema in this shared worktree within minutes of
-- each other, and both migrations used `create table if not exists`. The loser
-- of that race is a silent no-op: the tables already existed, so the CHECK
-- constraints written inside its CREATE TABLE were never created, and the
-- database ends up weaker than the file of record
-- (20260903030000_home_connections.sql) says it is. A schema that is weaker
-- than its own migration claims is the worst kind of drift, because nothing
-- reports it and every reader of the migration believes the guarantee holds.
--
-- Both statements are guarded by name, so this is a no-op on a database
-- provisioned cleanly from that migration and a repair on one that raced.

do $$
begin
    -- A relay connection with no relay id is unroutable, and a direct one that
    -- carries a relay id is a contradiction. Both are bugs, so the database
    -- refuses them rather than leaving the runtime to discover it at dial time.
    if not exists (select 1 from pg_constraint where conname = 'home_connections_relay_chk') then
        alter table home_connections
            add constraint home_connections_relay_chk
            check ((transport = 'relay') = (relay_id is not null));
    end if;

    -- Risk is the physical-action gate's verdict, not free text: 'security'
    -- (locks, alarms, garage doors), 'physical' (anything else that moves in the
    -- world), or null. An unconstrained column here would let a typo hide a
    -- security-risk action from every query that filters on it.
    if not exists (select 1 from pg_constraint where conname = 'home_action_log_risk_chk') then
        alter table home_action_log
            add constraint home_action_log_risk_chk
            check (risk is null or risk in ('security', 'physical'));
    end if;
end
$$;

commit;
