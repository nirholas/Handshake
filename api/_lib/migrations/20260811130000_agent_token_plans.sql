-- Migration: agent_token_plans, the launch configuration bound to an agent record.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260811130000_agent_token_plans.sql
-- Idempotent.
--
-- Before this table an agent token existed only AFTER it minted: the launch
-- config was passed ad hoc in a POST body and thrown away, so an agent could not
-- carry a token identity it had not launched yet. A plan is that missing object:
-- one saved, editable, per-network launch configuration owned by the agent, which
-- the launch paths read instead of re-collecting, and which flips to 'launched'
-- and records its mint the moment a real launch confirms.
--
-- One plan per (agent, network): an agent can hold a devnet rehearsal and a
-- mainnet plan side by side, but never two competing plans on the same chain.

begin;

create table if not exists agent_token_plans (
    id              uuid primary key default gen_random_uuid(),
    agent_id        uuid not null references agent_identities(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    network         text not null check (network in ('mainnet','devnet')),

    -- Coin identity as it will appear on chain.
    name            text not null,
    symbol          text not null,
    description     text not null default '',
    image_url       text,
    website         text,
    twitter         text,
    telegram        text,

    -- Launch mechanics. coin_type 'agent' binds the on-chain buyback agent;
    -- 'regular' is a plain bonding-curve coin; 'mayhem' is pump.fun mayhem mode.
    coin_type       text not null default 'agent'
                      check (coin_type in ('regular','mayhem','agent')),
    quote_currency  text not null default 'sol'
                      check (quote_currency in ('sol','usdc')),
    buyback_bps     int  not null default 0 check (buyback_bps between 0 and 10000),
    sol_buy_in      numeric(20, 9) not null default 0
                      check (sol_buy_in >= 0 and sol_buy_in <= 50),
    usdc_buy_in     numeric(20, 6) not null default 0
                      check (usdc_buy_in >= 0 and usdc_buy_in <= 1000000),

    -- Lifecycle. 'draft' is incomplete, 'ready' passed the readiness check, and
    -- 'launched' carries the mint of the coin this plan actually became.
    status          text not null default 'draft'
                      check (status in ('draft','ready','launched')),
    mint            text,
    launched_at     timestamptz,

    -- Last free proof run: the plan compiled and simulated against the chain
    -- without broadcasting. Stored so the owner can see the last verdict without
    -- re-running it, and so the launch UI can show a stale-proof warning.
    last_dry_run_at timestamptz,
    last_dry_run    jsonb,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create unique index if not exists agent_token_plans_agent_network_uniq
    on agent_token_plans(agent_id, network);
create index if not exists agent_token_plans_user
    on agent_token_plans(user_id, updated_at desc);
-- Partial index for the "which plans actually became coins" join; most rows are
-- drafts with a null mint and never participate in it.
create index if not exists agent_token_plans_mint
    on agent_token_plans(mint) where mint is not null;

commit;
