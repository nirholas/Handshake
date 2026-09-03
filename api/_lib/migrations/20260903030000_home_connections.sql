begin;

-- three.ws Home: the record that a person connected a real house, the credential
-- that makes it work, what they have standing permission for, and everything the
-- platform did inside their building.
--
-- Home Assistant owns the device layer. We store no devices, no entity states and
-- no room graph: those are a live projection of a live WebSocket and go stale the
-- moment a light changes. What is durable is exactly four things, and they are
-- the four tables below.
--
-- The credential is a Home Assistant long-lived access token. It is a key to a
-- physical building: with it an agent can unlock a front door. It therefore gets
-- the same primitive as a custodial wallet key (AES-256-GCM through
-- api/_lib/secret-box.js) from the first write, never a hash and never plaintext.
-- A hash would be cheaper and is wrong: we have to replay the token on every
-- reconnect, so we need it back, not just a way to compare it.

create table if not exists home_connections (
    id                uuid        primary key default gen_random_uuid(),
    -- The owner. Households, roles and per-member scopes arrive later and hang
    -- off this row rather than replacing this column: the owner of a house stays
    -- the owner once members exist.
    user_id           uuid        not null references users(id) on delete cascade,
    -- What the user calls it ("Home", "The office"). User-supplied, so every
    -- render treats it as untrusted text.
    label             text        not null,
    -- Always the normalized form from normalizeBaseUrl(): scheme present, no
    -- trailing slash, a reverse-proxy path prefix preserved. Storing the raw
    -- input would make the uniqueness constraint below meaningless, because
    -- "ha.example.com" and "https://ha.example.com/" are the same house.
    base_url          text        not null,
    -- encryptSecret() output. Scrubbed to '' on revoke so a revoked row keeps
    -- its audit lineage without keeping a key to someone's front door.
    access_token_enc  text        not null,
    -- sha256(token), hex. Lets a re-connect with the same token be idempotent
    -- and a rotation be detectable without decrypting anything, which keeps the
    -- decrypt path down to exactly one function (getDecryptedToken).
    token_fingerprint text        not null,
    -- How we reach the house. 'direct' is the user's own https URL; 'relay' is
    -- an add-on inside their LAN dialing out to us.
    transport         text        not null default 'direct',
    relay_id          text,
    -- What this instance can actually do, MEASURED at connect: HA version,
    -- entity count, whether the WebSocket channel opened, whether mcp_server
    -- answered and with how many tools. Never assumed from a version number.
    capabilities      jsonb       not null default '{}'::jsonb,
    status            text        not null default 'pending',
    -- The last human-readable reason, so a list view can explain an unreachable
    -- home without a second round trip to the house.
    status_detail     text,
    last_ok_at        timestamptz,
    last_error_at     timestamptz,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    -- Soft delete. The action log below references this row, and an operator has
    -- to be able to answer "what did it do in my house" about a home they have
    -- since disconnected.
    revoked_at        timestamptz,
    constraint home_connections_status_chk
        check (status in ('pending', 'connected', 'unreachable', 'auth_failed', 'revoked')),
    constraint home_connections_transport_chk
        check (transport in ('direct', 'relay')),
    -- A relay connection without a relay id is unroutable, and a direct one with
    -- one is a contradiction. Both are bugs, so the database refuses them.
    constraint home_connections_relay_chk
        check ((transport = 'relay') = (relay_id is not null))
);

create index if not exists home_connections_user_idx
    on home_connections (user_id, created_at desc)
    where revoked_at is null;

-- One live record per house per user. Two rows for the same instance means two
-- pooled sockets, two divergent capability snapshots, and a UI that cannot say
-- which one an action ran through. If a genuine need for two appears (two HA
-- accounts on one instance) the second dimension is token_fingerprint, not
-- dropping this.
create unique index if not exists home_connections_user_base_url_uniq
    on home_connections (user_id, base_url)
    where revoked_at is null;

-- The standing per-entity allowances behind the physical-action gate.
--
-- REJECTED, deliberately: a granted_domain column. A user who lets the agent
-- open the office door has not let it open the front door, and Home Assistant's
-- own tool descriptions make this concrete rather than theoretical: its
-- intent__HassTurnOff is documented as performing an UNLOCK on a lock, so an
-- agent told to "turn everything off" reaches locks through a tool whose name
-- says nothing about doors. A domain-wide grant would turn one convenience into
-- a burglary tool. Grants are per entity, and the direction is implicit: only
-- the opening direction is ever guarded, so only the opening direction is ever
-- granted. Locking up, closing and arming never prompt and never need a row here.
create table if not exists home_entity_grants (
    id         uuid        primary key default gen_random_uuid(),
    home_id    uuid        not null references home_connections(id) on delete cascade,
    entity_id  text        not null,
    granted_by uuid        not null references users(id),
    -- null means until revoked. The UI must always offer a bounded option, so
    -- "let it in for the next two hours" does not become forever by default.
    expires_at timestamptz,
    created_at timestamptz not null default now()
);

create unique index if not exists home_entity_grants_entity_uniq
    on home_entity_grants (home_id, entity_id);

-- Every write the platform performed against a house.
--
-- Deliberately NOT audit_log. That table is the platform-wide "who deleted what"
-- trail: low volume, one shape, read by us. This one is higher volume by an order
-- of magnitude (every light, every call, from five kinds of actor), carries the
-- physical-action verdict that only exists here, and is read by the HOUSE OWNER,
-- who has to be able to answer "what did my agent do in my house last Tuesday"
-- without a scan across every other tenant's rows.
create table if not exists home_action_log (
    id           bigserial   primary key,
    home_id      uuid        not null references home_connections(id) on delete cascade,
    -- null when the actor is an agent principal with no account behind it.
    user_id      uuid,
    actor        text        not null,
    channel      text        not null,
    -- A Home Assistant service ('light.turn_on') or an MCP tool name.
    action       text        not null,
    -- The RESOLVED targets, not the raw argument. "turn off the lights" has to
    -- land in this column as the entities it actually touched, or the log cannot
    -- answer the only question anyone asks it.
    entity_ids   text[]      not null default '{}',
    -- Did the gate fire on this call.
    guarded      boolean     not null default false,
    -- Who said yes, when it did. Never a model, never an inference: this column
    -- holds a human.
    confirmed_by uuid,
    risk         text,
    outcome      text        not null,
    -- Small. No credentials, no full state dumps: scrubbed through
    -- api/_lib/scrub-secrets.js before it lands.
    detail       jsonb,
    created_at   timestamptz not null default now(),
    constraint home_action_log_actor_chk
        check (actor in ('user', 'agent', 'voice', 'mcp', 'automation')),
    constraint home_action_log_channel_chk
        check (channel in ('websocket', 'mcp')),
    constraint home_action_log_outcome_chk
        check (outcome in ('ok', 'refused', 'failed')),
    constraint home_action_log_risk_chk
        check (risk is null or risk in ('security', 'physical'))
);

-- The owner's own history, newest first: the only read shape this table has.
create index if not exists home_action_log_home_idx
    on home_action_log (home_id, created_at desc);

commit;
