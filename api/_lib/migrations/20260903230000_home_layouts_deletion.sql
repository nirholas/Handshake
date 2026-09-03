begin;

-- home_layouts.updated_by blocked account deletion, the same way
-- home_entity_grants.granted_by did before 20260903180000.
--
-- The column referenced users(id) with no ON DELETE action, so a household
-- member who had ever edited somebody else's floorplan could not delete their
-- account at all: the DELETE failed on a foreign-key violation, with an error
-- naming a table the person has never heard of. The owner's own deletion
-- happened to work (their homes cascade, which cascades the layout in the same
-- statement), which is exactly why this kind of defect survives testing.
--
-- CASCADE would be wrong here, and this is the difference from the grants fix.
-- A grant is the departed person's authorisation and should not outlive them. A
-- floorplan is the BUILDING's, drawn once and used by everyone in the house;
-- deleting it because the person who last nudged a wall closed their account
-- would destroy a household's work over a detail none of them care about.
--
-- So: keep the drawing, forget who last touched it. The column becomes nullable
-- and the reference becomes SET NULL. A null updated_by reads as "edited by
-- somebody who is no longer here", which is true and is all the row needs to
-- say. The version column, not this one, is what the concurrency check reads,
-- so nothing that guards a concurrent edit depends on it.
--
-- The whole family was re-audited when this was found. Every other home_* column
-- that references users(id) already carries CASCADE (the person's own rows) or
-- SET NULL (a record of an action that outlives the actor):
-- home_confirmations.redeemed_by, home_invites.accepted_by,
-- home_members.invited_by and home_plan_overrides.set_by are all SET NULL; the
-- user_id columns and home_entity_grants.granted_by and home_invites.invited_by
-- all CASCADE. This was the last one that did neither.

alter table home_layouts
    alter column updated_by drop not null;

alter table home_layouts
    drop constraint if exists home_layouts_updated_by_fkey;

alter table home_layouts
    add constraint home_layouts_updated_by_fkey
    foreign key (updated_by) references users(id) on delete set null;

comment on column home_layouts.updated_by is
    'Who last wrote this layout. Null once that account is deleted: the drawing belongs to the building, the attribution does not outlive the person.';

commit;
