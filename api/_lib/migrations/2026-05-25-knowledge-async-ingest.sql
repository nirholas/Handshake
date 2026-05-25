-- Migration: knowledge async ingest — adds support for QStash-backed
-- background embedding. Large PDFs blow Vercel's 60s function cap during
-- inline embedding; queueing the work to a separate worker invocation makes
-- ingest reliable regardless of doc size.
--
--   source_text: raw extracted text held server-side until the worker
--                consumes it (then cleared to free row space).
--   status:      adds 'queued' as a pre-processing state.
--
-- Apply: npm run db:migrate -- --apply --file 2026-05-25-knowledge-async-ingest.sql
-- Idempotent.

begin;

alter table widget_knowledge_docs
    add column if not exists source_text text;

-- Drop+recreate the status check so 'queued' is allowed alongside the
-- existing states. PostgreSQL has no way to add a value to a CHECK
-- constraint in place.
do $$
declare cname text;
begin
    select conname into cname
    from pg_constraint
    where conrelid = 'widget_knowledge_docs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%';
    if cname is not null then
        execute format('alter table widget_knowledge_docs drop constraint %I', cname);
    end if;
end $$;

alter table widget_knowledge_docs
    add constraint widget_knowledge_docs_status_check
    check (status in ('queued', 'processing', 'ready', 'failed'));

commit;
