// GET /api/x402/market-mood
//
// Market Mood Index — $0.002 USDC per call on Solana or Base. A composite
// market-mood reading no single index gives you: blends the Crypto Fear &
// Greed index (positioning) with live lexicon sentiment scored across the
// newest headlines from the three.ws 192-feed news engine (narrative) into
// one 0–100 mood score — and reports when the two components disagree,
// which is the divergence signal.
//
// Data is live: alternative.me /fng (the standard free Fear & Greed source,
// same upstream as the free /api/coin/fear-greed page endpoint) plus the
// in-repo news engine (api/_lib/news.js). Both components must be live or
// the handler throws BEFORE settlement — a mood score with a dead component
// would be fabricated, and the buyer is never charged for one.
//
// A third, best-effort enrichment rides along: Deribit's DVOL implied-
// volatility index for BTC and ETH (keyless public API). Volatility is NOT
// part of the mood blend and never gates settlement; when Deribit is down the
// field is null and the paid contract is otherwise unchanged.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { getNews } from '../_lib/news.js';
import listing from '../_lib/service-catalog/services/market-mood.js';
import { fetchUpstream } from '../_lib/upstream-fetch.js';
import { cacheWrapLastGood } from '../_lib/cache.js';

const ROUTE = '/api/x402/market-mood';
const DESCRIPTION = listing.description;

const TTL_MS = 300_000;
const NEWS_SAMPLE = 120;
const FNG_WEIGHT = 0.6; // positioning
const NEWS_WEIGHT = 0.4; // narrative
const DRIVER_COUNT = 3;

// A paid call refuses before settlement when a component is down, so the buyer
// is never charged for a fabricated composite. That is right for a cold start
// and wrong for a blip: the shared last-good copy below serves a recent reading
// through a short outage and the pre-settle 503 fires only when there has never
// been data.
const STALE_TTL_S = 15 * 60;

let _cache = null; // { value, expiresAt }

function classify(v) {
	if (v <= 25) return 'Extreme Fear';
	if (v <= 45) return 'Fear';
	if (v <= 55) return 'Neutral';
	if (v <= 75) return 'Greed';
	return 'Extreme Greed';
}

async function fetchFearGreed() {
	const r = await fetchUpstream('https://api.alternative.me/fng/?limit=2', {
		headers: { accept: 'application/json' },
	}, { timeoutMs: 8000, attempts: 2, label: 'fng' });
	const raw = await r.json();
	const rows = Array.isArray(raw?.data) ? raw.data : [];
	const today = Number(rows[0]?.value);
	if (!Number.isFinite(today)) throw new Error('fng empty');
	const yesterday = Number(rows[1]?.value);
	return {
		value: today,
		label: classify(today),
		change_24h: Number.isFinite(yesterday) ? today - yesterday : null,
	};
}

// Aggregate lexicon sentiment over the newest headlines. Articles arrive with
// a pre-scored { score, label } from api/_lib/news.js; this rolls them up into
// one confidence-agnostic narrative reading plus the strongest drivers.
async function fetchNewsMood() {
	const { articles } = await getNews({ limit: NEWS_SAMPLE });
	if (!Array.isArray(articles) || !articles.length) throw new Error('news feed empty');

	let sum = 0;
	let positive = 0;
	let negative = 0;
	let neutral = 0;
	for (const a of articles) {
		const s = Number(a?.sentiment?.score) || 0;
		sum += s;
		if (s > 0.1) positive++;
		else if (s < -0.1) negative++;
		else neutral++;
	}
	const score = sum / articles.length;

	const driver = (a) => ({
		title: a.title,
		source: a.source || null,
		link: a.link || null,
	});
	const scored = articles.filter((a) => Number.isFinite(Number(a?.sentiment?.score)));
	const bullish = [...scored]
		.sort((a, b) => b.sentiment.score - a.sentiment.score)
		.filter((a) => a.sentiment.score > 0.1)
		.slice(0, DRIVER_COUNT)
		.map(driver);
	const bearish = [...scored]
		.sort((a, b) => a.sentiment.score - b.sentiment.score)
		.filter((a) => a.sentiment.score < -0.1)
		.slice(0, DRIVER_COUNT)
		.map(driver);

	return {
		score: Number(score.toFixed(3)),
		label: score > 0.1 ? 'positive' : score < -0.1 ? 'negative' : 'neutral',
		articles_scored: articles.length,
		positive,
		negative,
		neutral,
		drivers: { bullish, bearish },
	};
}

/**
 * Deribit DVOL rows ([[timestamp_ms, open, high, low, close], ...], oldest
 * first) → { value, change_24h } from the newest and oldest closes, or null
 * when the window is empty.
 */
export function summarizeDvol(rows) {
	const closes = (Array.isArray(rows) ? rows : [])
		.map((r) => Number(r?.[4]))
		.filter(Number.isFinite);
	if (!closes.length) return null;
	const value = closes[closes.length - 1];
	return {
		value: Number(value.toFixed(2)),
		change_24h: closes.length > 1 ? Number((value - closes[0]).toFixed(2)) : null,
	};
}

