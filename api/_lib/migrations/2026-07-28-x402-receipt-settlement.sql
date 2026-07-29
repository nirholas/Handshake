-- Migration: record the settlement amount + asset alongside each x402 receipt.
-- Apply: npm run db:migrate -- --apply --file 2026-07-28-x402-receipt-settlement.sql
-- Idempotent.
--
-- The signed receipt artifact follows spec §5.1 and carries no amount, and it
-- omits the transaction hash entirely when the endpoint declares
-- includeTxHash=false (spec §5.2 privacy default). That is correct for the
-- wire, but it left our own durable log unable to answer the buyer's first
-- question: "what did I actually pay for this?"
--
-- These columns hold the settlement facts we already had in hand at issue time
-- (from the verified payment requirement and the facilitator's settle
-- response). They are OUR audit trail, not part of the signed artifact, so the
-- wire format and its privacy properties are unchanged. /api/x402/my-receipts
-- only ever returns them to the wallet that signed for its own receipts.

begin;

alter table x402_receipts add column if not exists amount_atomics text;
alter table x402_receipts add column if not exists asset          text;

commit;
