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
-- Scoping the constraint: by MARKER, not by TIME.
--
-- The obvious approach — fence the index to "rows after the fix ships" — is
-- wrong, because the migration cannot know when the deploy actually lands. A
-- timestamp guessed at authoring time either demotes legitimate pre-fix rows
-- (rewriting a published audit trail: the 59,307 figure is public) or leaves a
-- gap. Instead the credit gate stamps every row it arbitrates with
-- credit_gated = true, and the unique index covers only those rows. History is
-- untouched by construction, the constraint takes effect exactly when the new
-- code starts serving, and applying this migration early or late is harmless.

ALTER TABLE x402_self_facilitator_log
	ADD COLUMN IF NOT EXISTS credit_gated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN x402_self_facilitator_log.credit_gated IS
	'True when this row was arbitrated by settle-credit.js (one credit per tx_sig). '
	'Rows predating that gate are false and are excluded from the uniqueness constraint.';

-- The race-proof arbiter behind settle-credit.js: the credit INSERT runs
-- ON CONFLICT DO NOTHING against this index, so of any set of concurrent settles
-- sharing a signature exactly one is credited.
CREATE UNIQUE INDEX IF NOT EXISTS x402_self_fac_settle_sig_unique
	ON x402_self_facilitator_log (tx_sig)
	WHERE action = 'settle' AND ok = true AND credit_gated = true AND tx_sig IS NOT NULL;

-- The audit pipeline's hot query: duplicates among gated rows.
CREATE INDEX IF NOT EXISTS x402_self_fac_settle_gated_sig
	ON x402_self_facilitator_log (tx_sig)
	WHERE action = 'settle' AND credit_gated = true;
