-- economy_fuel_swaps: the record of every USDC -> SOL auto-refuel the economy
-- master performs to keep the circulation engine funded (api/_lib/economy-fuel.js).
--
-- This table IS the per-UTC-day spend counter that bounds the refuel, so it must
-- exist before the first swap. The module also creates it lazily (CREATE TABLE IF
-- NOT EXISTS) as a safety net for environments where migrations lag, mirroring the
-- circulation_actions / economy ledger pattern; this migration is the canonical
-- definition and keeps db:check honest.

CREATE TABLE IF NOT EXISTS economy_fuel_swaps (
    id            bigserial   PRIMARY KEY,
    day           date        NOT NULL,
    usdc_atomics  bigint      NOT NULL,
    sol_lamports  bigint      NOT NULL,
    price_impact  numeric,
    signature     text,
    network       text        NOT NULL DEFAULT 'mainnet',
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- The daily-cap sum filters on `day`; the cooldown / recent-swaps read orders by
-- created_at. Index both access paths.
CREATE INDEX IF NOT EXISTS economy_fuel_swaps_day_idx ON economy_fuel_swaps (day);
CREATE INDEX IF NOT EXISTS economy_fuel_swaps_created_idx ON economy_fuel_swaps (created_at DESC);
