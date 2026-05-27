-- Migration to create the skill_purchases table

CREATE TABLE "skill_purchases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id"),
  "agent_id" uuid NOT NULL REFERENCES "agent_identities" ("id"),
  "skill_name" varchar(255) NOT NULL,
  "transaction_signature" varchar(255) UNIQUE NOT NULL,
  "amount" bigint NOT NULL,
  "currency_mint" varchar(255) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_skill_purchases_user_id" ON "skill_purchases" ("user_id");
CREATE INDEX "idx_skill_purchases_agent_id" ON "skill_purchases" ("agent_id");
