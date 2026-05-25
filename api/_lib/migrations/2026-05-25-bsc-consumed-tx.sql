-- Migration: anti-replay set for x402 direct payments on BSC.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-05-25-bsc-consumed-tx.sql
-- Idempotent.
--
-- Each successfully verified BSC payment tx is recorded so a replay across
-- Vercel cold starts or function replicas can't unlock the same resource
-- twice. The on-chain Payment(payer, amount, ref) event is uniquely keyed by
-- tx_hash; the table's PRIMARY KEY enforces single-consumption.

CREATE TABLE IF NOT EXISTS bsc_consumed_tx (
    tx_hash      text        PRIMARY KEY,
    ref          text,
    payer        text,
    amount       numeric,
    pay_to       text,
    consumed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bsc_consumed_tx_consumed_at
    ON bsc_consumed_tx (consumed_at);
