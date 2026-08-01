/**
 * On-chain TraderScore attestor (server-side).
 *
 * The Proof tab already lets anyone verify a trader's numbers by following each
 * position to its Solscan tx. This adds a second, tamper-evident layer: a daily
 * SPL-Memo attestation, signed by the platform attester, that commits the rolled-
 * up score for a trader's wallet to the chain and mirrors it into
 * `solana_attestations` (kind `threews.tradescore.v1`). A consumer can then trust
 * "this score was published by three.ws at this slot" without re-deriving it.
 *
 * Best-effort by contract, exactly like solana-validation-attest.js:
 *   - No attester key (ATTEST_AGENT_SECRET_KEY) → throws `attester_key_not_configured`;
 *     callers (the cron) catch and report skipped rather than failing.
 *   - Idempotent per (wallet, network, window, UTC day): re-running the cron the
 *     same day returns the existing signature instead of broadcasting a duplicate.
 */

import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { sendAndConfirm } from './solana/confirm.js';

import { sql } from './db.js';
import { solanaConnection } from './solana/connection.js';
import { RPC } from './solana-attestations.js';
import { loadAttesterKeypair } from './attest-event.js';

/** SPL Memo, the program the attestation instruction targets. Public so a consumer can pin it. */
export const MEMO_PROGRAM_ID_BASE58 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** Attestation kind written by this module and read back by the Trader Passport. */
export const TRADESCORE_KIND = 'threews.tradescore.v1';

const MEMO_PROGRAM_ID = new PublicKey(MEMO_PROGRAM_ID_BASE58);
const TX_TIMEOUT_MS = 15_000;

class TraderScoreAttestError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'TraderScoreAttestError';
		this.code = code;
	}
}

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error(`rpc timeout after ${ms}ms`), { code: 'RPC_TIMEOUT' })), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** UTC calendar day (YYYY-MM-DD) — the idempotency bucket. */
function utcDay(ts) {
	return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Attest one trader's rolled-up score on-chain.
 *
 * @param {object} p
 * @param {'mainnet'|'devnet'} p.network
 * @param {string} p.wallet     The agent's Solana trading wallet (base58) — the attestation subject.
 * @param {string} p.agentId    The three.ws agent UUID (recorded in the payload for back-reference).
 * @param {object} p.metrics    Output of computeTraderMetrics for the window.
 * @param {'24h'|'7d'|'30d'|'all'} p.window
 * @param {number} [p.now]      Injectable clock (defaults Date.now()).
 * @returns {Promise<{ status:'minted'|'deduped', signature:string, day:string, subject:string }>}
 */
export async function attestTraderScore({ network, wallet, agentId, metrics, window, now = Date.now() }) {
	if (network !== 'mainnet' && network !== 'devnet') {
		throw new TraderScoreAttestError('unsupported_network', `unsupported network ${network}`);
	}
	try { new PublicKey(wallet); } catch {
		throw new TraderScoreAttestError('invalid_wallet', 'wallet is not a valid pubkey');
	}

	let attester;
	try { attester = loadAttesterKeypair(); } catch {
		throw new TraderScoreAttestError('attester_key_not_configured', 'ATTEST_AGENT_SECRET_KEY is not set.');
	}
	const validator = attester.publicKey.toBase58();
	const day = utcDay(now);

	// Idempotency: one attestation per wallet/network/window/day.
	const [existing] = await sql`
		select signature from solana_attestations
		where agent_asset = ${wallet} and network = ${network} and kind = ${TRADESCORE_KIND}
		  and payload->>'window' = ${window} and payload->>'day' = ${day}
		limit 1
	`;
	if (existing) return { status: 'deduped', signature: existing.signature, day, subject: wallet };

	const payload = {
		v: 1,
		kind: TRADESCORE_KIND,
		agent: wallet,
		agent_id: agentId,
		window,
		day,
		network,
		ts: Math.floor(now / 1000),
		score: metrics.score,
		verified: metrics.verified,
		closed: metrics.closed_count,
		win_rate: metrics.win_rate,
		realized_pnl_sol: metrics.realized_pnl_sol,
		max_drawdown_pct: metrics.max_drawdown_pct,
		unique_coins: metrics.unique_coins,
		// Anti-gaming provenance committed alongside the score: the snipe hit-rate
		// (when a launch sample exists) and the count of self-dealt round-trips that
		// were excluded from the credited number. Makes the anchor honest, not just
		// tamper-evident.
		snipe_hit_rate: metrics.snipe_hit_rate ?? null,
		snipe_sample: metrics.snipe_sample ?? 0,
		self_dealing_excluded: metrics.self_dealing_count ?? 0,
		source: 'threews.trader-stats',
	};

	const conn = solanaConnection({ url: RPC[network] || RPC.devnet, commitment: 'confirmed' });
	const ix = new TransactionInstruction({
		programId: MEMO_PROGRAM_ID,
		keys: [
			{ pubkey: attester.publicKey, isSigner: true, isWritable: false },
			{ pubkey: new PublicKey(wallet), isSigner: false, isWritable: false },
		],
		data: Buffer.from(JSON.stringify(payload), 'utf8'),
	});

	let signature;
	try {
		signature = await withTimeout(
			sendAndConfirm(conn, new Transaction().add(ix), [attester], { commitment: 'confirmed' }),
			TX_TIMEOUT_MS,
		);
	} catch (err) {
		throw new TraderScoreAttestError('record_failed', `tradescore memo failed: ${err.message}`);
	}

	try {
		await sql`
			insert into solana_attestations (
				signature, network, slot, block_time, agent_asset, attester, kind, payload, verified
			) values (
				${signature}, ${network}, null, now(), ${wallet}, ${validator},
				${TRADESCORE_KIND}, ${JSON.stringify(payload)}::jsonb, true
			)
			on conflict (signature) do nothing
		`;
	} catch (err) {
		if (err?.code !== '23505') throw err;
	}

	return { status: 'minted', signature, day, subject: wallet };
}

export { TraderScoreAttestError };
