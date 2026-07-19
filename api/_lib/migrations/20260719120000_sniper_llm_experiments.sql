-- Sniper strategy experiments + LLM-judged decision mode.
--
-- decision_mode: 'rules' (default, the existing scorer/oracle gate chain) or
-- 'llm', the strategy skips the rule shields (mcap band, socials, oracle
-- threshold, creator gates) and asks a model to judge each launch instead. The
-- non-negotiable safety rails (Mayhem exclusion, trade firewall, budgets,
-- concurrency, headroom, spend policy) still apply to BOTH modes at the
-- executeBuy chokepoint.
--
-- label / experiment_group: human-readable identity for the A/B fleet so
-- performance can be compared per rule set ("which conditions actually win?")
-- rather than per anonymous strategy id. Read by /api/sniper/experiments.
--
-- Additive and idempotent, safe to re-run.
ALTER TABLE agent_sniper_strategies
	ADD COLUMN IF NOT EXISTS decision_mode      TEXT NOT NULL DEFAULT 'rules',
	ADD COLUMN IF NOT EXISTS llm_model          TEXT,
	ADD COLUMN IF NOT EXISTS llm_min_confidence NUMERIC,
	ADD COLUMN IF NOT EXISTS label              TEXT,
	ADD COLUMN IF NOT EXISTS experiment_group   TEXT;
