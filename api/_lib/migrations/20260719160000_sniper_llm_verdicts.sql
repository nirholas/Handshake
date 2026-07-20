-- LLM judgment ledger for the sniper experiment fleet.
--
-- Every verdict an LLM arm renders on a launch is persisted, buys AND skips,
-- so each model's judgment can be scored against what the coin actually did
-- (pump_coin_outcomes) even while the fleet trades tiny sizes or runs in
-- simulate mode. Trades measure execution; this ledger measures judgment,
-- including the counterfactuals ("the coins it passed on that later pumped").
--
-- One row per (mint, model): agents sharing a model share one verdict call, so
-- the ledger mirrors that dedupe. Written fire-and-forget by
-- workers/agent-sniper/llm-judge.js; read by /api/sniper/experiments.
--
-- Additive and idempotent, safe to re-run.
CREATE TABLE IF NOT EXISTS sniper_llm_verdicts (
	mint        TEXT NOT NULL,
	network     TEXT NOT NULL DEFAULT 'mainnet',
	model       TEXT NOT NULL,
	buy         BOOLEAN NOT NULL,
	confidence  NUMERIC NOT NULL,
	thesis      TEXT,
	latency_ms  INTEGER,
	answered_by TEXT,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (mint, network, model)
);

CREATE INDEX IF NOT EXISTS sniper_llm_verdicts_model_time
	ON sniper_llm_verdicts (network, model, created_at DESC);
