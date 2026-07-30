-- master_wallets: the platform-custodied EVM + Solana keypair attached to a user
-- account (api/user/wallet/*). One row per user, holding the encrypted secrets
-- that fund agents, pay x402 invoices, buy skills, and send tips.
--
-- Why this migration exists. The table had no canonical definition: it was
-- created at runtime by a CREATE TABLE IF NOT EXISTS inside the POST handler in
-- api/user/wallet/index.js, which is the ONE handler of the four that touches it.
-- api/user/wallet/history.js, send.js, and fund-agent.js all SELECT from it
-- directly, so until some user happened to POST the create endpoint first, those
-- three returned SQLSTATE 42P01 (relation does not exist) as a generic HTTP 500
-- with a Sentry event, instead of their designed "no wallet yet" responses
-- (an empty history list, or 404 master wallet not set up). Verified against
-- production on 2026-07-30: the table did not exist, and
-- GET /api/user/wallet/history returned 500 / 42P01 for a signed-in user.
-- Bootstrapping custody schema from a request path also meant the one table
-- where shape drift is least acceptable had no reviewed shape at all.
--
-- The FK is the shape the runtime bootstrap never had. ON DELETE CASCADE matches
-- agent_identities_user_id_fkey, which governs the same class of custodial key
-- material, so account deletion behaves identically for master and agent wallets.
-- user_id is UNIQUE (one wallet per user, which the create path already assumed
-- when it treated an existing row as idempotent success), and that unique index
-- also serves every read here, since all four handlers look up WHERE user_id = $1.

CREATE TABLE IF NOT EXISTS master_wallets (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    solana_address          text,
    encrypted_solana_secret text,
    evm_address             text,
    encrypted_evm_key       text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE master_wallets IS
    'Per-user platform-custodied master wallet (Solana + EVM). Secrets are '
    'AES-256-GCM secret-box ciphertexts (api/_lib/secret-box.js), never plaintext.';

-- Convergence for any environment that ran the old lazy bootstrap first: that
-- version created the same columns with no foreign key and so is byte-compatible
-- but constraint-poor. The clauses below bring it up to the definition above and
-- are no-ops on a table freshly created by this file.
DO $$
DECLARE
    user_id_attnum smallint;
BEGIN
    SELECT attnum INTO user_id_attnum
    FROM pg_attribute
    WHERE attrelid = 'master_wallets'::regclass AND attname = 'user_id';

    -- One wallet per user. Added before the FK so a legacy duplicate surfaces
    -- here, where the implicit transaction rolls the whole file back, rather
    -- than corrupting the idempotency the create path relies on.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'master_wallets'::regclass
          AND contype IN ('u', 'p')
          AND conkey = ARRAY[user_id_attnum]
    ) THEN
        ALTER TABLE master_wallets ADD CONSTRAINT master_wallets_user_id_key UNIQUE (user_id);
    END IF;

    -- NOT VALID: a pre-existing row whose user was already hard-deleted must not
    -- block the migration. Postgres still enforces the FK on every new write,
    -- and the constraint can be validated later once such rows are reconciled.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'master_wallets'::regclass
          AND contype = 'f'
          AND conkey = ARRAY[user_id_attnum]
    ) THEN
        ALTER TABLE master_wallets
            ADD CONSTRAINT master_wallets_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
    END IF;
END $$;
