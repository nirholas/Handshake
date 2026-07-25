-- x402 payment provenance on forge creations.
--
-- Paid generations through POST /api/x402/forge historically produced a GLB for
-- the buyer but never landed in forge_creations, so the community gallery showed
-- none of the agent-economy output and a settled payment left no artifact trail.
-- The endpoint now records one creation row per settled generation; these three
-- columns carry the receipt: who paid, the on-chain settle signature, and the
-- price. A populated x402_tx_sig is what the gallery renders as the
-- "paid via x402" provenance badge (Solscan-linkable).
--
-- All three stay NULL for every non-x402 lane.

ALTER TABLE forge_creations ADD COLUMN IF NOT EXISTS x402_payer text;
ALTER TABLE forge_creations ADD COLUMN IF NOT EXISTS x402_tx_sig text;
ALTER TABLE forge_creations ADD COLUMN IF NOT EXISTS x402_price_atomic bigint;

-- The gallery filters/badges on "is an x402 creation"; a partial index keeps the
-- predicate cheap without taxing the (much larger) non-x402 corpus.
CREATE INDEX IF NOT EXISTS forge_creations_x402_idx
	ON forge_creations (created_at DESC)
	WHERE x402_tx_sig IS NOT NULL;
