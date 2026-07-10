// `crypto_news_digest` — FREE MCP tool: the last N hours of crypto coverage
// clustered into the handful of stories that actually matter, instead of a
// flat headline list. Backed by GET /api/news/digest — the same engine behind
// three.ws/markets/digest. No payment, no key.

import { z } from 'zod';

import { free } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { NEWS_API_BASE, newsApiGet } from './_news-core.js';

const TOOL_NAME = 'crypto_news_digest';
const TOOL_DESCRIPTION =
	'The crypto news cycle, clustered: groups the last N hours (1–72, default 24) of coverage from the ' +
	'three.ws aggregator into distinct narratives, each with a title, a plain-language summary, a ' +
	'bullish/bearish/neutral stance, the tickers involved, a coverage count, and links to every real ' +
	'article behind it. The response names the clustering engine honestly — "llm" (semantic grouping via ' +
	'the platform model chain, with hallucinated citations dropped) or "heuristic" (keyword+ticker ' +
	'Jaccard clustering) — plus an overall market mood and the most-covered tickers for the window. ' +
	'Ideal first call for "what happened in crypto today". For raw headlines use crypto_news; for ' +
	'history use crypto_news_archive. Free — no payment or API key required.';

const inputZodShape = {
	hours: z.number().int().min(1).max(72).describe('Coverage window in hours (default 24).').optional(),
	limit: z.number().int().min(3).max(12).describe('Max narratives to return (default 8).').optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

async function runCryptoNewsDigest({ hours = 24, limit = 8 } = {}) {
	const body = await newsApiGet('/api/news/digest', { hours, limit }, { timeoutMs: 60_000 });
	if (body.ok === false) return body;

	return {
		ok: true,
		window_hours: body.window_hours,
		mood: body.mood,
		top_tickers: body.top_tickers,
		articles_considered: body.articles_considered,
		engine: body.engine,
		generated_at: body.generated_at,
		narratives: body.narratives.map((n) => ({
			title: n.title,
			summary: n.summary,
			stance: n.stance,
			tickers: n.tickers?.length ? n.tickers : undefined,
			coverage: n.coverage,
			articles: n.articles.map((a) => ({ title: a.title, link: a.link, source: a.source, published: a.pub_date })),
		})),
		browse_url: `${NEWS_API_BASE}/markets/digest${hours !== 24 ? `?hours=${hours}` : ''}`,
	};
}

export function buildCryptoNewsDigestTool() {
	const handler = free({ toolName: TOOL_NAME, inputSchema: inputJsonSchema }, (args) =>
		runCryptoNewsDigest(args),
	);
	return {
		name: TOOL_NAME,
		title: 'Crypto news digest (clustered)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Read-only; the digest regenerates as coverage moves, so calls are
		// safe to repeat but not byte-identical.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
