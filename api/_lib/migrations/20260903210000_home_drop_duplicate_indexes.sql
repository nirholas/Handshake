begin;

-- Drop the three duplicate home indexes a concurrent migration left on
-- production, so a live database and a fresh one describe the same schema.
--
-- Two agents built the home schema in this shared worktree within minutes of
-- each other and both migrations were applied. The duplicate file
-- (20260903120000_home_connections.sql) has since been deleted from the tree,
-- but deleting a migration does not un-apply it: three indexes it created are
-- still on the live database and are defined by no file that remains. A fresh
-- `npm run db:migrate` therefore produces a schema that differs from
-- production, which is the drift that makes a future index-dependent migration
-- behave differently in the two places.
--
-- Each dropped index is byte-identical to one the surviving migration
-- (20260903030000_home_connections.sql) creates, so no query plan loses an
-- access path and no uniqueness guarantee is weakened. Verified against Neon
-- before writing this: all three back no constraint (pg_constraint.conindid is
-- null for each), so dropping them cannot cascade.
--
--   home_action_log_home_recent_idx     == home_action_log_home_idx
--                                          btree (home_id, created_at desc)
--   home_connections_user_live_idx      == home_connections_user_idx
--                                          btree (user_id, created_at desc)
--                                            where revoked_at is null
--   home_entity_grants_home_entity_uniq == home_entity_grants_entity_uniq
--                                          unique btree (home_id, entity_id)
--
-- Deliberately NOT dropped: home_connections_user_active_idx, created by
-- 20260903160000_home_plan_overrides.sql. It looks like a third copy and is
-- not. Its predicate also excludes deactivated_at, so it serves the
-- entitlement-aware active-home listing that the plain revoked_at index cannot,
-- and both are load bearing.
--
-- Every statement is guarded by name, so this is a no-op on a database
-- provisioned cleanly and a repair on one that raced.

drop index if exists home_action_log_home_recent_idx;
drop index if exists home_connections_user_live_idx;
drop index if exists home_entity_grants_home_entity_uniq;

commit;
