-- Payment receipt on oracle intel signals.
--
-- Every row in oracle_intel_signals is bought: the x402 autonomous loop pays a
-- real USDC settle for the intel call that produced it. The settle signature
-- was recorded in x402_autonomous_log but never carried onto the signal row,
-- so the sniper's oracle gate could act on a paid signal without being able to
-- cite the payment. This column closes the provenance chain:
-- paid call (tx_signature) -> signal row -> gate adjustment -> trade decision.

ALTER TABLE oracle_intel_signals ADD COLUMN IF NOT EXISTS tx_signature text;
