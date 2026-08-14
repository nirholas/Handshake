-- Per-generation likeness scores: the Phase 1 verification metric, persisted.
--
-- The roadmap gates Phase 1 on a likeness score (README Roadmap: mint an agent
-- of yourself "with >=4/5 likeness score"). Until now nothing produced that
-- number for a real generation. The realism bench (api/_lib/quality-bench.js)
-- scores photorealism and never asks whose face it is; the reconstruction
-- worker's ISE eval (workers/avatar-reconstruction/eval/) measures face SHAPE
-- against a synthetic reference set, offline, and stores nothing. So the
-- platform could assert likeness but never measure it, and no query could
-- answer "what fraction of real reconstructions clear 4/5 this week".
--
-- Keyed on the creation, not the avatar. forge_creations is where a
-- reconstruction lands as a generation record (path = 'reconstruct', see
-- registerReconstructionCreation in api/_lib/forge-store.js) and it is the row
-- every quality surface already joins on. Cascade on delete because a score is
-- a statement about a specific generation: when the user deletes the creation,
-- the measurement of it has no subject left.
--
-- scorer_version is stored, not assumed, for the same reason
-- sim_readiness_grades stores grader_version: a score is a claim about what a
-- specific instrument measured. When the embedding model, the alignment
-- template or the view angles change, old rows stay valid and become
-- re-scoreable rather than silently incomparable, and
-- `where scorer_version <> $current` is the backfill query.
--
-- What is deliberately NOT here: anything derived from the input photos
-- themselves. No capture URLs, no crops, no embeddings. A face embedding is
-- biometric data, and the whole point of this table is to hold the measurement
-- rather than the person. report carries per-view statuses and cosines only;
-- rejected captures are recorded by index and reason.
--
-- Applied 2026-08-14 with `scripts/apply-migrations.mjs --apply --file
-- 20260814000000_avatar_likeness_scores.sql`, i.e. this file alone rather than
-- `npm run db:migrate`, because that script applies EVERY pending migration and
-- seven belonging to other in-flight work were queued behind it.

create table if not exists avatar_likeness_scores (
	creation_id       uuid primary key references forge_creations(id) on delete cascade,
	avatar_id         uuid,                      -- the avatars row the reconstruction produced
	job_id            text,                      -- avatar_regen_jobs.job_id the captures belong to
	scorer_version    text not null,             -- e.g. threews.likeness.sface.v1
	status            text not null,             -- ok | captures_unusable | render_unusable | no_glb | no_captures | budget_exhausted

	-- Headline: the head-on view, the framing every product surface shows first.
	likeness_score    double precision,          -- 1-5, the roadmap's gate
	identity_cosine   double precision,          -- raw cosine behind likeness_score

	-- The same measurement averaged over all scored views, plus the spread. A
	-- pipeline that only holds up head-on is visible in turn_falloff and
	-- nowhere else.
	mean_score        double precision,
	mean_cosine       double precision,
	worst_cosine      double precision,
	turn_falloff      double precision,
	same_identity     boolean,                   -- cosine cleared SFace's published threshold

	-- Input-side quality, so a weak score can be attributed to the capture set
	-- rather than blamed on the reconstruction.
	captures_total    smallint,
	captures_embedded smallint,
	capture_cohesion  double precision,          -- mean pairwise cosine among the captures
	views_scored      smallint,

	score_ms          integer,                   -- wall-clock cost, for the scale envelope
	report            jsonb not null,            -- the full per-view report, verbatim
	scored_at         timestamptz not null default now()
);

-- The distribution query the internal surface runs: newest scored generations
-- first, restricted to rows that actually produced a number.
create index if not exists idx_likeness_scored_at
	on avatar_likeness_scores (scored_at desc)
	where status = 'ok';

-- "What fraction cleared 4/5" and every histogram bucket behind it.
create index if not exists idx_likeness_score
	on avatar_likeness_scores (likeness_score desc)
	where status = 'ok';

-- The cron's work queue: which generations this scorer version has not seen.
create index if not exists idx_likeness_scorer_version
	on avatar_likeness_scores (scorer_version, scored_at desc);
