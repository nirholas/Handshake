-- Oracle training set: a permanent snapshot of (launch-time features, outcome)
-- per labeled coin. pump_coin_intel and pump_coin_outcomes are firehose tables
-- pruned by db-retention on a ~14-day window, which silently deletes the ground
-- truth the Oracle learns from. This table is the durable copy: one compact row
-- per labeled coin, written at label time by the intel learner and NEVER pruned
-- (it is deliberately absent from db-retention's FIREHOSE_SATELLITES list; at
-- one small row per coin it grows ~30k rows/day, a few MB/month).
create table if not exists oracle_training_set (
	mint text not null,
	network text not null default 'mainnet',
	-- Launch-time signals exactly as pump_coin_intel.signals held them when the
	-- outcome was judged (organic_score, bundle_score, snipe_ratio,
	-- timing_entropy, concentration_*, unique_buyers, dev_buy_sol,
	-- mc_sol_first_seen, buy/sell volumes, ...).
	features jsonb not null default '{}'::jsonb,
	category text,
	-- Creator track record AS OF label time (wallet_reputation drifts later).
	creator_launches int,
	creator_wins int,
	creator_dump_rate real,
	-- Ground truth.
	outcome text not null,
	graduated boolean,
	rugged boolean,
	ath_multiple double precision,
	first_seen_at timestamptz,
	labeled_at timestamptz not null default now(),
	primary key (mint, network)
);

create index if not exists oracle_training_set_outcome_idx
	on oracle_training_set (network, outcome);
create index if not exists oracle_training_set_first_seen_idx
	on oracle_training_set (network, first_seen_at);

-- Backfill every already-labeled coin still inside the retention window before
-- the pruner reaches it. Idempotent: conflict rows are left as first written.
insert into oracle_training_set (
	mint, network, features, category,
	creator_launches, creator_wins, creator_dump_rate,
	outcome, graduated, rugged, ath_multiple, first_seen_at, labeled_at
)
select
	i.mint, i.network, coalesce(i.signals, '{}'::jsonb), i.category,
	wr.creator_count, wr.creator_wins, wr.dump_rate,
	o.outcome, o.graduated, o.rugged, o.ath_multiple, i.first_seen_at,
	coalesce(o.labeled_at, now())
from pump_coin_intel i
join pump_coin_outcomes o on o.mint = i.mint
left join wallet_reputation wr
	on wr.wallet = i.creator and wr.network = i.network
where o.outcome is not null and o.outcome <> 'unknown'
on conflict (mint, network) do nothing;
