begin;

-- The permanent history gap an EVM crawl leaves when it skips a retention wall.
--
-- Keyless public RPCs serve a few thousand blocks and answer anything older
-- with "history has been pruned" or "archive requests require a personal
-- token". A cursor parked behind that wall never moves again, so the crawl
-- resumes at the head instead. That unsticks the chain, but the blocks it
-- jumped over are gone: no keyless lane will ever serve them, and once the
-- cursor is at head the chain reports zero backlog and looks perfectly healthy.
-- The gap then exists nowhere at all.
--
-- These columns are that gap, kept as a number. They are written only by a tick
-- that actually skipped, they accumulate across skips rather than overwriting,
-- and nothing on the read path depends on them, so a chain that has never hit a
-- retention wall carries the zero it was created with.

alter table erc8004_crawl_cursor
    -- Total blocks this chain's crawl has jumped over. Recovering them needs an
    -- archive provider for that chain, which the keyless failover tail is not.
    add column if not exists history_gap_blocks bigint not null default 0,
    -- The block the most recent skip resumed at, so the newest gap's upper edge
    -- is recoverable without re-reading a cron response that has long rotated
    -- out of the logs.
    add column if not exists history_gap_to bigint,
    -- When that skip happened. A gap that stops growing is a chain that caught
    -- up; one that grows every few days is a provider that needs replacing.
    add column if not exists history_gap_at timestamptz;

commit;
