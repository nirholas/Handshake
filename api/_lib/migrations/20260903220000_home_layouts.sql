begin;

-- The authored floorplan for one house.
--
-- Home Assistant knows which room a device is in. It does not know where that
-- room is, and it never will: there is no geometry anywhere in its registries.
-- The 3D scene ships a default arrangement (rooms packed into a grid per floor,
-- in name order) so it is useful the moment a house connects, and this table
-- holds the arrangement a person authored on top of it.
--
-- A layout is never required. The scene must render with no row here, with a row
-- that covers only some rooms, and with a row naming a room the house no longer
-- has. All three are ordinary states, so this table is an overlay and never a
-- prerequisite.
--
-- One live layout per home, not one per member: a floorplan is a property of the
-- building, and two members editing the same house are editing the same drawing.
-- `version` is what makes that safe. It is bumped on every write and a stale
-- write is refused rather than merged, so the second editor is asked instead of
-- silently overwriting the first. A version column beats a last-write-wins
-- timestamp here because clock skew between two browsers is real and the loser
-- of a millisecond race should not lose their work.
--
-- The document itself is jsonb rather than columns because its shape is the
-- renderer's contract and it will move (rotation, wall openings, polygons) while
-- this table will not. It is user-authored JSON that drives a renderer, so it is
-- validated against a schema with hard caps on write; see api/_lib/home/layout.js.
-- Nothing reads it without that validator.

create table if not exists home_layouts (
    home_id     uuid primary key references home_connections(id) on delete cascade,
    version     integer     not null default 1,
    layout      jsonb       not null,
    updated_by  uuid        not null references users(id),
    updated_at  timestamptz not null default now(),
    created_at  timestamptz not null default now(),

    -- A version that does not advance is a bug in the store, not a state a
    -- client can reach, and an unversioned row would make the concurrency check
    -- silently pass forever.
    constraint home_layouts_version_chk check (version >= 1)
);

comment on table home_layouts is
    'Authored floorplan per home. An overlay on the default arrangement, never required.';
comment on column home_layouts.version is
    'Bumped on every write. A PUT carrying a stale version is refused with 409 and the current document.';

commit;
