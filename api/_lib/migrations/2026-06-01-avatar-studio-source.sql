-- Add 'studio' as a valid avatar source value so avatars created in the
-- built-in avatar studio pass the check constraint.
do $$
begin
    if exists (
        select 1 from information_schema.table_constraints
        where table_name = 'avatars'
          and constraint_name like 'avatars_source_check%'
    ) then
        alter table avatars drop constraint if exists avatars_source_check;
    end if;
end $$;

alter table avatars
    add constraint avatars_source_check
    check (source in ('upload','avaturn','readyplayer','import','direct-upload','reconstruct','studio'));
