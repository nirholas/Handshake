-- Migration: the CZ agent claim ledger backing /api/cz/claim.
--
-- The handler has always required this table, but it only ever existed as a
-- comment at the top of api/cz/claim.js telling a human to "run once before
-- deploy". Nobody ran it, so every real call to the endpoint (GET to mint a
-- nonce, POST to redeem it) died with a 500 on `relation "cz_claims" does not
-- exist` while the malformed-input paths kept returning tidy 400s, which made
-- the surface look healthy from the outside.
--
-- One row per issued nonce. The row is minted `pending` by the GET, and the
-- POST flips it to `claimed` only after the ECDSA signature over
-- "Claim CZ Agent\n\nNonce: <nonce>" recovers to the same address the nonce
-- was issued for. `nonce` is unique so a replay can never resolve to two rows,
-- and the status flip is conditional on `status = 'pending'` in the handler so
-- two concurrent POSTs on one nonce cannot both win.

CREATE TABLE IF NOT EXISTS cz_claims (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    address     TEXT        NOT NULL,              -- lowercased 0x EOA the nonce was issued to
    nonce       TEXT        NOT NULL UNIQUE,       -- 16 random bytes, hex
    status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at  TIMESTAMPTZ
);

-- "has this address already claimed?" and the per-address audit trail.
CREATE INDEX IF NOT EXISTS cz_claims_address_idx ON cz_claims (address);
-- Sweeping expired pending nonces (the handler treats anything older than its
-- TTL as dead) and reading the claim feed newest-first.
CREATE INDEX IF NOT EXISTS cz_claims_created_at_idx ON cz_claims (created_at DESC);
