-- 20260729140000_x402_spent_payments.sql
--
-- Durable spent-payment record for paid x402 routes.
--
-- The always-on replay guard in api/_lib/x402-paid-endpoint.js keys on the
-- hashed X-PAYMENT proof (`proof:<paymentHash>`) but lives ONLY in the
-- idempotency cache, whose entries expire with the endpoint's
-- X402_PAYMENT_IDENTIFIER_TTL. Once that TTL lapses, a captured X-PAYMENT
-- header re-enters the handler and re-runs its side effects: the good is
-- re-delivered even though the flow settles at most once on-chain (the
-- settle-credit gate, migration 20260729000000, covers the money leg only).
--
-- This table is the leg the cache cannot cover: one row per payment proof that
-- has already been honoured, keyed on the proof hash so the check is a single
-- indexed lookup and the claim is a single atomic
-- `INSERT … ON CONFLICT DO NOTHING RETURNING` — the same race-proof arbiter
-- shape used by settle-credit.js. A conflict means "this exact signed proof
-- already bought this good", i.e. a replay, and the response is refused.
--
-- Columns are deliberately minimal: the proof hash is the identity, `endpoint`
-- and `amount_atomics` exist so an operator reading the table can tell WHAT was
-- bought and for how much without joining the audit ledger, and `created_at`
-- drives retention. No payer address, header, or payload is stored — the hash
-- is one-way, so this table cannot be mined for payment material.
--
-- Retention: api/cron/db-retention.js prunes rows past 90 days on a FIXED
-- window (it is deliberately exempt from the storage-pressure valve — shrinking
-- this window is exactly what re-opens the replay hole it closes).

CREATE TABLE IF NOT EXISTS x402_spent_payments (
	payment_hash   text        PRIMARY KEY,
	endpoint       text        NOT NULL,
	amount_atomics text,
	created_at     timestamptz NOT NULL DEFAULT now()
);

-- Retention scans by age, never by hash.
CREATE INDEX IF NOT EXISTS x402_spent_payments_created_at_idx
	ON x402_spent_payments (created_at);
