-- 20260728120000_x402_fee_payer_column.sql
--
-- The wallet fee governor meters daily SOL fee burn PER FEE-PAYING WALLET
-- (api/_lib/x402/wallet-fee-meter.js). The facilitator log only recorded the
-- buyer (`payer`), which equals the fee wallet in self-pay mode but not in
-- sponsor mode, where the sponsor/master pays. Record the wallet that actually
-- burned the fee so the meter sums the right ledger.
--
-- Nullable + additive: rows written before this deploy simply have no
-- attribution, and the meter treats an unknown spend as fail-open.

ALTER TABLE x402_self_facilitator_log ADD COLUMN IF NOT EXISTS fee_payer text;

-- The meter's hot query: today's summed fee_lamports for one fee wallet over
-- successful settles.
CREATE INDEX IF NOT EXISTS x402_self_fac_log_fee_payer_settle
	ON x402_self_facilitator_log (fee_payer, ts DESC)
	WHERE action = 'settle' AND ok = true;
