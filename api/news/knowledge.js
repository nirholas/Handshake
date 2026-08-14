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
//
// Every row this endpoint serves carries real extracted body text. A story the
// extraction ladder could not read is not knowledge, so it never appears here
// and its id answers 404 rather than a headline-only shell.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getExtraction, queryKnowledge, knowledgeStats } from '../_lib/news-knowledge-store.js';
import { suppression, isSuppressed, excerptParagraphs } from '../_lib/news-rights.js';

// The corpus stores each story's full body so the agents' grounding layer can
// reason over it server-side. This endpoint is public and CORS-open, so the
// same rights boundary the reader uses applies on the way out: withdrawn
// stories are dropped entirely, and `paragraphs` is capped to a lead excerpt.
// Callers wanting the whole article follow `url` to the publisher.
// A row only belongs in the grounding corpus if it actually carries extracted
// body text. Zero-content rows are the residue of a story every extraction
// rung refused (a paywall, a bot wall, or a link that was never an article):
// they hold a headline and nothing an agent can reason over, and they are the
// shape a drive-by write to /api/news/article leaves behind. Filtered here so
// the corpus already on disk is clean on the way out, not just from now on.
function hasBody(record) {
	return Number(record?.content_chars) > 0;
}

function publicRecord(record) {
	if (!record) return record;
	if (!Array.isArray(record.paragraphs)) return record;
	const { paragraphs, truncated } = excerptParagraphs(record.paragraphs);
	return { ...record, paragraphs, excerpt_truncated: truncated, full_text_url: record.url };
}

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
		const sup = suppression({ id });
		if (sup) return error(res, 410, 'removed', 'this story was withdrawn at the rightsholder’s request');
		const record = await getExtraction(id);
		if (!record || !hasBody(record)) return error(res, 404, 'not_found', 'no knowledge recorded for this story yet');
		if (isSuppressed(record)) return error(res, 410, 'removed', 'this story was withdrawn at the rightsholder’s request');
		return json(res, 200, publicRecord(record), headers);
	}

	if (ticker && !/^[A-Za-z0-9]{1,12}$/.test(ticker)) {
		return error(res, 400, 'bad_ticker', 'ticker must be a symbol like BTC');
	}
	if (q.length > 120) return error(res, 400, 'bad_query', 'query too long');

	const [articles, stats] = await Promise.all([
		queryKnowledge({ ticker: ticker || null, q: q || null, limit, full }),
		knowledgeStats(),
	]);
	const visible = articles.filter((a) => hasBody(a) && !isSuppressed(a)).map(publicRecord);
	return json(res, 200, { articles: visible, stats, query: { ticker: ticker || null, q: q || null, full } }, headers);
});
