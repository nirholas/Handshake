// `crypto_news_archive` — FREE MCP tool over the largest open crypto-news
// archive: 660,000+ enriched articles from September 2017 to today (refreshed
// hourly from the live feed), hosted on three.ws infrastructure. Backed by
// GET /api/news/archive — the same engine behind three.ws/markets/archive.
// No payment, no key.

import { z } from 'zod';

import { free } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { NEWS_API_BASE, newsApiGet, slimArticle } from './_news-core.js';

const TOOL_NAME = 'crypto_news_archive';
const TOOL_DESCRIPTION =
	'Search the largest open crypto-news archive: 660,000+ articles from September 2017 to today ' +
	'(CryptoPanic english corpus + Odaily chinese corpus + the three.ws live archiver, refreshed hourly), ' +
	'every record enriched with tickers, tags, sentiment, language, and — where captured — the market ' +
	'context at publication (BTC/ETH price, Fear & Greed). Query by keyword, ticker (e.g. BTC), source, ' +
	'date range, sentiment, or language (en/zh). mode="stats" returns corpus statistics; mode="trending" ' +
	'returns the most-covered tickers of the newest archived weeks. IMPORTANT: search scans months ' +
	'newest→oldest and reports exactly which months it covered (scanned.complete=false means older months ' +
	'remain) — pass start_date/end_date to reach a specific era, e.g. the 2017 ICO boom or the 2022 FTX ' +
	'collapse. For today\'s coverage use crypto_news or crypto_news_digest. Free — no payment or API key required.';

const inputZodShape = {
	mode: z
		.enum(['search', 'stats', 'trending'])
		.describe('search (default) queries articles; stats returns corpus statistics; trending returns the most-covered tickers of the newest archived weeks.')
		.optional(),
	q: z.string().max(120).describe('Full-text query over title + description, e.g. "bitcoin etf" or "mt gox".').optional(),
	ticker: z.string().max(12).describe('Filter to articles tagged with this ticker, e.g. BTC, SOL.').optional(),
	source: z.string().max(40).describe('Filter by source key or name substring, e.g. coindesk, odaily.').optional(),
	sentiment: z.enum(['positive', 'negative', 'neutral']).describe('Filter by enriched sentiment.').optional(),
	lang: z.enum(['en', 'zh']).describe('Filter by article language.').optional(),
	start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Earliest publish date, YYYY-MM-DD (archive starts 2017-09-23).').optional(),
	end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Latest publish date, YYYY-MM-DD.').optional(),
	limit: z.number().int().min(1).max(100).describe('Max articles to return (default 25).').optional(),
	offset: z.number().int().min(0).max(5000).describe('Pagination offset within the scanned window.').optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

async function runCryptoNewsArchive(args = {}) {
	const { mode = 'search', q, ticker, source, sentiment, lang, start_date, end_date, limit = 25, offset } = args;

	if (mode === 'stats') {
		const body = await newsApiGet('/api/news/archive', { stats: 'true' });
		if (body.ok === false) return body;
		return { ok: true, ...body, browse_url: `${NEWS_API_BASE}/markets/archive` };
	}
	if (mode === 'trending') {
		const body = await newsApiGet('/api/news/archive', { trending: 'true' });
		if (body.ok === false) return body;
		return { ok: true, ...body, browse_url: `${NEWS_API_BASE}/markets/archive` };
	}

	const body = await newsApiGet(
		'/api/news/archive',
		{ q, ticker, source, sentiment, lang, start_date, end_date, limit, offset },
		{ timeoutMs: 60_000 },
	);
	if (body.ok === false) return body;

	const out = {
		ok: true,
		matches_in_scanned_window: body.total_scanned_matches,
		count: body.articles.length,
		has_more: body.has_more,
		scanned: body.scanned,
		articles: body.articles.map((a) => ({
			...slimArticle(a),
			market_context: a.market_context || undefined,
		})),
		browse_url: `${NEWS_API_BASE}/markets/archive`,
	};
	// The API's own coverage hint tells the model how to reach older months.
	if (body.hint) out.hint = body.hint;
	return out;
}

export function buildCryptoNewsArchiveTool() {
	const handler = free({ toolName: TOOL_NAME, inputSchema: inputJsonSchema }, (args) =>
		runCryptoNewsArchive(args),
	);
	return {
		name: TOOL_NAME,
		title: 'Crypto news archive (660k+, 2017→)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Historical corpus reads are stable for date-bounded queries; the
		// newest month keeps growing hourly, so not strictly idempotent.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
