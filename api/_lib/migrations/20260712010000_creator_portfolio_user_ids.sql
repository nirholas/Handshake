begin;

-- Creator profile / portfolio (prompts/user-value/01-creator-profile.md)
-- ========================================================================
-- forge_creations and dioramas are both anonymous-by-design (scoped to a
-- hashed browser client_key, not a login) so /forge and /diorama keep
-- working with no account. When a caller IS signed in, we now also record
-- their user_id — best-effort, never required — so a logged-in creator's
-- forged 3D models and dioramas/worlds can be aggregated onto their public
-- portfolio at /u/:username alongside their avatars, agents, and coins.
--
-- Anonymous creations (user_id null) are simply never surfaced on any
-- profile — there is no user to attribute them to, and that's correct
-- behavior, not a bug.

alter table forge_creations
    add column if not exists user_id uuid references users(id) on delete set null;

alter table dioramas
    add column if not exists user_id uuid references users(id) on delete set null;

-- Power "this user's finished, stored models" — the profile Creations tab.
create index if not exists forge_creations_user_done
    on forge_creations (user_id, created_at desc)
    where user_id is not null and status = 'done' and glb_url is not null;

-- Power "this user's saved worlds" — same tab, other creation type.
create index if not exists dioramas_user_created
    on dioramas (user_id, created_at desc)
    where user_id is not null;

comment on column forge_creations.user_id is
    'The signed-in user who created this, when the /forge call carried a '
    'session cookie. NULL for anonymous generations (the default, and still '
    'the majority of rows) — never required, never backfilled.';
comment on column dioramas.user_id is
    'The signed-in user who saved this diorama/world, when the /diorama save '
    'call carried a session cookie. NULL for anonymous saves.';

commit;
