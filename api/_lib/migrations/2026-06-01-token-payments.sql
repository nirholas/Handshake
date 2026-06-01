-- Migration: token_payments — settled $THREE on-chain payments ledger.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-06-01-token-payments.sql
-- Idempotent.
--
-- Records every verified token payment for the premium-action layer (Task 18),
-- consumed by Task 19 (paid spins) and Task 20 (token-priced listings). One row
-- per settled payment. The UNIQUE constraints on nonce and tx_signature are the
-- source of truth for replay / double-submit protection — a second settle of the
-- same quote or transaction violates them and is surfaced as already_settled.
--
-- No secrets are stored: only public on-chain facts (amounts, destinations via
-- the splits jsonb, tx signature) plus the quoted USD/price for reconciliation.

begin;

create table if not exists token_payments (
    id            uuid primary key default gen_random_uuid(),
    -- Nullable: a payment may originate from a wallet not linked to a user row.
    user_id       uuid references users(id) on delete set null,
    payer_wallet  text,
    -- What the payment unlocked: 'spin', 'marketplace_sale', etc.
    purpose       text not null,
    mint          text not null,
    decimals      int  not null,
    -- Quoted USD amount and the live token price at quote time (for audit/recon).
    usd           numeric(20, 6) not null,
    price_usd     numeric(38, 18) not null,
    -- Total charged, in token atomics (string-safe via numeric).
    total_atomics numeric(40, 0) not null,
    -- Resolved split legs: [{ role, address, bps, atomics }].
    splits        jsonb not null,
    -- Per-quote nonce (also the on-chain memo) and the settled transaction.
    nonce         text not null unique,
    tx_signature  text not null unique,
    network       text not null default 'mainnet',
    slot          bigint,
    -- Optional link back to the spin / listing the payment settled.
    ref_type      text,
    ref_id        text,
    confirmed_at  timestamptz not null default now(),
    created_at    timestamptz not null default now()
);

create index if not exists token_payments_purpose_created
    on token_payments (purpose, created_at desc);

create index if not exists token_payments_user
    on token_payments (user_id, created_at desc);

create index if not exists token_payments_ref
    on token_payments (ref_type, ref_id);

create index if not exists token_payments_payer
    on token_payments (payer_wallet, created_at desc);

commit;
