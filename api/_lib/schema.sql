-- ─────────────────────────────────────────────────────────────────────────────
-- three.ws — Postgres schema (Neon)
-- Idempotent migrations. Apply with:  psql "$DATABASE_URL" -f api/_lib/schema.sql
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ── users ───────────────────────────────────────────────────────────────────
create table if not exists users (
    id              uuid primary key default gen_random_uuid(),
    email           citext not null unique,
    password_hash   text,                       -- null = oauth-only or wallet-only account
    display_name    text,
    avatar_url      text,
    plan            text not null default 'free' check (plan in ('free','pro','team','enterprise')),
    email_verified  boolean not null default false,
    wallet_address  text,                       -- lowercased 0x… for wallet login
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    deleted_at      timestamptz
);

-- Additive migration for deployments that pre-date the wallet_address column.
alter table users add column if not exists wallet_address text;
alter table users add column if not exists is_admin boolean not null default false;
alter table users add column if not exists username text;
create unique index if not exists users_wallet_unique on users(wallet_address) where wallet_address is not null;
create unique index if not exists users_username_unique on users(lower(username)) where username is not null;

-- ── avatars (GLBs stored in R2) ─────────────────────────────────────────────
create table if not exists avatars (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null references users(id) on delete cascade,
    slug            text not null,              -- short, URL-safe handle
    name            text not null,
    description     text,
    storage_key     text not null,              -- R2 object key
    size_bytes      bigint not null,
    content_type    text not null default 'model/gltf-binary',
    source          text not null default 'upload' check (source in ('upload','avaturn','import')),
    source_meta     jsonb not null default '{}'::jsonb,
    thumbnail_key   text,
    visibility      text not null default 'public' check (visibility in ('private','unlisted','public')),
    tags            text[] not null default '{}',
    checksum_sha256 text,
    version         int not null default 1,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    deleted_at      timestamptz,
    unique (owner_id, slug)
);

create index if not exists avatars_owner_idx on avatars(owner_id) where deleted_at is null;
create index if not exists avatars_public_idx on avatars(visibility, created_at desc) where visibility = 'public' and deleted_at is null;
create index if not exists avatars_tags_idx on avatars using gin(tags);

-- Additive migrations for avatars columns added after initial deployment.
alter table avatars add column if not exists storage_mode jsonb;
alter table avatars add column if not exists parent_avatar_id uuid references avatars(id) on delete set null;

-- ── mocap_clips (recorded face / pose / hand motion clips) ──────────────────
-- See api/_lib/migrations/2026-05-24-mocap-clips.sql for the full schema +
-- rationale. Mirrored here so a clean schema.sql apply provisions the table.
create table if not exists mocap_clips (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null references users(id) on delete cascade,
    avatar_id       uuid references avatars(id) on delete set null,
    slug            text not null,
    name            text not null,
    description     text,
    kind            text not null default 'face' check (kind in ('face','pose','hand','composite','vmc')),
    format          text not null default 'three.ws.face-mocap.v1',
    duration_ms     int not null default 0,
    frame_count     int not null default 0,
    frames          jsonb,
    storage_key     text,
    thumbnail_key   text,
    tags            text[] not null default '{}',
    visibility      text not null default 'private' check (visibility in ('private','unlisted','public')),
    price_amount    numeric(30,9),
    price_currency  text,
    play_count      bigint not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    deleted_at      timestamptz,
    unique (owner_id, slug)
);
create index if not exists mocap_clips_owner_idx on mocap_clips(owner_id, created_at desc) where deleted_at is null;
create index if not exists mocap_clips_public_idx on mocap_clips(visibility, created_at desc) where visibility = 'public' and deleted_at is null;
create index if not exists mocap_clips_kind_idx on mocap_clips(kind, created_at desc) where deleted_at is null;
create index if not exists mocap_clips_tags_idx on mocap_clips using gin(tags);

