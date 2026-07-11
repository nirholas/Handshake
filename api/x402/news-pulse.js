// GET /api/x402/news-pulse?ticker=BTC&hours=24
//
// Ticker News Pulse — $0.002 USDC per call on Solana or Base. Measures how
// loudly the news cycle is talking about one ticker right now: mention count
// across the live output of the three.ws 192-feed news engine, unique outlets,
// sentiment split, coverage velocity vs the immediately preceding window, and
// the top headlines with links.
//
// Data is live: the in-repo news engine (api/_lib/news.js) — the same 192
// publisher feeds behind the free three.ws news API; articles arrive with
// tickers and lexicon sentiment pre-extracted. Zero mentions is a truthful,
// billable answer (silence is a signal). A dead feed engine throws BEFORE
// settlement so the buyer is never charged.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { getNews } from '../_lib/news.js';
import listing from '../_lib/service-catalog/services/news-pulse.js';

const ROUTE = '/api/x402/news-pulse';
const DESCRIPTION = listing.description;

// Wide page so both the current and the preceding comparison window are
// covered from one engine call; the engine itself caches per-source feeds.
const SAMPLE_LIMIT = 400;
const HEADLINE_COUNT = 5;
const HOUR_MS = 3_600_000;

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	...listing.inputSchema,
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ticker', 'window_hours', 'mentions', 'unique_sources', 'velocity', 'sentiment', 'headlines', 'ts'],
	properties: {
		ticker: { type: 'string' },
		window_hours: { type: 'integer', minimum: 1, maximum: 72 },
		mentions: { type: 'integer' },
		unique_sources: { type: 'integer' },
		velocity: {
			type: 'object',
			required: ['previous_window_mentions', 'change_pct', 'trend'],
			properties: {
				previous_window_mentions: { type: 'integer' },
				change_pct: { type: ['number', 'null'] },
				trend: { type: 'string', enum: ['accelerating', 'steady', 'cooling', 'quiet'] },
			},
		},
		sentiment: {
			type: 'object',
			required: ['score', 'positive', 'negative', 'neutral'],
			properties: {
				score: { type: ['number', 'null'] },
				positive: { type: 'integer' },
				negative: { type: 'integer' },
				neutral: { type: 'integer' },
			},
		},
		headlines: {
			type: 'array',
			items: {
				type: 'object',
				required: ['title', 'source', 'link', 'pub_date', 'sentiment'],
				properties: {
					title: { type: 'string' },
					source: { type: ['string', 'null'] },
					link: { type: ['string', 'null'] },
					pub_date: { type: ['string', 'null'], format: 'date-time' },
					sentiment: { type: 'string' },
				},
			},
		},
		ts: { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['narrative tracking', 'coverage velocity', 'ticker sentiment'],
	input: {
		type: 'query',
		example: listing.input,
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: listing.outputExample,
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('news-pulse', '2000'), // $0.002 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: listing.serviceName,
		tags: listing.tags,
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const params = new URL(req.url, 'http://x').searchParams;
		const rawTicker = (params.get('ticker') || '').trim().replace(/^\$/, '').toUpperCase();
		if (!/^[A-Z0-9]{2,10}$/.test(rawTicker)) {
			// Validation failure is thrown (not settled) so the buyer is not charged
			// for a malformed request — the wrapper maps this to a 422 before settle.
			throw Object.assign(new Error('ticker must be 2–10 alphanumeric characters, e.g. BTC'), {
				status: 422,
				code: 'invalid_ticker',
			});
		}
		const hoursRaw = Number(params.get('hours') || '24');
		const hours = Math.min(72, Math.max(1, Number.isFinite(hoursRaw) ? Math.floor(hoursRaw) : 24));

		let articles = null;
		let sourcesOk = 0;
		try {
			const page = await getNews({ limit: SAMPLE_LIMIT });
			articles = Array.isArray(page?.articles) ? page.articles : null;
			sourcesOk = Number(page?.sources_ok) || 0;
		} catch { /* refund below */ }
		// An empty engine (no articles from any source) is an outage, not a quiet
		// ticker — quietness is measured against a live feed, so refund instead.
		if (!articles || !articles.length || !sourcesOk) {
			throw Object.assign(new Error('the news feed engine is temporarily unavailable'), {
				status: 503,
				code: 'data_unavailable',
			});
		}

		const now = Date.now();
		const windowStart = now - hours * HOUR_MS;
		const prevStart = now - 2 * hours * HOUR_MS;

		const mentionsTicker = (a) => Array.isArray(a.tickers) && a.tickers.includes(rawTicker);
		const inWindow = [];
		const inPrev = [];
		for (const a of articles) {
			if (!mentionsTicker(a)) continue;
			const t = Date.parse(a.pub_date || '');
			if (!Number.isFinite(t)) continue;
			if (t >= windowStart) inWindow.push(a);
			else if (t >= prevStart) inPrev.push(a);
		}

		let sum = 0;
		let positive = 0;
		let negative = 0;
		let neutral = 0;
		for (const a of inWindow) {
			const s = Number(a?.sentiment?.score) || 0;
			sum += s;
			if (s > 0.1) positive++;
			else if (s < -0.1) negative++;
			else neutral++;
		}

		const changePct = inPrev.length
			? ((inWindow.length - inPrev.length) / inPrev.length) * 100
			: null;
		const trend = !inWindow.length && !inPrev.length ? 'quiet'
			: changePct == null ? (inWindow.length ? 'accelerating' : 'quiet')
			: changePct > 20 ? 'accelerating'
			: changePct < -20 ? 'cooling'
			: 'steady';

		const headlines = inWindow.slice(0, HEADLINE_COUNT).map((a) => ({
			title: a.title,
			source: a.source || null,
			link: a.link || null,
			pub_date: a.pub_date || null,
			sentiment: a.sentiment?.label || 'neutral',
		}));

		return {
			ticker: rawTicker,
			window_hours: hours,
			mentions: inWindow.length,
			unique_sources: new Set(inWindow.map((a) => a.source_key || a.source)).size,
			velocity: {
				previous_window_mentions: inPrev.length,
				change_pct: changePct != null ? Number(changePct.toFixed(1)) : null,
				trend,
			},
			sentiment: {
				score: inWindow.length ? Number((sum / inWindow.length).toFixed(3)) : null,
				positive,
				negative,
				neutral,
			},
			headlines,
			ts: new Date().toISOString(),
		};
	},
});
