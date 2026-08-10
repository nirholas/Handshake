// GET /api/agent-trade/skill: Oracle agent's paid market-analysis skill.
//
// Without ?sig=  → HTTP 402 with x402 price manifest:
//   { x402:true, price:{sol,lamports}, currency:'SOL', recipient, network, memo }
//
// With ?sig=<base58-txSig>&topic=<topic>&buyer=<buyerAddr>
//   → Verifies payment on-chain, runs IBM Granite (or Claude fallback),
//     returns { content, model, provider, topic, payment:{sig,lamports,blockTime} }
//
// Independently callable by any agent, not coupled to the demo orchestrator.

import bs58 from 'bs58';
import { loadAvatarKeypair, getConnection, LAMPORTS_PER_SOL } from '../_lib/avatar-wallet.js';
import { watsonxConfig, watsonxChatComplete } from '../_lib/watsonx.js';
import { llmComplete } from '../_lib/llm.js';
import { cors, method, json, error, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheGet, cacheSet, cacheDel } from '../_lib/cache.js';

const DEFAULT_PRICE_SOL = 0.001;
const MAX_PAYMENT_AGE_SEC = 300; // 5 minutes
// Consumed-signature ledger: one verified tx signature buys exactly one call.
// TTL is 3× the freshness window, so a signature is remembered for the entire
// period during which verifyPayment would still accept it (and then some).
const SIG_CONSUMED_TTL_SEC = 900; // 15 minutes
const sigConsumedKey = (sig) => `x402-skill-sig:${sig}`;

// A Solana transaction signature is exactly 64 bytes of base58. Checking that
// here, before any RPC work, keeps a junk `sig` from costing three getTransaction
// round-trips plus two seconds of back-off per request, and from tripping the
// shared RPC pool's per-method circuit breaker: an "Invalid param: WrongSize"
// reply is indistinguishable, to the breaker, from a provider refusing the
// method, so garbage input was demoting healthy RPC endpoints for other callers.
function isSignatureShaped(sig) {
	try {
		return bs58.decode(sig).length === 64;
	} catch {
		return false;
	}
}

function skillConfig() {
	const sellerSecret = process.env.AGENT_SELLER_SECRET || '';
	const network =
		(process.env.AGENT_TRADE_NETWORK || 'mainnet').toLowerCase() === 'devnet'
			? 'devnet'
			: 'mainnet';
	const rpcUrl =
		network === 'devnet'
			? process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com'
			: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const priceSol = Math.max(
		0.000001,
		parseFloat(process.env.AGENT_TRADE_PRICE_SOL || String(DEFAULT_PRICE_SOL)),
	);
	const priceLamports = Math.round(priceSol * LAMPORTS_PER_SOL);

	let sellerAddress = null;
	let configured = false;
	if (sellerSecret) {
		try {
			sellerAddress = loadAvatarKeypair(sellerSecret).publicKey.toBase58();
			configured = true;
		} catch {
			/* misconfigured secret */
		}
	}
	return { configured, sellerAddress, network, rpcUrl, priceSol, priceLamports };
}

// Verify that sig is a confirmed Solana transfer of at least priceLamports to sellerAddress.
// Retries 3x with 1s back-off, because public RPC can lag a fresh confirmation.
async function verifyPayment(connection, sig, { sellerAddress, priceLamports, buyerAddress }) {
	let lastErr;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
		let tx;
		try {
			tx = await connection.getTransaction(sig, {
				commitment: 'confirmed',
				maxSupportedTransactionVersion: 0,
			});
		} catch (e) {
			lastErr = e;
			continue;
		}
		if (!tx?.meta) continue;

		// No blockTime means the cluster cannot tell us WHEN this settled, so the
		// freshness window is unenforceable and the payment cannot be accepted.
		// Reporting that honestly matters: calling it "expired" sent buyers off to
		// re-send a payment whose age was never the problem.
		if (!tx.blockTime) {
			throw Object.assign(new Error('transaction has no block time; cannot verify payment freshness'), {
				code: 'bad_payment',
			});
		}

		const age = Date.now() / 1000 - tx.blockTime;
		if (age > MAX_PAYMENT_AGE_SEC) {
			throw Object.assign(new Error('payment expired (>5 min old)'), {
				code: 'payment_expired',
			});
		}

		const keys = (
			tx.transaction.message.staticAccountKeys ||
			tx.transaction.message.accountKeys ||
			[]
		).map((k) => k.toString());

		const sellerIdx = keys.indexOf(sellerAddress);
		if (sellerIdx === -1) {
			throw Object.assign(new Error('seller address not in transaction'), {
				code: 'bad_payment',
			});
		}
		if (buyerAddress) {
			const buyerIdx = keys.indexOf(buyerAddress);
			if (buyerIdx === -1) {
				throw Object.assign(new Error('buyer address not in transaction'), {
					code: 'bad_payment',
				});
			}
		}

		const sellerGain =
			(tx.meta.postBalances[sellerIdx] || 0) - (tx.meta.preBalances[sellerIdx] || 0);
		// Allow 1% tolerance for minor rounding
		if (sellerGain < priceLamports * 0.99) {
			throw Object.assign(
				new Error(`payment too small: got ${sellerGain} lamports, need ${priceLamports}`),
				{ code: 'bad_payment' },
			);
		}

		return { verified: true, lamports: sellerGain, blockTime: tx.blockTime };
	}
	throw Object.assign(
		new Error(
			lastErr ? `RPC error: ${lastErr.message}` : 'transaction not found after 3 attempts',
		),
		{ code: 'tx_not_found' },
	);
}