-- ── OAuth 2.1 clients (for MCP & third-party apps) ──────────────────────────
-- Supports RFC 7591 dynamic client registration.
create table if not exists oauth_clients (
    id                      uuid primary key default gen_random_uuid(),
    client_id               text not null unique,
    client_secret_hash      text,                            -- null = public client
    client_type             text not null check (client_type in ('public','confidential')),
    name                    text not null,
    logo_uri                text,
    client_uri              text,
    redirect_uris           text[] not null,
    grant_types             text[] not null default '{authorization_code,refresh_token}',
    response_types          text[] not null default '{code}',
    token_endpoint_auth     text not null default 'none',    -- 'none' | 'client_secret_basic' | 'client_secret_post'
    scope                   text not null default 'avatars:read',
    software_id             text,
    software_version        text,
    registered_by_user_id   uuid references users(id) on delete set null,
    dynamically_registered  boolean not null default false,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

-- ── OAuth authorization codes (short-lived, PKCE) ───────────────────────────
create table if not exists oauth_auth_codes (
    code                text primary key,                    -- opaque, hashed-at-rest not needed (short TTL)
    client_id           text not null references oauth_clients(client_id) on delete cascade,
    user_id             uuid not null references users(id) on delete cascade,
    redirect_uri        text not null,
    scope               text not null,
    resource            text,                                -- RFC 8707 resource indicator
    code_challenge      text not null,
    code_challenge_method text not null default 'S256',
    expires_at          timestamptz not null,
    consumed_at         timestamptz,
    created_at          timestamptz not null default now()
);

create index if not exists oauth_auth_codes_expiry on oauth_auth_codes(expires_at);

-- ── OAuth refresh tokens ────────────────────────────────────────────────────
-- Access tokens are JWTs (stateless); refresh tokens are opaque + stored.
create table if not exists oauth_refresh_tokens (
    id              uuid primary key default gen_random_uuid(),
    token_hash      text not null unique,                    -- sha256 of the secret
    client_id       text not null references oauth_clients(client_id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    scope           text not null,
    resource        text,
    expires_at      timestamptz not null,
    revoked_at      timestamptz,
    replaced_by     uuid references oauth_refresh_tokens(id),
    created_at      timestamptz not null default now(),
    last_used_at    timestamptz
);

create index if not exists oauth_refresh_user on oauth_refresh_tokens(user_id) where revoked_at is null;
create index if not exists oauth_refresh_expiry on oauth_refresh_tokens(expires_at);

-- ── Developer API keys (for server-to-server MCP usage) ─────────────────────
create table if not exists api_keys (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    name            text not null,
    prefix          text not null,                           -- first 8 chars, for display
    token_hash      text not null unique,                    -- sha256(rest)
    scope           text not null default 'avatars:read avatars:write',
    last_used_at    timestamptz,
    expires_at      timestamptz,
    revoked_at      timestamptz,
    created_at      timestamptz not null default now()
);

create index if not exists api_keys_user on api_keys(user_id) where revoked_at is null;

-- ── SIWE (Sign-In with Ethereum) ────────────────────────────────────────────
-- Short-lived nonces issued per client; burned on verify to prevent replay.
create table if not exists siwe_nonces (
    nonce        text primary key,
    address      text,                       -- lowercased, set on verify attempt (audit only)
    issued_at    timestamptz not null default now(),
    expires_at   timestamptz not null,
    consumed_at  timestamptz
);

create index if not exists siwe_nonces_expiry on siwe_nonces(expires_at);

-- ── SIWS (Sign-In with Solana) ───────────────────────────────────────────────
-- Parallel to siwe_nonces; same burn-on-verify replay protection.
create table if not exists siws_nonces (
    nonce        text primary key,
    address      text,                       -- base58, set on verify attempt (audit only)
    issued_at    timestamptz not null default now(),
    expires_at   timestamptz not null,
    consumed_at  timestamptz
);

create index if not exists siws_nonces_expiry on siws_nonces(expires_at);

-- Link addresses to users. A user may have multiple wallets across chains; address is unique.
-- chain_type: 'evm' for 0x-prefixed hex addresses, 'solana' for base58 addresses.
create table if not exists user_wallets (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    address      text not null unique,       -- lowercased 0x-prefixed (EVM) or base58 (Solana)
    chain_type   text not null default 'evm' check (chain_type in ('evm', 'solana')),
    chain_id     int,                        -- EVM chain ID; null for Solana
    is_primary   boolean not null default false,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz
);

create index if not exists user_wallets_user on user_wallets(user_id);

-- Additive migration for deployments that pre-date chain_type.
alter table user_wallets add column if not exists chain_type text not null default 'evm'
    check (chain_type in ('evm', 'solana'));

-- ── Sessions (browser cookie auth) ──────────────────────────────────────────
create table if not exists sessions (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    token_hash      text not null unique,
    user_agent      text,
    ip              inet,
    expires_at      timestamptz not null,
    revoked_at      timestamptz,
    created_at      timestamptz not null default now(),
    last_seen_at    timestamptz not null default now()
);

create index if not exists sessions_user on sessions(user_id) where revoked_at is null;
create index if not exists sessions_expiry on sessions(expires_at);

-- ── Usage events (for quotas, analytics, billing) ───────────────────────────
create table if not exists usage_events (
    id              bigserial primary key,
    user_id         uuid references users(id) on delete set null,
    api_key_id      uuid references api_keys(id) on delete set null,
    client_id       text references oauth_clients(client_id) on delete set null,
    avatar_id       uuid references avatars(id) on delete set null,
    kind            text not null,                           -- 'tool_call' | 'avatar_fetch' | 'upload' | 'render'
    tool            text,                                    -- MCP tool name if applicable
    status          text not null default 'ok',              -- 'ok' | 'error' | 'rate_limited'
    bytes           bigint,
    latency_ms      int,
    meta            jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);

create index if not exists usage_events_user_time on usage_events(user_id, created_at desc);
create index if not exists usage_events_kind_time on usage_events(kind, created_at desc);

-- ── Plan quotas (soft reference; actual limits enforced in code) ────────────
create table if not exists plan_quotas (
    plan                text primary key,
    max_avatars         int not null,
    max_bytes_per_avatar bigint not null,
    max_total_bytes     bigint not null,
    mcp_calls_per_day   int not null,
    updated_at          timestamptz not null default now()
);

insert into plan_quotas (plan, max_avatars, max_bytes_per_avatar, max_total_bytes, mcp_calls_per_day) values
    ('free',         10,   26214400,       262144000,          1000),
    ('pro',          500,  52428800,       26843545600,        50000),
    ('team',         5000, 104857600,      536870912000,       500000),
    ('enterprise',   100000, 524288000,    10995116277760,     10000000)
on conflict (plan) do update set
    max_avatars = excluded.max_avatars,
    max_bytes_per_avatar = excluded.max_bytes_per_avatar,
    max_total_bytes = excluded.max_total_bytes,
    mcp_calls_per_day = excluded.mcp_calls_per_day,
    updated_at = now();

-- ── updated_at triggers ─────────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

do $$ begin
    create trigger users_set_updated_at before update on users
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
    create trigger avatars_set_updated_at before update on avatars
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
    create trigger oauth_clients_set_updated_at before update on oauth_clients
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── agent_identities — every agent gets a body, a place, an identity ─────────
CREATE TABLE IF NOT EXISTS agent_identities (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users(id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz,
	deleted_at timestamptz,
	name text NOT NULL CHECK (length(name) > 0),
	description text,
	persona_prompt text,
	home_url text,
	avatar_url text,
	profile_image_url text,
	is_public boolean NOT NULL DEFAULT true,
	is_template boolean NOT NULL DEFAULT false
);

create index if not exists agent_identities_user
    on agent_identities(user_id) where deleted_at is null;
create index if not exists agent_identities_wallet
    on agent_identities(wallet_address) where wallet_address is not null;

-- Additive migrations for agent_identities columns added after initial deployment.
alter table agent_identities add column if not exists wallet_address   text;
alter table agent_identities add column if not exists chain_id         int;
alter table agent_identities add column if not exists erc8004_agent_id bigint;
alter table agent_identities add column if not exists erc8004_registry text;
alter table agent_identities add column if not exists registration_cid text;
alter table agent_identities add column if not exists home_url         text;
alter table agent_identities add column if not exists embed_policy     jsonb;
alter table agent_identities add column if not exists voice_provider   text default 'browser';
alter table agent_identities add column if not exists voice_id         text;
alter table agent_identities add column if not exists voice_cloned_at  timestamptz;
alter table agent_identities add column if not exists farcaster_fid        integer;
alter table agent_identities add column if not exists farcaster_fname      text;
alter table agent_identities add column if not exists farcaster_seeded_at  timestamptz;
alter table agent_identities add column if not exists persona_prompt        text;
alter table agent_identities add column if not exists persona_prompt_hash   text;
alter table agent_identities add column if not exists persona_prompt_sig    text;
alter table agent_identities add column if not exists persona_tone_tags     jsonb not null default '[]'::jsonb;
alter table agent_identities add column if not exists persona_extracted_at  timestamptz;
-- is_public arrived via inline CREATE on fresh DBs but never as an additive
-- migration, so pre-existing deployments are missing the column entirely —
-- that 500s /api/avatars/:id/agents. Add it and backfill to the new default.
alter table agent_identities add column if not exists is_public boolean not null default true;
alter table agent_identities alter column is_public set default true;
update agent_identities set is_public = true
 where is_public = false and deleted_at is null;

-- ── agent_memories — the agent's persistent context ──────────────────────────
create table if not exists agent_memories (
    id          uuid primary key default gen_random_uuid(),
    agent_id    uuid not null references agent_identities(id) on delete cascade,
    type        text not null check (type in ('user','feedback','project','reference')),
    content     text not null,
    tags        text[] not null default '{}',
    context     jsonb not null default '{}'::jsonb,
    salience    real not null default 0.5,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    expires_at  timestamptz
);

create index if not exists agent_memories_agent_type
    on agent_memories(agent_id, type, created_at desc)
    where expires_at is null;

do $$ begin
    create trigger agent_memories_set_updated_at before update on agent_memories
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── agent_actions — append-only signed history ───────────────────────────────
create table if not exists agent_actions (
    id             bigserial primary key,
    agent_id       uuid not null references agent_identities(id) on delete cascade,
    type           text not null,
    payload        jsonb not null default '{}'::jsonb,
    source_skill   text,
    signature      text,
    signer_address text,
    created_at     timestamptz not null default now()
);

create index if not exists agent_actions_agent_time
    on agent_actions(agent_id, created_at desc);
create index if not exists agent_actions_type_time
    on agent_actions(type, created_at desc);

do $$ begin
    create trigger agent_identities_set_updated_at before update on agent_identities
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── widgets — saved configurations of avatars rendered in a widget runtime ──
create table if not exists widgets (
    id              text primary key,                -- 'wdgt_' + 12 base64url chars
    user_id         uuid not null references users(id) on delete cascade,
    avatar_id       uuid references avatars(id) on delete set null,
    type            text not null check (type in ('turntable','animation-gallery','talking-agent','passport','hotspot-tour','pumpfun-feed','kol-trades','live-trades-canvas')),
    name            text not null,
    config          jsonb not null default '{}'::jsonb,
    is_public       boolean not null default true,
    view_count      bigint not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    deleted_at      timestamptz
);

create index if not exists widgets_user_idx
    on widgets(user_id) where deleted_at is null;
create index if not exists widgets_type_idx
    on widgets(type) where deleted_at is null;

do $$ begin
    create trigger widgets_set_updated_at before update on widgets
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── widget_views — anonymous load events for widget owner analytics ─────────
-- No IPs, no UAs, no cookies. country from x-vercel-ip-country edge header.
create table if not exists widget_views (
    id            bigserial primary key,
    widget_id     text not null references widgets(id) on delete cascade,
    country       text,
    referer_host  text,
    created_at    timestamptz not null default now()
);

create index if not exists widget_views_widget_time
    on widget_views(widget_id, created_at desc);

-- ── widget_chat_threads — one row per (widget, visitor, page-load) ──────────
-- visitor_id is a cookieless opaque UUID minted client-side in localStorage;
-- thread_id is per page-load in sessionStorage so each "conversation start"
-- gets its own bucket. Lets the creator see conversations grouped by visit.
create table if not exists widget_chat_threads (
    id              text primary key,                -- 'wct_' + 12 base64url chars
    widget_id       text not null references widgets(id) on delete cascade,
    visitor_id      text not null,
    referer_host    text,
    country         text,
    user_agent_hash text,
    message_count   integer not null default 0,
    started_at      timestamptz not null default now(),
    last_message_at timestamptz not null default now()
);

create index if not exists widget_chat_threads_widget_time
    on widget_chat_threads(widget_id, last_message_at desc);
create index if not exists widget_chat_threads_visitor
    on widget_chat_threads(widget_id, visitor_id, started_at desc);

-- ── widget_chat_messages — append-only log of visitor + assistant turns ─────
-- content is the redacted form — email/phone/card patterns are scrubbed at
-- write time so the creator can review without storing PII.
create table if not exists widget_chat_messages (
    id           bigserial primary key,
    thread_id    text not null references widget_chat_threads(id) on delete cascade,
    widget_id    text not null references widgets(id) on delete cascade,
    role         text not null check (role in ('user', 'assistant')),
    content      text not null,
    actions      jsonb,
    provider     text,
    model        text,
    redacted     boolean not null default false,
    created_at   timestamptz not null default now()
);

create index if not exists widget_chat_messages_thread_time
    on widget_chat_messages(thread_id, created_at);
create index if not exists widget_chat_messages_widget_time
    on widget_chat_messages(widget_id, created_at desc);

-- ── widget_knowledge_docs — uploaded docs + URLs that ground the agent ─────
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

-- ── widget_knowledge_chunks — 512/100-overlap chunks with truncated embeds ──
-- Embedding is text-embedding-3-small @ 256 dims (Matryoshka), stored as a
-- JSONB float array. Retrieval scores via cosine similarity in JS at query
-- time; switch to pgvector if a single widget grows past several thousand
-- chunks.
create table if not exists widget_knowledge_chunks (
    id            bigserial primary key,
    doc_id        text not null references widget_knowledge_docs(id) on delete cascade,
    widget_id     text not null references widgets(id) on delete cascade,
    chunk_index   integer not null,
    content       text not null,
    embedding     jsonb not null,
    token_count   integer not null default 0,
    created_at    timestamptz not null default now()
);

create index if not exists widget_knowledge_chunks_widget
    on widget_knowledge_chunks(widget_id);
create index if not exists widget_knowledge_chunks_doc
    on widget_knowledge_chunks(doc_id, chunk_index);

-- ── erc8004_agents_index — crawled directory of every on-chain agent ───────
-- Populated by api/cron/erc8004-crawl.js from Etherscan V2 getLogs across every
-- chain in REGISTRY_DEPLOYMENTS. Metadata fields are lazily filled from each
-- agent's agentURI JSON. `has_3d` = true when services[name=avatar] is set.
create table if not exists erc8004_agents_index (
    chain_id           integer     not null,
    agent_id           text        not null,                -- uint256 as decimal string
    owner              text        not null,                -- 0x-lowercase
    registry           text        not null,                -- 0x-lowercase contract addr
    agent_uri          text,
    name               text,
    description        text,
    image              text,                                -- 2D thumbnail URL
    glb_url            text,                                -- services[name=avatar] endpoint
    services           jsonb       not null default '[]'::jsonb,
    x402_support       boolean     not null default false,
    has_3d             boolean     not null default false,
    active             boolean     not null default true,
    registered_block   bigint,
    registered_tx      text,
    registered_at      timestamptz,
    last_metadata_at   timestamptz,
    metadata_error     text,
    last_seen_at       timestamptz not null default now(),
    primary key (chain_id, agent_id)
);

create index if not exists erc8004_agents_has3d_time
    on erc8004_agents_index(has_3d, registered_at desc) where active;
create index if not exists erc8004_agents_chain_time
    on erc8004_agents_index(chain_id, registered_at desc) where active;
create index if not exists erc8004_agents_owner
    on erc8004_agents_index(owner) where active;
create index if not exists erc8004_agents_metadata_stale
    on erc8004_agents_index(last_metadata_at nulls first);

create table if not exists erc8004_crawl_cursor (
    chain_id       integer primary key,
    last_block     bigint  not null default 0,
    updated_at     timestamptz not null default now()
);

-- ── Solana on-chain attestations (ERC-8004 analog, no deployed program) ─────
-- Each row is one signed SPL Memo tx referencing an agent's Metaplex Core
-- asset pubkey. Schemas: threews.{feedback,validation,task,accept,revoke,dispute}.v1
create table if not exists solana_attestations (
    signature        text        primary key,
    network          text        not null,                      -- 'mainnet' | 'devnet'
    slot             bigint      not null,
    block_time       timestamptz,
    agent_asset      text        not null,                      -- referenced agent pubkey
    attester         text        not null,                      -- fee payer / signer
    kind             text        not null,                      -- e.g. threews.feedback.v1
    payload          jsonb       not null,
    task_id          text,                                      -- denormalized for fast joins
    target_signature text,                                      -- for revoke/dispute → original
    verified         boolean     not null default false,        -- payload schema-valid + task linkage if required
    revoked          boolean     not null default false,
    disputed         boolean     not null default false,
    indexed_at       timestamptz not null default now()
);
create index if not exists solana_att_agent_kind_time on solana_attestations(agent_asset, kind, slot desc);
create index if not exists solana_att_attester       on solana_attestations(attester);
create index if not exists solana_att_task_id        on solana_attestations(task_id) where task_id is not null;
create index if not exists solana_att_target         on solana_attestations(target_signature) where target_signature is not null;

create table if not exists solana_attestations_cursor (
    agent_asset       text primary key,
    network           text not null,
    last_signature    text,
    last_indexed_at   timestamptz not null default now()
);

-- ── SAS credentials (credentialed attestations issued by three.ws authority) ──
-- Permissionless attestations live in solana_attestations (memo-based);
-- this table is the credentialed counterpart for things only we can issue
-- (verified-client, audited-validation, etc.). Used to weight reputation.
create table if not exists solana_credentials (
    attestation_pda   text        primary key,
    network           text        not null,
    schema_pda        text        not null,
    credential_pda    text        not null,
    kind              text        not null,                -- e.g. threews.verified-client.v1
    subject           text        not null,                -- nonce; wallet or agent asset pubkey
    issuer_signature  text        not null,                -- tx sig of issuance
    data              jsonb       not null default '{}'::jsonb,
    expiry            timestamptz,
    closed            boolean     not null default false,
    closed_at         timestamptz,
    issued_at         timestamptz not null default now()
);
create index if not exists solana_creds_subject_kind on solana_credentials(subject, kind) where closed = false;
create index if not exists solana_creds_kind         on solana_credentials(kind, issued_at desc);

-- Additive migrations for usage_events.
alter table usage_events add column if not exists agent_id uuid references agent_identities(id) on delete set null;
create index if not exists usage_events_agent_time on usage_events(agent_id, created_at desc) where agent_id is not null;

-- ── agent_registrations_pending — transient prep records for 2-step registration ─────
create table if not exists agent_registrations_pending (
	id              uuid primary key default gen_random_uuid(),
	user_id         uuid not null references users(id) on delete cascade,
	cid             text not null,                         -- IPFS CID
	metadata_uri    text not null,                         -- ipfs://CID
	payload         jsonb not null,                        -- registration JSON
	created_at      timestamptz not null default now(),
	expires_at      timestamptz not null
);

create index if not exists agent_registrations_pending_user_expiry
	on agent_registrations_pending(user_id, expires_at);

-- ── agent_delegations — ERC-7710 signed delegation envelopes ────────────────
create table if not exists agent_delegations (
    id                  uuid primary key default gen_random_uuid(),
    agent_id            uuid not null references agent_identities(id) on delete cascade,
    chain_id            integer not null,
    delegator_address   text not null,
    delegate_address    text not null,
    delegation_hash     text not null unique,
    delegation_json     jsonb not null,
    scope               jsonb not null,
    status              text not null default 'active',
    expires_at          timestamptz not null,
    created_at          timestamptz not null default now(),
    revoked_at          timestamptz,
    tx_hash_revoke      text,
    last_redeemed_at    timestamptz,
    redemption_count    integer not null default 0,

    constraint agent_delegations_status_check
        check (status in ('active', 'revoked', 'expired')),
    constraint agent_delegations_chain_id_check
        check (chain_id > 0),
    constraint agent_delegations_delegator_address_check
        check (length(delegator_address) = 42 and delegator_address like '0x%'),
    constraint agent_delegations_delegate_address_check
        check (length(delegate_address) = 42 and delegate_address like '0x%')
);

create index if not exists idx_delegations_agent on agent_delegations(agent_id);
create index if not exists idx_delegations_status on agent_delegations(status) where status = 'active';
create index if not exists idx_delegations_delegator on agent_delegations(delegator_address);

-- ── agent_subscriptions — recurring on-chain payment schedules ──────────────
create table if not exists agent_subscriptions (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references users(id) on delete cascade,
    agent_id            uuid not null references agent_identities(id) on delete cascade,
    delegation_id       uuid not null references agent_delegations(id) on delete cascade,
    period_seconds      integer not null,
    amount_per_period   text not null,
    next_charge_at      timestamptz not null,
    last_charge_at      timestamptz,
    status              text not null default 'active',
    last_error          text,
    created_at          timestamptz not null default now(),
    canceled_at         timestamptz,

    constraint agent_subscriptions_status_check
        check (status in ('active', 'canceled', 'paused')),
    constraint agent_subscriptions_period_seconds_check
        check (period_seconds > 0)
);

create index if not exists idx_subscriptions_due on agent_subscriptions(next_charge_at) where status = 'active';
create index if not exists idx_subscriptions_user on agent_subscriptions(user_id);
create index if not exists idx_subscriptions_agent on agent_subscriptions(agent_id);

-- ── indexer_state — block cursor for the index-delegations cron ──────────────
create table if not exists indexer_state (
    contract           text    not null,
    chain_id           int     not null,
    last_indexed_block bigint  not null default 0,
    updated_at         timestamptz not null default now(),
    primary key (contract, chain_id)
);

-- ── dca_strategies — DCA schedule configs ───────────────────────────────────
create table if not exists dca_strategies (
    id                      uuid primary key default gen_random_uuid(),
    agent_id                uuid not null,
    delegation_id           uuid not null,
    chain_id                integer not null default 84532,
    token_in                text not null,
    token_out               text not null,
    token_out_symbol        text not null default 'WETH',
    amount_per_execution    text not null,
    period_seconds          integer not null,
    slippage_bps            integer not null default 50,
    status                  text not null default 'active',
    next_execution_at       timestamptz not null,
    last_execution_at       timestamptz,
    created_at              timestamptz not null default now(),
    cancelled_at            timestamptz,

    constraint dca_strategies_status_check
        check (status in ('active', 'paused', 'expired', 'cancelled')),
    constraint dca_strategies_chain_id_check
        check (chain_id > 0),
    constraint dca_strategies_slippage_check
        check (slippage_bps between 1 and 500),
    constraint dca_strategies_period_check
        check (period_seconds in (86400, 604800))
);

create index if not exists idx_dca_strategies_agent on dca_strategies(agent_id);
create index if not exists idx_dca_strategies_next_exec on dca_strategies(next_execution_at) where status = 'active';

-- ── dca_executions — per-cron swap attempt log ───────────────────────────────
create table if not exists dca_executions (
    id                      uuid primary key default gen_random_uuid(),
    strategy_id             uuid not null references dca_strategies(id) on delete cascade,
    chain_id                integer not null,
    tx_hash                 text,
    amount_in               text not null,
    quote_amount_out        text,
    amount_out              text,
    slippage_bps_used       integer,
    quote_divergence_bps    integer,
    status                  text not null default 'pending',
    error                   text,
    executed_at             timestamptz not null default now(),

    constraint dca_executions_status_check
        check (status in ('pending', 'success', 'failed', 'aborted'))
);

create index if not exists idx_dca_executions_strategy on dca_executions(strategy_id);

-- ── subscriptions — platform plan subscriptions paid on-chain ────────────────
-- chain_type: 'evm' | 'solana'. One active row per user (upserted on payment).
-- EVM payments use USDC on any supported chain; Solana payments use SPL USDC.
create table if not exists subscriptions (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    plan            text not null check (plan in ('pro', 'team', 'enterprise')),
    chain_type      text not null check (chain_type in ('evm', 'solana')),
    chain_id        integer,                -- EVM chain ID; null for Solana
    token_address   text,                  -- EVM: USDC contract; Solana: USDC mint address
    tx_hash         text,                  -- most recent payment tx hash / signature
    amount_usd      numeric(12,2),         -- USD value at time of payment
    status          text not null default 'active' check (status in ('active','expired','cancelled')),
    active_until    timestamptz not null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    cancelled_at    timestamptz
);

create unique index if not exists subscriptions_user_active
    on subscriptions(user_id) where status = 'active';
create index if not exists subscriptions_expiry
    on subscriptions(active_until) where status = 'active';

do $$ begin
    create trigger subscriptions_set_updated_at before update on subscriptions
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── plan_payment_intents — tracks checkout sessions before on-chain confirmation ──
-- Created when user initiates checkout; confirmed when tx lands on-chain.
create table if not exists plan_payment_intents (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    plan            text not null check (plan in ('pro', 'team', 'enterprise')),
    chain_type      text not null check (chain_type in ('evm', 'solana')),
    chain_id        integer,
    amount_usdc     numeric(12,6) not null, -- exact USDC amount expected
    recipient       text not null,          -- address/pubkey that should receive payment
    nonce           text not null unique,   -- random, prevents replay
    memo            text,                   -- Solana Pay memo / EVM calldata hint
    status          text not null default 'pending' check (status in ('pending','confirmed','expired','failed')),
    tx_hash         text,
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null,
    confirmed_at    timestamptz
);

create index if not exists payment_intents_user on plan_payment_intents(user_id);
create index if not exists payment_intents_expiry on plan_payment_intents(expires_at) where status = 'pending';
create index if not exists payment_intents_nonce on plan_payment_intents(nonce);

-- ── email_verifications — short-lived numeric codes for email verification ──
-- Code is stored hashed. Latest unconsumed row per user is the active one.
create table if not exists email_verifications (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    code_hash    text not null,             -- sha256 of the 6-digit code
    expires_at   timestamptz not null,
    consumed_at  timestamptz,
    attempts     int not null default 0,
    created_at   timestamptz not null default now()
);

create index if not exists email_verifications_user on email_verifications(user_id) where consumed_at is null;
create index if not exists email_verifications_expiry on email_verifications(expires_at);

-- ── password_resets — single-use tokens for password reset flow ─────────────
-- Token is stored hashed; raw value is delivered via email link only.
create table if not exists password_resets (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    token_hash   text not null unique,       -- sha256 of the random token
    expires_at   timestamptz not null,
    consumed_at  timestamptz,
    created_at   timestamptz not null default now()
);

create index if not exists password_resets_user on password_resets(user_id) where consumed_at is null;
create index if not exists password_resets_expiry on password_resets(expires_at);

-- ── user_prefs — per-user UI preferences (dashboard layout, filters, etc.) ──
create table if not exists user_prefs (
    user_id     uuid primary key references users(id) on delete cascade,
    prefs       jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now()
);

-- ── pumpfun_signals — off-chain pump.fun activity signals attached to a wallet ─
-- Not an on-chain attestation — these are crawled from the upstream
-- pumpfun-claims-bot enrichment pipeline. Used to weight Solana reputation
-- and surface trust signals on the agent passport.
create table if not exists pumpfun_signals (
    id                bigserial primary key,
    wallet            text        not null,         -- claimer / creator base58 pubkey
    agent_asset       text,                          -- linked Solana agent if known
    kind              text        not null,         -- 'first_claim' | 'fake_claim' | 'graduation' | 'influencer' | 'new_account'
    weight            real        not null default 0,-- reputation impact, -1..1
    payload           jsonb       not null default '{}'::jsonb,
    tx_signature      text        unique,
    seen_at           timestamptz not null default now()
);
create index if not exists pumpfun_signals_wallet on pumpfun_signals(wallet, seen_at desc);
create index if not exists pumpfun_signals_agent  on pumpfun_signals(agent_asset, seen_at desc) where agent_asset is not null;
create index if not exists pumpfun_signals_kind   on pumpfun_signals(kind, seen_at desc);

-- ── marketplace_skills — community skill registry ────────────────────────────
-- Two flavors:
--   • tool skills    — schema_json: jsonb array matching the ToolPack schema used in chat/src/tools.js.
--                      Each element: { clientDefinition: {...}, type, function: { name, description, parameters } }
--   • content skills — content: markdown knowledge injected into the system prompt (no tool schema).
-- Every row must have at least one of `schema_json` or `content` (enforced by check constraint).
create table if not exists marketplace_skills (
    id            uuid primary key default gen_random_uuid(),
    author_id     uuid references users(id) on delete set null,
    name          text not null,
    slug          text not null unique,
    description   text not null,
    category      text not null default 'general',
    schema_json   jsonb,
    content       text,
    tags          text[] not null default '{}',
    is_public     boolean not null default true,
    install_count integer not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    constraint marketplace_skills_has_payload check (schema_json is not null or content is not null)
);

create index if not exists marketplace_skills_category_idx on marketplace_skills(category);
create index if not exists marketplace_skills_author_idx   on marketplace_skills(author_id);
create index if not exists marketplace_skills_popular_idx  on marketplace_skills(install_count desc);
create index if not exists marketplace_skills_new_idx      on marketplace_skills(created_at desc);

do $$ begin
    create trigger marketplace_skills_set_updated_at before update on marketplace_skills
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── skill_installs — tracks which users have installed which skills ───────────
create table if not exists skill_installs (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references users(id) on delete cascade,
    skill_id     uuid references marketplace_skills(id) on delete cascade,
    installed_at timestamptz not null default now(),
    unique (user_id, skill_id)
);

create index if not exists skill_installs_user_idx on skill_installs(user_id);

-- ── skill_ratings ────────────────────────────────────────────────────────────
create table if not exists skill_ratings (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references users(id) on delete cascade,
    skill_id   uuid references marketplace_skills(id) on delete cascade,
    rating     smallint not null check (rating between 1 and 5),
    created_at timestamptz not null default now(),
    unique (user_id, skill_id)
);

-- ── agent_payments — autonomous agent-to-agent / agent-to-skill payment ledger ─
-- Inserted by skill-runtime after each paid skill call. status transitions:
--   pending → confirmed (on-chain tx broadcast succeeded)
--   pending → failed    (insufficient balance or tx error)
create table if not exists agent_payments (
    id              uuid        primary key default gen_random_uuid(),
    payer_agent_id  uuid        not null references agent_identities(id),
    payee_agent_id  uuid        references agent_identities(id),   -- null when paying a skill author
    skill_id        uuid        references marketplace_skills(id),
    amount_wei      numeric(40) not null,
    chain_id        integer     not null,
    tx_hash         text,
    memo            text,
    status          text        not null default 'pending',
    created_at      timestamptz not null default now(),
    constraint agent_payments_status_check
        check (status in ('pending', 'confirmed', 'failed'))
);

create index if not exists agent_payments_payer_time
    on agent_payments(payer_agent_id, created_at desc);
create index if not exists agent_payments_payee_time
    on agent_payments(payee_agent_id, created_at desc) where payee_agent_id is not null;
create index if not exists agent_payments_status
    on agent_payments(status, created_at desc);

-- Additive migration: royalty pricing on skills.
alter table marketplace_skills add column if not exists price_per_call_usd numeric(10,6) not null default 0;

-- ── royalty_ledger — per-call micro-payment records ──────────────────────────
create table if not exists royalty_ledger (
    id             uuid        primary key default gen_random_uuid(),
    skill_id       uuid        not null references marketplace_skills(id) on delete cascade,
    agent_id       uuid        not null references agent_identities(id) on delete cascade,
    author_user_id uuid        not null references users(id) on delete cascade,
    price_usd      numeric(10,6) not null,
    status         text        not null default 'pending',
    settled_at     timestamptz,
    tx_hash        text,
    created_at     timestamptz not null default now(),
    constraint royalty_ledger_status_check check (status in ('pending', 'settled', 'failed'))
);

create index if not exists royalty_ledger_author_idx on royalty_ledger(author_user_id, created_at desc);
create index if not exists royalty_ledger_agent_idx  on royalty_ledger(agent_id, created_at desc);

-- ── subscription_plans — creator monetization plans ───────────────────────────
-- Distinct from the `subscriptions` table (platform billing). These are
-- creator-to-fan recurring payment plans.
create table if not exists subscription_plans (
    id           uuid        primary key default gen_random_uuid(),
    creator_id   uuid        not null references users(id) on delete cascade,
    agent_id     uuid        references agent_identities(id) on delete set null,
    name         text        not null,
    price_usd    numeric(8,2) not null check (price_usd >= 0.99),
    interval     text        not null default 'monthly' check (interval in ('weekly','monthly')),
    perks        text[],
    active       boolean     not null default true,
    created_at   timestamptz not null default now()
);

create index if not exists subscription_plans_creator_idx
    on subscription_plans(creator_id) where active = true;
create index if not exists subscription_plans_agent_idx
    on subscription_plans(agent_id) where agent_id is not null and active = true;

-- ── creator_subscriptions — fan subscriptions to creator plans ────────────────
create table if not exists creator_subscriptions (
    id                   uuid        primary key default gen_random_uuid(),
    plan_id              uuid        not null references subscription_plans(id),
    subscriber_user_id   uuid        not null references users(id) on delete cascade,
    status               text        not null default 'active' check (status in ('active','paused','cancelled','past_due')),
    current_period_start timestamptz not null default now(),
    current_period_end   timestamptz not null,
    payment_method       text        not null default 'x402',
    wallet_address       text,
    created_at           timestamptz not null default now(),
    cancelled_at         timestamptz,
    unique(plan_id, subscriber_user_id)
);

create index if not exists creator_subscriptions_subscriber_idx
    on creator_subscriptions(subscriber_user_id) where status = 'active';
create index if not exists creator_subscriptions_plan_idx
    on creator_subscriptions(plan_id);
create index if not exists creator_subscriptions_due_idx
    on creator_subscriptions(current_period_end) where status = 'active';

-- ── subscription_payments — per-period payment records ────────────────────────
create table if not exists subscription_payments (
    id              uuid        primary key default gen_random_uuid(),
    subscription_id uuid        not null references creator_subscriptions(id),
    amount_usd      numeric(8,2) not null,
    status          text        not null default 'pending' check (status in ('pending','succeeded','failed')),
    tx_hash         text,
    paid_at         timestamptz,
    created_at      timestamptz not null default now()
);

create index if not exists subscription_payments_subscription_idx
    on subscription_payments(subscription_id);

-- ── social_connections ────────────────────────────────────────────────────────
create table if not exists social_connections (
    id           uuid        primary key default gen_random_uuid(),
    user_id      uuid        not null references users(id) on delete cascade,
    provider     text        not null,
    provider_uid text        not null,
    username     text        not null,
    access_token text        not null,
    scopes       text        not null,
    connected_at timestamptz not null default now(),
    unique(user_id, provider)
);

create index if not exists social_connections_user_idx on social_connections(user_id);

-- Additive migrations for social_connections added after initial deployment.
alter table social_connections add column if not exists refresh_token    text;
alter table social_connections add column if not exists expires_at       timestamptz;
alter table social_connections add column if not exists raw_data         jsonb not null default '{}'::jsonb;
alter table social_connections add column if not exists disconnected_at  timestamptz;
alter table social_connections add column if not exists updated_at       timestamptz not null default now();
-- provider_uid holds the provider's user ID (e.g. Twitter numeric ID)

-- Additive migrations for agent_identities — X social seeding
alter table agent_identities add column if not exists x_username   text;
alter table agent_identities add column if not exists x_seeded_at  timestamptz;

-- ── scene_gates ───────────────────────────────────────────────────────────────
-- Token-gated scene shares. Visitors must prove wallet ownership before loading.
create table if not exists scene_gates (
    id           text primary key,
    user_id      uuid references users(id),
    scene_ref    text not null,
    chain        text not null check (chain in ('solana','evm')),
    kind         text not null check (kind in ('spl','collection','erc20','erc721')),
    address      text not null,
    min_balance  numeric not null default 1,
    created_at   timestamptz not null default now()
);

-- ── gate_nonces ───────────────────────────────────────────────────────────────
-- One-time nonces for gate-check wallet signature verification.
create table if not exists gate_nonces (
    nonce       text primary key,
    gate_id     text not null references scene_gates(id) on delete cascade,
    address     text not null,
    expires_at  timestamptz not null,
    consumed_at timestamptz
);

create index if not exists gate_nonces_expiry  on gate_nonces(expires_at);
create index if not exists gate_nonces_gate_id on gate_nonces(gate_id);

-- ── plugins — LobeHub/pai-chat compatible plugin marketplace ─────────────────
-- manifest_json matches ToolManifest from pai-chat:
--   { identifier, meta:{title,...}, api[], systemRole?, type?, settings?, ... }
create table if not exists plugins (
    id            uuid         primary key default gen_random_uuid(),
    author_id     uuid         references users(id) on delete set null,
    identifier    text         not null,
    manifest_url  text,
    manifest_json jsonb        not null,
    name          text         not null,
    description   text         not null default '',
    category      text         not null default 'tools',
    tags          text[]       not null default '{}',
    is_public     boolean      not null default true,
    install_count integer      not null default 0,
    avg_rating    numeric(3,2) not null default 0,
    rating_count  integer      not null default 0,
    deleted_at    timestamptz,
    created_at    timestamptz  not null default now(),
    updated_at    timestamptz  not null default now(),
    unique (identifier, author_id)
);

create index if not exists plugins_category_idx   on plugins(category);
create index if not exists plugins_author_idx     on plugins(author_id);
create index if not exists plugins_popular_idx    on plugins(install_count desc);
create index if not exists plugins_new_idx        on plugins(created_at desc);
create index if not exists plugins_identifier_idx on plugins(identifier);

do $$ begin
    create trigger plugins_set_updated_at before update on plugins
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── pumpfun_graduations — persisted pump.fun → AMM migration events ──────────
-- See migrations/2026-05-04-pumpfun-graduations.sql for the full schema.
create table if not exists pumpfun_graduations (
    tx_signature        text        primary key,
    mint                text        not null,
    name                text,
    symbol              text,
    creator             text,
    pool                text,
    raydium_pool        text,
    pump_swap_pool      text,
    market_cap_usd      double precision,
    market_cap_usd_initial double precision,
    ath_market_cap      double precision,
    amount_sol          double precision,
    amount_usd          double precision,
    sol_price           double precision,
    image_uri           text,
    description         text,
    twitter             text,
    telegram            text,
    website             text,
    creator_launches    integer,
    creator_graduated   integer,
    payload             jsonb       not null default '{}'::jsonb,
    seen_at             timestamptz not null default now()
);
create index if not exists pumpfun_graduations_seen_at on pumpfun_graduations(seen_at desc);
create index if not exists pumpfun_graduations_mint on pumpfun_graduations(mint);
create index if not exists pumpfun_graduations_creator on pumpfun_graduations(creator) where creator is not null;

-- ── agent_skill_prices ───────────────────────────────────────────────────────
-- Per-skill price set by the agent owner. Authoritative source of truth for
-- "is this skill paid, and how much?". See migration 2026-04-30-agent-monetization.sql.
CREATE TABLE IF NOT EXISTS agent_skill_prices (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    skill             TEXT NOT NULL,
    currency_mint     TEXT NOT NULL,
    chain             TEXT NOT NULL DEFAULT 'solana',
    amount            BIGINT NOT NULL,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    mint_decimals     SMALLINT NOT NULL DEFAULT 6,                 -- A2 cached mint decimals
    trial_uses        INTEGER  NOT NULL DEFAULT 0,                 -- C2 trial allowance per buyer
    time_pass_hours   INTEGER,                                     -- C3 time-pass duration
    time_pass_amount  BIGINT,                                      -- C3 time-pass price
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, skill)
);

CREATE INDEX IF NOT EXISTS agent_skill_prices_agent_id ON agent_skill_prices(agent_id);

-- ── skill_purchases ─────────────────────────────────────────────────────────
-- Per-buyer skill ownership ledger. Pending row is created when buyer initiates
-- the Solana Pay flow; status flips to 'confirmed' once on-chain transfer is
-- verified by /api/marketplace/purchase/:reference/confirm or by the
-- /api/webhooks/solana-pay endpoint. See migration 2026-05-10-skill-purchases.sql.
CREATE TABLE IF NOT EXISTS skill_purchases (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id         UUID NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    skill            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'confirmed', 'failed', 'expired', 'tipped', 'trial')),
    reference        TEXT NOT NULL UNIQUE,
    tx_signature     TEXT UNIQUE,
    amount           BIGINT NOT NULL,
    currency_mint    TEXT NOT NULL,
    chain            TEXT NOT NULL DEFAULT 'solana',
    kind             TEXT NOT NULL DEFAULT 'purchase'
                       CHECK (kind IN ('purchase', 'trial', 'time_pass')),
    expires_at       TIMESTAMPTZ,                                 -- A3 pending TTL
    valid_until      TIMESTAMPTZ,                                 -- C3 time-bounded access (time_pass)
    trial_remaining  INTEGER,                                     -- C2 trial counter
    tipped_amount    BIGINT,                                      -- A6 mismatch-as-tip
    referrer_user_id UUID REFERENCES users(id),                   -- C6 referral attribution
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at     TIMESTAMPTZ
);

