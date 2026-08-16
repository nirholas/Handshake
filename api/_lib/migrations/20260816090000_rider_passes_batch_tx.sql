-- rider_passes: drop the standalone UNIQUE on tx_signature.
--
-- One Solana transaction can carry $THREE into the rider vault from more than
-- one wallet (a batch or aggregator transfer). Both senders earn a pass, and
-- both rows legitimately share that transaction's signature, so the unique index
-- made the second insert fail. That surfaced as a 500 from /api/rider/webhook,
-- which Helius retries: an endless redelivery loop that rewrote the first
-- payer's row on every attempt and never granted the second payer anything.
--
-- Replay idempotency does not depend on this index. The wallet_address primary
-- key already collapses a redelivered payload into the same upsert. The plain
-- index that replaces it keeps signature lookups (support, reconciliation) fast.

begin;

alter table rider_passes drop constraint if exists rider_passes_tx_signature_key;
create index if not exists rider_passes_tx_signature_idx on rider_passes (tx_signature);

commit;
