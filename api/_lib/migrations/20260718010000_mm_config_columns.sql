-- Market-maker config: add the two columns the worker reads and writes but the
-- original table never defined.
--
-- workers/agent-sniper/market-maker.js loadEnabledConfigs() selects
-- avg_entry_price_lamports and trade_count, and recordTrade() updates both. The
-- creating migration (20260626200000_agent_capabilities.sql) shipped the table
-- with total_buys/total_sells but neither of these, so every market-maker tick
-- threw "column c.avg_entry_price_lamports does not exist" (Postgres validates
-- columns at plan time, so an empty config set still failed). Additive and
-- idempotent — safe to re-run.
ALTER TABLE agent_market_maker_configs
	ADD COLUMN IF NOT EXISTS avg_entry_price_lamports NUMERIC NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS trade_count              INTEGER NOT NULL DEFAULT 0;
