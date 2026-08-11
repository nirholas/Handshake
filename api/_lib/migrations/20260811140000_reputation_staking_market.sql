-- Reputation Staking Market v1 (rsm.v1) — the index behind specs/REPUTATION_STAKING_MARKET.md.
--
-- These tables are an INDEX, not the ledger. Every row here is derivable by
-- replaying Solana: positions from threews.stake.v1 memos paid into the market
-- escrow, settlements from threews.unstake.v1 memos paid out of it. The stake
-- transaction signature is the primary key precisely so the chain, not this
-- database, defines a position's identity: a reader who distrusts the index can
-- verify any position with a single getTransaction() call.
--
-- Apply: npm run db:migrate  (read `npm run db:status` first — it applies every
-- pending file, not just this one). Idempotent.

begin;

-- ── reputation_stake_positions ─────────────────────────────────────────────
-- One row per stake transaction. principal_lamports is the ESCROW's balance
-- delta in that transaction, never the staker's debit: a staker who also paid
-- fees or funded rent in the same tx staked only what the escrow received.
create table if not exists reputation_stake_positions (
	signature          text        primary key,                 -- stake tx signature = position id
	network            text        not null,                    -- 'devnet' | 'mainnet'
	agent_asset        text        not null,                    -- subject agent pubkey
	staker             text        not null,                    -- fee payer of the stake tx
	principal_lamports numeric(30,0) not null,
	score              smallint,                                -- staker's 1-5 conviction rating
	opened_at          timestamptz not null,                    -- stake tx block_time
	status             text        not null default 'open',     -- 'open' | 'settling' | 'closed'
	closed_at          timestamptz,
	settle_signature   text,
	earnings_lamports  numeric(30,0) not null default 0,
	indexed_at         timestamptz not null default now(),
	constraint reputation_stake_positions_status_chk
		check (status in ('open', 'settling', 'closed')),
	constraint reputation_stake_positions_principal_chk
		check (principal_lamports >= 0),
	-- A closed position must carry the settlement that closed it. Without this a
	-- crash between the payout and the status write would leave a row that reads
	-- as settled but names no transaction to verify it against.
	constraint reputation_stake_positions_closed_chk
		check (status <> 'closed' or (closed_at is not null and settle_signature is not null))
);

-- The market listing ranks agents by open conviction: this is its covering index.
create index if not exists reputation_stake_positions_agent_open_idx
	on reputation_stake_positions (network, agent_asset)
	where status <> 'closed';

-- "My positions" for a wallet, newest first.
create index if not exists reputation_stake_positions_staker_idx
	on reputation_stake_positions (staker, network, opened_at desc);

-- Epoch accrual walks every position that was open during a window, including
-- ones already closed inside it.
create index if not exists reputation_stake_positions_window_idx
	on reputation_stake_positions (network, opened_at, closed_at);

-- ── reputation_stake_settlements ───────────────────────────────────────────
-- One row per payout. Keyed by the stake signature, so a replayed withdrawal
-- can never pay twice: the insert collides instead.
create table if not exists reputation_stake_settlements (
	stake_signature    text        primary key
		references reputation_stake_positions(signature) on delete cascade,
	network            text        not null,
	staker             text        not null,
	principal_lamports numeric(30,0) not null,
	earnings_lamports  numeric(30,0) not null,
	-- true when the escrow's reward surplus could not cover the accrued earnings
	-- and the payout was clamped to what was actually there (spec §2). Principal
	-- is never clamped.
	clamped            boolean     not null default false,
	-- Per-epoch derivation: [{ epoch, lamports, posWeight, epochFraction }, ...].
	-- Kept so a staker can audit the payout against the pure engine without
	-- re-reading the whole chain.
	breakdown          jsonb       not null default '[]'::jsonb,
	settle_signature   text        not null,
	settled_at         timestamptz not null default now()
);

create index if not exists reputation_stake_settlements_staker_idx
	on reputation_stake_settlements (staker, settled_at desc);

commit;
