-- agent_onchain_events — the platform's own cross-chain index of agent
-- lifecycle events, Solana first, EVM alongside it.
--
-- Before this table the indexers stored only the CURRENT state of an agent
-- (one row per agent in erc8004_agents_index / solana_agents_index) plus the
-- memo attestations in solana_attestations. Everything that HAPPENED to an
-- agent after registration was dropped on the floor: a live census of the
-- ERC-8004 Identity Registry on Base, Ethereum and Ethereum Sepolia (2026-08-11)
-- showed the crawler indexing 7 of 66, 15 of 93 and 3 of 16 registry logs
-- respectively, because it filtered on the single `Registered` topic. Ownership
-- transfers, URI updates and metadata writes were invisible, which is also why
-- an agent's indexed owner could never change.
--
-- One row per on-chain event, one table for every chain. `chain_id` is 0 on
-- Solana so the uniqueness constraint below never sees a NULL (Postgres treats
-- NULLs as distinct, which would let the same log be inserted twice).
--
-- occurred_at is the ABSOLUTE on-chain timestamp (EVM block timestamp / Solana
-- blockTime), never an ingestion time; indexed_at is the ingestion time and is
-- what the lag monitor on /status reads.
--
-- Apply: node scripts/apply-migrations.mjs --apply
-- Idempotent.

begin;

create table if not exists agent_onchain_events (
    id            bigserial   primary key,
    chain         text        not null,                       -- 'solana' | 'evm'
    chain_id      integer     not null default 0,             -- EVM chain id; 0 on Solana
    network       text        not null default 'mainnet',     -- 'mainnet' | 'devnet' | 'testnet'
    agent_ref     text        not null,                       -- EVM: '<chainId>:<agentId>'; Solana: asset/registry pubkey
    event_class   text        not null,                       -- registration|metadata|transfer|token_launch|reputation|validation|delegation
    event_name    text        not null,                       -- concrete on-chain name, e.g. 'Registered', 'SetAgentTokenV1'
    tx            text        not null,                       -- tx hash (EVM) / signature (Solana)
    log_index     integer     not null default 0,             -- EVM log index; instruction ordinal on Solana
    block_number  bigint,                                     -- EVM block number / Solana slot
    occurred_at   timestamptz not null,                       -- absolute on-chain timestamp
    actor         text,                                       -- sender / attester / authority
    counterparty  text,                                       -- transfer recipient, when the class has one
    payload       jsonb       not null default '{}'::jsonb,
    indexed_at    timestamptz not null default now()
);

create unique index if not exists agent_onchain_events_uniq
    on agent_onchain_events(chain, chain_id, tx, log_index);
create index if not exists agent_onchain_events_agent_time
    on agent_onchain_events(agent_ref, occurred_at desc);
create index if not exists agent_onchain_events_class_time
    on agent_onchain_events(event_class, occurred_at desc);
create index if not exists agent_onchain_events_chain_indexed
    on agent_onchain_events(chain, indexed_at desc);

-- agent_event_cursor — per-agent crawl position for the Solana leg, which walks
-- signatures per account rather than block ranges. Chain-agnostic on purpose so
-- an account-scan leg on another chain reuses it.
create table if not exists agent_event_cursor (
    chain           text        not null,
    chain_id        integer     not null default 0,
    agent_ref       text        not null,
    network         text        not null default 'mainnet',
    last_tx         text,
    last_slot       bigint,
    last_event_at   timestamptz,
    last_indexed_at timestamptz not null default now(),
    scanned         integer     not null default 0,
    error           text,
    primary key (chain, chain_id, agent_ref)
);

create index if not exists agent_event_cursor_stale
    on agent_event_cursor(last_indexed_at nulls first);

commit;
