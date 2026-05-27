-- Developer webhooks: outgoing event notifications for partner integrations.
-- Mirrors the Standard Webhooks signature format for verification.

create table if not exists developer_webhooks (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references users(id) on delete cascade,
    url         text not null,
    secret      text not null,
    events      text[] not null default '{}',
    active      boolean not null default true,
    description text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create index if not exists developer_webhooks_user_active
    on developer_webhooks (user_id) where active = true;

create table if not exists webhook_deliveries (
    id              uuid primary key default gen_random_uuid(),
    webhook_id      uuid not null references developer_webhooks(id) on delete cascade,
    event_type      text not null,
    event_id        text not null,
    payload         jsonb not null,
    status_code     int,
    response_body   text,
    error           text,
    attempt         int not null default 1,
    created_at      timestamptz not null default now()
);

create index if not exists webhook_deliveries_webhook_recent
    on webhook_deliveries (webhook_id, created_at desc);

create index if not exists webhook_deliveries_event_id
    on webhook_deliveries (event_id);
