-- AWS Marketplace customer subscriptions.
-- customer_identifier is the stable ID returned by ResolveCustomer.
-- user_id is set once the customer completes registration on three.ws.

CREATE TABLE aws_marketplace_customers (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_identifier     TEXT        NOT NULL UNIQUE,
  product_code            TEXT        NOT NULL,
  customer_aws_account_id TEXT,
  user_id                 UUID        REFERENCES users(id) ON DELETE SET NULL,

  -- Lifecycle
  subscription_status     TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (subscription_status IN ('pending', 'active', 'trial', 'cancelled', 'expired')),
  is_free_trial           BOOLEAN     NOT NULL DEFAULT false,
  offer_id                TEXT,

  subscribed_at           TIMESTAMPTZ,
  trial_ends_at           TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX aws_marketplace_customers_user_id_idx
  ON aws_marketplace_customers (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX aws_marketplace_customers_status_idx
  ON aws_marketplace_customers (subscription_status);

-- Metering records — each successful MeterUsage call is stored for audit.
CREATE TABLE aws_marketplace_metering (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_identifier  TEXT        NOT NULL REFERENCES aws_marketplace_customers(customer_identifier) ON DELETE CASCADE,
  dimension            TEXT        NOT NULL,
  quantity             INTEGER     NOT NULL CHECK (quantity > 0),
  metering_record_id   TEXT        UNIQUE,          -- AWS-returned record ID
  usage_allocation_id  TEXT,
  reported_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX aws_marketplace_metering_customer_idx
  ON aws_marketplace_metering (customer_identifier);
