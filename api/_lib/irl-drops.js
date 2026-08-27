// IRL Money Drops & Bounties — escrow custody + claim engine (Wave II task 06).
//
// A drop locks REAL value in a fresh, single-purpose Solana escrow wallet anchored
// to a physical location. Funding is the creator's own signed transfer, CONFIRMED
// on-chain before the drop is claimable. A presence-proven claimant inside the
// radius releases a share to their own wallet; unclaimed drops auto-refund the
// creator on expiry. Every release/refund is server-signed by the escrow key with
// the platform funding wallet as fee-payer (so the escrow holds EXACTLY the funded
// amount and the platform pays network fees + ATA rent), and the irl_drops /
// irl_drop_claims rows + on-chain signatures are the durable audit trail.
//
// Money-safety invariants:
//   • A drop is shown claimable ONLY after its escrow is confirmed funded on-chain.
//   • A claim is reserved under pg_advisory_xact_lock(drop id) and bounded by
//     claims_count < max_claims, so racing claimants are serialized and only the
//     real winners get a slot — a partial-unique index makes it idempotent per
//     claimant, and a failed release frees the slot for a clean retry.
//   • A drop is EITHER paid out (claims) AND/OR refunded (remainder), never able to
//     release more than it holds; the escrow balance is the hard ceiling on-chain.

import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
	getAssociatedTokenAddress,
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferInstruction,
	getAccount,
} from '@solana/spl-token';

import { sql } from './db.js';
import { ataExists } from './solana/read-guards.js';
import { env } from './env.js';
import { sha256 } from './crypto.js';
import { encodeGeohash } from './geohash.js';
import { generateSolanaAgentWallet } from './agent-wallet.js';
import { decryptSecret } from './secret-box.js';
import { solanaConnection } from './agent-pumpfun.js';
import { solanaConnection as rawSolanaConnection } from './solana/connection.js';
import { submitProtected } from './execution-engine.js';
import { recordCustodyEvent, updateCustodyEvent } from './agent-trade-guards.js';
import { SOLANA_USDC_MINT, SOLANA_USDC_MINT_DEVNET } from '../payments/_config.js';
import {
	decimalsForAsset,
	amountToAtomics,
	atomicsToAmount,
	readDropBalance,
	fundingConfigured,
} from './sealed-drop-funding.js';

export { decimalsForAsset, amountToAtomics, atomicsToAmount, fundingConfigured };

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FIX_CELL_PRECISION = 7; // ~153 m, matches the presence-token cell.
const SUPPORTED_ASSETS = new Set(['SOL', 'USDC', 'THREE']);
const CLAIM_RULES = new Set(['first', 'each-once', 'quiz']);
const BOUNTY_CONDITIONS = new Set(['presence', 'chat', 'quiz']);

// ── platform fee-payer (shared resolution with sealed-drop-funding.js) ──────────
// Releases + refunds are paid by the platform funding wallet so a USDC/$THREE
// escrow never needs its own SOL for fees, and a SOL escrow pays out its exact
// amount. Same env precedence every custodial-money endpoint shares.
function resolveFeePayerBase58() {
	const candidates = [env.VANITY_DROP_FUNDING_KEY, env.VANITY_BOUNTY_PAYOUT_KEY].filter(Boolean);
	for (const raw of candidates) {
		const s = String(raw).trim();
		try { if (bs58.decode(s).length === 64) return s; } catch { /* try base64 */ }
		try { const buf = Buffer.from(s, 'base64'); if (buf.byteLength === 64) return bs58.encode(buf); } catch { /* ignore */ }
	}
	const clubB64 = process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64;
	if (clubB64) {
		try { const buf = Buffer.from(clubB64, 'base64'); if (buf.byteLength === 64) return bs58.encode(buf); } catch { /* ignore */ }
	}
	return null;
}

function feePayerKeypair() {
	const key = resolveFeePayerBase58();
	if (!key) {
		throw Object.assign(
			new Error('drop payout wallet is not configured — set VANITY_DROP_FUNDING_KEY (Base58 64-byte secret)'),
			{ status: 503, code: 'payout_unconfigured' },
		);
	}
	return Keypair.fromSecretKey(bs58.decode(key));
}

