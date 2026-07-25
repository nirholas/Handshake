-- Earned autonomy: an arm's tier, recorded next to the tuning it drove.
--
-- The autonomy engine (api/_lib/sniper-autonomy.js) classifies every arm from its
-- own realized record on each optimizer run: probation | standard | trusted |
-- autonomous. The tier decides how wide the optimizer's bounds are, how big its
-- per-run step is, which fields it may write at all, how much of the fleet budget
-- the evolution loop concentrates on the arm, and how much evidence the LLM judge
-- is handed before it rules on a launch.
--
-- Storing the tier on each run makes the whole progression auditable after the
-- fact: you can see exactly which tier an arm held when a given knob moved, and
-- watch an arm earn its way up (or fall back) over time.
--
-- Additive and idempotent, safe to re-run.

ALTER TABLE agent_sniper_optimizer_runs
	ADD COLUMN IF NOT EXISTS autonomy_tier   TEXT,
	ADD COLUMN IF NOT EXISTS autonomy_reason TEXT;

COMMENT ON COLUMN agent_sniper_optimizer_runs.autonomy_tier IS
	'Earned-autonomy tier this run was decided under: probation | standard | trusted | autonomous.';
COMMENT ON COLUMN agent_sniper_optimizer_runs.autonomy_reason IS
	'Human-readable evidence for the tier (realized sample, net PnL, average edge).';

CREATE INDEX IF NOT EXISTS idx_sniper_optimizer_runs_tier
	ON agent_sniper_optimizer_runs (autonomy_tier, created_at DESC);