-- 'confirmed' or 'trial' both count as active ownership for uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS skill_purchases_one_active_per_user
    ON skill_purchases (user_id, agent_id, skill)
    WHERE status IN ('confirmed', 'trial');

CREATE INDEX IF NOT EXISTS skill_purchases_user_agent       ON skill_purchases (user_id, agent_id);
CREATE INDEX IF NOT EXISTS skill_purchases_agent            ON skill_purchases (agent_id);
CREATE INDEX IF NOT EXISTS skill_purchases_status_created   ON skill_purchases (status, created_at DESC);
CREATE INDEX IF NOT EXISTS skill_purchases_expires_at
    ON skill_purchases (expires_at)
    WHERE status = 'pending' AND expires_at IS NOT NULL;

-- ── purchase_receipts ────────────────────────────────────────────────────────
-- Append-only signed receipts for confirmed skill purchases. See
-- api/_lib/purchase-confirm.js and migration 2026-05-10-monetization-v2.sql.
CREATE TABLE IF NOT EXISTS purchase_receipts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id   UUID NOT NULL REFERENCES skill_purchases(id) ON DELETE CASCADE,
    receipt_json  JSONB NOT NULL,
    signature     TEXT NOT NULL,                                  -- HMAC-SHA256 over canonical receipt_json
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (purchase_id)
);

