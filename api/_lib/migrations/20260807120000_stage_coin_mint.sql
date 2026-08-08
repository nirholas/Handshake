-- Plaza stages (F17): bind a Living Stage to the /play coin world whose plaza it
-- stands in.
--
-- The stage's id is already derived from the mint (uuidv5, see
-- multiplayer/src/plaza-stage.js), so this column stores no new authority, it
-- records the binding in a readable, queryable form so the /stage directory can
-- link a show back to the world you can walk into, and so a plaza claim can be
-- verified against the row it is about to write.
ALTER TABLE stages ADD COLUMN IF NOT EXISTS coin_mint TEXT;

CREATE INDEX IF NOT EXISTS stages_coin_mint ON stages (coin_mint) WHERE coin_mint IS NOT NULL;
