-- 20260729000000_x402_settle_sig_unique.sql
--
-- One on-chain signature settles AT MOST one payment.
--
-- Measured 2026-07-28: 12,674 of 59,271 ok settle rows (21.4%) shared a tx_sig
-- with another ok row. Sampled transactions on mainnet carry exactly ONE token
-- transfer, yet up to 9 settle rows with 9 distinct idempotency keys were
-- credited against each — deterministic Ed25519 signatures on byte-identical
-- ring payments (same payer/amount/recipient, one shared tick blockhash,
-- colliding fee nonce) let the facilitator's already-processed recovery branch
-- credit later payments off the first one's broadcast.
--
-- This index is the race-proof arbiter behind settle-credit.js: the credit
-- INSERT runs ON CONFLICT DO NOTHING against it, so of any set of concurrent
-- settles sharing a signature exactly one is credited.
--
-- The predicate is time-fenced to the fix's deploy window: history before the
-- cutoff keeps its duplicates (they are real, documented, and analyzed by
-- scripts/x402-milestone-stats.mjs — rewriting them would falsify the audit
-- trail). Any duplicate credited AFTER the cutoff but BEFORE this migration
-- runs is demoted below, keeping the earliest row per signature, so index
-- creation cannot fail regardless of when the migration is applied.

WITH ranked AS (
	SELECT id,
	       ROW_NUMBER() OVER (PARTITION BY tx_sig ORDER BY ts ASC, id ASC) AS rn
	FROM x402_self_facilitator_log
	WHERE action = 'settle' AND ok = true AND tx_sig IS NOT NULL
	  AND ts >= '2026-07-29 00:00:00+00'
)
UPDATE x402_self_facilitator_log l
SET ok = false,
    reject_reason = 'signature_already_settled:migration_backfill'
FROM ranked r
WHERE l.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS x402_self_fac_settle_sig_unique
	ON x402_self_facilitator_log (tx_sig)
	WHERE action = 'settle' AND ok = true AND tx_sig IS NOT NULL
	  AND ts >= '2026-07-29 00:00:00+00';
