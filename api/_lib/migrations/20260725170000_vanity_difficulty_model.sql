-- Record which difficulty model priced each inventory row.
--
-- The Base58 leading character is not uniform (2^256/58^43 ≈ 17.05 means a
-- 44-digit encoding can only lead with the first 17 symbols), so the original
-- 58^n model mis-stated the work behind every address in the book: the median
-- live SKU was ~17x harder to grind than its stored difficulty claimed, and
-- prefixes leading with '2'-'H' were up to 1.75x easier.
--
-- Repricing under the corrected model changes rarity_bits, rarity_tier,
-- rarity_score and price_usd. Stamping the model that produced those numbers
-- keeps the book self-describing: a row priced under the old model is
-- distinguishable from one priced under the new one, so a partially-migrated
-- book is detectable rather than silently inconsistent.
--
-- Sold and destroyed rows keep their historical numbers and their v1 stamp:
-- the price a buyer actually paid is a fact about the past, not a value to
-- recompute.

ALTER TABLE vanity_inventory
	ADD COLUMN IF NOT EXISTS difficulty_model text NOT NULL DEFAULT '58^effectiveLength';

COMMENT ON COLUMN vanity_inventory.difficulty_model IS
	'Difficulty model id the rarity/price columns were computed under: 58^effectiveLength (v1, uniform 1/58 per character) or base58-exact/v2 (exact positional distribution).';

CREATE INDEX IF NOT EXISTS vanity_inventory_difficulty_model_idx
	ON vanity_inventory (difficulty_model)
	WHERE status = 'available';
