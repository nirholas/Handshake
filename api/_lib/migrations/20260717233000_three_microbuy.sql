-- Programmatic $THREE micro-buy ledger.
--
-- The x402 micro-buy service (api/x402/three-buy.js), driven by the per-minute
-- loop (api/cron/three-buy-loop.js), fires many tiny, real USDC->$THREE market
-- buys on Jupiter so the platform shows continuous, verifiable buy pressure on
-- $THREE. It is the high-frequency, small-ticket sibling of the daily buyback
-- (three_buyback_runs). BUY-ONLY -- nothing here sells $THREE; bought tokens are
-- swept to the treasury.
--
-- One immutable row per settled call. Confirmed/pending rows are the DB fallback
-- for the UTC-daily spend cap (the Redis counter is the fast path); skipped and
-- failed rows record why a call did not buy (never a silent no-op).

begin;

create table if not exists three_microbuy_runs (
  id                    uuid primary key default gen_random_uuid(),
  -- 'confirmed' | 'pending' | 'skipped' | 'failed'
  status                text not null,
  -- machine-readable skip/fail reason: 'disabled' | 'not_configured'
  -- | 'insufficient_usdc' | 'treasury_unavailable' | 'no_quote'
  -- | 'daily_cap_reached' | 'swap_failed' | 'tx_reverted' | 'plan_failed'
  reason                text,
  -- USDC deployed into this buy (atomics, 6dp). Counted toward the daily cap for
  -- confirmed + pending rows.
  usdc_spent_atomics    bigint not null default 0,
  -- $THREE received (atomics). Zero for pending buys not yet confirmed.
  three_bought_atomics  bigint not null default 0,
  -- Effective execution price (USD per whole $THREE) from the quote.
  price_usd             numeric,
  slippage_bps          integer,
  -- Jupiter buy tx signature.
  buy_signature         text,
  created_at            timestamptz not null default now()
);

create index if not exists three_microbuy_runs_created
  on three_microbuy_runs (created_at desc);

create index if not exists three_microbuy_runs_status_created
  on three_microbuy_runs (status, created_at desc);

-- Powers the daily-spend DB fallback sum (status + day range).
create index if not exists three_microbuy_runs_day
  on three_microbuy_runs (created_at)
  where status in ('confirmed', 'pending');

commit;