CREATE INDEX IF NOT EXISTS purchase_receipts_created_at
    ON purchase_receipts (created_at DESC);

-- ── purchase_events ──────────────────────────────────────────────────────────
-- Funnel telemetry for the purchase lifecycle.
CREATE TABLE IF NOT EXISTS purchase_events (
    id          BIGSERIAL PRIMARY KEY,
    purchase_id UUID REFERENCES skill_purchases(id) ON DELETE CASCADE,
    event       TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS purchase_events_purchase
    ON purchase_events (purchase_id, created_at DESC);

CREATE INDEX IF NOT EXISTS purchase_events_event_time
    ON purchase_events (event, created_at DESC);

-- ── csrf_tokens ──────────────────────────────────────────────────────────────
-- Lightweight double-submit cookie tokens (A5). See api/_lib/csrf.js. Expired
-- rows are pruned by the cron job in api/cron/[name].js.
CREATE TABLE IF NOT EXISTS csrf_tokens (
    token       TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS csrf_tokens_user
    ON csrf_tokens (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS csrf_tokens_expires
    ON csrf_tokens (expires_at);

-- ── agent_payment_intents ────────────────────────────────────────────────────
-- Generic payment intent (subscriptions, one-shot, x402 invocations). Skill
-- purchases get a synthetic intent with id 'sp_<skill_purchase_id>' on confirm
-- so agent_revenue_events.intent_id FK can point at it.
CREATE TABLE IF NOT EXISTS agent_payment_intents (
    id             TEXT PRIMARY KEY,
    payer_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id       UUID NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    currency_mint  TEXT NOT NULL,
    amount         TEXT NOT NULL,
    memo           TEXT,
    start_time     TIMESTAMPTZ,
    end_time       TIMESTAMPTZ,
    status         TEXT NOT NULL DEFAULT 'pending',
    cluster        TEXT,
    tx_signature   TEXT,
    paid_at        TIMESTAMPTZ,
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL
);

-- ── paid_assets — "buy once, re-download forever" 3D-asset catalog ──────────
-- Mirror of api/_lib/migrations/2026-05-21-paid-assets.sql. Backs the
-- /api/x402/asset-download endpoint: creators upload a GLB/avatar/accessory
-- to R2, price it in USDC atomics. Per-row payout overrides let creators
-- receive USDC directly to their own wallet; NULL falls back to env X402_PAY_TO_*.
CREATE TABLE IF NOT EXISTS paid_assets (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                 text        NOT NULL UNIQUE,
    title                text        NOT NULL,
    description          text        NOT NULL,
    mime_type            text        NOT NULL,
    size_bytes           bigint      NOT NULL,
    r2_key               text        NOT NULL,
    price_atomics        text        NOT NULL,
    creator_payto_base   text,
    creator_payto_solana text,
    creator_payto_bsc    text,
    created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paid_assets_slug_idx ON paid_assets (slug);

-- ── siwx_payments + siwx_nonces — Sign-In-With-X (CAIP-122) payment history ─
-- Mirror of api/_lib/migrations/2026-05-21-siwx.sql. A wallet that paid for a
-- resource can re-access it by signing CAIP-122 instead of re-paying. Stored
-- addresses follow CAIP-122 payload format exactly (lowercase hex EVM,
-- base58 Solana); siwx-storage.js normalizes before SELECT/INSERT.
CREATE TABLE IF NOT EXISTS siwx_payments (
    resource     text        NOT NULL,
    address      text        NOT NULL,
    network      text        NOT NULL,
    paid_at      timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz,
    last_used_at timestamptz,
    use_count    integer     NOT NULL DEFAULT 0,
    PRIMARY KEY (resource, address)
);
CREATE INDEX IF NOT EXISTS siwx_payments_expires_idx
    ON siwx_payments (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS siwx_nonces (
    nonce    text        PRIMARY KEY,
    resource text        NOT NULL,
    address  text        NOT NULL,
    used_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS siwx_nonces_used_at_idx ON siwx_nonces (used_at);

-- ── x402_subscriptions + x402_access_log — subscription keys + bypass audit ─
-- Mirror of api/_lib/migrations/2026-05-21-x402-subscriptions.sql. The
-- installAccessControl() onProtectedRequest hook short-circuits the 402
-- challenge when a request carries INTERNAL_API_KEY, a subscription key, or
-- an OAuth bearer with the required scope. Every bypass and abort writes
-- to x402_access_log so audit dashboards can reconstruct who used what.
CREATE TABLE IF NOT EXISTS x402_subscriptions (
    id                    text        PRIMARY KEY,
    name                  text        NOT NULL,
    key_hash              text        NOT NULL UNIQUE,
    key_prefix            text        NOT NULL,
    rate_limit_per_minute integer     NOT NULL DEFAULT 60,
    expires_at            timestamptz,
    revoked_at            timestamptz,
    meta                  jsonb,
    created_by            uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x402_subscriptions_prefix_idx ON x402_subscriptions(key_prefix);
CREATE INDEX IF NOT EXISTS x402_subscriptions_active_idx ON x402_subscriptions(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS x402_access_log (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    caller_id   text        NOT NULL,
    route       text        NOT NULL,
    reason      text        NOT NULL,
    granted     boolean     NOT NULL,
    meta        jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x402_access_log_caller_idx ON x402_access_log(caller_id, created_at desc);
CREATE INDEX IF NOT EXISTS x402_access_log_route_idx ON x402_access_log(route, created_at desc);
CREATE INDEX IF NOT EXISTS x402_access_log_created_idx ON x402_access_log(created_at desc);

-- ── club_tips — Pole Club live-tip ledger ───────────────────────────────────
-- Mirror of api/_lib/migrations/2026-05-22-club-tips.sql. Every settled
-- /api/x402/dance-tip payment writes one row here; /api/club/tips reads it
-- for the page boot, /api/club/tips/stream tails for SSE. paid_at/paid_tx
-- are reserved for the dancer-payouts sweep.
CREATE TABLE IF NOT EXISTS club_tips (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       text        NOT NULL UNIQUE,
    dancer          text        NOT NULL,
    dance           text        NOT NULL,
    clip            text,
    label           text,
    payer           text,
    network         text,
    amount_atomics  numeric,
    asset           text,
    started_at      timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,
    paid_at         timestamptz,
    paid_tx         text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_tips_created_at_desc ON club_tips (created_at desc);
CREATE INDEX IF NOT EXISTS club_tips_dancer_created ON club_tips (dancer, created_at desc);

-- ── club_dancer_wallets + club_payouts — Pole Club payout sweep ─────────────
-- Mirror of api/_lib/migrations/2026-05-23-club-dancer-wallets.sql. Each row
-- carries display metadata + two destination addresses (EVM Base 8453, Solana
-- mainnet) the cron sweep deposits accumulated tips into. /api/cron/club-payouts
-- is idempotent — re-running only sweeps tips with paid_at IS NULL.
CREATE TABLE IF NOT EXISTS club_dancer_wallets (
    dancer          text         PRIMARY KEY,
    display_name    text         NOT NULL,
    bio             text,
    evm_address     text,
    solana_address  text,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now()
);
-- Partial index for the cron filter (unpaid tips grouped by dancer/network/asset).
CREATE INDEX IF NOT EXISTS club_tips_unpaid_by_dancer_net
    ON club_tips (dancer, network, asset)
    WHERE paid_at IS NULL;

CREATE TABLE IF NOT EXISTS club_payouts (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    dancer            text        NOT NULL REFERENCES club_dancer_wallets(dancer),
    network           text        NOT NULL,
    asset             text        NOT NULL,
    amount_atomics    numeric     NOT NULL,
    tx                text        NOT NULL,
    swept_tip_count   integer     NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_payouts_dancer_created
    ON club_payouts (dancer, created_at desc);

-- Seed the four built-in stage slots with display names hard-coded in
-- /api/x402/dance-tip and src/club.js. Addresses stay NULL until an admin
-- sets them; the cron logs + skips (dancer, network) pairs where missing.
INSERT INTO club_dancer_wallets (dancer, display_name) VALUES
    ('1', 'Nyx'),
    ('2', 'Ari'),
    ('3', 'Sable'),
    ('4', 'Vesper')
ON CONFLICT (dancer) DO UPDATE
    SET display_name = excluded.display_name,
        updated_at   = now();

-- ── x402_receipts — durable log of x402 offer-receipt artifacts ─────────────
-- Mirror of api/_lib/migrations/2026-05-24-x402-receipts.sql. Every successful
-- paid /api/x402/* call writes one row: the signed receipt we returned in the
-- SettlementResponse, the resource it covered, the payer wallet, and the chain.
-- Buyers query their own receipts via /api/x402/my-receipts (buyer-signed gate).
CREATE TABLE IF NOT EXISTS x402_receipts (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    payer        text        NOT NULL,
    network      text        NOT NULL,
    resource_url text        NOT NULL,
    format       text        NOT NULL,
    receipt      jsonb       NOT NULL,
    transaction  text,
    issued_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x402_receipts_payer_issued
    ON x402_receipts (payer, issued_at desc);
CREATE INDEX IF NOT EXISTS x402_receipts_resource_issued
    ON x402_receipts (resource_url, issued_at desc);
