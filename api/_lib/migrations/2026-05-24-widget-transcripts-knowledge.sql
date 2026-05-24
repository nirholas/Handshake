-- Migration: widget analytics (idempotent table guard) + chat transcripts
-- + knowledge upload for the talking-agent widget type.
--
-- Apply: npm run db:migrate -- --apply --file 2026-05-24-widget-transcripts-knowledge.sql
-- Idempotent.

begin;

-- ── widget_views ─────────────────────────────────────────────────────────────
-- Already defined in schema.sql. Re-asserted here so deployments that pre-date
-- the schema.sql addition pick it up. The stats + view endpoints both catch
-- "relation does not exist" so this is the only step needed to wire them live.
create table if not exists widget_views (
    id            bigserial primary key,
    widget_id     text not null references widgets(id) on delete cascade,
    country       text,
    referer_host  text,
    created_at    timestamptz not null default now()
);

create index if not exists widget_views_widget_time
    on widget_views(widget_id, created_at desc);

-- ── widget_chat_threads ──────────────────────────────────────────────────────
-- One row per (widget, visitor, page-load). visitor_id is a cookieless opaque
-- UUID minted client-side in localStorage; thread_id is per page-load in
-- sessionStorage so each "conversation start" gets its own bucket.
create table if not exists widget_chat_threads (
    id              text primary key,                -- 'wct_' + 12 base64url chars (client-supplied)
    widget_id       text not null references widgets(id) on delete cascade,
    visitor_id      text not null,                   -- opaque UUID from localStorage
    referer_host    text,
    country         text,
    user_agent_hash text,                            -- sha256(ua) truncated; never the raw UA
    message_count   integer not null default 0,
    started_at      timestamptz not null default now(),
    last_message_at timestamptz not null default now()
);

create index if not exists widget_chat_threads_widget_time
    on widget_chat_threads(widget_id, last_message_at desc);
create index if not exists widget_chat_threads_visitor
    on widget_chat_threads(widget_id, visitor_id, started_at desc);

-- ── widget_chat_messages ─────────────────────────────────────────────────────
-- Append-only log of (role, content) pairs per thread. content is the redacted
-- form — raw email/phone/card patterns are replaced at write time. Useful for
-- the creator to see what visitors asked without storing PII.
create table if not exists widget_chat_messages (
    id           bigserial primary key,
    thread_id    text not null references widget_chat_threads(id) on delete cascade,
    widget_id    text not null references widgets(id) on delete cascade,
    role         text not null check (role in ('user', 'assistant')),
    content      text not null,
    actions      jsonb,                              -- assistant-only: [{type, ...}] of fired skills
    provider     text,                               -- assistant-only: anthropic | openai | ...
    model        text,                               -- assistant-only: model id used
    redacted     boolean not null default false,     -- true when content was scrubbed
    created_at   timestamptz not null default now()
);

create index if not exists widget_chat_messages_thread_time
    on widget_chat_messages(thread_id, created_at);
create index if not exists widget_chat_messages_widget_time
    on widget_chat_messages(widget_id, created_at desc);

-- ── widget_knowledge_docs ────────────────────────────────────────────────────
-- One doc per uploaded PDF / text paste / crawled URL attached to a widget.
-- Content lives in widget_knowledge_chunks (1..N per doc).
create table if not exists widget_knowledge_docs (
    id           text primary key,                   -- 'wkd_' + 12 base64url chars
    widget_id    text not null references widgets(id) on delete cascade,
    user_id      uuid not null references users(id) on delete cascade,
    title        text not null,
    source_type  text not null check (source_type in ('url', 'text', 'pdf', 'markdown')),
    source_url   text,
    byte_size    integer not null default 0,
    chunk_count  integer not null default 0,
    token_count  integer not null default 0,
    status       text not null default 'ready' check (status in ('processing', 'ready', 'failed')),
    error        text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists widget_knowledge_docs_widget
    on widget_knowledge_docs(widget_id, created_at desc);
create index if not exists widget_knowledge_docs_user
    on widget_knowledge_docs(user_id, created_at desc);

do $$ begin
    create trigger widget_knowledge_docs_set_updated_at before update on widget_knowledge_docs
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── widget_knowledge_chunks ──────────────────────────────────────────────────
-- Each chunk is a 512-token window with 100-token overlap, embedded with
-- text-embedding-3-small truncated to 256 dimensions (Matryoshka). Stored as a
-- JSONB float array; retrieval scores via cosine similarity in JS at query
-- time — fine up to several thousand chunks per widget. Beyond that, switch to
-- pgvector with a single column rewrite.
create table if not exists widget_knowledge_chunks (
    id            bigserial primary key,
    doc_id        text not null references widget_knowledge_docs(id) on delete cascade,
    widget_id     text not null references widgets(id) on delete cascade,
    chunk_index   integer not null,
    content       text not null,
    embedding     jsonb not null,                    -- float[256] truncated text-embedding-3-small
    token_count   integer not null default 0,
    created_at    timestamptz not null default now()
);

create index if not exists widget_knowledge_chunks_widget
    on widget_knowledge_chunks(widget_id);
create index if not exists widget_knowledge_chunks_doc
    on widget_knowledge_chunks(doc_id, chunk_index);

commit;
