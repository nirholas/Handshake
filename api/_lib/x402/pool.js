// x402 ring payer-wallet POOL — a reused set of custodial payer wallets the ring
// tick rotates through so the closed-loop economy presents many distinct,
// attributed payers instead of one seed wallet, at NO extra per-settle cost.
//
// Design (see docs/x402-ring-economy.md "Payer pool"):
//   • REUSED, not throwaway. A fresh wallet per call would add a funding hop plus
//     ~0.00204 SOL of USDC-ATA rent EVERY settle and still cluster on-chain to the
//     one float that funds them. A reused pool pays that rent once per wallet, keeps
//     the settle on the 1-signature self-pay hot path, and rotates least-recently-
//     used-first so a few hundred wallets yield unlimited distinct-payer sequences.
//   • Membership is automatic. generatePoolWallets() mirrors every pubkey into
//     x402_ring_wallets(role='pool'), so ringAllowedAddresses() (the controlled
//     set), the on-chain leak scanner (classifies them INTERNAL), and the
//     facilitator allowlist all pick them up with no extra wiring.
//   • Sweepback-safe by construction. Pool wallets are NOT in solana-signers.js, so
//     the excess-mode treasury-sweepback never enumerates them — the exact bug that
//     was closing the treasury's USDC ATA and churning ~2.04M lamports of rent per
//     settle cannot recur across 1,000 pool wallets.
//   • Secrets never live in env. Each key is secret-box-encrypted at rest
//     (WALLET_ENCRYPTION_KEY + random per-record salt), decrypted only in-process
//     for the moment it signs.

import { Keypair } from '@solana/web3.js';
import { encryptSecret, decryptSecret } from '../secret-box.js';
import { sql as defaultSql } from '../db.js';
import { logger } from '../usage.js';

const log = logger('x402-ring-pool');

/** True when the ring should rotate through the payer pool. Off by default. */
export function ringPoolEnabled() {
	return String(process.env.X402_RING_POOL_ENABLED || '').trim().toLowerCase() === 'true';
}

