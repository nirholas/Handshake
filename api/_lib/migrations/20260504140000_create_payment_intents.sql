-- Up
CREATE TABLE agent_payment_intents (
  id VARCHAR(32) PRIMARY KEY, -- e.g., pi_xxxxxxxx
  payer_user_id UUID NOT NULL REFERENCES users(id),
  agent_id UUID NOT NULL REFERENCES agent_identities(id),
  currency_mint VARCHAR(44) NOT NULL,
  amount BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, successful, failed
  expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_payment_intents_on_payer ON agent_payment_intents(payer_user_id);
CREATE INDEX idx_agent_payment_intents_on_status ON agent_payment_intents(status);

-- Down
DROP TABLE agent_payment_intents;
