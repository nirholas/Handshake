// GET /api/cron/x402-seed-cron
//
// Per-minute cron that seeds the x402 activity feed with 60 real Solana
// micropayments per tick — one per second equivalent, fired in parallel.
//
// Each invocation:
//   1. Loads the seeder keypair (X402_SEED_SOLANA_SECRET_BASE58 or fallback).
//   2. Probes /api/x402/dance-tip once to get live payment requirements.
//   3. Fetches a single blockhash + mint info shared across all 60 transactions.
//   4. Builds 60 signed USDC TransferChecked transactions (synchronous).
//   5. Fires all 60 in parallel against dance-tip with X-PAYMENT headers.
//
// The payments are real on-chain USDC transfers from the seeder wallet.
// The Solana x402 facilitator co-signs (feePayer) and broadcasts each tx.
// Every successful tip is inserted into club_tips + the x402 activity feed.
//
// Env:
//   X402_SEED_SOLANA_SECRET_BASE58   base58 64-byte ed25519 seeder keypair
//   X402_SEED_ENABLED                set to 'false' to pause (default: enabled)
//   X402_SEED_BATCH_SIZE             calls per tick (default: 60)

import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import {
	Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction,
	ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getMint,
} from '@solana/spl-token';

import { json, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { getRedis, isRedisAuthError } from '../_lib/redis.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { logger } from '../_lib/usage.js';
import { SPONSOR_SOL_FLOOR_LAMPORTS } from '../_lib/x402/self-facilitator.js';
import { readPayerUsdcAtomic } from './x402-autonomous-loop.js';
import { requireCron } from '../_lib/cron-auth.js';

const log = logger('x402-seed-cron');

const ORIGIN = () => env.APP_ORIGIN || 'https://three.ws';
const USDC_MINT = env.X402_ASSET_MINT_SOLANA;
const SOLANA_RPC = env.SOLANA_RPC_URL;
const FETCH_TIMEOUT_MS = 20_000;

// Mirror of x402-pay.js FEED_KEY so our seeded payments appear on the /pay feed.
const FEED_KEY = 'x402:pay:feed';
const FEED_MAX = 50;

const DANCERS = ['1', '2', '3', '4'];
const STYLES = [
	'hiphop', 'rumba', 'silly', 'thriller', 'capoeira',
	'twerk', 'spin', 'climb', 'combo',
];

function loadSeedKeypair() {
	// Dedicated seeder key — allows a separate wallet funded only for seeding
	// without touching the shared agent/demo wallet.
	const b58 = process.env.X402_SEED_SOLANA_SECRET_BASE58
		|| process.env.X402_AGENT_SOLANA_SECRET_BASE58;
	if (b58) {
		const raw = bs58.decode(b58);
		if (raw.length !== 64) throw new Error(`seed keypair decoded to ${raw.length} bytes; expected 64`);
		return Keypair.fromSecretKey(raw);
	}
	// Local dev fallback — same path x402-pay.js uses.
	if (process.env.NODE_ENV !== 'production') {
		try {
			const arr = JSON.parse(readFileSync('/home/codespace/.config/x402-test-wallets/solana.json', 'utf8'));
			return Keypair.fromSecretKey(Uint8Array.from(arr));
		} catch { /* fall through */ }
	}
	throw new Error('seed keypair not configured (set X402_SEED_SOLANA_SECRET_BASE58)');
}

// Pick a random element from an array.
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Fetch one JSON endpoint — short timeout, returns { ok, status, body }.
async function fetchJson(url, opts = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			...opts,
			signal: controller.signal,
			headers: { 'user-agent': 'threews-x402-seed/1.0', ...opts.headers },
		});
		let body = null;
		const ct = res.headers.get('content-type') || '';
		if (ct.includes('application/json')) {
			try { body = await res.json(); } catch { /* non-JSON */ }
		} else {
			const text = await res.text();
			try { body = JSON.parse(text); } catch { body = text; }
		}
		return { ok: res.ok, status: res.status, body };
	} finally {
		clearTimeout(timer);
	}
}

