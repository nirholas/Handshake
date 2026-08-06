-- Agora: pre-chain spend holds, so the rolling 24h cap cannot be raced.
--
-- checkPostSpend metered a citizen against agora_activity, which is the
-- PROJECTION written AFTER the on-chain escrow succeeds. Between the check and
-- that write there was a window (an RPC round trip wide) in which a second post
-- read the same total and also passed: two concurrent posts by one citizen could
-- each clear a cap only one of them fit under.
--
-- A reservation is taken BEFORE the chain call, inside the same statement that
-- sums the window, under a per-citizen advisory lock. It counts toward the cap
-- while held, is marked settled once the activity row lands (and the projection
-- takes over the counting), and is released when the escrow fails.
--
-- Holds also expire: the cap sum only counts rows younger than the hold TTL, so a
-- process that dies between reserving and settling parks a citizen's headroom for
-- minutes, never permanently, and no sweeper is required for correctness.

create table if not exists agora_spend_reservations (
    id            uuid primary key default gen_random_uuid(),
    citizen_id    uuid not null references agora_citizens(id) on delete cascade,
    -- The reward being escrowed, in the cluster's atomic units (lamports on
    -- devnet, $THREE atomics on mainnet).
    amount_atomic numeric not null check (amount_atomic > 0),
    -- Matches agora_activity.reward_mint: '$THREE' on mainnet, null (native SOL)
    -- on devnet, so a devnet hold never eats a mainnet cap.
    reward_mint   text,
    -- held: counting against the cap. settled: the activity row now counts it.
    -- released: the escrow never happened.
    state         text not null default 'held' check (state in ('held', 'settled', 'released')),
    -- What it turned into, for the audit trail. Set on settle.
    task_pda      text,
    tx_signature  text,
    created_at    timestamptz not null default now(),
    resolved_at   timestamptz
);

-- The cap sum: held rows for one citizen in one asset, newest window only.
create index if not exists agora_spend_reservations_open
    on agora_spend_reservations (citizen_id, reward_mint, created_at)
    where state = 'held';
