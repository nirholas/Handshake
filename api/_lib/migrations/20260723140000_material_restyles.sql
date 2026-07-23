begin;

-- Material restyle history (prompts/user-value/01-creator-profile.md follow-up)
-- ========================================================================
-- api/material-studio.js (the /restyle page + the paid restyle_material MCP
-- tool) is a stateless transform today: it reads a GLB, re-skins it, and
-- returns a durable https URL — no row anywhere records who made it. That's
-- fine for the tool itself (no account required, same "hosted FREE lane"
-- doctrine as forge_free), but it means restyled models were the one creation
-- type genuinely untracked and therefore invisible on a creator's public
-- portfolio (/u/:username).
--
-- This table is the minimal, best-effort record: one row per generated output
-- (a restyle call writes one row; a variants call writes one row per variant).
-- user_id is nullable and only ever set when the caller carried a session
-- cookie — anonymous restyles (the majority) simply never surface on any
-- profile, same pattern as forge_creations.user_id / dioramas.user_id.

create table if not exists material_restyles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references users(id) on delete set null,
    client_key text,
    action text not null check (action in ('restyle', 'variants')),
    label text,
    source_url text not null,
    result_url text not null,
    instruction text,
    preset text,
    seed integer,
    material_index integer,
    created_at timestamptz not null default now()
);

-- Power "this user's restyled models" on the profile Creations tab.
create index if not exists material_restyles_user_created
    on material_restyles (user_id, created_at desc)
    where user_id is not null;

comment on table material_restyles is
    'One row per Material Studio output (AI PBR restyle or a seeded colorway '
    'variant). user_id is set best-effort when the caller was signed in; NULL '
    'for anonymous restyles, which never appear on any profile.';

commit;
