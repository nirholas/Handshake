// `crypto_news` — FREE MCP tool: live crypto headlines from the three.ws
// native aggregator (192 publisher RSS/Atom feeds across 27 categories and
// 17 languages, per-source cached with serve-stale-on-error). No payment, no
// key. Backed by GET /api/news/feed — the same endpoint behind
// three.ws/markets/news.

import { z } from 'zod';

import { free } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { NEWS_API_BASE, newsApiGet, slimArticle } from './_news-core.js';

const TOOL_NAME = 'crypto_news';
const TOOL_DESCRIPTION =
	'Live crypto news headlines aggregated by three.ws directly from 192 publisher RSS/Atom feeds — ' +
	'CoinDesk, The Block, Decrypt, CoinTelegraph, SEC press, exchange blogs, research desks, and ' +
	'international outlets in 17 languages. Filter by category (bitcoin, ethereum, solana, defi, nft, ' +
	'trading, research, security, regulation-adjacent geopolitical, and more), by a single source key, ' +
	'by language, or full-text search the headlines. Each article returns title, publisher link, source, ' +
	'publish time, detected tickers, and lexicon sentiment. An invalid category/source errors with the ' +
	'valid list, so retry from that. For the day grouped into stories use crypto_news_digest; for ' +
	'coverage older than a few days use crypto_news_archive. Free — no payment or API key required.';

const inputZodShape = {
	q: z.string().max(80).describe('Full-text filter over title/description/tickers, e.g. "bitcoin etf" or "SOL".').optional(),
	category: z
		.string()
		.max(24)
		.describe('One category slug, e.g. bitcoin, ethereum, solana, defi, nft, trading, research, onchain, security, mainstream, geopolitical, journalism. Omit for all. Invalid values error with the full list.')
		.optional(),
	source: z.string().max(40).describe('A single source key (e.g. coindesk, theblock, sec_press) — overrides category and lang.').optional(),
	lang: z
		.string()
		.max(5)
		.describe('Language code: en (default), or any of the 17 registry languages (zh, ja, ko, es, de, fr, …), or "all" to interleave every language.')
		.optional(),
	limit: z.number().int().min(1).max(50).describe('Max articles to return (default 20).').optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

async function runCryptoNews({ q, category, source, lang, limit = 20 } = {}) {
	const body = await newsApiGet('/api/news/feed', { q, category, source, lang, limit });
	if (body.ok === false) return body; // toolError envelope, verbatim

	return {
		ok: true,
		total_matching: body.total,
		count: body.articles.length,
		sources_live: `${body.sources_ok}/${body.sources_total}`,
		fetched_at: body.fetched_at,
		articles: body.articles.map(slimArticle),
		browse_url: `${NEWS_API_BASE}/markets/news${q ? `?q=${encodeURIComponent(q)}` : ''}`,
		rss_url: `${NEWS_API_BASE}/api/news/rss`,
	};
}

export function buildCryptoNewsTool() {
	const handler = free({ toolName: TOOL_NAME, inputSchema: inputJsonSchema }, (args) => runCryptoNews(args));
	return {
		name: TOOL_NAME,
		title: 'Crypto news (live, 192 feeds)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Read-only view over a live feed: repeat calls are safe but not
		// byte-identical (new stories arrive), and it reaches the open web.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
