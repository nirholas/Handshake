-- Rename agent_reviews.review → body to match the reviews API.
-- The CREATE TABLE used "review text" but api/marketplace/reviews.js
-- references the column as "body" throughout. This is the idempotent fix.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_reviews' AND column_name = 'body'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'agent_reviews' AND column_name = 'review'
    ) THEN
      ALTER TABLE agent_reviews RENAME COLUMN review TO body;
    ELSE
      ALTER TABLE agent_reviews ADD COLUMN body text;
    END IF;
  END IF;
END $$;
