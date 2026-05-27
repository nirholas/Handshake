// POST /api/x402/fact-check
//
// Real-Time Fact Checker — paid x402 micropayment endpoint.
// $0.10 base (100_000 atomics). Per check: generate queries, multi-source
// search, LLM stance extraction, weighted verdict, SHA-256 attestation.
//
// Body: { claim: string, strictness: "high"|"medium"|"low" }
// Response 200: { verdict, confidence, claim, strictness, sources,
//                 costBreakdown, cachedAt?, attestation }

import { createHash } from 'crypto';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { generateSearchQueries, analyzeResults } from '../../agents/fact-checker/src/llm-verdict.js';
import { searchAll } from '../../agents/fact-checker/src/search-sources.js';
import { authorityScore } from '../../agents/fact-checker/src/source-authority.js';

const ROUTE = '/api/x402/fact-check';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ── Redis helpers ──────────────────────────────────────────────────────────────

function getRedisCredentials() {
	const url =
		process.env.UPSTASH_REDIS_REST_URL ||
		process.env.three_KV_REST_API_URL ||
		process.env.KV_REST_API_URL;
	const token =
		process.env.UPSTASH_REDIS_REST_TOKEN ||
		process.env.three_KV_REST_API_TOKEN ||
		process.env.KV_REST_API_TOKEN;
	return { url, token };
}

async function redisGet(key) {
	const { url, token } = getRedisCredentials();
	if (!url || !token) return null;
	try {
		const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		const d = await r.json();
		return d.result ? JSON.parse(d.result) : null;
	} catch {
		return null;
	}
}

