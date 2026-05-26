-- Phase 1 — Selfie → Avatar reconstruction
--
-- The selfie pipeline submits a Replicate job *before* an avatar row exists:
-- the user has photos, not a GLB, and the GLB is the *output* of the job.
-- We let the job exist without a source avatar and materialize the avatar
-- row on success. Both relaxations are backwards-compatible — every existing
-- row is non-null today.

-- 1. Allow avatar_regen_jobs to track jobs that have no input avatar (only
--    selfie photos). The 'reconstruct' mode is the sole legitimate source.
alter table avatar_regen_jobs
    alter column source_avatar_id drop not null;

-- 2. Add the 'reconstruct' source to the avatars source check so the avatar
--    row created from a finished reconstruction can be tagged correctly.
do $$
begin
    if exists (
        select 1
        from information_schema.check_constraints
        where constraint_name like 'avatars_source_check%'
    ) then
        alter table avatars drop constraint if exists avatars_source_check;
    end if;
end$$;

alter table avatars
    add constraint avatars_source_check
    check (source in ('upload','avaturn','readyplayer','import','direct-upload','reconstruct'));
