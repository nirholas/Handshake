-- economy_wallet_registry: a durable log of every wallet the economy has ever used.
--
-- Until now the only record of a platform wallet was the env var holding its
-- secret plus the code-level spec in api/_lib/solana-signers.js. That is a
-- snapshot, not a log: rotating a signer overwrites the env var and the previous
-- address survives nowhere except an operator's memory and the chain. Anyone
-- reconciling revenue, auditing a settle, or answering "what paid this fee in
-- July" had nothing authoritative to read.
--
-- This table is that log. One row per (role, address). Rotating a role inserts a
-- fresh row and retires the old one, so the lineage is queryable forever and the
-- old address stays attributable long after its key leaves the environment.
--
-- Secret material NEVER lands here. The row records WHERE the secret lives
-- (`secret_location`, e.g. the Cloud Run env var name), never the secret.
--
-- Idempotent.

begin;

create table if not exists economy_wallet_registry (
    id              uuid primary key default gen_random_uuid(),
    role            text        not null,
    address         text        not null,
    network         text        not null default 'solana-mainnet',
    status          text        not null default 'pending',
    env_var         text,
    secret_location text,
    purpose         text,
    rotated_from    text,
    notes           text,
    created_at      timestamptz not null default now(),
    activated_at    timestamptz,
    retired_at      timestamptz,
    constraint economy_wallet_registry_status_chk
        check (status in ('pending', 'active', 'retired'))
);

-- The same address may serve two roles, and a role accumulates many addresses
-- over its life, but a given pair is recorded once.
create unique index if not exists economy_wallet_registry_role_address_uniq
    on economy_wallet_registry (role, address, network);

-- Exactly one live wallet per role per network. This is the constraint that
-- makes a half-finished rotation impossible to leave behind: activating a fresh
-- wallet fails loudly until its predecessor is retired.
create unique index if not exists economy_wallet_registry_one_active_uniq
    on economy_wallet_registry (role, network)
    where status = 'active';

create index if not exists economy_wallet_registry_address_idx
    on economy_wallet_registry (address);

create index if not exists economy_wallet_registry_status_idx
    on economy_wallet_registry (status, network);

commit;
