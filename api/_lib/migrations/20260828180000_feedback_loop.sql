begin;

-- The feedback loop: what a visitor tells the corner companion, plus enough
-- machine-captured context to act on it.
--
-- Two halves live in this one table on purpose. The left half (body, route,
-- build_sha, console_errors ...) is captured facts: what was said and what the
-- page looked like when it was said. The right half (severity, kind, summary,
-- cluster_key ...) is an LLM's opinion about those facts, written later by
-- api/cron/feedback-triage. The split matters because `body` is UNTRUSTED text
-- typed by anyone on the internet. Nothing downstream may treat it as an
-- instruction, and nothing in the triage half is allowed to trigger an action
-- on its own: it sorts a queue a human reads.

create table if not exists feedback_reports (
    id               uuid        primary key default gen_random_uuid(),

    -- Who. Signed-in reports carry a user; anonymous ones carry only a hashed
    -- per-browser key, which is enough to thread a follow-up and to rate-limit
    -- without storing an identifier we would rather not hold.
    user_id          uuid        references users(id) on delete set null,
    client_key       text,

    -- What was said. Untrusted. Capped at the API boundary.
    body             text        not null,
    transport        text        not null default 'text',

    -- Where it was said, captured by the browser, not typed by the visitor.
    -- build_sha is the single most valuable column here: it turns "the avatar
    -- page is blank" into "the avatar page went blank in the deploy that
    -- shipped abc1234".
    route            text,
    page_title       text,
    build_sha        text,
    viewport         text,
    user_agent       text,
    locale           text,
    console_errors   jsonb       not null default '[]'::jsonb,
    failed_requests  jsonb       not null default '[]'::jsonb,

    -- The triage half. Advisory only.
    status           text        not null default 'new',
    severity         smallint,
    kind             text,
    subsystem        text,
    summary          text,
    repro            text,
    cluster_key      text,
    triage_model     text,
    triaged_at       timestamptz,

    -- Set when a human acts on the report, so the queue can close a loop and
    -- the reporter can be told their report went somewhere.
    resolved_at      timestamptz,
    resolution       text,

    created_at       timestamptz not null default now(),

    constraint feedback_reports_status_check
        check (status in ('new', 'triaged', 'accepted', 'dismissed', 'fixed')),
    constraint feedback_reports_transport_check
        check (transport in ('text', 'voice')),
    constraint feedback_reports_severity_check
        check (severity is null or (severity >= 0 and severity <= 100))
);

-- The review queue reads untriaged first, then by severity within a cluster.
create index if not exists feedback_reports_queue_idx
    on feedback_reports (status, severity desc nulls last, created_at desc);
create index if not exists feedback_reports_cluster_idx
    on feedback_reports (cluster_key, created_at desc)
    where cluster_key is not null;
create index if not exists feedback_reports_untriaged_idx
    on feedback_reports (created_at)
    where triaged_at is null;
create index if not exists feedback_reports_route_idx
    on feedback_reports (route, created_at desc);
create index if not exists feedback_reports_user_idx
    on feedback_reports (user_id, created_at desc)
    where user_id is not null;

commit;
