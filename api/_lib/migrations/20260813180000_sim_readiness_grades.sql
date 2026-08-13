-- Simulation-readiness grades, keyed by content hash.
--
-- A physics grade is a property of BYTES, not of a row in any one product
-- table. The same GLB shows up as a forge creation, an Object Library entry, a
-- remix of an earlier creation, and as an arbitrary third-party URL handed to
-- the free endpoint. Keying by glb_sha256 means one grade per unique asset, a
-- cache hit across every one of those surfaces, and no duplicated grading work
-- when a mesh is reused. It also matches how provenance already addresses an
-- asset (api/_lib/provenance-3d.js, specs/PROVENANCE_3D.md), so a grade and a
-- credential for the same bytes join on one column.
--
-- grader_version is stored, not assumed. The grade is a claim about what a
-- specific grader measured; when the grader changes, old rows stay valid and
-- become re-gradeable rather than silently wrong. Re-grading writes a new row
-- version in place and bumps graded_at, so `where grader_version <> $current`
-- is the backfill query.
--
-- report holds the full JSON report exactly as api/_lib/sim-readiness.js
-- returns it. The promoted columns duplicate the four fields the product
-- actually filters and sorts on, because a jsonb path predicate cannot use a
-- btree index the way `where verdict = 'simulation_ready'` can, and "show me
-- every simulation-ready asset under 2 kg" is the query this whole lane exists
-- to answer.
--
-- Draft: written by the architect pass, NOT applied. Run `npm run db:status`
-- to confirm it reads as pending before `npm run db:migrate` applies it (and
-- read that status first: db:migrate applies EVERY pending migration, not just
-- this one).

create table if not exists sim_readiness_grades (
	glb_sha256        text primary key,          -- 64-char hex sha256 of the GLB bytes
	grader_version    text not null,             -- e.g. threews.sim.readiness.v1
	verdict           text not null,             -- simulation_ready | needs_scale | needs_repair | unusable
	blockers          jsonb not null default '[]'::jsonb,
	warnings          jsonb not null default '[]'::jsonb,
	watertight        boolean,                   -- promoted from report.topology
	longest_axis_m    double precision,          -- promoted from report.scale
	volume_m3         double precision,          -- promoted from report.mass
	convexity_ratio   double precision,          -- promoted from report.collision
	triangles         integer,
	size_bytes        integer,
	source_url        text,                      -- the URL first graded, for triage only; never the key
	creation_id       uuid,                      -- forge_creations.id when the grade came from our own lane
	grade_ms          integer,                   -- wall-clock grading cost, for the scale envelope
	report            jsonb not null,            -- the full report, verbatim
	graded_at         timestamptz not null default now()
);

-- The lane's headline query: every asset a simulator can consume, newest first.
create index if not exists idx_sim_readiness_verdict
	on sim_readiness_grades (verdict, graded_at desc);

-- Backfill sweep after a grader version bump.
create index if not exists idx_sim_readiness_grader
	on sim_readiness_grades (grader_version);

-- Join back to the creation that produced the asset (nullable: third-party and
-- Object Library assets have no forge row).
create index if not exists idx_sim_readiness_creation
	on sim_readiness_grades (creation_id)
	where creation_id is not null;