// Parse a 402 challenge body to find the Solana accept entry.
function parseSolanaAccept(challengeBody) {
	if (!challengeBody || !Array.isArray(challengeBody.accepts)) return null;
	return challengeBody.accepts.find(
		(a) => typeof a?.network === 'string' && a.network.startsWith('solana'),
	) || null;
}

// Build and sign a USDC TransferChecked versioned transaction for x402.
// Caller provides a pre-fetched blockhash and mint to avoid per-call RPCs.
export function buildPaymentTx({ accept, buyer, blockhash, mintInfo, receiverAtaExists, index = 0 }) {
	const mint = new PublicKey(accept.asset);
	const payTo = new PublicKey(accept.payTo);
	const feePayer = new PublicKey(accept.extra.feePayer);
	const amount = BigInt(accept.amount);

	const senderAta = getAssociatedTokenAddressSync(
		mint, buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const receiverAta = getAssociatedTokenAddressSync(
		mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);

	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
		// The priority fee is what makes each transaction in a batch DISTINCT, and
		// it has to be: every other input (blockhash, amount, accounts, decimals) is
		// identical across the batch, so a fixed price made all N transactions
		// byte-identical. Identical bytes mean one signature, and the paid endpoint
		// derives paymentId by hashing the payment proof, so the whole batch
		// collided on a single id: one call landed and the rest 409'd on
		// writeConflict, while any that raced past the guard hit the chain as a
		// duplicate signature and settled as `broadcast_failed` with empty
		// simulation logs. Measured 2026-07-30: ~40 of 41 calls per tick lost, the
		// single largest source of 4xx on the fleet at 2,403/hour.
		// Cost of the spread is negligible: 60k CU * N microLamports is 0.06*N
		// lamports, so a full batch adds a few lamports in total.
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 + index }),
	];
	if (!receiverAtaExists) {
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(
			feePayer, receiverAta, payTo, mint,
			TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		));
	}
	ixs.push(createTransferCheckedInstruction(
		senderAta, mint, receiverAta, buyer.publicKey,
		amount, mintInfo.decimals, [], TOKEN_PROGRAM_ID,
	));

	const message = new TransactionMessage({
		payerKey: feePayer,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(message);
	vtx.sign([buyer]);
	return Buffer.from(vtx.serialize()).toString('base64');
}

/**
 * Decide what a tick should actually send, from the two wallet balances that
 * determine whether a payment can succeed at all.
 *
 * Every call in a batch shares one sponsor (pays the SOL fee) and one payer
 * (pays the USDC), so both conditions are decided before the first transaction
 * is built. Without this gate a dry treasury turns each tick into `batchSize`
 * doomed payments: observed 2026-07-26, 6,314 `fee_wallet_below_floor` settle
 * failures and 745 `simulation_failed` verify rejects, i.e. hours of 502s on
 * /api/x402/dance-tip plus wasted RPC, for an outcome fixed in advance. The
 * ring tick and the autonomous loop already gate on these; the seeder was the
 * last paid lane that did not.
 *
 * A `null` balance means the read FAILED, not zero. Unknown leaves the path
 * open (the same contract readPayerUsdcAtomic documents) so that a transient
 * RPC blip can never silently halt seeding.
 *
 * @param {object} a
 * @param {number|null} a.sponsorSolLamports  fee payer's SOL, or null if unread
 * @param {number|null} a.payerUsdcAtomic     seeder's USDC (6dp), or null if unread
 * @param {number} a.priceAtomic              price of one call, atomic USDC
 * @param {number} a.batchSize                configured calls per tick
 * @returns {{ skip: string|null, batch: number }} `skip` names the blocking
 *   condition (and `batch` is 0); otherwise `batch` is what the payer can fund.
 */
export function planSeedBatch({ sponsorSolLamports, payerUsdcAtomic, priceAtomic, batchSize }) {
	if (sponsorSolLamports !== null && sponsorSolLamports < SPONSOR_SOL_FLOOR_LAMPORTS) {
		return { skip: 'sponsor_sol_below_floor', batch: 0 };
	}
	// A price of 0 would make "how many can we afford" meaningless; treat an
	// unusable price as unknown and let the configured batch stand.
	if (!Number.isFinite(priceAtomic) || priceAtomic <= 0 || payerUsdcAtomic === null) {
		return { skip: null, batch: batchSize };
	}
	const affordable = Math.floor(payerUsdcAtomic / priceAtomic);
	if (affordable < 1) return { skip: 'payer_usdc_exhausted', batch: 0 };
	// Right-size rather than overshoot: a float that funds 12 of 60 tips should
	// send 12 real payments, not 60 of which 48 fail at verify.
	return { skip: null, batch: Math.min(batchSize, affordable) };
}

// Push an entry to the shared x402 activity feed in Redis.
async function pushFeedEntry(entry) {
	const r = getRedis();
	if (!r) return;
	try {
		await r.lpush(FEED_KEY, JSON.stringify(entry));
		await r.ltrim(FEED_KEY, 0, FEED_MAX - 1);
	} catch (err) {
		log.warn('feed_push_failed', { message: err?.message });
	}
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default wrapCron(async (req, res) => {
	if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
	if (!requireCron(req, res)) return;

	if (process.env.X402_SEED_ENABLED === 'false') {
		return json(res, 200, { ok: true, skipped: true, reason: 'X402_SEED_ENABLED=false' });
	}

	const BATCH_SIZE = Math.max(1, Math.min(
		120,
		Number(process.env.X402_SEED_BATCH_SIZE || 60),
	));

	const origin = ORIGIN();

	// ── Pre-flight: verify Redis is reachable ─────────────────────────────────
	// The dance-tip payment handler uses the x402VerifyIp rate-limiter which is
	// CRITICAL (fails closed when Redis is unavailable). If Redis is down, every
	// payment in the batch will return 429 — generating thousands of useless
	// errors and burning Solana RPC calls. Skip the tick entirely when Redis is
	// unhealthy so the cron stays silent rather than flooding logs.
	const redis = getRedis();
	if (redis) {
		try {
			await redis.ping();
		} catch (err) {
			if (!err?.circuitOpen && !isRedisAuthError(err)) log.warn('redis_unavailable_skip', { message: err?.message });
			return json(res, 200, { ok: false, skipped: true, reason: `redis_unavailable: ${err?.message}` });
		}
	}

	// ── Step 1: probe dance-tip for live payment requirements ─────────────────
	const probeUrl = `${origin}/api/x402/dance-tip?dancer=1&dance=hiphop`;
	const probe = await fetchJson(probeUrl);
	if (probe.status !== 402 || !probe.body) {
		return json(res, 200, {
			ok: false,
			reason: `dance-tip probe returned ${probe.status} (expected 402)`,
		});
	}
	const accept = parseSolanaAccept(probe.body);
	if (!accept) {
		return json(res, 200, { ok: false, reason: 'no Solana accept in 402 challenge' });
	}
	if (!accept.extra?.feePayer) {
		return json(res, 200, { ok: false, reason: 'Solana accept missing feePayer' });
	}
	if (!USDC_MINT || accept.asset !== USDC_MINT) {
		return json(res, 200, {
			ok: false,
			reason: `unexpected asset in accept: ${accept.asset} (expected ${USDC_MINT})`,
		});
	}

	// ── Step 2: load keypair, fetch shared blockhash + mint info ──────────────
	let buyer;
	try { buyer = loadSeedKeypair(); } catch (err) {
		return json(res, 200, { ok: false, reason: err.message });
	}

	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
	// The two balance reads ride along in this batch, so the preflight below
	// costs no extra wall-clock on a healthy tick.
	const [{ blockhash }, mintInfo, receiverAtaInfo, sponsorSolLamports, payerUsdcAtomic] =
		await Promise.all([
			conn.getLatestBlockhash('confirmed'),
			getMint(conn, new PublicKey(accept.asset)),
			conn.getAccountInfo(getAssociatedTokenAddressSync(
				new PublicKey(accept.asset),
				new PublicKey(accept.payTo),
				false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
			)),
			conn.getBalance(new PublicKey(accept.extra.feePayer), 'confirmed').catch(() => null),
			readPayerUsdcAtomic(conn, buyer.publicKey),
		]);
	const receiverAtaExists = receiverAtaInfo !== null;

	// ── Pre-flight: never fire a batch whose outcome is already decided ───────
	const plan = planSeedBatch({
		sponsorSolLamports,
		payerUsdcAtomic,
		priceAtomic: Number(accept.amount),
		batchSize: BATCH_SIZE,
	});
	if (plan.skip) {
		log.warn(`${plan.skip}_skip`, {
			feePayer: accept.extra.feePayer,
			payer: buyer.publicKey.toBase58(),
			sponsor_lamports: sponsorSolLamports,
			payer_usdc_atomic: payerUsdcAtomic,
		});
		return json(res, 200, {
			ok: false,
			skipped: true,
			reason: plan.skip,
			feePayer: accept.extra.feePayer,
			payer: buyer.publicKey.toBase58(),
			sponsor_sol: sponsorSolLamports === null ? null : sponsorSolLamports / 1e9,
			floor_sol: SPONSOR_SOL_FLOOR_LAMPORTS / 1e9,
			payer_usdc: payerUsdcAtomic === null ? null : payerUsdcAtomic / 1e6,
			price_usdc: Number(accept.amount) / 1e6,
		});
	}

	// ── Step 3: build the signed transactions (synchronous) ───────────────────
	const affordable = plan.batch;
	const txBases = Array.from({ length: affordable }, (_, index) =>
		buildPaymentTx({ accept, buyer, blockhash, mintInfo, receiverAtaExists, index }),
	);

	// ── Step 4: fire all in parallel ──────────────────────────────────────────
	const resourceUrl = `${origin}/api/x402/dance-tip`;
	const paymentPayloadTemplate = {
		x402Version: 2,
		scheme: 'exact',
		network: accept.network,
		resource: { url: resourceUrl, mimeType: 'application/json' },
		accepted: accept,
	};

	const results = await Promise.allSettled(
		txBases.map((txBase64, i) => {
			const dancer = DANCERS[i % DANCERS.length];
			const style = pick(STYLES);
			const xPayment = Buffer.from(JSON.stringify({
				...paymentPayloadTemplate,
				payload: { transaction: txBase64 },
			})).toString('base64');

			return fetchJson(
				`${origin}/api/x402/dance-tip?dancer=${dancer}&dance=${style}`,
				{ headers: { 'X-PAYMENT': xPayment } },
			).then((r) => ({ ok: r.ok, status: r.status, dancer, style, ticket: r.body }));
		}),
	);

	// ── Step 5: record successful payments in the x402 feed ──────────────────
	const succeeded = results
		.filter((r) => r.status === 'fulfilled' && r.value.ok)
		.map((r) => r.value);
	const failed = results.filter(
		(r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok),
	).length;

	const feedTs = Date.now();
	if (succeeded.length > 0) {
		// Push one aggregated feed entry per tick so the activity feed ticks
		// without flooding it with 60 individual rows.
		void pushFeedEntry({
			ts: feedTs,
			tool: 'dance-tip',
			argsSummary: `seed ×${succeeded.length}`,
			network: accept.network,
			amount: accept.amount,
			batch: succeeded.length,
			payer: buyer.publicKey.toBase58(),
			payTo: accept.payTo,
		}).catch(() => {});
	}

	const payerAddress = buyer.publicKey.toBase58();
	log.info('x402_seed_tick', {
		batch: affordable,
		configured_batch: BATCH_SIZE,
		succeeded: succeeded.length,
		failed,
		payer: payerAddress,
		payTo: accept.payTo,
		amount_atomics: accept.amount,
	});

	return json(res, 200, {
		ok: true,
		batch: affordable,
		configured_batch: BATCH_SIZE,
		succeeded: succeeded.length,
		failed,
		payer: payerAddress,
		payTo: accept.payTo,
		network: accept.network,
		amount_atomics: accept.amount,
		price_usdc: (Number(accept.amount) / 1e6).toFixed(4),
		total_usdc: ((succeeded.length * Number(accept.amount)) / 1e6).toFixed(4),
	});
});
