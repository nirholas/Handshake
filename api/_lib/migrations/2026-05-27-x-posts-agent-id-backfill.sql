-- Backfill migration: ensure agent_id exists on x_scheduled_posts and
-- x_pending_reviews for tenant DBs created before the column was added.
--
-- Root cause: 2026-05-25-marketplace-and-social-tables.sql creates these
-- tables with agent_id using CREATE TABLE IF NOT EXISTS, which is a no-op
-- when the table already exists from an older deployment. The ALTER TABLE
-- below is the idempotent fix.

ALTER TABLE x_scheduled_posts ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agent_identities(id) ON DELETE SET NULL;
ALTER TABLE x_pending_reviews ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agent_identities(id) ON DELETE SET NULL;
