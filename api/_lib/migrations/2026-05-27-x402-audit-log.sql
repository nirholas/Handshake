-- x402 payment audit log — durable ledger of every payment event.
-- Covers settlements, failures, SIWX grants/accesses, and access-control bypasses.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS x402_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,          -- 'payment_settled', 'payment_failed', 'siwx_grant', 'siwx_access', 'bypass_granted'
  route TEXT NOT NULL,
  resource_url TEXT,
  payer TEXT,                        -- wallet address
  network TEXT,
  amount_atomics TEXT,
  asset TEXT,
  tx_hash TEXT,
  settlement_status TEXT,            -- 'success', 'failed'
  facilitator_response JSONB,
  duration_ms INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_x402_audit_route ON x402_audit_log(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x402_audit_payer ON x402_audit_log(payer, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x402_audit_type ON x402_audit_log(event_type, created_at DESC);