function usdcMint(network) {
	return network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT;
}

function mintForAsset(asset, network) {
	if (asset === 'USDC') return usdcMint(network);
	if (asset === 'THREE') return env.THREE_TOKEN_MINT;
	return null; // SOL is native
}

function dropError(message, status = 400, code = 'bad_request', extra = {}) {
	return Object.assign(new Error(message), { status, code, ...extra });
}

// Great-circle distance in metres.
export function haversineM(lat1, lng1, lat2, lng2) {
	const R = 6371000;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a = Math.sin(dLat / 2) ** 2
		+ Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Normalize a quiz answer the same way on store + check: trim, collapse spaces,
// lowercase. The plaintext answer is NEVER persisted — only sha256(normalized).
function normalizeAnswer(s) {
	return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
export async function hashAnswer(answer) {
	return sha256(`irl-drop-quiz:${normalizeAnswer(answer)}`);
}

// ── public projection ───────────────────────────────────────────────────────
// Never leaks the escrow secret, creator identity, or another claimant's wallet.
export function toPublicDrop(row, { viewerKey = null, viewerUserId = null } = {}) {
	const mine = (!!viewerUserId && row.creator_user_id === viewerUserId)
		|| (!!viewerKey && row.creator_device === viewerKey);
	return {
		id: row.id,
		kind: row.kind,
		asset: row.asset,
		amount: atomicsToAmount(row.amount_atomics, row.asset),
		amount_atomics: String(row.amount_atomics),
		max_claims: row.max_claims,
		claims_count: row.claims_count,
		claims_left: Math.max(0, row.max_claims - row.claims_count),
		claim_rule: row.claim_rule,
		bounty_condition: row.bounty_condition ?? null,
		quiz_question: row.quiz_question ?? null,
		title: row.title ?? null,
		note: row.note ?? null,
		lat: row.lat,
		lng: row.lng,
		radius_m: row.radius_m,
		network: row.network,
		status: row.status,
		escrow_address: row.escrow_address,
		funding_tx: row.funding_tx ?? null,
		refund_tx: row.refund_tx ?? null,
		expires_at: row.expires_at,
		created_at: row.created_at,
		is_mine: mine,
	};
}

// ── create ──────────────────────────────────────────────────────────────────
/**
 * Validate config, generate the escrow keypair, and persist a pending_funding
 * drop. Returns { drop, escrowAddress, total } — the caller funds escrowAddress
 * then calls confirmFunding().
 */
export async function createDrop(cfg) {
	const {
		creatorUserId = null,
		creatorDevice = null,
		creatorAgentId = null,
		kind = 'drop',
		asset,
		amount,
		maxClaims = 1,
		claimRule = 'first',
		bountyCondition = null,
		quizQuestion = null,
		quizAnswer = null,
		title = null,
		note = null,
		lat,
		lng,
		radiusM = 30,
		expiresInMs,
		refundAddress = null,
		network = 'mainnet',
	} = cfg;

	if (!SUPPORTED_ASSETS.has(asset)) throw dropError('asset must be SOL, USDC or THREE', 400, 'invalid_asset');
	if (!CLAIM_RULES.has(claimRule)) throw dropError('invalid claim rule', 400, 'invalid_claim_rule');
	if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
		throw dropError('a valid drop location is required', 400, 'invalid_location');
	}
	const radius = Math.max(5, Math.min(250, Number(radiusM) || 30));
	const claims = Math.max(1, Math.min(1000, Math.floor(Number(maxClaims) || 1)));
	const perClaim = amountToAtomics(amount, asset); // throws on bad amount
	const total = perClaim * BigInt(claims);

	const ttl = Number(expiresInMs);
	if (!Number.isFinite(ttl) || ttl < 60_000 || ttl > 30 * 24 * 3600_000) {
		throw dropError('expiry must be between 1 minute and 30 days', 400, 'invalid_expiry');
	}

	let condition = null;
	let answerHash = null;
	let question = null;
	if (kind === 'bounty') {
		condition = bountyCondition || 'presence';
		if (!BOUNTY_CONDITIONS.has(condition)) throw dropError('invalid bounty condition', 400, 'invalid_condition');
		if (condition === 'quiz' || claimRule === 'quiz') {
			condition = 'quiz';
			question = String(quizQuestion || '').trim();
			if (!question) throw dropError('a quiz bounty needs a question', 400, 'missing_question');
			if (!String(quizAnswer || '').trim()) throw dropError('a quiz bounty needs an answer', 400, 'missing_answer');
			answerHash = await hashAnswer(quizAnswer);
		}
	} else if (claimRule === 'quiz') {
		throw dropError('the quiz claim rule requires a bounty with a question', 400, 'invalid_claim_rule');
	}

	if (refundAddress != null && !BASE58_RE.test(String(refundAddress))) {
		throw dropError('refund address must be a Solana address', 400, 'invalid_refund_address');
	}

	const escrow = await generateSolanaAgentWallet(); // { address, encrypted_secret }
	const geocell = encodeGeohash(lat, lng, FIX_CELL_PRECISION);
	const expiresAt = new Date(Date.now() + ttl).toISOString();

	const [row] = await sql`
		INSERT INTO irl_drops
			(creator_user_id, creator_device, creator_agent_id, kind, asset,
			 amount_atomics, max_claims, claim_rule, total_atomics,
			 bounty_condition, quiz_question, quiz_answer_hash, title, note,
			 lat, lng, radius_m, geocell7, escrow_address, escrow_secret_enc,
			 refund_address, network, status, expires_at)
		VALUES
			(${creatorUserId}, ${creatorDevice}, ${creatorAgentId}, ${kind}, ${asset},
			 ${total > 0n ? perClaim.toString() : '0'}, ${claims}, ${claimRule}, ${total.toString()},
			 ${condition}, ${question}, ${answerHash}, ${title ? String(title).slice(0, 120) : null},
			 ${note ? String(note).slice(0, 500) : null},
			 ${lat}, ${lng}, ${radius}, ${geocell}, ${escrow.address}, ${escrow.encrypted_secret},
			 ${refundAddress}, ${network}, 'pending_funding', ${expiresAt})
		RETURNING *
	`;
	return { drop: row, escrowAddress: escrow.address, total };
}

// ── funding confirmation (on-chain verify, server-authoritative) ──────────────
function accountKeyStr(k) {
	return k?.pubkey?.toString?.() || String(k?.pubkey ?? '');
}
function lamportsCreditedTo(tx, owner) {
	const keys = tx.transaction?.message?.accountKeys || [];
	const idx = keys.findIndex((k) => accountKeyStr(k) === owner);
	if (idx < 0) return 0n;
	return BigInt(tx.meta?.postBalances?.[idx] ?? 0) - BigInt(tx.meta?.preBalances?.[idx] ?? 0);
}
function tokenCreditedTo(tx, { mint, owner }) {
	const pre = tx.meta?.preTokenBalances || [];
	const post = tx.meta?.postTokenBalances || [];
	let delta = 0n;
	for (const p of post) {
		if (p.mint !== mint || p.owner !== owner) continue;
		const before = pre.find((x) => x.accountIndex === p.accountIndex);
		delta += BigInt(p.uiTokenAmount?.amount ?? '0') - BigInt(before?.uiTokenAmount?.amount ?? '0');
	}
	return delta;
}

/**
 * Confirm a funding transfer landed in the escrow and flip the drop to active.
 * Verifies on-chain that `signature` credited the escrow address at least the
 * required total for the drop's asset. Idempotent: a drop already active for the
 * same funding signature returns success without re-verifying.
 */
export async function confirmFunding({ drop, signature, refundAddress = null }) {
	if (!drop) throw dropError('drop not found', 404, 'not_found');
	if (drop.status === 'active' || drop.status === 'exhausted') {
		return { ok: true, alreadyActive: true, funding_tx: drop.funding_tx };
	}
	if (drop.status !== 'pending_funding') {
		throw dropError(`drop is ${drop.status}, cannot be funded`, 409, 'not_fundable');
	}
	if (typeof signature !== 'string' || signature.length < 32 || signature.length > 128) {
		throw dropError('a valid funding signature is required', 400, 'bad_request');
	}

	const conn = rawSolanaConnection({
		url: drop.network === 'devnet'
			? (env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com')
			: (env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'),
		commitment: 'confirmed',
	});

	let tx = null;
	try {
		tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
	} catch { tx = null; }
	if (!tx) {
		// Not visible yet — let the client poll instead of failing hard.
		let status = null;
		try {
			const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
			status = value?.[0] || null;
		} catch { status = null; }
		if (status?.err) throw dropError('funding transaction failed on-chain', 422, 'tx_failed');
		return { ok: false, pending: true, status: 'awaiting_confirmation' };
	}
	if (tx.meta?.err) throw dropError('funding transaction failed on-chain', 422, 'tx_failed');

	const required = BigInt(drop.total_atomics);
	let received;
	if (drop.asset === 'SOL') {
		received = lamportsCreditedTo(tx, drop.escrow_address);
	} else {
		received = tokenCreditedTo(tx, { mint: mintForAsset(drop.asset, drop.network), owner: drop.escrow_address });
	}
	if (received < required) {
		throw dropError(
			`escrow received ${atomicsToAmount(received, drop.asset)} ${drop.asset}, needs ${atomicsToAmount(required, drop.asset)}`,
			422, 'underfunded',
		);
	}

	const [updated] = await sql`
		UPDATE irl_drops
		SET status = 'active', funding_tx = ${signature}, funded_atomics = ${received.toString()},
		    funded_at = now(), updated_at = now(),
		    refund_address = COALESCE(${refundAddress}, refund_address)
		WHERE id = ${drop.id} AND status = 'pending_funding'
		RETURNING *
	`;
	const final = updated || drop;

	if (final.creator_agent_id) {
		recordCustodyEvent({
			agentId: final.creator_agent_id,
			userId: final.creator_user_id,
			eventType: 'spend',
			category: 'irl_drop',
			network: final.network,
			asset: final.asset,
			signature,
			status: 'confirmed',
			reason: 'fund_irl_bounty',
			meta: { drop_id: final.id, escrow: final.escrow_address, total: required.toString() },
		}).catch(() => {});
	}
	return { ok: true, drop: updated || null, funding_tx: signature };
}

// ── claim (atomic reservation under advisory lock) ────────────────────────────
/**
 * Atomically reserve a claim slot for a claimant. Serialized per drop by an
 * advisory lock; bounded by max_claims; idempotent per claimant (a live claim
 * blocks a second). Returns { ok, claimId, amount_atomics, asset } on success, or
 * { ok:false, reason } where reason ∈ inactive | expired | exhausted | already_claimed.
 */
export async function reserveClaim({ dropId, claimantUserId = null, claimantDevice = null, claimantKey, claimWallet }) {
	if (!BASE58_RE.test(String(claimWallet || ''))) {
		throw dropError('a valid claim wallet is required', 400, 'invalid_wallet');
	}
	const rows = await sql`
		WITH lock AS (
			SELECT pg_advisory_xact_lock(hashtextextended(${String(dropId)}, 0))
		),
		d AS (
			SELECT id, status, expires_at, max_claims, claims_count, amount_atomics, asset, escrow_address
			FROM irl_drops WHERE id = ${dropId} FOR UPDATE
		),
		ins AS (
			INSERT INTO irl_drop_claims
				(drop_id, claimant_user_id, claimant_device, claimant_key, claim_wallet, amount_atomics, asset, status)
			SELECT d.id, ${claimantUserId}, ${claimantDevice}, ${claimantKey}, ${claimWallet}, d.amount_atomics, d.asset, 'pending'
			FROM d, lock
			WHERE d.status = 'active'
			  AND (d.expires_at IS NULL OR d.expires_at > now())
			  AND d.claims_count < d.max_claims
			  AND NOT EXISTS (
			      SELECT 1 FROM irl_drop_claims c
			      WHERE c.drop_id = d.id AND c.claimant_key = ${claimantKey}
			        AND c.status IN ('pending','confirmed')
			  )
			RETURNING id, amount_atomics, asset
		),
		upd AS (
			UPDATE irl_drops
			SET claims_count = claims_count + 1,
			    status = CASE WHEN claims_count + 1 >= max_claims THEN 'exhausted' ELSE status END,
			    updated_at = now()
			WHERE id = ${dropId} AND EXISTS (SELECT 1 FROM ins)
			RETURNING id
		)
		SELECT
			(SELECT id FROM ins) AS claim_id,
			(SELECT amount_atomics FROM ins) AS amount_atomics,
			(SELECT asset FROM ins) AS asset,
			(SELECT status FROM d) AS drop_status,
			(SELECT (expires_at IS NOT NULL AND expires_at <= now()) FROM d) AS is_expired,
			(SELECT (claims_count >= max_claims) FROM d) AS is_full,
			(SELECT EXISTS (
				SELECT 1 FROM irl_drop_claims c
				WHERE c.drop_id = ${dropId} AND c.claimant_key = ${claimantKey} AND c.status IN ('pending','confirmed')
			)) AS already
	`;
	const r = rows[0] || {};
	if (r.claim_id) {
		return { ok: true, claimId: r.claim_id, amount_atomics: String(r.amount_atomics), asset: r.asset };
	}
	if (r.drop_status == null) return { ok: false, reason: 'not_found' };
	if (r.drop_status !== 'active' && r.drop_status !== 'exhausted') return { ok: false, reason: 'inactive' };
	if (r.is_expired) return { ok: false, reason: 'expired' };
	if (r.already) return { ok: false, reason: 'already_claimed' };
	if (r.is_full) return { ok: false, reason: 'exhausted' };
	return { ok: false, reason: 'unavailable' };
}

// Free a reserved slot when the on-chain release fails — marks the claim failed
// (so it stops occupying the idempotency slot) and gives the slot back.
export async function failClaim({ dropId, claimId }) {
	await sql`
		WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${String(dropId)}, 0))),
		c AS (
			UPDATE irl_drop_claims SET status = 'failed'
			WHERE id = ${claimId} AND status = 'pending'
			RETURNING id
		)
		UPDATE irl_drops
		SET claims_count = GREATEST(0, claims_count - 1),
		    status = CASE
		        WHEN status = 'exhausted' AND (expires_at IS NULL OR expires_at > now()) THEN 'active'
		        ELSE status END,
		    updated_at = now()
		FROM lock
		WHERE id = ${dropId} AND EXISTS (SELECT 1 FROM c)
	`;
}

export async function confirmClaim({ claimId, signature }) {
	await sql`
		UPDATE irl_drop_claims
		SET status = 'confirmed', signature = ${signature}, confirmed_at = now()
		WHERE id = ${claimId}
	`;
}

// ── on-chain release / refund ────────────────────────────────────────────────
function escrowKeypair(drop) {
	// decryptSecret -> base64(64-byte secret) -> Keypair. Decrypted ONLY here, to
	// sign a verified release or refund; never logged or returned.
	return decryptSecret(drop.escrow_secret_enc).then((b64) => Keypair.fromSecretKey(Buffer.from(b64, 'base64')));
}

/**
 * Release `atomics` of the drop's asset from its escrow to `toAddress`. The
 * platform fee-payer pays the network fee + any ATA rent; the escrow co-signs the
 * transfer of its own balance. Throws on revert (claim left reservable for retry).
 */
export async function releaseFromEscrow({ drop, toAddress, atomics }) {
	if (!BASE58_RE.test(String(toAddress || ''))) throw dropError('invalid claim wallet', 400, 'invalid_wallet');
	const amount = BigInt(atomics);
	if (amount <= 0n) throw dropError('nothing to release', 400, 'invalid_amount');
	if (!fundingConfigured()) throw dropError('drop payout wallet is not configured', 503, 'payout_unconfigured');

	const escrowKp = await escrowKeypair(drop);
	const feePayer = feePayerKeypair();
	const recipient = new PublicKey(toAddress);
	const conn = solanaConnection(drop.network);

	const instructions = [];
	if (drop.asset === 'SOL') {
		instructions.push(SystemProgram.transfer({ fromPubkey: escrowKp.publicKey, toPubkey: recipient, lamports: amount }));
	} else {
		const mint = new PublicKey(mintForAsset(drop.asset, drop.network));
		const fromATA = await getAssociatedTokenAddress(mint, escrowKp.publicKey);
		const toATA = await getAssociatedTokenAddress(mint, recipient);
// The create is the IDEMPOTENT variant on purpose: it pairs with ataExists,
// which fails open to "missing" when the chain cannot be read. With the plain
// create that guess would be unsafe (a create for an account that already
// exists fails the whole transaction); with this one an unnecessary create is a
// no-op, so a dead RPC costs nothing and the probe-then-submit race disappears
// with it.
		if (!(await ataExists(conn, toATA))) {
			instructions.push(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, toATA, recipient, mint));
		}
		instructions.push(createTransferInstruction(fromATA, toATA, escrowKp.publicKey, amount));
	}

	const { signature } = await submitProtected({
		network: drop.network,
		connection: conn,
		payer: feePayer,
		instructions,
		opts: { extraSigners: [escrowKp] },
	});
	return signature;
}

/**
 * Sweep the full remaining escrow balance back to the drop's refund address.
 * Idempotent at the store layer (caller CAS-es status to 'refunded' first). For an
 * empty escrow returns 'empty'.
 */
export async function sweepRefund({ drop }) {
	const toAddress = drop.refund_address;
	if (!BASE58_RE.test(String(toAddress || ''))) throw dropError('no refund address on file', 422, 'no_refund_address');
	if (!fundingConfigured()) throw dropError('drop payout wallet is not configured', 503, 'payout_unconfigured');

	const escrowKp = await escrowKeypair(drop);
	const feePayer = feePayerKeypair();
	const recipient = new PublicKey(toAddress);
	const conn = solanaConnection(drop.network);

	const instructions = [];
	if (drop.asset === 'SOL') {
		const lamports = await conn.getBalance(escrowKp.publicKey, 'confirmed');
		if (lamports <= 0) return 'empty';
		instructions.push(SystemProgram.transfer({ fromPubkey: escrowKp.publicKey, toPubkey: recipient, lamports: BigInt(lamports) }));
	} else {
		const mint = new PublicKey(mintForAsset(drop.asset, drop.network));
		const fromATA = await getAssociatedTokenAddress(mint, escrowKp.publicKey);
		let amount = 0n;
		try { amount = (await getAccount(conn, fromATA)).amount; } catch { amount = 0n; }
		if (amount <= 0n) return 'empty';
		const toATA = await getAssociatedTokenAddress(mint, recipient);
		if (!(await ataExists(conn, toATA))) {
			instructions.push(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, toATA, recipient, mint));
		}
		instructions.push(createTransferInstruction(fromATA, toATA, escrowKp.publicKey, amount));
	}

	const { signature } = await submitProtected({
		network: drop.network,
		connection: conn,
		payer: feePayer,
		instructions,
		opts: { extraSigners: [escrowKp] },
	});
	return signature;
}

// CAS a drop into 'refunded' (only an owner-cancellable / expired drop with no
// further live claims). Returns the locked row or null if not refundable. The
// caller then sweeps and records refund_tx.
export async function markRefunding({ dropId, allowActive = false }) {
	const rows = await sql`
		WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${String(dropId)}, 0)))
		UPDATE irl_drops
		SET status = 'refunded', refunded_at = now(), updated_at = now()
		FROM lock
		WHERE id = ${dropId}
		  AND status IN (${allowActive ? sql`'active','exhausted','expired','pending_funding'` : sql`'expired','exhausted'`})
		RETURNING *
	`;
	return rows[0] || null;
}

export async function recordRefundTx({ dropId, refundTx }) {
	await sql`UPDATE irl_drops SET refund_tx = ${refundTx}, updated_at = now() WHERE id = ${dropId} AND refund_tx IS NULL`;
}

// ── reads ─────────────────────────────────────────────────────────────────────
export async function getDropRow(id) {
	const [row] = await sql`SELECT * FROM irl_drops WHERE id = ${id}`;
	return row || null;
}

/** Live drops within `radiusM` of (lat,lng), claimable-first, capped. */
export async function nearbyDrops({ lat, lng, radiusM = 60, viewerKey = null, viewerUserId = null }) {
	// Coarse bounding-box on the indexed geocell neighbourhood, then exact haversine.
	const latDelta = radiusM / 110540;
	const lngDelta = radiusM / ((111320 * Math.cos(lat * (Math.PI / 180))) || 1);
	const rows = await sql`
		SELECT * FROM irl_drops
		WHERE status IN ('active','exhausted')
		  AND lat BETWEEN ${lat - latDelta} AND ${lat + latDelta}
		  AND lng BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
		  AND expires_at > now()
		ORDER BY created_at DESC
		LIMIT 200
	`;
	return rows
		.map((r) => ({ ...toPublicDrop(r, { viewerKey, viewerUserId }), distance_m: Math.round(haversineM(lat, lng, r.lat, r.lng)) }))
		.filter((d) => d.distance_m <= radiusM + d.radius_m)
		.sort((a, b) => a.distance_m - b.distance_m)
		.slice(0, 60);
}

/** All drops created by a user/device, every status, with live claim receipts. */
export async function myDrops({ userId = null, deviceToken = null }) {
	if (!userId && !deviceToken) return [];
	const rows = await sql`
		SELECT * FROM irl_drops
		WHERE (${userId}::uuid IS NOT NULL AND creator_user_id = ${userId})
		   OR (${deviceToken}::text IS NOT NULL AND creator_device = ${deviceToken})
		ORDER BY created_at DESC
		LIMIT 100
	`;
	return rows.map((r) => toPublicDrop(r, { viewerKey: deviceToken, viewerUserId: userId }));
}

/** Claims I have made (receipts), newest first. */
export async function myClaims({ claimantKey }) {
	if (!claimantKey) return [];
	const rows = await sql`
		SELECT cl.id, cl.drop_id, cl.amount_atomics, cl.asset, cl.signature, cl.status, cl.created_at, cl.confirmed_at,
		       d.title, d.kind, d.network, d.lat, d.lng
		FROM irl_drop_claims cl JOIN irl_drops d ON d.id = cl.drop_id
		WHERE cl.claimant_key = ${claimantKey}
		ORDER BY cl.created_at DESC
		LIMIT 100
	`;
	return rows.map((r) => ({
		id: String(r.id),
		drop_id: r.drop_id,
		title: r.title,
		kind: r.kind,
		asset: r.asset,
		amount: atomicsToAmount(r.amount_atomics, r.asset),
		signature: r.signature,
		status: r.status,
		network: r.network,
		created_at: r.created_at,
		confirmed_at: r.confirmed_at,
	}));
}

/** Has this claimant had a REAL chat interaction with the drop's agent? (bounty: chat) */
export async function hasChatSignal({ agentId, claimantUserId, claimantDevice }) {
	if (!agentId) return false;
	try {
		const rows = await sql`
			SELECT 1 FROM irl_interactions
			WHERE agent_id = ${agentId}
			  AND kind IN ('chat','message','talk')
			  AND ( (${claimantUserId}::uuid IS NOT NULL AND user_id = ${claimantUserId})
			     OR (${claimantDevice}::text IS NOT NULL AND device_token = ${claimantDevice}) )
			LIMIT 1
		`;
		return rows.length > 0;
	} catch {
		// irl_interactions schema may differ across deploys — fail closed (no signal).
		return false;
	}
}

export async function verifyQuiz({ drop, answer }) {
	if (!drop.quiz_answer_hash) return false;
	const h = await hashAnswer(answer);
	return h === drop.quiz_answer_hash;
}

/** Expired, still-funded drops needing an auto-refund (cron). */
export async function listExpiredRefundable(limit = 25) {
	const rows = await sql`
		SELECT id FROM irl_drops
		WHERE status IN ('active','exhausted','pending_funding')
		  AND expires_at <= now()
		ORDER BY expires_at ASC
		LIMIT ${limit}
	`;
	return rows.map((r) => r.id);
}

// Mark an expired drop 'expired' (terminal-ish) when it has no funds to sweep
// (e.g. never funded, or fully claimed) so the cron stops revisiting it.
export async function markExpired({ dropId }) {
	await sql`
		UPDATE irl_drops SET status = 'expired', updated_at = now()
		WHERE id = ${dropId} AND status IN ('active','exhausted','pending_funding') AND expires_at <= now()
	`;
}

export { readDropBalance };
