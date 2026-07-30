-- Agent Payment Sessions — platform-funded spend envelopes for autonomous agents.
--
-- The core concept (borrowed from AWS AgentCore Payments patterns):
-- "The agent does not hold a wallet. It proposes spend. Governance enforces policy."
--
-- A PaymentSession lets a developer pre-fund a budget (drawn from their credits)
-- and give an agent a session token. The agent uses the token to call paid x402
-- endpoints via /api/pay/execute. The platform's own payer wallet executes the
-- on-chain transaction; the session atomically tracks spend and enforces limits.
--
-- This separates WALLET CUSTODY (platform holds keys) from BUDGET AUTHORITY
-- (developer sets limits per session) from EXECUTION (agent calls endpoints).
--
-- Schema:
--   id                  — UUID primary key, used as the session identifier in tokens
--   user_id             — owner (who funded this session / whose credits are drawn)
--   agent_id            — optional: which agent is authorized to use this session
--   label               — human-readable name (e.g. "Research run #4")
--   budget_usdc         — total budget in USDC atomic units (6 decimals)
--   spent_usdc          — running spend counter (atomically incremented)
--   max_per_tx_usdc     — optional per-payment ceiling (rejects over-priced endpoints)
--   allowed_hosts       — if non-empty, only pay endpoints at these hosts (allowlist)
--   network             — settlement network ('solana' or 'base')
--   connector_ref       — opaque reference to which wallet/connector to use (null = platform default)
--   status              — 'active' | 'exhausted' | 'expired' | 'cancelled'
--   expires_at          — hard expiry; payments rejected after this time
--   token_hash          — bcrypt hash of the bearer token (token itself never stored)
--   session_metadata    — arbitrary JSON for caller bookkeeping
--   created_at / updated_at

create table if not exists payment_sessions (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references users(id) on delete cascade,
    agent_id            uuid references agent_identities(id) on delete set null,

    label               text not null default '',
    budget_usdc         bigint not null check (budget_usdc > 0),
    spent_usdc          bigint not null default 0 check (spent_usdc >= 0),
    max_per_tx_usdc     bigint check (max_per_tx_usdc > 0),
    allowed_hosts       text[] not null default '{}',
    network             text not null default 'solana' check (network in ('solana', 'base')),
    connector_ref       text,

    status              text not null default 'active'
                            check (status in ('active', 'exhausted', 'expired', 'cancelled')),
    expires_at          timestamptz not null,
    token_hash          text not null,

    session_metadata    jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- Efficient lookup for active sessions by user
create index if not exists payment_sessions_user_status
    on payment_sessions (user_id, status, expires_at desc);

-- Efficient sweep of expired/exhausted sessions
create index if not exists payment_sessions_status_expires
    on payment_sessions (status, expires_at);

-- Agent-scoped lookup (which sessions is this agent authorized for)
create index if not exists payment_sessions_agent_id
    on payment_sessions (agent_id)
    where agent_id is not null;

-- Payment execution log — immutable record of every x402 payment made through a session.
--
-- Governs idempotency (idempotency_key prevents double-billing on retries),
-- provides the audit trail, and is the source-of-truth for reconciling
-- session.spent_usdc if needed.

create table if not exists payment_session_executions (
    id                  uuid primary key default gen_random_uuid(),
    session_id          uuid not null references payment_sessions(id) on delete restrict,
    user_id             uuid not null references users(id),

    -- The x402 endpoint that was paid
    endpoint_url        text not null,
    endpoint_host       text not null,
    method              text not null default 'GET',

    -- Settlement details
    amount_usdc         bigint not null check (amount_usdc > 0),
    network             text not null,
    tx_hash             text,
    payer_address       text,
    payee_address       text,

    -- Outcome
    status              text not null default 'pending'
                            check (status in ('pending', 'settled', 'failed', 'refunded')),
    error_code          text,
    error_message       text,
    response_body       jsonb,
    duration_ms         integer,

    idempotency_key     text unique,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists pse_session_id
    on payment_session_executions (session_id, created_at desc);

create index if not exists pse_user_id
    on payment_session_executions (user_id, created_at desc);

create index if not exists pse_endpoint_host
    on payment_session_executions (endpoint_host, created_at desc);

-- Idempotency index already covered by the UNIQUE constraint on idempotency_key.
