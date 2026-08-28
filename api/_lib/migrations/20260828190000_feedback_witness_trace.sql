begin;

-- The witness trace: what the person actually did, in order, before it broke.
--
-- Stored beside the report rather than in it, because the two have different
-- lifetimes and different sensitivities. The body is a sentence a human wrote;
-- the trace is a machine record that compiles into a runnable test
-- (packages/witness). Keeping it as jsonb means a maintainer can query across
-- traces ("every report whose trace contains a 500 from /api/export") without
-- parsing anything.
--
-- Values a person typed are never in here: the recorder counts characters and
-- keeps the shape, never the text (packages/witness/src/redact.js).

alter table feedback_reports
    add column if not exists trace jsonb,
    -- Denormalized from the trace so the queue can sort and filter on them
    -- without opening every document.
    add column if not exists trace_steps smallint,
    add column if not exists replay_confidence smallint;

-- Reports that carry a replayable trace are the ones worth reaching for first,
-- so the queue can find them without scanning.
create index if not exists feedback_reports_traced_idx
    on feedback_reports (replay_confidence desc nulls last, created_at desc)
    where trace is not null;

-- Cross-report search over the failures a trace recorded, which is what turns
-- "someone said export is broken" into "eleven sessions hit POST /api/export".
create index if not exists feedback_reports_trace_gin_idx
    on feedback_reports using gin (trace jsonb_path_ops)
    where trace is not null;

commit;
