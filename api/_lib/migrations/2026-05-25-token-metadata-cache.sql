-- Migration: token_metadata — server-side cache of Solana token metadata
-- (symbol/name/logo/decimals) keyed by mint. Resolved via Helius DAS once,
-- then served from Postgres on every subsequent portfolio load. This is the
-- single biggest Helius-credit saver: getAsset is ~10 credits per call, and
-- mint metadata is effectively immutable.
--
-- refreshed_at lets us TTL stale rows (e.g. logo URL went 404).
--
-- Apply: npm run db:migrate -- --apply --file 2026-05-25-token-metadata-cache.sql
-- Idempotent.

begin;

create table if not exists token_metadata (
    mint           text primary key,
    chain          text not null default 'solana',
    symbol         text,
    name           text,
    logo           text,
    decimals       smallint,
    source         text,            -- 'helius-das' | 'jupiter' | 'manual'
    refreshed_at   timestamptz not null default now(),
    created_at     timestamptz not null default now()
);

create index if not exists token_metadata_chain on token_metadata(chain);
create index if not exists token_metadata_refreshed on token_metadata(refreshed_at);

commit;
