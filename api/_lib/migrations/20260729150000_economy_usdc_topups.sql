-- economy_usdc_topups: the record of every direct USDC transfer the economy
-- master makes to a USDC-spending engine wallet (api/_lib/economy-usdc-topup.js).
--
-- The rebalancer refills a payer by swapping the payer's OWN SOL for USDC, which
-- cannot help a payer that is short of both assets: on 2026-07-28 the x402 ring
-- payer sat at ~3 USDC against a $10 floor (and the a2a payer at 0) while the
-- master idled on 48 USDC, so every $10 ring-settle leg failed with an SPL
-- insufficient-funds error one hop from the money. This table IS the per-UTC-day
-- spend counter that bounds the direct topup, so it must exist before the first
-- transfer. The module also creates it lazily (CREATE TABLE IF NOT EXISTS) as a
-- safety net for environments where migrations lag, mirroring economy_fuel_swaps;
-- this migration is the canonical definition and keeps db:check honest.

CREATE TABLE IF NOT EXISTS economy_usdc_topups (
    id             bigserial   PRIMARY KEY,
    day            date        NOT NULL,
    recipient      text        NOT NULL,
    recipient_name text,
    usdc_atomics   bigint      NOT NULL,
    signature      text,
    network        text        NOT NULL DEFAULT 'mainnet',
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The daily-cap sum filters on `day`; the cooldown read takes MAX(created_at).
CREATE INDEX IF NOT EXISTS economy_usdc_topups_day_idx ON economy_usdc_topups (day);
CREATE INDEX IF NOT EXISTS economy_usdc_topups_created_idx ON economy_usdc_topups (created_at DESC);
