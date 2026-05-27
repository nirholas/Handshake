-- Marketplace: paid avatars / agents / plugins (and any future asset kind).
--
-- Skills already have their own price + purchase tables (agent_skill_prices,
-- skill_purchases) and a confirmed Solana Pay flow. This migration generalises
-- the same pattern to *whole assets* — let any owner attach a price to an
-- avatar, agent identity, or plugin and let buyers pay USDC for access.
--
-- Pre-existing rows in avatars / agent_identities / plugins are NOT mirrored
-- here, which is exactly what we want: absent listing == free. New paid
-- listings are explicit, owner-driven inserts.

-- ── asset_prices ────────────────────────────────────────────────────────────
-- One row per (item_type, item_id). Soft-deactivate via is_active=false
-- rather than DELETE so we keep history for analytics / receipts.
CREATE TABLE IF NOT EXISTS asset_prices (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type       text         NOT NULL CHECK (item_type IN ('avatar', 'agent', 'plugin')),
    item_id         uuid         NOT NULL,
    owner_user_id   uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount          bigint       NOT NULL CHECK (amount >= 0),  -- in smallest unit (e.g. USDC = 6 decimals)
    currency_mint   text         NOT NULL,                       -- SPL mint address or 'native' for ETH/SOL
    chain           text         NOT NULL DEFAULT 'solana',
    mint_decimals   int          NOT NULL DEFAULT 6,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- One row per (item_type, item_id). Deactivation flips is_active rather than
-- deleting, so the same row gets re-used when a seller re-lists.
CREATE UNIQUE INDEX IF NOT EXISTS asset_prices_item_unique
    ON asset_prices(item_type, item_id);

CREATE INDEX IF NOT EXISTS asset_prices_owner
    ON asset_prices(owner_user_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS asset_prices_kind_active
    ON asset_prices(item_type, is_active);

-- ── asset_purchases ─────────────────────────────────────────────────────────
-- One row per (buyer, item) purchase attempt. Lives separately from
-- skill_purchases so the skill flow stays untouched.
CREATE TABLE IF NOT EXISTS asset_purchases (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_user_id      uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type          text          NOT NULL CHECK (item_type IN ('avatar', 'agent', 'plugin')),
    item_id            uuid          NOT NULL,
    seller_user_id     uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status             text          NOT NULL DEFAULT 'pending'
                                           CHECK (status IN ('pending', 'confirmed', 'expired', 'tipped', 'refunded')),
    reference          text          NOT NULL UNIQUE,
    amount             bigint        NOT NULL CHECK (amount >= 0),
    currency_mint      text          NOT NULL,
    chain              text          NOT NULL DEFAULT 'solana',
    tx_signature       text          UNIQUE,
    payout_address     text          NOT NULL,
    expires_at         timestamptz   NOT NULL,
    confirmed_at       timestamptz,
    referrer_user_id   uuid          REFERENCES users(id) ON DELETE SET NULL,
    metadata           jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_purchases_buyer
    ON asset_purchases(buyer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS asset_purchases_seller
    ON asset_purchases(seller_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS asset_purchases_item
    ON asset_purchases(item_type, item_id, status);

CREATE INDEX IF NOT EXISTS asset_purchases_pending_expiry
    ON asset_purchases(expires_at) WHERE status = 'pending';

-- ── asset_purchase_receipts ─────────────────────────────────────────────────
-- HMAC-signed receipt per confirmed purchase, mirroring purchase_receipts for
-- skill sales. Stored once at confirm time so buyers can verify the trade
-- happened without re-querying the chain.
CREATE TABLE IF NOT EXISTS asset_purchase_receipts (
    id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id  uuid         NOT NULL UNIQUE REFERENCES asset_purchases(id) ON DELETE CASCADE,
    receipt_json jsonb        NOT NULL,
    signature    text         NOT NULL,
    created_at   timestamptz  NOT NULL DEFAULT now()
);
