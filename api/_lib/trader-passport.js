/**
 * Trader Passport: the portable, third-party-verifiable form of a track record.
 *
 * `trader-score-attest.js` commits a trader's rolled-up score to Solana every day
 * as a signed SPL-Memo attestation (kind `threews.tradescore.v1`) and mirrors it
 * into `solana_attestations`. This module is the read side: it turns those rows
 * into a credential any other application can fetch, pin, and re-check against
 * the chain without trusting three.ws at all.
 *
 * Two guarantees it is built to keep:
 *
 *   1. **Independently verifiable.** `verifyOnChain` re-fetches the attestation
 *      transaction from an RPC node, re-parses the memo, and re-checks the signer
 *      and the subject. It never reads the database, so a consumer that distrusts
 *      our API can run the same check themselves against any RPC.
 *   2. **Honest about staleness and drift.** A credential is a snapshot. The
 *      passport always reports how old it is and how far the live numbers have
 *      moved since, rather than presenting the anchored score as current truth.
 */

import { sql } from './db.js';
import { solanaConnection } from './solana/connection.js';
import { RPC, extractMemoPayload, attesterFromTx } from './solana-attestations.js';
import { MEMO_PROGRAM_ID_BASE58, TRADESCORE_KIND } from './trader-score-attest.js';

export { TRADESCORE_KIND, MEMO_PROGRAM_ID_BASE58 };

export const PASSPORT_WINDOWS = new Set(['24h', '7d', '30d', 'all']);
export const PASSPORT_NETWORKS = new Set(['mainnet', 'devnet']);
export const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

/** Fields the on-chain payload commits that the passport surfaces as the score snapshot. */
const SNAPSHOT_FIELDS = ['score', 'closed', 'win_rate', 'realized_pnl_sol', 'max_drawdown_pct', 'unique_coins'];

const RPC_TIMEOUT_MS = 12_000;
const DAY_MS = 86_400_000;

export class PassportError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.name = 'PassportError';
		this.code = code;
		this.status = status;
	}
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new PassportError('rpc_timeout', `${label} timed out after ${ms}ms`, 504)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function explorerTx(signature, network) {
	return network === 'devnet'
		? `https://solscan.io/tx/${signature}?cluster=devnet`
		: `https://solscan.io/tx/${signature}`;
}

export function explorerAddr(address, network) {
	return network === 'devnet'
		? `https://solscan.io/account/${address}?cluster=devnet`
		: `https://solscan.io/account/${address}`;
}

/**
 * Schema check for a `threews.tradescore.v1` memo payload.
 *
 * Deliberately local rather than a new case in `solana-attestations.validatePayload`:
 * that function's kind list also drives which memos the attestation crawler indexes,
 * and the passport must not change what gets crawled.
 *
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validateTradeScorePayload(p) {
	const reasons = [];
	if (!p || typeof p !== 'object') return { ok: false, reasons: ['payload is not an object'] };
	if (p.v !== 1) reasons.push('unsupported payload version');
	if (p.kind !== TRADESCORE_KIND) reasons.push(`kind is not ${TRADESCORE_KIND}`);
	if (typeof p.agent !== 'string' || !WALLET_RE.test(p.agent)) reasons.push('agent is not a Solana address');
	if (!PASSPORT_WINDOWS.has(p.window)) reasons.push('window is not one of 24h/7d/30d/all');
	if (typeof p.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) reasons.push('day is not an ISO calendar date');
	if (!PASSPORT_NETWORKS.has(p.network)) reasons.push('network is not mainnet/devnet');
	if (!Number.isFinite(p.score)) reasons.push('score is not a number');
	if (!Number.isInteger(p.closed) || p.closed < 0) reasons.push('closed is not a non-negative integer');
	return { ok: reasons.length === 0, reasons };
}

function numOrNull(v) {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One `solana_attestations` row → the public credential shape. */
export function shapeCredential(row, network) {
	const payload = row.payload || {};
	const blockTime = row.block_time ? new Date(row.block_time).toISOString() : null;
	const check = validateTradeScorePayload(payload);
	return {
		kind: row.kind,
		signature: row.signature,
		slot: row.slot != null ? Number(row.slot) : null,
		block_time: blockTime,
		day: payload.day || null,
		window: payload.window || null,
		attester: row.attester || null,
		subject: payload.agent || row.agent_asset || null,
		agent_id: payload.agent_id || null,
		revoked: row.revoked === true,
		well_formed: check.ok,
		schema_problems: check.ok ? [] : check.reasons,
		snapshot: {
			score: numOrNull(payload.score),
			closed: numOrNull(payload.closed),
			win_rate: numOrNull(payload.win_rate),
			realized_pnl_sol: numOrNull(payload.realized_pnl_sol),
			max_drawdown_pct: numOrNull(payload.max_drawdown_pct),
			unique_coins: numOrNull(payload.unique_coins),
			verified: payload.verified === true,
			// Anti-gaming provenance committed alongside the headline number, so a
			// consumer sees what was excluded rather than only what was credited.
			snipe_hit_rate: numOrNull(payload.snipe_hit_rate),
			snipe_sample: numOrNull(payload.snipe_sample) ?? 0,
			self_dealing_excluded: numOrNull(payload.self_dealing_excluded) ?? 0,
		},
		explorer_url: explorerTx(row.signature, network),
	};
}

