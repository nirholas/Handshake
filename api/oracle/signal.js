/**
 * Oracle — agent signal endpoint (machine-optimized).
 *
 *   GET /api/oracle/signal?network=mainnet&min_score=72&category=ai&limit=5
 *   GET /api/oracle/signal?mint=<mint>                     → verdict for one coin
 *
 * The compact read a user's 3D AI agent polls to act fast. Returns the current
 * highest-conviction plays (or a single coin's verdict) with an explicit,
 * agent-friendly recommendation derived from the fused tier — so an autonomous
 * agent doesn't have to re-implement the decision rules to decide whether to buy.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isDbUnavailableError } from '../_lib/db.js';
import { readFeed, scoreCoin } from '../_lib/oracle/store.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const CATEGORIES = new Set(['meme', 'tech', 'ai', 'culture', 'community', 'political', 'news', 'animal', 'celebrity', 'utility', 'unknown']);
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Tier → agent-readable recommendation + a suggested fraction of the agent's
// per-trade size. Conservative by design: only prime/strong are "act".
const REC = {
	prime: { action: 'buy', confidence: 'high', size_factor: 1.0, note: 'top-conviction play — proven money in a clean, on-narrative launch' },
	strong: { action: 'buy', confidence: 'medium', size_factor: 0.75, note: 'strong conviction — favorable across pedigree and structure' },
	lean: { action: 'watch', confidence: 'low', size_factor: 0, note: 'leaning positive but not decisive — watch for confirmation' },
	watch: { action: 'skip', confidence: 'low', size_factor: 0, note: 'inconclusive — no edge yet' },
	avoid: { action: 'skip', confidence: 'high', size_factor: 0, note: 'structural or pedigree red flags — avoid' },
};

function shape(it) {
	const rec = REC[it.tier] || REC.avoid;
	return {
		mint: it.mint,
		symbol: it.symbol,
		conviction: it.score,
		tier: it.tier,
		category: it.category,
		smart_wallet_count: it.smart_wallet_count,
		pillars: it.pillars,
		badges: it.badges,
		recommendation: rec,
		scored_at: it.scored_at,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const p = url.searchParams;
	const network = NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';

	// Single-coin verdict.
	const mint = (p.get('mint') || '').trim();
	if (mint) {
		if (!MINT_RE.test(mint)) return error(res, 400, 'validation_error', 'invalid mint');
		let scored;
		try {
			scored = await scoreCoin(mint, { network, classify: true, persist: true });
		} catch {
			// Downstream intel store / DB outage — not a true "not observed". 503 so
			// the transient failure isn't cached by clients as a permanent 404.
			return error(res, 503, 'scoring_unavailable', 'signal scoring is temporarily unavailable — retry shortly');
		}
		if (!scored) return error(res, 404, 'not_found', 'mint not observed yet');
		const v = scored.verdict;
		return json(res, 200, {
			network, mint,
			signal: shape({
				mint, symbol: scored.intel.symbol, score: v.score, tier: v.tier,
				category: scored.intel.category, smart_wallet_count: scored.intel.smartMoney?.smartWalletCount || 0,
				pillars: v.pillars, badges: v.badges, scored_at: new Date().toISOString(),
			}),
			generated_at: new Date().toISOString(),
		});
	}

	// Top plays.
	const minScore = Math.max(0, Math.min(100, Number(p.get('min_score')) || 72));
	const category = CATEGORIES.has(p.get('category')) ? p.get('category') : null;
	const limit = Math.min(25, Math.max(1, Number(p.get('limit')) || 5));

	// An autonomous agent reads `count: 0` as "the oracle sees no plays right now"
	// and stands down. During a DB outage that is a wrong answer dressed as a
	// verdict, and the single-mint branch above already refuses to fake one, so
	// the list branch answers the same way: propagate (wrap() → 503 + Retry-After)
	// on a connectivity failure, degrade to an empty board on a statement fault.
	const items = await readFeed({ network, limit, minScore, category, sinceSeconds: 6 * 3600 })
		.catch((err) => {
			if (isDbUnavailableError(err)) throw err;
			return [];
		});
	const plays = items.map(shape);
	return json(res, 200, {
		network,
		count: plays.length,
		top: plays[0] || null,
		plays,
		generated_at: new Date().toISOString(),
	}, { 'Cache-Control': 'public, max-age=3, stale-while-revalidate=15' });
});
