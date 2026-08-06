-- Verified settlements: stage tips and IRL pays now prove themselves on-chain.
--
-- Both surfaces recorded a money event from a client-supplied signature after
-- checking only its SHAPE (a base58 / 0x regex), the mint allow-list, and a
-- positive amount. Nothing fetched the transaction, so a well-formed but
-- unrelated signature with a large amount minted a tip that never happened
-- (security review M4). The handlers now verify the transfer on-chain before the
-- row counts for anything.
--
-- verified_at is that proof: non-null means the chain showed us the transfer.
-- A row may exist with verified_at null when the transaction is real but not yet
-- visible to our RPC (a genuine payment must not be thrown away over lag); those
-- rows are excluded from every total, leaderboard, and notification until the
-- sweep in api/cron/settlement-verify.js promotes them, and are deleted when they
-- turn out to be unverifiable.
--
-- Backfill: every row that exists when this migration runs predates verification
-- and cannot be re-proved retroactively, so it is grandfathered as verified. The
-- deploy gate runs migrations before the new code is live, so no genuinely
-- pending row can exist yet at this point.

alter table if exists show_tips add column if not exists verified_at timestamptz;
alter table if exists show_tips add column if not exists verify_error text;
update show_tips set verified_at = created_at where verified_at is null;

-- The leaderboard and show totals read verified rows only.
create index if not exists show_tips_verified
    on show_tips (show_id, amount_atomic desc)
    where verified_at is not null;

-- The sweep's work queue: unverified rows, oldest first.
create index if not exists show_tips_unverified
    on show_tips (created_at)
    where verified_at is null;

alter table if exists irl_interactions add column if not exists verified_at timestamptz;
update irl_interactions set verified_at = created_at where type = 'pay' and verified_at is null;

create index if not exists irl_interactions_unverified
    on irl_interactions (created_at)
    where type = 'pay' and verified_at is null;
