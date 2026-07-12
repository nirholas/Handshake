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
alter table users add column if not exists privy_did text;
create unique index if not exists users_wallet_unique on users(wallet_address) where wallet_address is not null;
create unique index if not exists users_username_unique on users(lower(username)) where username is not null;
create unique index if not exists users_privy_did_unique on users(privy_did) where privy_did is not null;
-- Case-insensitive username lookup on the login/signup hot path (auth/[action].js).
create index if not exists users_display_name_lower on users(lower(display_name)) where deleted_at is null;

-- Public social-profile fields. Surfaced on /u/<username> and editable by the
-- owner via PATCH /api/auth/profile. All nullable — a profile with none set
-- still renders cleanly from the user's avatars/agents/coins.
alter table users add column if not exists bio text;
alter table users add column if not exists website text;
alter table users add column if not exists location text;
alter table users add column if not exists banner_url text;

-- Account tier ("mode"): the coarse membership mode shown on a member's card.
-- NULL = the default 'user' tier. Granted modes are assigned by an admin
-- (api/admin/user/[id].js); 'holder' is derived live from on-chain $THREE and is
-- never stored here. See api/_lib/account-tier.js for the resolver + perk curve.
alter table users add column if not exists account_tier text
    check (account_tier is null or account_tier in ('beta', 'pro', 'three-dimensional'));

-- Onboarding guided-tour state (api/_lib/migrations/20260712030000_onboarding_tour_state.sql).
-- seen_at = offered/started at least once (auto-start suppressed after this);
-- completed_at = finished the onboarding track end to end.
alter table users add column if not exists onboarding_tour_seen_at timestamptz;
alter table users add column if not exists onboarding_tour_completed_at timestamptz;

-- ── user_follows — the social graph ──────────────────────────────────────────
-- A directed follow edge: follower_id follows following_id. Composite PK makes
-- a follow idempotent (one edge per pair) and the toggle a single upsert/delete.
-- The check blocks self-follows at the storage layer. Two covering indexes back
-- the hot reads: "who follows X" (follower list + count) and "who X follows"
-- (following list + count, and the feed fan-out join).
create table if not exists user_follows (
    follower_id   uuid not null references users(id) on delete cascade,
    following_id  uuid not null references users(id) on delete cascade,
    created_at    timestamptz not null default now(),
    primary key (follower_id, following_id),
    check (follower_id <> following_id)
);
create index if not exists user_follows_following on user_follows(following_id, created_at desc);
create index if not exists user_follows_follower  on user_follows(follower_id, created_at desc);

-- SAML SSO subject link (set when a user signs in via an enterprise IdP).
alter table users add column if not exists saml_name_id text;
alter table users add column if not exists saml_issuer text;
-- A SAML subject is unique per (IdP issuer, NameID). Partial unique so the same
-- NameID from two different IdPs never collides and non-SSO users (null
-- saml_name_id) are unconstrained.
create unique index if not exists users_saml_subject_unique
    on users(saml_issuer, saml_name_id) where saml_name_id is not null;

-- ── saml_request_ids — SAML SSO InResponseTo replay protection ──────────────
-- The /api/auth/saml/login lambda records each AuthnRequest ID here; the
-- /api/auth/saml/acs lambda (a separate serverless instance) confirms the IdP's
-- response echoes one we issued, then deletes it. Lives in Postgres rather than
-- process memory so it survives across instances. Rows are swept on insert and
-- removed on successful validation; abandoned logins expire by created_at.
create table if not exists saml_request_ids (
    request_id text primary key,
    value      text not null,
    created_at timestamptz not null default now()
);
create index if not exists saml_request_ids_created on saml_request_ids(created_at);

