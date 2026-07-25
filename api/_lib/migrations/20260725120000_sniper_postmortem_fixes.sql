-- Post-postmortem fixes, from the published fleet audit
-- (three.ws/blog/autonomous-trading-experiment) and its follow-up verification.
--
-- Three findings, three fields:
--
-- 1. "Model overconfidence is real and measurable. Judge verdicts at 0.7
--    confidence were the best band; 0.9-plus verdicts went winless."
--    -> llm_max_confidence: an optional CEILING next to the existing floor. A
--    verdict at or above it is treated as a miscalibrated screamer and skipped.
--    NULL = no ceiling (unchanged behavior).
--
-- 2. "The failover chain answering most calls muddied the model-vs-model
--    comparison." The named-model arms were mostly piloted by fallback models.
--    -> llm_strict_model: when true, a verdict whose answering model was a
--    fallback (model tag 'fallback:*') may be RECORDED for calibration but can
--    never fund a buy. The arm pauses rather than pollutes its own experiment.
--
-- 3. "Dead coins stop squatting on concurrency slots for half an hour." A coin
--    with zero trades is priced by a bonding curve that never moves; the only
--    exit that ever fired on those was the timeout.
--    -> stale_since on the position: the moment its re-quoted value stopped
--    changing while underwater. The position loop exits 'liquidity_decay' once
--    the clock exceeds the fleet threshold, freeing the slot in minutes.
--
-- Additive and idempotent, safe to re-run.

ALTER TABLE agent_sniper_strategies
	ADD COLUMN IF NOT EXISTS llm_max_confidence NUMERIC,
	ADD COLUMN IF NOT EXISTS llm_strict_model   BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agent_sniper_strategies.llm_max_confidence IS
	'Optional confidence CEILING for LLM verdicts. A buy verdict at/above this is skipped as miscalibrated overconfidence (the 0.9+ band went winless in the July 2026 audit). NULL = no ceiling.';
COMMENT ON COLUMN agent_sniper_strategies.llm_strict_model IS
	'When true, a verdict answered by a fallback model (not the arm''s named model) is recorded but can never fund a buy. Keeps the model-vs-model experiment clean.';

ALTER TABLE agent_sniper_positions
	ADD COLUMN IF NOT EXISTS stale_since TIMESTAMPTZ;

COMMENT ON COLUMN agent_sniper_positions.stale_since IS
	'When the position''s re-quoted value stopped changing while underwater (no trades are moving the curve). Cleared on any movement; liquidity_decay exits fire off this clock.';
