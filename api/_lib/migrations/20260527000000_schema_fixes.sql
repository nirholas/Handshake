-- Schema fixes for issues surfaced in production logs 2026-05-27.
-- Idempotent: all statements use IF NOT EXISTS / IF EXISTS / TRY patterns.

BEGIN;

-- 1. x_triggers: add agent_id column that was in CREATE TABLE but missing from
--    the ALTER TABLE rollforward, so deployments that already had the table
--    did not receive it.
ALTER TABLE x_triggers ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agent_identities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS x_triggers_agent_id ON x_triggers(agent_id) WHERE enabled;

-- 2. avatar_regen_jobs: make source_avatar_id nullable.
--    The reconstruct flow (build from photos, no source avatar) inserts null
--    here legitimately. The NOT NULL constraint was only valid for regenerate
--    jobs; relax it and let application logic enforce presence when relevant.
ALTER TABLE avatar_regen_jobs ALTER COLUMN source_avatar_id DROP NOT NULL;

COMMIT;
