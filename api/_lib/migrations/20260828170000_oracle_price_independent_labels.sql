-- Oracle: price-independent outcome labels, and a home for learned models.
--
-- Why this exists
-- ---------------
-- `pump_coin_outcomes.rugged` was not a property of the coin. It was a readout
-- of the SOL price on the day we happened to look.
--
-- deriveOutcome judged a rug with two tests: the coin fell to <= 25% of the
-- market cap at first sight, or its market cap dropped under a hardcoded
-- $3,000. The first test can essentially never fire. A pump.fun bonding curve
-- with zero real reserves is worth 30 SOL * 1e9 / 1073000191 = 27.958993 SOL,
-- and we first see a coin inside its opening 90 seconds, when its market cap is
-- 28-38 SOL. The floor is therefore 73-99% of the market cap at first sight and
-- the "fell to 25%" branch is unreachable for almost every launch.
--
-- That left the $3,000 test deciding every rug, against a floor that is worth
-- 27.958993 * (the SOL price). Measured over the ten days to 2026-08-28:
--
--   rugged=true,  graduated=false   n=206,428   206,419 of them under $3,000
--   rugged=false, graduated=false   n= 25,180   minimum exactly $3,000
--
-- Both groups are the same object: an empty bonding curve. 25,180 completely
-- dead coins were labeled survivors purely because SOL was above roughly $107.3
-- when the labeler reached them, which is also why the per-day rug rate sat at
-- 90-94% for weeks and then fell to 55.3% on 2026-08-27. Every downstream
-- "clean win rate" that subtracts rugs was reading the SOL price.
--
-- The fix
-- -------
-- Two ratios, both taken from the SAME API response, so the SOL price cancels:
--
--   retained      = last_market_cap_usd / ath_market_cap_usd
--                   the share of its own peak the coin still holds
--   hold_multiple = ath_multiple * retained
--                   what a holder who bought at first sight and held would have
--
-- Neither can be moved by the price of SOL. Both backfill exactly from columns
-- we already store, with no re-fetch: this migration recomputes them for every
-- historical row. Measured on the corrected labels, the real rug rate for
-- non-graduated coins is 11.0%, not 91%, and it holds within two points across
-- every observation-age bucket from 60 minutes to 3 days, which is what a
-- property of the coin is supposed to do.
--
-- label_version marks which rule judged a row: 1 = the USD-threshold rule,
-- 2 = price-independent. The fitter trains on version 2 only.

-- ── Outcomes: the corrected ratios ───────────────────────────────────────────
alter table pump_coin_outcomes add column if not exists retained double precision;
alter table pump_coin_outcomes add column if not exists hold_multiple double precision;
-- Exact "the curve is empty" flag, from the SOL-denominated market cap. Only
-- populated going forward: the historical rows never stored a SOL market cap.
alter table pump_coin_outcomes add column if not exists at_floor boolean;
alter table pump_coin_outcomes add column if not exists label_version smallint not null default 1;

update pump_coin_outcomes
set retained = last_market_cap_usd / ath_market_cap_usd,
    hold_multiple = ath_multiple * (last_market_cap_usd / ath_market_cap_usd),
    label_version = 2
where retained is null
  and ath_market_cap_usd > 0
  and last_market_cap_usd is not null
  and ath_multiple is not null;

-- ── Training set: same two ratios, backfilled from the outcomes table ────────
alter table oracle_training_set add column if not exists retained double precision;
alter table oracle_training_set add column if not exists hold_multiple double precision;
alter table oracle_training_set add column if not exists label_version smallint not null default 1;

update oracle_training_set t
set retained = o.retained,
    hold_multiple = o.hold_multiple,
    label_version = 2
from pump_coin_outcomes o
where o.mint = t.mint
  and t.retained is null
  and o.retained is not null;

-- The fitter reads "version 2 rows, oldest first". Without this it sequential
-- scans three quarters of a million rows on every refit.
create index if not exists idx_oracle_training_label_version
	on oracle_training_set (network, label_version, first_seen_at)
	where outcome <> 'unknown';

-- ── Learned models live in the database, not in the container image ─────────
-- The conviction model shipped as a JSON file baked in at build time, so the
-- only way to teach the Oracle anything was to redeploy. Nothing ever did: it
-- sat at its 2026-08-09 weights, fitted on 92,906 rows, while the labeled set
-- grew past 750,000. Weights here mean the refit cron can promote a better
-- model between deploys, and the JSON file stays as the bootstrap for a cold
-- container and for tests.
create table if not exists oracle_model_versions (
	id bigserial primary key,
	network text not null default 'mainnet',
	-- The full model document: heads, per-bucket weights, anchors, holdout report.
	model jsonb not null,
	fitted_at timestamptz not null,
	training_rows int not null,
	-- Denormalised from model.holdout so the promotion gate and the public
	-- endpoint can rank candidates without unpacking the whole document.
	holdout_auc_win double precision,
	holdout_auc_rug double precision,
	holdout_auc_moon double precision,
	-- 'active' serves traffic, 'candidate' lost to the incumbent, 'rejected'
	-- failed the gate outright. Never delete: the trail is the audit.
	status text not null default 'candidate',
	-- Why the gate decided what it decided, in words, for whoever asks later.
	decision text,
	promoted_at timestamptz,
	created_at timestamptz not null default now()
);

create index if not exists idx_oracle_model_versions_active
	on oracle_model_versions (network, promoted_at desc)
	where status = 'active';
create index if not exists idx_oracle_model_versions_recent
	on oracle_model_versions (network, created_at desc);

-- Exactly one active model per network. The promoter demotes the incumbent and
-- promotes the challenger in one transaction; this makes a bug that skips the
-- demotion fail loudly instead of serving two models at random.
create unique index if not exists idx_oracle_model_versions_one_active
	on oracle_model_versions (network) where status = 'active';