/** Target pool size (number of reused payer wallets). 0 disables growth. */
export function ringPoolTargetSize() {
	const n = Number(process.env.X402_RING_POOL_SIZE || 0);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Hard cap on how many wallets a single generate call will mint — a runaway-loop
 * backstop far above any real target. Env-tunable for an unusually large pool.
 */
export function ringPoolMaxGenerate() {
	const n = Number(process.env.X402_RING_POOL_MAX_GENERATE || 2000);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

let _schemaReady = false;
/** Idempotent DDL guard (mirrors the migration; keeps standalone runs self-sufficient). */
export async function ensurePoolSchema(sql = defaultSql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS x402_ring_pool (
			pubkey            text PRIMARY KEY,
			encrypted_secret  text NOT NULL,
			enabled           boolean NOT NULL DEFAULT true,
			last_used_at      timestamptz,
			use_count         bigint NOT NULL DEFAULT 0,
			created_at        timestamptz NOT NULL DEFAULT now()
		)`;
	await sql`CREATE INDEX IF NOT EXISTS x402_ring_pool_rotation
		ON x402_ring_pool (enabled, last_used_at NULLS FIRST, pubkey)`;
	_schemaReady = true;
}

/** Count of enabled pool wallets. */
export async function poolCount(sql = defaultSql) {
	await ensurePoolSchema(sql);
	const rows = await sql`SELECT count(*)::int AS n FROM x402_ring_pool WHERE enabled = true`;
	return rows[0]?.n ?? 0;
}

/** All enabled pool pubkeys (for the funding pipeline's batched balance reads). */
export async function listEnabledPubkeys(sql = defaultSql) {
	await ensurePoolSchema(sql);
	const rows = await sql`SELECT pubkey FROM x402_ring_pool WHERE enabled = true ORDER BY pubkey`;
	return rows.map((r) => r.pubkey);
}

/** Recover a single pool keypair by pubkey (used by the funding pipeline to sweep an overfull wallet). */
export async function recoverPoolKeypair(pubkey, sql = defaultSql) {
	await ensurePoolSchema(sql);
	const rows = await sql`SELECT encrypted_secret FROM x402_ring_pool WHERE pubkey = ${pubkey} AND enabled = true LIMIT 1`;
	if (!rows[0]?.encrypted_secret) return null;
	return decodeKeypair(await decryptSecret(rows[0].encrypted_secret));
}

// Decode a base64-encoded 64-byte secret key into a Keypair.
function decodeKeypair(secretB64) {
	const raw = Buffer.from(secretB64, 'base64');
	if (raw.length !== 64) throw new Error(`pool key decode: expected 64 bytes, got ${raw.length}`);
	return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Generate `count` NEW pool wallets, encrypt each secret at rest, insert them into
 * x402_ring_pool, and mirror each pubkey into x402_ring_wallets(role='pool') so it
 * joins the controlled set immediately. Idempotent per pubkey (fresh keypairs never
 * collide, but the upsert is ON CONFLICT-safe). Returns the created pubkeys.
 *
 * @param {{ count:number, sql?:Function }} args
 */
export async function generatePoolWallets({ count, sql = defaultSql } = {}) {
	const n = Math.max(0, Math.min(Math.floor(Number(count) || 0), ringPoolMaxGenerate()));
	if (n === 0) return { created: [], total: await poolCount(sql) };
	await ensurePoolSchema(sql);

	const created = [];
	for (let i = 0; i < n; i++) {
		const kp = Keypair.generate();
		const pubkey = kp.publicKey.toBase58();
		const encrypted = await encryptSecret(Buffer.from(kp.secretKey).toString('base64'));
		// Insert the pool row and register membership in ONE round-trip pair. Both are
		// ON CONFLICT DO NOTHING so a re-run never duplicates or overwrites a wallet.
		await sql`
			INSERT INTO x402_ring_pool (pubkey, encrypted_secret)
			VALUES (${pubkey}, ${encrypted})
			ON CONFLICT (pubkey) DO NOTHING`;
		await sql`
			INSERT INTO x402_ring_wallets (pubkey, label, role, enabled, note)
			VALUES (${pubkey}, ${'ring-pool'}, ${'pool'}, ${true},
			        ${'reused rotating ring payer (x402_ring_pool)'})
			ON CONFLICT (pubkey) DO UPDATE SET role = 'pool', enabled = true`;
		created.push(pubkey);
	}
	const total = await poolCount(sql);
	log.info('ring_pool_generated', { created: created.length, total });
	return { created, total };
}

/**
 * Grow the pool up to `target` (default X402_RING_POOL_SIZE), minting only the
 * shortfall. Safe to call every provisioning run — it never shrinks or re-keys.
 */
export async function growPoolToTarget({ target, sql = defaultSql } = {}) {
	const want = Number.isFinite(target) && target > 0 ? Math.floor(target) : ringPoolTargetSize();
	if (want <= 0) return { created: [], total: await poolCount(sql), target: 0 };
	const current = await poolCount(sql);
	const shortfall = Math.max(0, want - current);
	if (shortfall === 0) return { created: [], total: current, target: want };
	const { created, total } = await generatePoolWallets({ count: shortfall, sql });
	return { created, total, target: want };
}

/**
 * Atomically claim the next payer wallet on a least-recently-used rotation, bump
 * its usage cursor, and return its decrypted Keypair. Concurrent ticks never pick
 * the same wallet (FOR UPDATE SKIP LOCKED). Returns null when the pool is empty —
 * the caller falls back to the seed payer so the ring never stalls.
 *
 * @returns {Promise<{ keypair: Keypair, pubkey: string } | null>}
 */
export async function claimNextPayer(sql = defaultSql) {
	await ensurePoolSchema(sql);
	const rows = await sql`
		UPDATE x402_ring_pool
		SET last_used_at = now(), use_count = use_count + 1
		WHERE pubkey = (
			SELECT pubkey FROM x402_ring_pool
			WHERE enabled = true
			ORDER BY last_used_at NULLS FIRST, pubkey
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING pubkey, encrypted_secret`;
	if (!rows[0]) return null;
	try {
		const keypair = decodeKeypair(await decryptSecret(rows[0].encrypted_secret));
		return { keypair, pubkey: rows[0].pubkey };
	} catch (err) {
		log.warn('ring_pool_claim_decrypt_failed', { pubkey: rows[0].pubkey, message: err?.message });
		return null;
	}
}