async function redisSet(key, value, ttlSeconds) {
	const { url, token } = getRedisCredentials();
	if (!url || !token) return;
	try {
		await fetch(`${url}/set/${encodeURIComponent(key)}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ value: JSON.stringify(value), ex: ttlSeconds }),
		});
	} catch {
		// Cache write failure is non-fatal.
	}
}

// ── Cache key ─────────────────────────────────────────────────────────────────

function cacheKey(claim, strictness) {
	const hash = createHash('sha256')
		.update(JSON.stringify({ claim, strictness }))
		.digest('hex');
	return `fact-check:v1:${hash}`;
}

// ── Verdict logic ─────────────────────────────────────────────────────────────

function computeVerdict(sources) {
	if (sources.length < 2) {
		return { verdict: 'insufficient', confidence: 0.2 };
	}

	let weightedSupport = 0;
	let weightedContra = 0;
	let totalWeight = 0;

	for (const s of sources) {
		totalWeight += s.weight;
		if (s.stance === 'supports') weightedSupport += s.weight;
		else if (s.stance === 'contradicts') weightedContra += s.weight;
	}

	if (totalWeight === 0) {
		return { verdict: 'insufficient', confidence: 0.2 };
	}

	const supportRatio = weightedSupport / totalWeight;
	const contraRatio = weightedContra / totalWeight;

	if (supportRatio > 0.65) {
		return { verdict: 'supported', confidence: Math.round(supportRatio * 100) / 100 };
	}
	if (contraRatio > 0.65) {
		return { verdict: 'contradicted', confidence: Math.round(contraRatio * 100) / 100 };
	}
	return { verdict: 'mixed', confidence: 0.5 };
}

// ── Core fact-check pipeline ───────────────────────────────────────────────────

async function runFactCheck(claim, strictness) {
	let totalTokens = 0;
	let searchCalls = 0;

	// 1. Generate 3 search queries.
	const { queries, tokens: queryTokens } = await generateSearchQueries(claim);
	totalTokens += queryTokens;

	// 2. Run searches in parallel across all queries (multi-source internally).
	searchCalls = queries.length;
	const rawResults = await searchAll(queries);

	// 3. Take top 5 unique results.
	const top5 = rawResults.slice(0, 5);

	if (top5.length === 0) {
		const err = new Error('No search results found for the given claim');
		err.status = 422;
		err.code = 'no_results';
		throw err;
	}

	// 4. LLM stance extraction for top 5.
	const { analyses, tokens: analysisTokens } = await analyzeResults(claim, top5);
	totalTokens += analysisTokens;

	// 5. Build source objects with authority scores.
	const sources = top5.map((r, i) => {
		const authority = authorityScore(r.url);
		const analysis = analyses[i] || { excerpt: '', stance: 'neutral' };
		return {
			url: r.url,
			title: r.title,
			excerpt: analysis.excerpt || r.snippet.slice(0, 200),
			stance: analysis.stance,
			weight: authority,
			retrievedAt: new Date().toISOString(),
		};
	});

	// 6. Adjust weights by strictness.
	// high: penalize low-authority sources more; low: accept everything equally.
	if (strictness === 'high') {
		for (const s of sources) {
			if (s.weight < 0.7) s.weight *= 0.5;
		}
	} else if (strictness === 'low') {
		for (const s of sources) {
			s.weight = Math.max(s.weight, 0.55);
		}
	}

	// 7. Compute verdict.
	const { verdict, confidence } = computeVerdict(sources);

	// 8. Cost breakdown — approximate USDC cost.
	const USDC_PER_1K_TOKENS = 0.00025; // claude-haiku-4-5 pricing approx
	const llmCostUsdc = (totalTokens / 1000) * USDC_PER_1K_TOKENS;
	const totalUsdc = (0.10 + llmCostUsdc).toFixed(6);

	const costBreakdown = {
		searchCalls,
		llmTokens: totalTokens,
		totalUsdc,
	};

	// 9. Attestation.
	const attestation =
		'sha256:' +
		createHash('sha256')
			.update(
				JSON.stringify({
					verdict,
					confidence,
					claim,
					sources: sources.map((s) => s.url),
				}),
			)
			.digest('hex');

	return { verdict, confidence, claim, strictness, sources, costBreakdown, attestation };
}

// ── Bazaar schema ──────────────────────────────────────────────────────────────

const DESCRIPTION =
	'three.ws Real-Time Fact Checker — submit a claim and receive a ' +
	'sourced verdict (supported/contradicted/mixed/insufficient) backed by ' +
	'live web search and LLM analysis. Each result includes cited sources, ' +
	'authority weights, confidence score, cost breakdown, and a SHA-256 ' +
	'attestation. Strictness controls how aggressively low-authority sources ' +
	'are downweighted. Price: $0.10 base per check on Base or Solana USDC.';

const INPUT_EXAMPLE = {
	claim: 'The Eiffel Tower is 330 meters tall.',
	strictness: 'high',
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['claim'],
	properties: {
		claim: {
			type: 'string',
			minLength: 5,
			maxLength: 1000,
			description: 'The factual claim to verify.',
		},
		strictness: {
			type: 'string',
			enum: ['high', 'medium', 'low'],
			default: 'medium',
			description:
				'high: penalizes low-authority sources. medium: default. low: accepts all sources equally.',
		},
	},
};

const OUTPUT_EXAMPLE = {
	verdict: 'contradicted',
	confidence: 0.78,
	claim: 'The Eiffel Tower is 330 meters tall.',
	strictness: 'high',
	sources: [
		{
			url: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
			title: 'Eiffel Tower - Wikipedia',
			excerpt: 'The tower is 330 m (1,083 ft) tall, including a 24 m (79 ft) antenna.',
			stance: 'supports',
			weight: 0.7,
			retrievedAt: '2026-05-27T00:00:00.000Z',
		},
	],
	costBreakdown: { searchCalls: 3, llmTokens: 1420, totalUsdc: '0.100355' },
	attestation: 'sha256:abcdef1234567890...',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['verdict', 'confidence', 'claim', 'strictness', 'sources', 'costBreakdown', 'attestation'],
	properties: {
		verdict: { type: 'string', enum: ['supported', 'contradicted', 'mixed', 'insufficient'] },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
		claim: { type: 'string' },
		strictness: { type: 'string' },
		sources: {
			type: 'array',
			items: {
				type: 'object',
				required: ['url', 'title', 'excerpt', 'stance', 'weight', 'retrievedAt'],
				properties: {
					url: { type: 'string' },
					title: { type: 'string' },
					excerpt: { type: 'string' },
					stance: { type: 'string', enum: ['supports', 'contradicts', 'neutral'] },
					weight: { type: 'number' },
					retrievedAt: { type: 'string', format: 'date-time' },
				},
			},
		},
		costBreakdown: {
			type: 'object',
			required: ['searchCalls', 'llmTokens', 'totalUsdc'],
			properties: {
				searchCalls: { type: 'number' },
				llmTokens: { type: 'number' },
				totalUsdc: { type: 'string' },
			},
		},
		cachedAt: { type: 'string', format: 'date-time' },
		attestation: { type: 'string' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyType: 'json',
			body: INPUT_EXAMPLE,
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// ── Endpoint ──────────────────────────────────────────────────────────────────

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: 100_000, // $0.10
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Fact Checker',
		tags: ['fact-check', 'search', 'verification'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		// Parse body from raw Node.js readable stream.
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const rawBody = Buffer.concat(chunks).toString();

		let body;
		try {
			body = JSON.parse(rawBody);
		} catch {
			const err = new Error('Request body must be valid JSON');
			err.status = 400;
			err.code = 'invalid_json';
			throw err;
		}

		const claim = String(body?.claim || '').trim();
		if (!claim || claim.length < 5) {
			const err = new Error('"claim" must be at least 5 characters');
			err.status = 400;
			err.code = 'invalid_claim';
			throw err;
		}
		if (claim.length > 1000) {
			const err = new Error('"claim" must be at most 1000 characters');
			err.status = 400;
			err.code = 'claim_too_long';
			throw err;
		}

		const strictness = ['high', 'medium', 'low'].includes(body?.strictness)
			? body.strictness
			: 'medium';

		// Idempotency cache — 7-day TTL.
		const key = cacheKey(claim, strictness);
		const cached = await redisGet(key);
		if (cached) {
			return { ...cached, cachedAt: cached.cachedAt || new Date().toISOString() };
		}

		const result = await runFactCheck(claim, strictness);

		// Persist to cache (fire-and-forget on failure).
		await redisSet(key, result, CACHE_TTL_SECONDS);

		return result;
	},
});
