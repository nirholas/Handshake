/**
 * Oracle: live conviction feed.
 *
 *   GET /api/oracle/feed?network=mainnet&limit=50&min_score=0&tier=strong&category=ai
 *
 * Serves the materialized oracle_conviction cache (one fast indexed read). On a
 * cold cache it opportunistically scores a handful of recent coins straight from
 * the data brain (no LLM, DB-only, fast) so the feed is never empty before the
 * ingestion augmentor has swept. Also returns the conviction-tier backtest so
 * the UI can prove the edge.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isDbUnavailableError } from '../_lib/db.js';
import { readFeed, convictionBacktest, scoreCoin } from '../_lib/oracle/store.js';
import { recentMints } from '../_lib/oracle/sources.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const TIERS = new Set(['prime', 'strong', 'lean', 'watch', 'avoid']);
const CATEGORIES = new Set(['meme', 'tech', 'ai', 'culture', 'community', 'political', 'news', 'animal', 'celebrity', 'utility', 'unknown']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const p = url.searchParams;
	const network = NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';
	const limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 50));
	const minScore = Math.max(0, Math.min(100, Number(p.get('min_score')) || 0));
	const tier = TIERS.has(p.get('tier')) ? p.get('tier') : null;
	const category = CATEGORIES.has(p.get('category')) ? p.get('category') : null;

	let items = await safeFeed({ network, limit, minScore, tier, category });

	// Cold-start warm: if the cache is empty, score a few recent brain coins
	// (DB-only, no LLM) so the page has something real to render immediately.
	if (items.length === 0) {
		const mints = await recentMints({ network, limit: 8, sinceSeconds: 6 * 3600 }).catch(() => []);
		await Promise.allSettled(mints.map((m) => scoreCoin(m, { network, classify: false, persist: true })));
		items = await safeFeed({ network, limit, minScore, tier, category });
	}

	const backtest = await convictionBacktest({ network }).catch(() => []);

	return json(res, 200, {
		network,
		count: items.length,
		items,
		backtest,
		generated_at: new Date().toISOString(),
	}, { 'Cache-Control': 'public, max-age=3, stale-while-revalidate=15' });
});

// A read fault degrades to an empty feed, which the cold-start path above then
// tries to warm. A connectivity failure must NOT take that route: it is not "no
// coins scored yet", and treating it as one made the outage far more expensive
// than the outage itself. Every request answered 200 with an empty feed (so the
// page rendered a dead market as fact), and on the way there it fired eight
// scoreCoin() calls that could not possibly persist. Rethrowing hands it to
// wrap() for the shared 503 + Retry-After and skips the pointless warm attempt.
async function safeFeed(opts) {
	try {
		return await readFeed(opts);
	} catch (err) {
		if (isDbUnavailableError(err)) throw err;
		return [];
	}
}
