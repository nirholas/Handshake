-- trading_journal: give agent_id and position_id their real types.
--
-- The table was created with `agent_id text` and `position_id bigint`, but both
-- writers in workers/agent-sniper/journal.js pass uuids:
-- agent_sniper_strategies.agent_id and agent_sniper_positions.id are uuid
-- columns. Every INSERT therefore died on `invalid input syntax for type
-- bigint`, and because a journal write is deliberately best-effort (a dropped
-- row must never fail a trade) the failure was swallowed as a warning. The
-- table has held zero rows since it was created, across 323 real closed
-- positions.
--
-- The read side failed for the matching reason: /api/sniper/journal scopes rows
-- to the caller through `agent_sniper_strategies.agent_id = trading_journal.agent_id`,
-- which Postgres rejects outright as `operator does not exist: uuid = text`, so
-- the endpoint 500'd on every request rather than returning an empty journal.
--
-- Retyping is safe precisely because nothing ever landed: the USING clauses
-- below run over an empty table. Indexes on both columns are rebuilt by the
-- ALTER.
ALTER TABLE trading_journal
    ALTER COLUMN agent_id TYPE uuid USING nullif(agent_id, '')::uuid,
    ALTER COLUMN position_id TYPE uuid USING nullif(position_id::text, '')::uuid;
