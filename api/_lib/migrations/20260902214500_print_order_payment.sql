begin;

-- Materialize checkout: what an order was charged, and how we proved it.
--
-- The fulfillment migration landed everything about producing a print and
-- nothing about paying for one, because payment came later. It comes now, and
-- both lanes settle into these same columns:
--
--   * the human lane (POST /api/print/orders) quotes a Solana Pay intent. The
--     order carries the reference pubkey it asked the buyer to attach, and the
--     confirm step finds the transaction BY that reference and validates it
--     moved the right USDC to the right wallet. The reference is what makes a
--     payment attributable to one order without trusting anything the client says.
--   * the agent lane (POST /api/x402/print-order) settles through x402 before
--     the order row exists, so it arrives with a settled signature and no
--     reference. Nullable on purpose: only one of the two paths issues one.
--
-- quote_expires_at is the signed quote token's own expiry, copied out of the
-- token so the operator console and the expiry sweep can see a stale unpaid
-- order without decoding an HMAC.

alter table print_orders
    add column if not exists payment_reference       text,
    add column if not exists payment_signature       text,
    add column if not exists payment_chain           text,
    add column if not exists payment_amount_atomics  bigint,
    add column if not exists paid_at                 timestamptz,
    add column if not exists quote_expires_at        timestamptz;

-- One order per reference. A reference is a freshly generated keypair's public
-- key, so a collision means a bug or a replay, and either should fail loudly at
-- insert rather than quietly attach a second order to someone else's payment.
create unique index if not exists print_orders_payment_reference_uniq
    on print_orders (payment_reference)
    where payment_reference is not null;

-- Settling the same transaction against two orders is the double-credit bug.
-- The database refuses it outright rather than relying on every caller checking.
create unique index if not exists print_orders_payment_signature_uniq
    on print_orders (payment_signature)
    where payment_signature is not null;

-- The unpaid-quote sweep's working set: orders still waiting on a buyer, oldest
-- first, so an expired intent can be closed without scanning the whole table.
create index if not exists print_orders_awaiting_payment_idx
    on print_orders (quote_expires_at)
    where status in ('created', 'quoted');

commit;
