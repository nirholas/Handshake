-- threews.sol subdomain claims.
--
-- Each row records that user_id owns the on-chain subdomain
-- `<label>.<parent>.sol` (parent = 'threews' for the platform-owned root).
-- The on-chain SNS registry is the source of truth for ownership; this table
-- exists so we can do fast availability checks, drive the /u/:label showcase
-- without hitting the RPC, and bind a subdomain back to a app user_id.

CREATE TABLE IF NOT EXISTS user_subdomains (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label           text          NOT NULL CHECK (label ~ '^[a-z0-9-]{1,63}$'),
    parent          text          NOT NULL DEFAULT 'threews',
    owner_wallet    text          NOT NULL,           -- base58 Solana address that owns the subdomain on-chain
    url_record      text,                              -- value set in the SNS URL record (e.g. https://three.ws/u/nich)
    signature       text          NOT NULL,            -- tx signature of the creation
    created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_subdomains_label_parent
    ON user_subdomains(label, parent);

CREATE INDEX IF NOT EXISTS user_subdomains_user
    ON user_subdomains(user_id);

CREATE INDEX IF NOT EXISTS user_subdomains_owner_wallet
    ON user_subdomains(owner_wallet);
