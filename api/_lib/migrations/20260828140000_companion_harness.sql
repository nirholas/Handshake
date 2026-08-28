begin;

-- The Companion: a personal 3D assistant that delivers a user's own important
-- messages in person. Everything here is per-user and BYOK: the credentials for
-- each source live encrypted in companion_sources.config_encrypted (AES-256-GCM,
-- api/_lib/companion/crypto.js), never in plaintext columns.

create table if not exists companion_settings (
    user_id            uuid primary key references users(id) on delete cascade,
    enabled            boolean     not null default true,
    -- Only events scoring at or above this get a spoken delivery (0-100).
    threshold          integer     not null default 60,
    -- Quiet hours in the user's own timezone; a delivery inside the window is
    -- stored and shown in the feed but never spoken or pushed.
    quiet_start        smallint,
    quiet_end          smallint,
    timezone           text        not null default 'UTC',
    -- Default stage presence when a sender has no contact-specific avatar.
    avatar_glb_url     text,
    voice              text        not null default 'alloy',
    -- Bearer for the phone/desktop bridge (POST /api/companion/ingest).
    ingest_token       text        not null,
    push_enabled       boolean     not null default true,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    constraint companion_settings_threshold_chk check (threshold between 0 and 100),
    constraint companion_settings_quiet_chk
        check ((quiet_start is null) = (quiet_end is null)
               and (quiet_start is null or (quiet_start between 0 and 23 and quiet_end between 0 and 23)))
);

create unique index if not exists companion_settings_ingest_token_uniq
    on companion_settings (ingest_token);

create table if not exists companion_sources (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid        not null references users(id) on delete cascade,
    kind               text        not null,
    label              text        not null,
    config_encrypted   text        not null,
    -- Lane cursor: telegram update offset, imap uid, calendar seen-uid set.
    cursor             jsonb       not null default '{}'::jsonb,
    enabled            boolean     not null default true,
    status             text        not null default 'pending',
    last_error         text,
    last_polled_at     timestamptz,
    last_event_at      timestamptz,
    created_at         timestamptz not null default now(),
    constraint companion_sources_kind_chk check (kind in ('telegram', 'calendar', 'email')),
    constraint companion_sources_status_chk check (status in ('pending', 'ok', 'error'))
);

create index if not exists companion_sources_user_idx on companion_sources (user_id, kind);
create index if not exists companion_sources_poll_idx on companion_sources (enabled, last_polled_at);

-- Who the message is from, and who shows up to deliver it. One row per identity
-- the user cares about (a telegram @handle, an email address, a phone number).
create table if not exists companion_contacts (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid        not null references users(id) on delete cascade,
    identifier         text        not null,
    display_name       text        not null,
    avatar_glb_url     text,
    avatar_image_url   text,
    voice              text,
    -- Added to every event from this identity, so family outranks a newsletter.
    priority_boost     integer     not null default 0,
    created_at         timestamptz not null default now(),
    constraint companion_contacts_boost_chk check (priority_boost between -100 and 100)
);

create unique index if not exists companion_contacts_identity_uniq
    on companion_contacts (user_id, lower(identifier));

create table if not exists companion_events (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid        not null references users(id) on delete cascade,
    source_id          uuid        references companion_sources(id) on delete set null,
    source_kind        text        not null,
    -- Stable per-lane id (telegram message id, imap uid, calendar uid+start,
    -- bridge-supplied id) so a re-poll never speaks the same message twice.
    external_id        text        not null,
    contact_id         uuid        references companion_contacts(id) on delete set null,
    sender             text,
    sender_id          text,
    title              text        not null,
    body               text,
    url                text,
    importance         integer     not null default 0,
    reason             text,
    spoken_line        text,
    triage_engine      text        not null default 'rules',
    occurs_at          timestamptz,
    delivered_at       timestamptz,
    dismissed_at       timestamptz,
    created_at         timestamptz not null default now(),
    constraint companion_events_importance_chk check (importance between 0 and 100)
);

create unique index if not exists companion_events_dedupe_uniq
    on companion_events (user_id, source_kind, external_id);
create index if not exists companion_events_feed_idx
    on companion_events (user_id, created_at desc);
create index if not exists companion_events_pending_idx
    on companion_events (user_id, delivered_at, importance desc)
    where delivered_at is null and dismissed_at is null;

commit;
