-- Migration: AWS Marketplace ↔ x402 subscription linkage.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260528000000_aws_marketplace_x402_link.sql
-- Idempotent.
--
-- Bridges the AWS Marketplace SaaS listing to the existing x402 bypass
-- infrastructure. When a customer activates their AWS subscription on
-- /aws-marketplace/welcome, we mint a row in x402_subscriptions and store
-- the id here. Their plaintext x402_live_* key is the only artifact the
-- customer sees — it grants bypass on every paid /api/x402/* endpoint.
--
-- Lifecycle:
--   • subscribe-success / register   → issue x402 subscription, link here.
--   • unsubscribe-success / expired  → revoke x402 subscription (sets revoked_at).
--   • entitlement-updated            → no-op for usage products; for contract
--                                      products the rate-limit tier may flip.

alter table aws_marketplace_customers
    add column if not exists x402_subscription_id text
        references x402_subscriptions(id) on delete set null;

create index if not exists aws_marketplace_customers_x402_sub_idx
    on aws_marketplace_customers(x402_subscription_id)
    where x402_subscription_id is not null;

-- Reverse-lookup index for the access-control hook: given a subscription id
-- (which is what x402 access logs and metering callbacks carry), find the
-- AWS customer in O(1) so we can fire MeterUsage with the right CustomerIdentifier.
-- meta->>'aws_customer_identifier' is also written for redundancy when the
-- subscription is created outside this table.
create index if not exists x402_subscriptions_aws_customer_idx
    on x402_subscriptions ((meta->>'aws_customer_identifier'))
    where meta ? 'aws_customer_identifier';
