-- Migration: x402 pay-per-call pump.fun launches.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-05-30-x402-pump-launch.sql
-- Idempotent.
--
-- One row per token deployed through POST /api/x402/pump-launch. Unlike
-- pump_agent_mints, these launches have NO owning agent or three.ws user — the
-- buyer is an anonymous x402 caller who paid USDC, so this table FKs to nothing
-- and records the payer wallet (when the facilitator surfaces it) instead.

begin;

create table if not exists x402_pump_launches (
    id              uuid primary key default gen_random_uuid(),
    network         text not null default 'mainnet' check (network in ('mainnet','devnet')),
    mint            text not null,                  -- spl mint pubkey (base58)
    name            text,
    symbol          text,
    metadata_uri    text not null,
    creator         text not null,                  -- pump.fun creator (buyer-supplied or launcher)
    launcher        text not null,                  -- server payer/signer pubkey
    tx_signature    text not null,
    payer           text,                           -- x402 payer wallet (base58 / 0x), if known
    payment_network text,                           -- 'base' | 'solana' | 'bsc'
    price_atomics   text,                           -- USDC atomics charged
    vanity_prefix   text,
    vanity_suffix   text,
    created_at      timestamptz not null default now()
);

create unique index if not exists x402_pump_launches_mint_uniq
    on x402_pump_launches(mint, network);
create index if not exists x402_pump_launches_created
    on x402_pump_launches(created_at desc);
create index if not exists x402_pump_launches_payer
    on x402_pump_launches(payer) where payer is not null;

commit;
