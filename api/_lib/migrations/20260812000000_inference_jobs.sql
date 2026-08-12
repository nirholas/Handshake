-- Migration: metered inference jobs and their cryptographic settlement
-- receipts (Roadmap phase 4: pay-per-token settlement for inference work).
--
-- Every paid /api/x402/llm-proxy call lands here once: the metered job core
-- (prompt/response hashes + token counts + the node's ed25519 response
-- signature) and, once settlement lands, the signed receipt that ties the
-- payment (network, payer, amount, asset, tx) to that exact job. This is the
-- operator-side audit trail that lets a node operator prove they were paid
-- for exactly the work performed; the buyer-side copy travels on the
-- X-PAYMENT-RESPONSE header and re-verifies offline with
-- scripts/inference-receipt-verify.mjs (spec: specs/inference-receipts.md).

CREATE TABLE IF NOT EXISTS inference_jobs (
    job_id              TEXT PRIMARY KEY,           -- uuid minted per request
    route               TEXT NOT NULL,              -- e.g. '/api/x402/llm-proxy'
    network             TEXT,                       -- CAIP-2 the job settled on
    payer               TEXT,                       -- buyer wallet
    model               TEXT NOT NULL,
    provider            TEXT NOT NULL,              -- lane that ran it (groq, ...)
    prompt_sha256       TEXT NOT NULL,              -- sha256 of the raw prompt
    response_sha256     TEXT NOT NULL,              -- sha256 of the completion text
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    tokens_used         INTEGER NOT NULL DEFAULT 0,
    latency_ms          INTEGER,
    response_signature  TEXT NOT NULL,              -- ed25519 over the job core
    response_signer     TEXT NOT NULL,              -- base58 pubkey of the node
    amount_atomics      TEXT,                       -- price charged (6-dec atomics)
    asset               TEXT,                       -- settlement asset (mint / contract)
    tx_hash             TEXT,                       -- settlement transaction
    receipt             JSONB,                      -- the full signed receipt object
    receipt_signer      TEXT,                       -- base58 pubkey of the issuer
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Operator lookups: "what did wallet X pay me for, and when?"
CREATE INDEX IF NOT EXISTS inference_jobs_payer_idx ON inference_jobs (payer, created_at DESC);
-- Receipt lookup by settlement transaction (dispute resolution).
CREATE INDEX IF NOT EXISTS inference_jobs_tx_idx ON inference_jobs (tx_hash);
