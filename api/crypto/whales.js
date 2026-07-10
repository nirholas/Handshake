// GET /api/crypto/whales — FREE whale / large-buy activity for AI agents.
//
// Agent use-case: a trading or sniper agent, mid-task, wants to know if big
// money is moving into a token (or the pump.fun market broadly) BEFORE it
// commits. A whale already in = price impact ahead; no whales = thin. This is a
// free, keyless read of large buys — high signal, no account, no payment.
//
//   ?mint=<spl-mint>  → whale BUYS of that token (per-transaction rows)
//   (omit mint)       → top whale WALLETS active across pump.fun right now
//   ?minSol=<n>       → single-buy SOL threshold to qualify as a whale (default 5)
//   ?limit=<n>        → rows to return (default 10, max 25)
//
// Response: { scope, mint, whales:[{ wallet, solMoved, txHash, ts }], whaleCount,
//   totalSolMoved, signal:'bullish'|'bearish'|'neutral', ts, source }. The signal
// is a deterministic net-whale-flow rule (see api/_lib/pump-whale-scan.js
// computeSignal + docs/crypto-api.md), never an LLM.
//
// Never 500 on a well-formed request: no whales over threshold → 200 empty +
// neutral; feed down → 200 empty + a `note`. A paid, coarser version of this
// data lives at api/x402/pump-agent-audit.js; this is the free, cleaner read.

import { wrap, cors, method, json, error, rateLimited, setRateLimitHeaders } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import {
	scanTokenWhales,
	scanMarketWhales,
	WHALE_MIN_SOL_DEFAULT,
	WHALE_LIMIT_DEFAULT,
	WHALE_LIMIT_MAX,
} from '../_lib/pump-whale-scan.js';

// Base58 Solana mint pubkey (same shape the pump audit endpoint validates).
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// Public read bucket — keyless, generous, per-IP flood guard.
	const rl = await limits.marketDataIp(clientIp(req));
	setRateLimitHeaders(res, rl);
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const mintRaw = String(url.searchParams.get('mint') || '').trim();

	// minSol: positive number, default 5. Clamp to a sane floor so a whale is
	// always a meaningfully large buy; reject non-numeric input.
	let minSol = WHALE_MIN_SOL_DEFAULT;
	if (url.searchParams.has('minSol')) {
		const raw = Number(url.searchParams.get('minSol'));
		if (!Number.isFinite(raw) || raw <= 0) {
			return error(res, 400, 'invalid_min_sol', 'minSol must be a positive number', {
				example: '/api/crypto/whales?minSol=5',
			});
		}
		minSol = Math.max(0.1, raw);
	}

	// limit: 1..25, default 10.
	let limit = WHALE_LIMIT_DEFAULT;
	if (url.searchParams.has('limit')) {
		const raw = Number(url.searchParams.get('limit'));
		if (!Number.isFinite(raw) || raw < 1) {
			return error(res, 400, 'invalid_limit', 'limit must be a positive integer (max 25)', {
				example: '/api/crypto/whales?limit=10',
			});
		}
		limit = Math.min(WHALE_LIMIT_MAX, Math.floor(raw));
	}

	// Token scope requires a valid base58 mint; a malformed mint is a client error.
	if (mintRaw && !BASE58_RE.test(mintRaw)) {
		return error(res, 400, 'invalid_mint', 'mint must be a base58 Solana pubkey', {
			example: '/api/crypto/whales?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		});
	}

	const result = mintRaw
		? await scanTokenWhales({ mint: mintRaw, minSol, limit })
		: await scanMarketWhales({ minSol, limit });

	const { degraded, ...body } = result;
	body.minSol = minSol;
	// Feed down (no trades reachable) → 200 empty + a note, per the never-500 rule.
	if (degraded) {
		body.note =
			'pump.fun feed is temporarily unavailable — returning an empty whale set; retry shortly';
	}

	return json(res, 200, body, {
		// Whale activity turns over fast; a short shared-edge cache collapses
		// bursts of identical polls without making the read stale.
		'cache-control': 'public, s-maxage=15, stale-while-revalidate=45',
	});
});
