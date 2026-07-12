// GET /api/news/knowledge — the crypto knowledge base the 3D agents read from.
// ---------------------------------------------------------------------------
// Every story the reader fully extracts and analyzes is recorded to the durable
// news_knowledge table (api/_lib/news-knowledge-store.js): full body, AI
// summary + key points, sentiment, detected tickers with a market snapshot, and
// the named entities the story is about. This endpoint is the read side — the
// grounding surface an agent hits to answer "what's happening with SOL?" with
// real, sourced, recent context instead of a hallucination.
//
// Modes:
//   ?id=<16hex>                 → the full stored record for one story
//   ?ticker=SOL[&full=1]        → recent stories that mention a coin
//   ?q=<text>[&full=1]          → free-text search over titles + summaries
//   (none)                      → the latest recorded stories + corpus stats
//
// Lightweight rows by default; add &full=1 for the extracted body + coins.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getExtraction, queryKnowledge, knowledgeStats } from '../_lib/news-knowledge-store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const id = (params.get('id') || '').trim();
	const ticker = (params.get('ticker') || '').trim();
	const q = (params.get('q') || '').trim();
	const full = params.get('full') === '1' || params.get('full') === 'true';
	const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '20', 10) || 20), 100);

	const headers = { 'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600' };

	if (id) {
		if (!/^[a-f0-9]{16}$/.test(id)) return error(res, 400, 'bad_id', 'id must be a 16-hex article id');
		const record = await getExtraction(id);
		if (!record) return error(res, 404, 'not_found', 'no knowledge recorded for this story yet');
		return json(res, 200, record, headers);
	}

	if (ticker && !/^[A-Za-z0-9]{1,12}$/.test(ticker)) {
		return error(res, 400, 'bad_ticker', 'ticker must be a symbol like BTC');
	}
	if (q.length > 120) return error(res, 400, 'bad_query', 'query too long');

	const [articles, stats] = await Promise.all([
		queryKnowledge({ ticker: ticker || null, q: q || null, limit, full }),
		knowledgeStats(),
	]);
	return json(res, 200, { articles, stats, query: { ticker: ticker || null, q: q || null, full } }, headers);
});