async function fetchDvol(currency) {
	const end = Date.now();
	const start = end - 24 * 3_600_000;
	const r = await fetchUpstream(
		`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}` +
			`&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`,
		{ headers: { accept: 'application/json' } },
		{ timeoutMs: 8000, attempts: 2, label: 'dvol' },
	);
	return summarizeDvol((await r.json())?.result?.data);
}

// Best-effort: per-currency failures collapse to null and never reject, so a
// Deribit outage cannot fail (or refund) a call whose paid components are live.
async function fetchVolatility() {
	const [btc, eth] = await Promise.all(
		['BTC', 'ETH'].map((c) => fetchDvol(c).catch(() => null)),
	);
	if (!btc && !eth) return null;
	return { index: 'DVOL', btc, eth };
}

async function loadMood() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;
	const value = await cacheWrapLastGood('x402:market-mood', TTL_MS / 1000, buildMood, { staleTtlSeconds: STALE_TTL_S });
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

async function buildMood() {
	// Both components are required — Promise.all rejects if either is down and
	// the caller refunds. A one-legged "composite" would be a fabricated signal.
	// fetchVolatility never rejects (best-effort enrichment, null on outage).
	const [fng, news, volatility] = await Promise.all([
		fetchFearGreed(),
		fetchNewsMood(),
		fetchVolatility(),
	]);

	// News score is -1..1; map to 0..100 and blend with Fear & Greed.
	const newsIndex = ((news.score + 1) / 2) * 100;
	const mood = Math.round(FNG_WEIGHT * fng.value + NEWS_WEIGHT * newsIndex);

	// Divergence: positioning and narrative pointing different directions is the
	// actionable part of a composite — surface it explicitly.
	const fngBullish = fng.value > 55;
	const fngBearish = fng.value < 45;
	const newsBullish = news.label === 'positive';
	const newsBearish = news.label === 'negative';
	const divergence =
		(fngBullish && newsBearish) || (fngBearish && newsBullish) ? 'diverging' : 'aligned';

	const value = {
		mood,
		label: classify(mood),
		divergence,
		components: {
			fear_greed: { value: fng.value, label: fng.label, change_24h: fng.change_24h },
			news: {
				score: news.score,
				label: news.label,
				articles_scored: news.articles_scored,
				positive: news.positive,
				negative: news.negative,
				neutral: news.neutral,
			},
			volatility,
		},
		drivers: news.drivers,
	};
	return value;
}

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	...listing.inputSchema,
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mood', 'label', 'divergence', 'components', 'drivers', 'ts'],
	properties: {
		mood: { type: 'integer', minimum: 0, maximum: 100 },
		label: { type: 'string', enum: ['Extreme Fear', 'Fear', 'Neutral', 'Greed', 'Extreme Greed'] },
		divergence: { type: 'string', enum: ['aligned', 'diverging'] },
		components: {
			type: 'object',
			required: ['fear_greed', 'news'],
			properties: {
				fear_greed: {
					type: 'object',
					required: ['value', 'label', 'change_24h'],
					properties: {
						value: { type: 'number' },
						label: { type: 'string' },
						change_24h: { type: ['number', 'null'] },
					},
				},
				news: {
					type: 'object',
					required: ['score', 'label', 'articles_scored', 'positive', 'negative', 'neutral'],
					properties: {
						score: { type: 'number', minimum: -1, maximum: 1 },
						label: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
						articles_scored: { type: 'integer' },
						positive: { type: 'integer' },
						negative: { type: 'integer' },
						neutral: { type: 'integer' },
					},
				},
				// Best-effort enrichment, not in `required`: null when Deribit is down.
				volatility: {
					type: ['object', 'null'],
					properties: {
						index: { type: 'string', enum: ['DVOL'] },
						btc: {
							type: ['object', 'null'],
							properties: {
								value: { type: 'number' },
								change_24h: { type: ['number', 'null'] },
							},
						},
						eth: {
							type: ['object', 'null'],
							properties: {
								value: { type: 'number' },
								change_24h: { type: ['number', 'null'] },
							},
						},
					},
				},
			},
		},
		drivers: {
			type: 'object',
			required: ['bullish', 'bearish'],
			properties: {
				bullish: { type: 'array', items: { type: 'object' } },
				bearish: { type: 'array', items: { type: 'object' } },
			},
		},
		ts: { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['market sentiment', 'fear-greed composite', 'narrative divergence'],
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
	priceAtomics: priceFor('market-mood', '2000'), // $0.002 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: listing.serviceName,
		tags: listing.tags,
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler() {
		let mood = null;
		try { mood = await loadMood(); } catch { /* refund below */ }
		if (!mood) {
			throw Object.assign(new Error('mood components are temporarily unavailable'), {
				status: 503,
				code: 'data_unavailable',
			});
		}
		return { ...mood, ts: new Date().toISOString() };
	},
});