-- ── user_subdomains — tracks `<label>.threews.sol` SNS claims ───────────────
-- Populated by /api/threews/subdomain POST; read by /api/threews/* + a few
-- on-ramp endpoints (u-og, x402/pay-by-name). Without it every /threews/claim
-- availability check 500s with "relation does not exist".
create table if not exists user_subdomains (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    label           text not null,
    parent          text not null,
    owner_wallet    text not null,
    url_record      text,
    signature       text,
    created_at      timestamptz not null default now()
);

create unique index if not exists user_subdomains_label_parent
    on user_subdomains(label, parent);
create index if not exists user_subdomains_user
    on user_subdomains(user_id, created_at desc);

-- ── token_metadata — server cache of Solana token info (symbol/name/logo) ──
-- Resolved once via Helius DAS, then served from Postgres on every subsequent
-- portfolio load. Biggest Helius-credit saver in the system.
create table if not exists token_metadata (
    mint           text primary key,
    chain          text not null default 'solana',
    symbol         text,
    name           text,
    logo           text,
    decimals       smallint,
    source         text,
    refreshed_at   timestamptz not null default now(),
    created_at     timestamptz not null default now()
);
create index if not exists token_metadata_chain on token_metadata(chain);
create index if not exists token_metadata_refreshed on token_metadata(refreshed_at);

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
-- Vision-generated accessibility description of the thumbnail (T4.1). Null = not
-- generated yet; the gallery falls back to the avatar name.
alter table avatars add column if not exists alt_text text;

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

-- ── animation_clips (keyframe animations authored in the Animation Studio) ──
-- See api/_lib/migrations/2026-05-31-animation-clips.sql for the full schema +
-- rationale. Mirrored here so a clean schema.sql apply provisions the table.
create table if not exists animation_clips (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null references users(id) on delete cascade,
    avatar_id       uuid references avatars(id) on delete set null,
    slug            text not null,
    name            text not null,
    description     text,
    kind            text not null default 'animation' check (kind in ('animation','loop','sequence')),
    format          text not null default 'three.ws.animation.v1',
    duration_ms     int not null default 0,
    frame_count     int not null default 0,
    fps             int,
    loop            boolean not null default true,
    clip            jsonb,
    storage_key     text,
    editor_doc      jsonb,
    thumbnail_key   text,
    tags            text[] not null default '{}',
    visibility      text not null default 'private' check (visibility in ('private','unlisted','public')),
    price_amount    numeric(30,9),
    price_currency  text,
    artifact_key        text,
    artifact_bytes      bigint,
    artifact_mime       text,
    creator_payto_base  text,
    creator_payto_solana text,
    creator_payto_bsc   text,
    listed          boolean not null default false,
    play_count      bigint not null default 0,
    purchase_count  bigint not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    deleted_at      timestamptz,
    unique (owner_id, slug)
);
create index if not exists animation_clips_owner_idx on animation_clips(owner_id, created_at desc) where deleted_at is null;
create index if not exists animation_clips_public_idx on animation_clips(visibility, created_at desc) where visibility = 'public' and deleted_at is null;
create index if not exists animation_clips_kind_idx on animation_clips(kind, created_at desc) where deleted_at is null;
create index if not exists animation_clips_listed_idx on animation_clips(listed, created_at desc) where listed = true and deleted_at is null;
create index if not exists animation_clips_tags_idx on animation_clips using gin(tags);

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

-- Additive migrations for agent_identities columns added after initial deployment.
alter table agent_identities add column if not exists wallet_address   text;
-- Custodial wallet keys, on-chain identity, persona, payments, and the unified
-- meta.onchain block all live in `meta`; `skills` is the agent's text[] skill
-- list (read/written as a raw Postgres array — never jsonb — by api/agents.js
-- and queried with `skills @> '{…}'::text[]` in api/agents/public.js). Both
-- columns are written on EVERY create path (api/agents.js:154,281) and read by
-- the wallet/onchain provisioning, the task-01 backfill, and the custody
-- migration, yet the original CREATE TABLE above never declared them — a DB
-- bootstrapped purely from this file 500s on the first wallet write without
-- these two lines. Declare them idempotently here so a fresh apply is correct.
alter table agent_identities add column if not exists meta             jsonb not null default '{}'::jsonb;
alter table agent_identities add column if not exists skills           text[] not null default '{}'::text[];

-- Wallet-address index: created AFTER the column is guaranteed above so a fresh
-- apply never references a not-yet-added column (the original ordering indexed
-- wallet_address before its ADD and broke a clean-room bootstrap).
create index if not exists agent_identities_wallet
    on agent_identities(wallet_address) where wallet_address is not null;
alter table agent_identities add column if not exists chain_id         int;
alter table agent_identities add column if not exists erc8004_agent_id bigint;
alter table agent_identities add column if not exists erc8004_registry text;
alter table agent_identities add column if not exists registration_cid text;
alter table agent_identities add column if not exists home_url         text;
alter table agent_identities add column if not exists embed_policy     jsonb;
alter table agent_identities add column if not exists voice_provider   text default 'browser';
alter table agent_identities add column if not exists voice_id         text;
alter table agent_identities add column if not exists voice_cloned_at  timestamptz;
alter table agent_identities add column if not exists voice_model      text;
alter table agent_identities add column if not exists voice_settings   jsonb;
alter table agent_identities add column if not exists farcaster_fid        integer;
alter table agent_identities add column if not exists farcaster_fname      text;
alter table agent_identities add column if not exists farcaster_seeded_at  timestamptz;
alter table agent_identities add column if not exists persona_prompt        text;
alter table agent_identities add column if not exists persona_prompt_hash   text;
alter table agent_identities add column if not exists persona_prompt_sig    text;
alter table agent_identities add column if not exists persona_tone_tags     jsonb not null default '[]'::jsonb;
alter table agent_identities add column if not exists persona_extracted_at  timestamptz;
-- Brain Studio: structured, editable personality. `persona_traits` is the source
-- of truth for the slider dimensions + vocabulary + base persona; it compiles
-- (src/agents/persona-compile.js) into the signed `persona_prompt` above.
-- `persona_updated_at` tracks the last Brain Studio save (distinct from the
-- one-time extraction interview in `persona_extracted_at`).
alter table agent_identities add column if not exists persona_traits        jsonb not null default '{}'::jsonb;
alter table agent_identities add column if not exists persona_updated_at    timestamptz;
-- is_public arrived via inline CREATE on fresh DBs but never as an additive
-- migration, so pre-existing deployments are missing the column entirely —
-- that 500s /api/avatars/:id/agents. Add it and backfill to the new default.
alter table agent_identities add column if not exists is_public boolean not null default true;
alter table agent_identities alter column is_public set default true;
update agent_identities set is_public = true
 where is_public = false and deleted_at is null;

-- Per-agent Metaplex Core skill collection: master identifier for the agent's
-- "skill ownership" NFTs. Populated by scripts/create-agent-collection.mjs.
-- See api/_lib/migrations/20260617120000_agent_skill_collection.sql.
alter table agent_identities add column if not exists skill_collection_mint       text;
alter table agent_identities add column if not exists skill_collection_network    text;
alter table agent_identities add column if not exists skill_collection_uri        text;
alter table agent_identities add column if not exists skill_collection_tx         text;
alter table agent_identities add column if not exists skill_collection_created_at timestamptz;
create unique index if not exists agent_identities_skill_collection_mint
    on agent_identities (skill_collection_mint)
    where skill_collection_mint is not null;

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

-- Memories are owner-only by default. `is_public` is an explicit opt-in that
-- lets an owner surface a memory on their public profile (/u/<username>).
-- Default false so nothing is ever exposed without a deliberate toggle.
alter table agent_memories add column if not exists is_public boolean not null default false;

-- Partial index for the public-profile read path: public, non-expired memories
-- for a given agent, newest first.
create index if not exists agent_memories_public
    on agent_memories(agent_id, created_at desc)
    where is_public = true and expires_at is null;

-- Memory Studio (P2): tiered model (working/recall/archival) + recall bookkeeping
-- + lazy embedding/entity cursors. See migrations/20260619120000_memory_studio.sql.
alter table agent_memories add column if not exists tier text not null default 'recall'
    check (tier in ('working', 'recall', 'archival'));
alter table agent_memories add column if not exists embedding jsonb;
alter table agent_memories add column if not exists embedder text;
alter table agent_memories add column if not exists pinned boolean not null default false;
alter table agent_memories add column if not exists last_accessed_at timestamptz;
alter table agent_memories add column if not exists access_count integer not null default 0;
alter table agent_memories add column if not exists entities_extracted boolean not null default false;

create index if not exists agent_memories_working
    on agent_memories(agent_id, salience desc)
    where tier = 'working' and expires_at is null;
create index if not exists agent_memories_needs_embed
    on agent_memories(agent_id, created_at desc)
    where embedding is null and expires_at is null;
create index if not exists agent_memories_needs_entities
    on agent_memories(agent_id, created_at desc)
    where entities_extracted = false and expires_at is null;

do $$ begin
    create trigger agent_memories_set_updated_at before update on agent_memories
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── agent_reflections / _reflection_runs — Reflection & Dreams (Living Agents) ─
-- The agent consolidates raw memories + actions into higher-order "dreams" the
-- owner reviews. agent_reflections holds the candidate insights (provenance via
-- source_memory_ids is mandatory); agent_reflection_runs logs every pass — even
-- skipped ones — so the per-agent daily cap + debounce never silently truncate.
-- See migrations/20260623210000_agent_reflections.sql.
create table if not exists agent_reflections (
    id                 uuid primary key default gen_random_uuid(),
    agent_id           uuid not null references agent_identities(id) on delete cascade,
    status             text not null default 'pending'
                           check (status in ('pending', 'accepted', 'rejected')),
    kind               text not null default 'insight'
                           check (kind in ('insight', 'belief', 'question', 'prune')),
    statement          text not null,
    rationale          text,
    confidence         real not null default 0.5 check (confidence >= 0 and confidence <= 1),
    source_memory_ids  uuid[] not null default '{}',
    proposed_type      text check (proposed_type in ('user', 'feedback', 'project', 'reference')),
    proposed_salience  real not null default 0.7 check (proposed_salience >= 0 and proposed_salience <= 1),
    proposed_action    jsonb,
    question           text,
    answer             text,
    run_id             uuid,
    accepted_memory_id uuid,
    created_at         timestamptz not null default now(),
    reviewed_at        timestamptz
);
create index if not exists agent_reflections_agent_status
    on agent_reflections(agent_id, status, created_at desc);
create index if not exists agent_reflections_run
    on agent_reflections(run_id)
    where run_id is not null;

create table if not exists agent_reflection_runs (
    id             uuid primary key default gen_random_uuid(),
    agent_id       uuid not null references agent_identities(id) on delete cascade,
    trigger        text not null check (trigger in ('cron', 'on-demand', 'manual')),
    status         text not null check (status in ('ok', 'skipped', 'error')),
    reason         text,
    dreams_created integer not null default 0,
    candidates     integer not null default 0,
    model          text,
    input_tokens   integer,
    output_tokens  integer,
    created_at     timestamptz not null default now()
);
create index if not exists agent_reflection_runs_agent_time
    on agent_reflection_runs(agent_id, created_at desc);

-- ── agent_autopilot_proposals — Memory-grounded Autopilot (Living Agents) ─────
-- Explainable autonomy: the agent proposes and (within owner-granted scope) takes
-- REAL actions, each traceable to the memory/reflection that motivated it. Scope
-- lives on agent_identities.meta.autopilot; this is the proposal queue. Execution
-- records a signed agent_actions row linked via executed_action_id. Provenance
-- (source_memory_ids and/or source_reflection_id) is mandatory.
-- See migrations/20260623230000_autopilot_proposals.sql.
create table if not exists agent_autopilot_proposals (
    id                    uuid primary key default gen_random_uuid(),
    agent_id              uuid not null references agent_identities(id) on delete cascade,
    user_id               uuid not null references users(id) on delete cascade,
    kind                  text not null
                              check (kind in ('create_alert', 'briefing', 'wallet_transfer')),
    title                 text not null,
    rationale             text not null,
    params                jsonb not null default '{}'::jsonb,
    source_memory_ids     uuid[] not null default '{}',
    source_reflection_id  uuid references agent_reflections(id) on delete set null,
    confidence            real not null default 0.6 check (confidence >= 0 and confidence <= 1),
    requires_confirmation boolean not null default true,
    status                text not null default 'pending'
                              check (status in ('pending', 'executed', 'dismissed', 'undone', 'failed')),
    executed_action_id    bigint,
    result                jsonb not null default '{}'::jsonb,
    created_at            timestamptz not null default now(),
    decided_at            timestamptz,
    executed_at           timestamptz,
    constraint agent_autopilot_proposals_has_source
        check (array_length(source_memory_ids, 1) > 0 or source_reflection_id is not null)
);
create index if not exists agent_autopilot_proposals_agent_status
    on agent_autopilot_proposals(agent_id, status, created_at desc);
create index if not exists agent_autopilot_proposals_user
    on agent_autopilot_proposals(user_id, created_at desc);
create unique index if not exists agent_autopilot_proposals_reflection_pending
    on agent_autopilot_proposals(source_reflection_id)
    where source_reflection_id is not null and status = 'pending';

-- ── agent_memory_entities / _entity_links — temporal knowledge graph (P2) ────
-- Nodes are the entities (mints, tickers, wallets, people, strategies, topics)
-- the agent's memories mention; edges are derived at read time from co-occurrence
-- within the same memory. See migrations/20260619120000_memory_studio.sql.
create table if not exists agent_memory_entities (
    id            uuid primary key default gen_random_uuid(),
    agent_id      uuid not null references agent_identities(id) on delete cascade,
    kind          text not null,
    label         text not null,
    normalized    text not null,
    salience      real not null default 0.5,
    mention_count integer not null default 0,
    first_seen_at timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    meta          jsonb not null default '{}'::jsonb,
    unique (agent_id, kind, normalized)
);
create index if not exists agent_memory_entities_agent
    on agent_memory_entities(agent_id, last_seen_at desc);
create index if not exists agent_memory_entities_kind
    on agent_memory_entities(agent_id, kind, mention_count desc);

create table if not exists agent_memory_entity_links (
    entity_id   uuid not null references agent_memory_entities(id) on delete cascade,
    memory_id   uuid not null references agent_memories(id) on delete cascade,
    created_at  timestamptz not null default now(),
    primary key (entity_id, memory_id)
);
create index if not exists agent_memory_entity_links_memory
    on agent_memory_entity_links(memory_id);

-- ── agent_memory_pins — IPFS CIDs an agent has pinned ────────────────────────
-- Lets the read proxy (GET /api/agents/:id/memory/:cid) confirm the requested
-- CID belongs to this agent instead of proxying any caller-supplied CID.
create table if not exists agent_memory_pins (
    agent_id    uuid not null references agent_identities(id) on delete cascade,
    cid         text not null,
    filename    text not null,
    bytes       integer not null default 0,
    created_at  timestamptz not null default now(),
    primary key (agent_id, cid)
);

create index if not exists agent_memory_pins_agent
    on agent_memory_pins(agent_id, created_at desc);

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
    type            text not null check (type in ('turntable','animation-gallery','talking-agent','passport','hotspot-tour','pumpfun-feed','kol-trades','live-trades-canvas','bonding-curve','walking-avatar')),
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
    status       text not null default 'ready' check (status in ('queued', 'processing', 'ready', 'failed')),
    error        text,
    source_text  text,                                   -- held server-side until QStash worker consumes it
    embedder     text,                                   -- vector space tag ('<model>@<dim>'); null = legacy text-embedding-3-small@256
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

alter table widget_knowledge_docs add column if not exists embedder text;

create index if not exists widget_knowledge_docs_widget
    on widget_knowledge_docs(widget_id, created_at desc);
create index if not exists widget_knowledge_docs_user
    on widget_knowledge_docs(user_id, created_at desc);

do $$ begin
    create trigger widget_knowledge_docs_set_updated_at before update on widget_knowledge_docs
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── widget_knowledge_chunks — 512/100-overlap chunks with tagged embeds ─────
-- Embedding is stored as a JSONB float array, produced by the embedder named
-- in `embedder` ('<model>@<dim>', e.g. 'nvidia/nv-embedqa-e5-v5@1024' on the
-- free NIM lane or 'text-embedding-3-small@256' on OpenAI; null = legacy
-- OpenAI rows). Vectors from different embedders are different spaces — query
-- time embeds the search string with the SAME tag and never compares across
-- tags (api/_lib/embeddings.js scoreRowsBySpace). Retrieval scores via cosine
-- similarity in JS at query time; switch to pgvector if a single widget grows
-- past several thousand chunks.
create table if not exists widget_knowledge_chunks (
    id            bigserial primary key,
    doc_id        text not null references widget_knowledge_docs(id) on delete cascade,
    widget_id     text not null references widgets(id) on delete cascade,
    chunk_index   integer not null,
    content       text not null,
    embedding     jsonb not null,
    token_count   integer not null default 0,
    embedder      text,
    created_at    timestamptz not null default now()
);

alter table widget_knowledge_chunks add column if not exists embedder text;

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

-- ── solana_agents_index — crawled directory of every on-chain Solana agent ──
-- External agents (NOT three.ws's own agent_identities) from two registries,
-- folded into one table via `source`:
--   'metaplex' → Metaplex Agent Registry (1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p)
--   'agenc'    → AgenC coordination protocol (Tetsuo Corp)
-- Populated by api/cron/[name].js → handleSolanaAgentsCrawl. Served by
-- /api/explore?source=agents next to erc8004_agents_index (EVM) so /agents lists
-- the whole ecosystem. Mirrors api/_lib/migrations/20260628140000_solana_agents_index.sql.
create table if not exists solana_agents_index (
    source           text        not null,
    ref              text        not null,
    network          text        not null default 'mainnet',
    owner            text,
    asset            text,
    agent_id         text,
    name             text,
    description      text,
    image            text,
    glb_url          text,
    metadata_uri     text,
    endpoint         text,
    capabilities     text,
    reputation       integer,
    status           text,
    has_3d           boolean     not null default false,
    x402_support     boolean     not null default false,
    active           boolean     not null default true,
    registered_at    timestamptz,
    last_metadata_at timestamptz,
    metadata_error   text,
    last_seen_at     timestamptz not null default now(),
    primary key (source, ref)
);
create index if not exists solana_agents_active_time
    on solana_agents_index(registered_at desc) where active;
create index if not exists solana_agents_source_time
    on solana_agents_index(source, registered_at desc) where active;
create index if not exists solana_agents_owner
    on solana_agents_index(owner) where active;
create index if not exists solana_agents_asset
    on solana_agents_index(asset) where asset is not null;
create index if not exists solana_agents_metadata_stale
    on solana_agents_index(last_metadata_at nulls first);

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

-- LLM cost accounting (see migrations/20260608010000_usage_events_llm_cost.sql).
-- cost_micro_usd is micro-USD ($0.000001) as bigint so spend sums never drift.
alter table usage_events add column if not exists provider       text;
alter table usage_events add column if not exists model          text;
alter table usage_events add column if not exists input_tokens   int;
alter table usage_events add column if not exists output_tokens  int;
alter table usage_events add column if not exists cost_micro_usd bigint;
create index if not exists usage_events_llm_time on usage_events(created_at desc) where kind = 'llm';
create index if not exists usage_events_llm_provider_time on usage_events(provider, created_at desc) where kind = 'llm' and provider is not null;

-- Usage metering ledger (see migrations/20260623170000_usage_metering.sql).
-- Money is stored in USDC atomics (6 decimals) as bigint so statement sums never
-- drift. Metered rows carry kind='metered' and an idempotency_key so a retried
-- settlement meters EXACTLY once.
alter table usage_events add column if not exists meter_action       text;
alter table usage_events add column if not exists units              int;
alter table usage_events add column if not exists price_usdc_atomics bigint;
alter table usage_events add column if not exists fee_usdc_atomics   bigint;
alter table usage_events add column if not exists discount_bps       int;
alter table usage_events add column if not exists settlement_ref     text;
alter table usage_events add column if not exists settlement_kind    text;
alter table usage_events add column if not exists idempotency_key    text;
create unique index if not exists usage_events_idem on usage_events(idempotency_key) where idempotency_key is not null;
create index if not exists usage_events_settlement on usage_events(settlement_ref) where settlement_ref is not null;
create index if not exists usage_events_metered_user_time on usage_events(user_id, created_at desc) where kind = 'metered';

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
    amount_usdc     numeric(12,6) not null, -- USD value charged (equals the USDC amount on USDC intents)
    asset           text not null default 'USDC' check (asset in ('USDC', 'SOL', 'THREE')),
    amount_asset    numeric(30,9),          -- exact on-chain amount of `asset` expected, human units (null on legacy USDC rows)
    asset_price_usd numeric(18,9),          -- USD price of one unit of `asset` at quote time (null for USDC)
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
    wallet            text,                          -- claimer / creator / buyer base58 pubkey (null for mint-attributed signals)
    agent_asset       text,                          -- linked Solana agent if known
    kind              text        not null,         -- 'first_claim' | 'fake_claim' | 'graduation' | 'influencer' | 'new_account' | 'whale_buy' | 'launch'
    weight            real        not null default 0,-- reputation impact, -1..1
    payload           jsonb       not null default '{}'::jsonb,
    tx_signature      text,
    seen_at           timestamptz not null default now(),
    -- One row per (transaction, signal kind): a single tx can legitimately
    -- carry several signal kinds (e.g. first_claim + influencer + new_account).
    constraint pumpfun_signals_tx_kind_key unique (tx_signature, kind)
);
create index if not exists pumpfun_signals_wallet  on pumpfun_signals(wallet, seen_at desc);
create index if not exists pumpfun_signals_agent   on pumpfun_signals(agent_asset, seen_at desc) where agent_asset is not null;
create index if not exists pumpfun_signals_kind    on pumpfun_signals(kind, seen_at desc);
create index if not exists pumpfun_signals_seen_at on pumpfun_signals(seen_at desc);

-- Per-source crawl cursor for the pumpfun-signals cron. Keeps the sweep from
-- re-evaluating the whole recent-events window every run; lives in Postgres to
-- avoid spending Upstash write quota (tasks/redis-burn-rate-reduction.md).
create table if not exists pumpfun_signals_cursor (
    source         text        primary key,         -- 'claims' | 'whales' | 'mints' | 'graduations'
    last_seen_ms   bigint      not null default 0,
    last_signature text,
    updated_at     timestamptz not null default now()
);

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
    constraint royalty_ledger_status_check check (status in ('pending', 'settling', 'settled', 'failed'))
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
    included_skills text[]   not null default '{}',
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
    period_end      timestamptz,
    created_at      timestamptz not null default now()
);

create index if not exists subscription_payments_subscription_idx
    on subscription_payments(subscription_id);

-- At most one pending charge per (subscription, billing period) — see
-- migration 20260621122000_subscription-payment-idempotency.sql.
create unique index if not exists subscription_payments_one_pending_per_period
    on subscription_payments (subscription_id, period_end)
    where status = 'pending' and period_end is not null;

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
-- See api/_lib/migrations/2026-05-04-pumpfun-graduations.sql for the full schema.
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
    platform_fee_amount BIGINT NOT NULL DEFAULT 0,                -- platform fee split off on-chain (atomic units)
    platform_fee_wallet TEXT,                                     -- treasury wallet the fee leg pays
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

-- Skill-ownership NFT minted to the buyer after confirmation (perpetual on-chain
-- receipt + license). One NFT per confirmed purchase. See migration
-- 20260617130000_skill_nft_mints.sql and api/skills/mint.js.
ALTER TABLE skill_purchases ADD COLUMN IF NOT EXISTS skill_nft_mint      TEXT;
ALTER TABLE skill_purchases ADD COLUMN IF NOT EXISTS skill_nft_signature TEXT;
ALTER TABLE skill_purchases ADD COLUMN IF NOT EXISTS skill_nft_network   TEXT;
ALTER TABLE skill_purchases ADD COLUMN IF NOT EXISTS skill_nft_minted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS skill_purchases_skill_nft_mint
    ON skill_purchases (skill_nft_mint)
    WHERE skill_nft_mint IS NOT NULL;

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

-- Avatar thumbnail regeneration freshness tracking + queue.
-- Mirror of api/_lib/migrations/2026-06-27-avatar-thumbnail-regen.sql. The
-- autonomous x402 loop pays asset-download for the stalest listing and queues a
-- re-render; the drainer cron (api/cron/avatar-thumbnail-render.js) renders the
-- current GLB to a fresh PNG and writes it back so listings show current state.
ALTER TABLE paid_assets ADD COLUMN IF NOT EXISTS thumbnail_r2_key       text;
ALTER TABLE paid_assets ADD COLUMN IF NOT EXISTS thumbnail_generated_at timestamptz;
ALTER TABLE paid_assets ADD COLUMN IF NOT EXISTS source_updated_at      timestamptz;
ALTER TABLE paid_assets ADD COLUMN IF NOT EXISTS avatar_id              uuid REFERENCES avatars(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS avatar_thumbnail_regen_jobs (
    id                 bigserial   PRIMARY KEY,
    asset_id           uuid        REFERENCES paid_assets(id) ON DELETE CASCADE,
    asset_slug         text        NOT NULL,
    avatar_id          uuid        REFERENCES avatars(id) ON DELETE SET NULL,
    r2_key             text        NOT NULL,
    run_id             uuid,
    x402_tx_signature  text,
    amount_atomic      bigint      NOT NULL DEFAULT 0,
    status             text        NOT NULL DEFAULT 'queued'
                                   CHECK (status IN ('queued','rendering','done','failed')),
    thumbnail_r2_key   text,
    width              int         NOT NULL DEFAULT 768,
    height             int         NOT NULL DEFAULT 768,
    attempts           int         NOT NULL DEFAULT 0,
    error              text,
    reason             text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    rendered_at        timestamptz
);
CREATE INDEX IF NOT EXISTS avatar_thumbnail_regen_jobs_status_idx
    ON avatar_thumbnail_regen_jobs (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS avatar_thumbnail_regen_jobs_open_uniq
    ON avatar_thumbnail_regen_jobs (asset_slug)
    WHERE status IN ('queued','rendering');

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

-- ── bsc_consumed_tx — anti-replay set for x402 direct payments on BSC ───────
-- Mirror of api/_lib/migrations/2026-05-25-bsc-consumed-tx.sql. Each
-- successfully verified BSC payment tx is recorded here so a replay across
-- Vercel cold starts or function replicas can't unlock the same resource
-- twice. The on-chain Payment(payer, amount, ref) event is uniquely keyed by
-- tx_hash; the table's PRIMARY KEY enforces single-consumption.
CREATE TABLE IF NOT EXISTS bsc_consumed_tx (
    tx_hash      text        PRIMARY KEY,
    ref          text,
    payer        text,
    amount       numeric,
    pay_to       text,
    consumed_at  timestamptz NOT NULL DEFAULT now()
);

-- Garbage-collect old rows. The Payment event is public on-chain so eventual
-- cleanup of records older than 30 days is safe; auditing can re-derive from
-- BSC archive nodes if needed.
CREATE INDEX IF NOT EXISTS bsc_consumed_tx_consumed_at
    ON bsc_consumed_tx (consumed_at);

-- ── agent_reviews — marketplace ratings ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_reviews (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id     uuid        NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating       int         NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review       text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, user_id)
);
CREATE INDEX IF NOT EXISTS agent_reviews_agent_id ON agent_reviews(agent_id);
CREATE INDEX IF NOT EXISTS agent_reviews_user_id  ON agent_reviews(user_id);

-- ── x_triggers / x_scheduled_posts / x_pending_reviews — social automation ──
CREATE TABLE IF NOT EXISTS x_triggers (
    id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id       uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    kind           text        NOT NULL,
    config         jsonb       NOT NULL DEFAULT '{}',
    auto_publish   boolean     NOT NULL DEFAULT false,
    enabled        boolean     NOT NULL DEFAULT true,
    last_fired_at  timestamptz,
    last_state     jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_triggers_user_enabled ON x_triggers(user_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS x_triggers_agent_enabled ON x_triggers(agent_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS x_scheduled_posts (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id     uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    text         text        NOT NULL,
    scheduled_at timestamptz NOT NULL,
    published_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_scheduled_posts_pending
    ON x_scheduled_posts(scheduled_at) WHERE published_at IS NULL;

-- ── walk metrics / events / achievements ────────────────────────────────────
-- See api/_lib/migrations/20260621140000_walk_metrics.sql for the full rationale.
-- Mirrored here so a clean schema.sql apply provisions the walk leaderboard +
-- per-creator analytics pipeline. Ingest: POST /api/walk/metrics. Reads:
-- GET /api/walk/leaderboard and GET /api/walk/analytics.
create table if not exists walk_metrics (
    id              bigserial primary key,
    user_id         uuid references users(id) on delete cascade,
    anon_id         text,
    avatar_id       uuid references avatars(id) on delete set null,
    day             date not null,
    env_id          text,
    embed_origin    text,
    site_hostname   text,
    distance_meters double precision not null default 0,
    duration_sec    double precision not null default 0,
    sessions        integer not null default 0,
    updated_at      timestamptz not null default now(),
    created_at      timestamptz not null default now(),
    constraint walk_metrics_walker_present check (user_id is not null or anon_id is not null)
);
create unique index if not exists walk_metrics_rollup_uniq
    on walk_metrics (
        coalesce(user_id::text, ''),
        coalesce(anon_id, ''),
        day,
        coalesce(env_id, ''),
        coalesce(embed_origin, ''),
        coalesce(avatar_id::text, '')
    );
create index if not exists walk_metrics_user_day on walk_metrics (user_id, day) where user_id is not null;
create index if not exists walk_metrics_anon_day on walk_metrics (anon_id, day) where anon_id is not null;
create index if not exists walk_metrics_avatar_day on walk_metrics (avatar_id, day) where avatar_id is not null;
create index if not exists walk_metrics_origin on walk_metrics (avatar_id, embed_origin) where avatar_id is not null;

create table if not exists walk_events (
    id              bigserial primary key,
    user_id         uuid references users(id) on delete set null,
    anon_id         text,
    avatar_id       uuid references avatars(id) on delete set null,
    event_name      text not null,
    value           double precision,
    embed_origin    text,
    created_at      timestamptz not null default now()
);
create index if not exists walk_events_avatar_time on walk_events (avatar_id, created_at desc) where avatar_id is not null;
create index if not exists walk_events_avatar_name on walk_events (avatar_id, event_name) where avatar_id is not null;

create table if not exists walk_achievements (
    id              bigserial primary key,
    user_id         uuid references users(id) on delete cascade,
    anon_id         text,
    code            text not null,
    unlocked_at     timestamptz not null default now(),
    constraint walk_achievements_walker_present check (user_id is not null or anon_id is not null)
);
create unique index if not exists walk_achievements_uniq
    on walk_achievements (
        coalesce(user_id::text, ''),
        coalesce(anon_id, ''),
        code
    );
create index if not exists walk_achievements_user on walk_achievements (user_id) where user_id is not null;

-- ── walk programmatic-control sessions + command queue ───────────────────────
-- See api/_lib/migrations/20260621160000_walk_control.sql for the full rationale.
-- Mirrored here so a clean schema.sql apply provisions the walk control API.
-- Endpoint: api/walk/control/[action].js. The walk client opts in via
-- /walk?control=<sessionId>&ck=<controlToken>.
create table if not exists walk_control_sessions (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null references users(id) on delete cascade,
    avatar_id       uuid references avatars(id) on delete set null,
    token_hash      text not null,
    label           text,
    env_id          text,
    pos_x           double precision,
    pos_z           double precision,
    facing          double precision,
    motion          text,
    current_env     text,
    client_seen_at  timestamptz,
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null
);
create index if not exists walk_control_sessions_owner
    on walk_control_sessions (owner_id, created_at desc);
create index if not exists walk_control_sessions_token
    on walk_control_sessions (token_hash);
create index if not exists walk_control_sessions_expires
    on walk_control_sessions (expires_at);

create table if not exists walk_control_commands (
    id              bigserial primary key,
    session_id      uuid not null references walk_control_sessions(id) on delete cascade,
    seq             bigint not null,
    kind            text not null check (kind in ('move','gesture','say','env')),
    payload         jsonb not null default '{}'::jsonb,
    dedup_key       text,
    created_at      timestamptz not null default now(),
    delivered_at    timestamptz
);
create index if not exists walk_control_commands_drain
    on walk_control_commands (session_id, seq)
    where delivered_at is null;
create unique index if not exists walk_control_commands_dedup
    on walk_control_commands (session_id, kind, dedup_key)
    where dedup_key is not null;

CREATE TABLE IF NOT EXISTS x_pending_reviews (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trigger_id   uuid        REFERENCES x_triggers(id) ON DELETE SET NULL,
    agent_id     uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    text         text        NOT NULL,
    reviewed_at  timestamptz,
    approved     boolean,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_pending_reviews_user_pending
    ON x_pending_reviews(user_id) WHERE reviewed_at IS NULL;

-- ── club_tips — backfill amount_atomics ──────────────────────────────────────
ALTER TABLE club_tips ADD COLUMN IF NOT EXISTS amount_atomics numeric;

-- ── PWA & notifications (task 39) ────────────────────────────────────────────
-- Web Push endpoints, the unified preference center, the sent→opened→returned
-- funnel, and the double opt-in newsletter list. Full rationale lives in the
-- dated migration 20260628000000_push_and_notification_prefs.sql; mirrored here
-- so a clean schema.sql apply provisions the tables.
create table if not exists push_subscriptions (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    endpoint     text not null,
    p256dh       text not null,
    auth         text not null,
    user_agent   text,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);
create unique index if not exists push_subscriptions_endpoint
    on push_subscriptions (endpoint);
create index if not exists push_subscriptions_user
    on push_subscriptions (user_id, created_at desc);

create table if not exists notification_preferences (
    user_id    uuid primary key references users(id) on delete cascade,
    prefs      jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

create table if not exists notification_events (
    id              bigint generated always as identity primary key,
    notification_id uuid references user_notifications(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    channel         text not null check (channel in ('in_app','push','email','telegram')),
    event           text not null check (event in ('sent','opened','returned')),
    meta            jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);
create index if not exists notification_events_notif
    on notification_events (notification_id);
create index if not exists notification_events_funnel
    on notification_events (event, channel, created_at desc);
create unique index if not exists notification_events_once
    on notification_events (notification_id, channel, event)
    where notification_id is not null and event in ('opened','returned');

create table if not exists newsletter_subscribers (
    id            uuid primary key default gen_random_uuid(),
    email         citext not null unique,
    status        text not null default 'pending'
                  check (status in ('pending','confirmed','unsubscribed')),
    confirm_token text not null,
    locale        text,
    source        text,
    created_at    timestamptz not null default now(),
    confirmed_at  timestamptz,
    unsubbed_at   timestamptz
);
create index if not exists newsletter_subscribers_token
    on newsletter_subscribers (confirm_token);

-- ── genome_breedings — Agent Genome: provable breeding events + lineage ──────
-- Two agents breed into a child that provably inherits a recombination of both
-- parents' brain, voice, body, and skill alleles. Each row records the breeding
-- seed + derived genome so the descent is re-derivable and non-forgeable
-- (api/_lib/genome.js deriveGenome/verifyGenome). The child gets a fresh distinct
-- wallet (fork's ownership invariant, extended to two parents); the parents'
-- rows are never mutated by a breed. `breeding_key` is the idempotency key:
-- replaying the same key returns the same child instead of minting twins.
create table if not exists genome_breedings (
    id                 uuid primary key default gen_random_uuid(),
    breeding_key       text not null unique,
    parent_a_agent_id  uuid not null references agent_identities(id) on delete cascade,
    parent_b_agent_id  uuid not null references agent_identities(id) on delete cascade,
    child_agent_id     uuid references agent_identities(id) on delete set null,
    seed               text not null,
    genome             jsonb not null,
    genome_hash        text not null,
    generation         integer not null default 1,
    pedigree_tier      text not null default 'common',
    bred_by            uuid not null references users(id),
    stud_fee_lamports  bigint not null default 0,
    stud_fee_signature text,
    consent_owner      uuid references users(id),
    status             text not null default 'born'
                       check (status in ('pending','born','failed')),
    created_at         timestamptz not null default now()
);
create index if not exists genome_breedings_parent_a
    on genome_breedings (parent_a_agent_id, created_at desc);
create index if not exists genome_breedings_parent_b
    on genome_breedings (parent_b_agent_id, created_at desc);
create index if not exists genome_breedings_child
    on genome_breedings (child_agent_id) where child_agent_id is not null;
create index if not exists genome_breedings_bred_by
    on genome_breedings (bred_by, created_at desc);

-- ── Portable & Verifiable Brain (Living Agents · Task 06) ──────────────────────
-- See api/_lib/migrations/20260623230000_brain_ownership.sql for the full rationale.
-- Per-memory authorship (signed by the agent's EVM wallet), integrity hash, and
-- storage provenance; per-agent default storage mode; and the brain-anchor
-- history (content-addressed milestones recorded on the ERC-8004 registry).
alter table agent_memories add column if not exists content_hash   text;
alter table agent_memories add column if not exists signature       text;
alter table agent_memories add column if not exists signer_address  text;
alter table agent_memories add column if not exists signed_at       timestamptz;
alter table agent_memories add column if not exists storage_mode    text;
alter table agent_memories add column if not exists ipfs_cid        text;
alter table agent_memories drop constraint if exists agent_memories_storage_mode_chk;
alter table agent_memories add constraint agent_memories_storage_mode_chk
    check (storage_mode is null or storage_mode in ('local','ipfs','encrypted-ipfs','none'));

alter table agent_identities add column if not exists memory_storage_mode text not null default 'local';
alter table agent_identities drop constraint if exists agent_identities_memory_storage_mode_chk;
alter table agent_identities add constraint agent_identities_memory_storage_mode_chk
    check (memory_storage_mode in ('local','ipfs','encrypted-ipfs','none'));

create table if not exists agent_brain_anchors (
    id                  uuid primary key default gen_random_uuid(),
    agent_id            uuid not null references agent_identities(id) on delete cascade,
    brain_hash          text not null,
    kind                text not null default 'threews.brain-anchor.v1',
    status              text not null default 'pending'
                            check (status in ('pending','anchored','failed')),
    proof_uri           text,
    proof_hash          text,
    tx_hash             text,
    chain_id            integer,
    erc8004_agent_id    bigint,
    memory_count        integer not null default 0,
    public_count        integer not null default 0,
    persona_prompt_hash text,
    signer_address      text,
    signature           text,
    error_code          text,
    error_detail        text,
    created_at          timestamptz not null default now(),
    anchored_at         timestamptz
);
create index if not exists agent_brain_anchors_agent
    on agent_brain_anchors(agent_id, created_at desc);
create index if not exists agent_brain_anchors_hash
    on agent_brain_anchors(agent_id, brain_hash);
create index if not exists agent_brain_anchors_status
    on agent_brain_anchors(agent_id, status, created_at desc);

-- ── user_streaks / user_badges — cross-surface leaderboard streaks + badges ──
-- See api/_lib/migrations/20260712020000_leaderboard_streaks_badges.sql for the
-- full rationale.
create table if not exists user_streaks (
    user_id         uuid primary key references users(id) on delete cascade,
    current_streak  integer not null default 0,
    longest_streak  integer not null default 0,
    last_active_day date,
    updated_at      timestamptz not null default now(),
    created_at      timestamptz not null default now()
);

create table if not exists user_badges (
    id          bigserial primary key,
    user_id     uuid not null references users(id) on delete cascade,
    code        text not null,
    context     jsonb,
    unlocked_at timestamptz not null default now()
);
create unique index if not exists user_badges_uniq on user_badges (user_id, code);
create index if not exists user_badges_user on user_badges (user_id, unlocked_at desc);
