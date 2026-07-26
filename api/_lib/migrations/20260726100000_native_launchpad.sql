-- three.ws native launchpad lane (Meteora Dynamic Bonding Curve).
-- Mirrors pump_agent_mints for the self-hosted curve: one row per confirmed
-- native launch, keyed by (mint, network). `pool` is the DBC virtual-pool
-- address; `config_key` records which partner curve config the pool was
-- created under so fee claims and analytics can group by curve generation.

create table if not exists native_launches (
    id              uuid primary key default gen_random_uuid(),
    agent_id        uuid not null references agent_identities(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    network         text not null check (network in ('mainnet','devnet')),
    mint            text not null,                  -- base token mint (base58)
    pool            text not null,                  -- DBC virtual pool address (base58)
    config_key      text not null,                  -- DBC partner config the pool runs on
    name            text,
    symbol          text,
    metadata_uri    text,
    creator_address text,                            -- on-chain pool creator (fee recipient)
    status          text not null default 'curve' check (status in ('curve','migrated')),
    quote_mint      text,                            -- null = SOL-paired
    migrated_at     timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create unique index if not exists native_launches_mint_uniq
    on native_launches(mint, network);
create index if not exists native_launches_agent
    on native_launches(agent_id);
create index if not exists native_launches_network_time
    on native_launches(network, created_at desc);
