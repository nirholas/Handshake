-- ERC-8004 validation: remember which on-chain request an attestation answered.
--
-- The deployed ValidationRegistry is request/response based: the agent's owner
-- opens a request (a bytes32 id) naming a validator, and the validator answers
-- that id. Storing the id lets ops (and a re-validation) find the exact request a
-- verdict belongs to without re-deriving it from the GLB bytes, and lets the
-- badge match an index row to the on-chain record it came from.

ALTER TABLE erc8004_agents_index
  ADD COLUMN IF NOT EXISTS validation_request_hash text;
