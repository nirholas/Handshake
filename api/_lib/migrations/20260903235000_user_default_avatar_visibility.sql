begin;

-- The owner's default visibility for newly created avatars.
--
-- /settings has offered a "Default avatar visibility" control since the page
-- shipped, but it only ever wrote localStorage: nothing on the server read it,
-- so a user who chose "Private" still got whatever each create path hardcoded.
-- A privacy control that silently does nothing is worse than no control, so the
-- preference now lives here and the create paths read it.
--
-- Nullable on purpose. NULL means "no preference expressed", and every create
-- path keeps its own existing default in that case (private for a direct
-- upload, unlisted for a forge import), so nothing changes for the accounts
-- that never open the setting.
alter table users
    add column if not exists default_avatar_visibility text
    check (default_avatar_visibility in ('private', 'unlisted', 'public'));

commit;
