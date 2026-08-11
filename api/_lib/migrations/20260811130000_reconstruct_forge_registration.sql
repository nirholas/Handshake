-- Reconstruction results join the Forge store, without leaking private captures.
--
-- Selfie/prompt reconstructions (avatar_regen_jobs mode='reconstruct') used to
-- finish as an avatars row only: the Forge surfaces keyed off forge_creations
-- (showcase, recent feed, share/embed pages, remix bazaar, leaderboards) never
-- saw them. Registering them there requires a visibility notion the table never
-- needed while every row was a public anonymous /forge generation.
--
--   visibility  null = legacy row, treated as 'public' (exactly today's
--               behavior); otherwise 'public' | 'unlisted' | 'private',
--               mirrored from the avatar the reconstruction produced.
--               Public feeds serve null/'public'; the share/embed read also
--               serves 'unlisted'; 'private' rows are owner-only.
--   avatar_id   the avatars row the reconstruction materialized, so provenance
--               resolves in both directions (avatars.source_meta.jobId already
--               points back at the job).
--
-- avatar_regen_jobs.error_kind mirrors the reconstruction worker's error
-- taxonomy ('input' = the photos were unusable and `error` is caller-facing
-- copy; 'internal' = service fault, `error` is an opaque correlation id), so
-- the status endpoint can relay actionable capture errors instead of masking
-- every failure into the generic retry message.

alter table forge_creations
	add column if not exists visibility text,
	add column if not exists avatar_id  uuid references avatars(id) on delete set null;

alter table forge_creations
	drop constraint if exists forge_creations_visibility_check;
alter table forge_creations
	add constraint forge_creations_visibility_check
	check (visibility is null or visibility in ('public', 'unlisted', 'private'));

-- Provenance lookup: which creation row a given avatar registered as.
create index if not exists idx_forge_creations_avatar
	on forge_creations (avatar_id)
	where avatar_id is not null;

alter table avatar_regen_jobs
	add column if not exists error_kind text;

alter table avatar_regen_jobs
	drop constraint if exists avatar_regen_jobs_error_kind_check;
alter table avatar_regen_jobs
	add constraint avatar_regen_jobs_error_kind_check
	check (error_kind is null or error_kind in ('input', 'internal'));