/**
 * Newest-first tradescore attestations for a wallet.
 *
 * @param {object} p
 * @param {string} p.wallet
 * @param {'mainnet'|'devnet'} p.network
 * @param {'24h'|'7d'|'30d'|'all'} [p.window]  Restrict to one attested window.
 * @param {number} [p.limit]
 */
export async function loadCredentials({ wallet, network, window = null, limit = 30 }) {
	const capped = Math.max(1, Math.min(100, Number(limit) || 30));
	const rows = window
		? await sql`
			select signature, network, slot, block_time, agent_asset, attester, kind, payload, verified, revoked
			from solana_attestations
			where agent_asset = ${wallet} and network = ${network} and kind = ${TRADESCORE_KIND}
			  and payload->>'window' = ${window}
			order by block_time desc nulls last, slot desc nulls last
			limit ${capped}
		`
		: await sql`
			select signature, network, slot, block_time, agent_asset, attester, kind, payload, verified, revoked
			from solana_attestations
			where agent_asset = ${wallet} and network = ${network} and kind = ${TRADESCORE_KIND}
			order by block_time desc nulls last, slot desc nulls last
			limit ${capped}
		`;
	return rows.map((r) => shapeCredential(r, network));
}

/** Whole days between an ISO timestamp and now. Null when the timestamp is missing. */
export function ageInDays(iso, now = Date.now()) {
	if (!iso) return null;
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return null;
	return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/**
 * Compare the live, re-derived metrics against what the credential committed.
 *
 * The passport leads with this rather than burying it: an anchored score is a
 * snapshot, and a consumer deciding whether to trust it needs to know how far the
 * trader has moved since it was signed.
 *
 * @returns {{ fields: object, moved: boolean }|null}
 */
export function scoreDrift(liveMetrics, snapshot) {
	if (!liveMetrics || !snapshot) return null;
	const live = {
		score: numOrNull(liveMetrics.score),
		closed: numOrNull(liveMetrics.closed_count),
		win_rate: numOrNull(liveMetrics.win_rate),
		realized_pnl_sol: numOrNull(liveMetrics.realized_pnl_sol),
		max_drawdown_pct: numOrNull(liveMetrics.max_drawdown_pct),
		unique_coins: numOrNull(liveMetrics.unique_coins),
	};
	const fields = {};
	let moved = false;
	for (const key of SNAPSHOT_FIELDS) {
		const attested = numOrNull(snapshot[key]);
		const current = live[key];
		const delta = attested != null && current != null ? Math.round((current - attested) * 1e6) / 1e6 : null;
		if (delta != null && delta !== 0) moved = true;
		fields[key] = { attested, live: current, delta };
	}
	return { fields, moved };
}

/**
 * Re-check one attestation directly against the chain.
 *
 * Database-free on purpose: this is the primitive a third party runs when they do
 * not want to trust our API. Everything it asserts comes from the transaction.
 *
 * @param {object} p
 * @param {string} p.signature
 * @param {'mainnet'|'devnet'} p.network
 * @param {string} [p.expectSubject]  Fail the check unless the memo commits this wallet.
 * @param {string} [p.expectAttester] Fail the check unless this key signed it.
 */
export async function verifyOnChain({ signature, network, expectSubject = null, expectAttester = null }) {
	if (!SIGNATURE_RE.test(signature)) throw new PassportError('invalid_signature', 'signature is not a base-58 transaction signature');
	if (!PASSPORT_NETWORKS.has(network)) throw new PassportError('unsupported_network', `unsupported network ${network}`);

	const conn = solanaConnection({ url: RPC[network] || RPC.devnet, commitment: 'confirmed' });
	let tx;
	try {
		tx = await withTimeout(
			conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
			RPC_TIMEOUT_MS,
			'getTransaction',
		);
	} catch (err) {
		if (err instanceof PassportError) throw err;
		// A signature that passes the base-58 shape test can still fail to decode to
		// 64 bytes, and the RPC rejects it as a bad param rather than answering
		// "no such transaction". Reporting that as an outage would blame our
		// infrastructure for the caller's typo, so it becomes a not-found verdict.
		if (/invalid param|wrongsize|invalid signature/i.test(err.message || '')) {
			return {
				valid: false, found: false, network, signature,
				reasons: ['the RPC rejected this as a malformed transaction signature'],
				explorer_url: explorerTx(signature, network),
			};
		}
		throw new PassportError('rpc_failed', `could not read the transaction: ${err.message}`, 502);
	}
	if (!tx) {
		return {
			valid: false, found: false, network, signature,
			reasons: ['transaction not found on this network at confirmed commitment'],
			explorer_url: explorerTx(signature, network),
		};
	}

	const reasons = [];
	if (tx.meta?.err) reasons.push('transaction failed on-chain');

	const payload = extractMemoPayload(tx);
	if (!payload) reasons.push('no SPL-Memo payload in the transaction log');

	const schema = payload ? validateTradeScorePayload(payload) : { ok: false, reasons: [] };
	if (payload && !schema.ok) reasons.push(...schema.reasons);

	const keys = (tx.transaction?.message?.staticAccountKeys || tx.transaction?.message?.accountKeys || [])
		.map((k) => (typeof k?.toBase58 === 'function' ? k.toBase58() : String(k)));
	const attester = attesterFromTx(tx);
	const subject = payload?.agent || null;

	if (subject && !keys.includes(subject)) {
		reasons.push('the committed subject wallet is not an account of the attestation transaction');
	}
	if (expectSubject && subject !== expectSubject) {
		reasons.push(`memo commits ${subject || 'no subject'}, not the requested ${expectSubject}`);
	}
	if (expectAttester && attester !== expectAttester) {
		reasons.push(`signed by ${attester || 'nobody'}, not the expected issuer ${expectAttester}`);
	}

	const programs = new Set(
		(tx.transaction?.message?.compiledInstructions || tx.transaction?.message?.instructions || [])
			.map((ix) => keys[ix.programIdIndex])
			.filter(Boolean),
	);
	if (programs.size && !programs.has(MEMO_PROGRAM_ID_BASE58)) {
		reasons.push('transaction does not invoke the SPL Memo program');
	}

	return {
		valid: reasons.length === 0,
		found: true,
		network,
		signature,
		slot: tx.slot ?? null,
		block_time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
		attester,
		subject,
		payload: payload || null,
		reasons,
		explorer_url: explorerTx(signature, network),
	};
}

/**
 * The issuer block a consumer pins to decide whether a credential is ours.
 *
 * Prefers the key that actually signed the trader's most recent attestation over
 * anything the server merely holds, so the answer describes the chain rather than
 * this process's configuration.
 */
export async function resolveIssuer({ network, credentials = [] }) {
	const signed = credentials.find((c) => c.attester)?.attester || null;
	let attester = signed;
	if (!attester) {
		const [row] = await sql`
			select attester from solana_attestations
			where network = ${network} and kind = ${TRADESCORE_KIND} and attester is not null
			order by block_time desc nulls last limit 1
		`;
		attester = row?.attester || null;
	}
	return {
		name: 'three.ws',
		kind: TRADESCORE_KIND,
		attester,
		attester_url: attester ? explorerAddr(attester, network) : null,
		memo_program: MEMO_PROGRAM_ID_BASE58,
		cadence: 'daily',
		note: 'Scores are re-derived from on-chain fills and committed as a signed SPL-Memo attestation once per UTC day.',
	};
}

/** Wallet → the three.ws agent that trades from it, for display. Null when unclaimed. */
export async function agentForWallet({ wallet, network }) {
	const [row] = await sql`
		select p.agent_id, i.name, i.profile_image_url, i.avatar_url, i.is_public
		from agent_sniper_positions p
		join agent_identities i on i.id = p.agent_id
		where p.wallet = ${wallet} and p.network = ${network}
		order by p.opened_at desc nulls last
		limit 1
	`;
	if (!row) return null;
	return {
		id: row.agent_id,
		name: row.name || null,
		image: row.profile_image_url || row.avatar_url || null,
		is_public: row.is_public !== false,
	};
}
