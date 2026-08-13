-- erc8004_crawl_cursor — track how far behind the CHAIN HEAD each EVM leg is,
-- not just when the cron last touched the row.
--
-- Why. On 2026-08-13 the status surface reported the EVM index healthy on 17 of
-- 21 chains, because the only freshness signal was `updated_at`: proof the cron
-- ran, not proof the index caught up. A live probe of every configured chain's
-- real block production told a different story. Reading two block timestamps one
-- chunk apart on each chain, and comparing the wall-clock span a single 15-minute
-- tick can cover:
--
--   Arbitrum One      1000 blocks =   251s of chain =  0.28x the cron period
--   Arbitrum Sepolia  1000 blocks =   250s          =  0.28x
--   BNB Chain         1000 blocks =   450s          =  0.50x
--   BSC Testnet       1000 blocks =   450s          =  0.50x
--   Polygon            500 blocks =   750s          =  0.83x
--
-- Five of twenty-two chains consume less chain time per tick than the tick
-- itself, so their backlog grows monotonically and forever (Arbitrum One sheds
-- roughly 250k blocks a day) while every one of them reports a fresh cursor.
--
-- head_block and blocks_behind make that a NUMBER on /status. chunk_size makes
-- the crawl able to do something about it: it grows while a chain is behind and
-- halves when an RPC rejects the range, so each chain settles at the largest
-- window its provider actually serves instead of a global guess.
--
-- Apply: node scripts/apply-migrations.mjs --apply
-- Idempotent.

begin;

alter table erc8004_crawl_cursor
    add column if not exists head_block    bigint,
    add column if not exists blocks_behind bigint  not null default 0,
    add column if not exists chunk_size    integer not null default 1000,
    add column if not exists last_error    text;

-- The lag monitor asks for the worst offender across all chains on every
-- /status render, which is a full scan without this.
create index if not exists erc8004_crawl_cursor_behind
    on erc8004_crawl_cursor(blocks_behind desc);

commit;
