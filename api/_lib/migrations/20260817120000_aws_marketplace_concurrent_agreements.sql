-- AWS Marketplace: Concurrent Agreements re-key.
--
-- AWS made updated integration requirements mandatory for every NEW SaaS
-- product from 2026-06-01. Two consequences for this schema:
--
--   1. ResolveCustomer no longer populates CustomerIdentifier for a new
--      integration. It returns CustomerAWSAccountId + LicenseArn, and LicenseArn
--      is the per-grant identity. Our listing has never been created, so it is a
--      new integration by definition and customer_identifier will arrive NULL.
--   2. Lifecycle notifications moved from the SNS subscription topic to
--      EventBridge agreement/license events, which carry an agreement id and a
--      license ARN rather than a customer identifier.
--
-- Under Concurrent Agreements one AWS account can hold several simultaneous
-- agreements for the same product, so (customer_aws_account_id, product_code) is
-- deliberately NOT unique. license_arn is the unique key; agreement_id is a
-- non-unique correlation key stamped from the agreement events.
--
-- Idempotent.

alter table aws_marketplace_customers
    add column if not exists license_arn  text,
    add column if not exists agreement_id text;

alter table aws_marketplace_customers
    alter column customer_identifier drop not null;

create unique index if not exists aws_marketplace_customers_license_arn_uniq
    on aws_marketplace_customers (license_arn)
    where license_arn is not null;

create index if not exists aws_marketplace_customers_agreement_idx
    on aws_marketplace_customers (agreement_id)
    where agreement_id is not null;

create index if not exists aws_marketplace_customers_aws_account_idx
    on aws_marketplace_customers (customer_aws_account_id, product_code)
    where customer_aws_account_id is not null;

-- The metering audit table pointed at customer_identifier by foreign key, which
-- cannot survive that column going nullable. Point it at the customer row's own
-- primary key instead and keep the old text column for the legacy rows.
alter table aws_marketplace_metering
    add column if not exists customer_row_id uuid
        references aws_marketplace_customers(id) on delete cascade,
    add column if not exists license_arn text;

alter table aws_marketplace_metering
    drop constraint if exists aws_marketplace_metering_customer_identifier_fkey;

alter table aws_marketplace_metering
    alter column customer_identifier drop not null;

update aws_marketplace_metering m
set customer_row_id = c.id
from aws_marketplace_customers c
where m.customer_row_id is null
  and m.customer_identifier is not null
  and c.customer_identifier = m.customer_identifier;

create index if not exists aws_marketplace_metering_customer_row_idx
    on aws_marketplace_metering (customer_row_id)
    where customer_row_id is not null;

-- Reverse lookup for the x402 bridge: subscriptions issued from a marketplace
-- row now carry the row id in meta, because the license ARN is the thing we do
-- not want to spread across JSONB in more places than necessary.
create index if not exists x402_subscriptions_aws_customer_row_idx
    on x402_subscriptions ((meta->>'aws_customer_row_id'))
    where meta ? 'aws_customer_row_id';
