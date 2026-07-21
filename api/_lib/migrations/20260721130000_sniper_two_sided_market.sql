-- Sniper market-realness gates (the painted-stairstep defense).
--
-- A big opening candle that then stairsteps up on a handful of wallets with no
-- sellers is a chart PAINTED to trap momentum bots. In the platform's own labeled
-- outcomes (~62k coins), a genuine two-sided market (>=20 unique buyers AND >=5
-- unique sellers over the observation window) wins ~52% vs a ~12% base rate, while
-- a one-sided painted rise barely beats a coin flip. These two optional per-strategy
-- gates let an arm demand a real market before it buys. Read by the worker's
-- scoreIntel (api/../scorer.js) via assessMarketRealness. Off by default (NULL/false)
-- so existing arms are unchanged.
--
--   require_two_sided_market — hard-require the proven two-sided bar.
--   min_unique_sellers       — require a floor of real sellers (no painted one-sided rise).
--
-- Additive and idempotent, safe to re-run.
ALTER TABLE agent_sniper_strategies
	ADD COLUMN IF NOT EXISTS require_two_sided_market BOOLEAN NOT NULL DEFAULT false,
	ADD COLUMN IF NOT EXISTS min_unique_sellers       INTEGER;
