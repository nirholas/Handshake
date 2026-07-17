-- x402 ring payer-wallet POOL — a reused set of custodial payer wallets the ring
-- tick rotates through so the closed-loop economy has many distinct, attributed
-- payers instead of one seed wallet, at NO extra per-settle cost.
--
-- Why a pool (vs. throwaway wallets per call): a fresh wallet per settle would add
-- a funding hop + a one-time USDC-ATA rent (~0.00204 SOL ≈ $0.15) EVERY call, and
-- would still be trivially clusterable on-chain (all funded from one float). A
-- REUSED pool pays that rent ONCE per wallet, keeps the settle on the 1-signature
-- self-pay hot path (1 tx/settle), and — because the wallets are the least-recently
-- -used-first rotation — produces effectively unlimited distinct-payer sequences
-- from a few hundred wallets. See docs/x402-ring-economy.md ("Payer pool").
--
-- Membership: each pool pubkey is ALSO written to x402_ring_wallets(role='pool') by
-- the generator, so ringAllowedAddresses() (the controlled-wallet set) and the
-- on-chain leak scanner classify every pool wallet as INTERNAL automatically, and
-- the facilitator allowlist accepts settlements from them. Pool wallets are
-- deliberately NOT in api/_lib/solana-signers.js, so the economy master's
-- treasury-sweepback never enumerates (and never closes the ATAs of) 1,000 wallets.
--
-- Secrets: unlike the three env-held role wallets, a 500–1,000-wallet pool cannot
-- live in env vars — each secret is stored here encrypted with the same
-- secret-box scheme (WALLET_ENCRYPTION_KEY + random per-record salt) used for
-- custodial agent wallets. The plaintext key never leaves the process.

CREATE TABLE IF NOT EXISTS x402_ring_pool (
	pubkey            text PRIMARY KEY,
	encrypted_secret  text NOT NULL,                        -- secret-box ciphertext (never plaintext)
	enabled           boolean NOT NULL DEFAULT true,
	last_used_at      timestamptz,                          -- LRU rotation cursor; NULL = never used
	use_count         bigint NOT NULL DEFAULT 0,
	created_at        timestamptz NOT NULL DEFAULT now()
);

-- The rotation claim orders by (last_used_at NULLS FIRST, pubkey): never-used
-- wallets first, then the stalest. This index makes that ORDER BY … LIMIT 1 an
-- index scan even at 1,000+ rows.
CREATE INDEX IF NOT EXISTS x402_ring_pool_rotation
	ON x402_ring_pool (enabled, last_used_at NULLS FIRST, pubkey);

COMMENT ON TABLE x402_ring_pool IS
	'Reused custodial payer wallets the ring tick rotates through (LRU). Pubkeys mirrored into x402_ring_wallets(role=pool). Secrets secret-box-encrypted. Not in solana-signers.js so sweepback never touches them.';