async function generateAnalysis(topic) {
	// The buyer has already paid on-chain by the time this runs, so a watsonx
	// outage must not turn their purchase into an error: a Granite failure
	// degrades to the platform LLM chain below instead of propagating.
	const wx = watsonxConfig();
	if (wx.configured) {
		try {
			const messages = [
				{
					role: 'user',
					content: `Provide a concise 2 to 3 sentence crypto market insight on: ${topic}. Be specific, data-driven, and actionable.`,
				},
			];
			const { text } = await watsonxChatComplete(wx, {
				messages,
				maxTokens: 200,
				temperature: 0.7,
			});
			return {
				content: text?.trim() || '',
				model: wx.chatModel || 'ibm/granite-3-8b-instruct',
				provider: 'IBM Granite',
			};
		} catch (err) {
			console.warn(`[agent-trade:skill] watsonx failed (${err?.message}); falling back to platform LLM chain`);
		}
	}

	// Platform LLM policy (api/_lib/llm.js): free providers first, paid keys as
	// the automatic last resort, so a dead Anthropic key cannot fail a paid call.
	const { text, model, provider } = await llmComplete({
		system: 'You are a concise crypto market analyst. Respond in 2 to 3 sharp sentences.',
		user: `Market insight on: ${topic}`,
		maxTokens: 200,
		track: { tool: 'agent-trade.skill' },
	});
	return { content: text, model, provider };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const cfg = skillConfig();
	if (!cfg.configured) {
		return error(
			res,
			503,
			'not_configured',
			'AGENT_SELLER_SECRET is not configured on this deployment.',
		);
	}

	const url = new URL(req.url, 'http://x');
	const sig = (url.searchParams.get('sig') || '').trim();
	const topic = (url.searchParams.get('topic') || 'crypto market trends').trim().slice(0, 200);
	const buyerAddress = (url.searchParams.get('buyer') || '').trim();

	// No payment proof → return 402 manifest
	if (!sig) {
		res.setHeader('Content-Type', 'application/json');
		res.statusCode = 402;
		res.end(
			JSON.stringify({
				x402: true,
				version: 'x402/0.1',
				skill: 'oracle-market-analysis',
				price: { sol: cfg.priceSol, lamports: cfg.priceLamports },
				currency: 'SOL',
				recipient: cfg.sellerAddress,
				network: cfg.network,
				memo: 'oracle-skill-v1',
			}),
		);
		return;
	}

	// Shape check before anything touches the chain (see isSignatureShaped).
	if (!isSignatureShaped(sig)) {
		return error(
			res,
			402,
			'bad_payment',
			'sig must be a base58-encoded 64-byte Solana transaction signature',
		);
	}

	// Replay check next: a consumed signature never buys a second call, and
	// rejecting before verification saves the RPC round-trips.
	const consumedKey = sigConsumedKey(sig);
	if (await cacheGet(consumedKey)) {
		return error(res, 402, 'payment_replayed', 'this payment signature has already been used');
	}

	// Has sig → verify on-chain then analyze
	const connection = getConnection(cfg.rpcUrl);
	let payment;
	try {
		payment = await verifyPayment(connection, sig, {
			sellerAddress: cfg.sellerAddress,
			priceLamports: cfg.priceLamports,
			buyerAddress,
		});
	} catch (e) {
		return error(res, 402, e.code || 'bad_payment', e.message);
	}

	// Mark the signature consumed BEFORE running the paid work so a concurrent
	// duplicate request can't double-spend it.
	await cacheSet(
		consumedKey,
		{ usedAt: Date.now(), buyer: buyerAddress || null, lamports: payment.lamports },
		SIG_CONSUMED_TTL_SEC,
	);

	let analysis;
	try {
		analysis = await generateAnalysis(topic);
	} catch (e) {
		// The buyer paid but got nothing, so release the signature and let a retry
		// within the freshness window isn't treated as a replay.
		await cacheDel(consumedKey).catch(() => {});
		return error(res, 502, 'analysis_failed', e.message);
	}

	return json(res, 200, {
		ok: true,
		topic,
		content: analysis.content,
		model: analysis.model,
		provider: analysis.provider,
		payment: {
			sig,
			lamports: payment.lamports,
			blockTime: payment.blockTime,
		},
	});
});
