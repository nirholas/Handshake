// Re-listed per the 2026-07-08 storefront cleanup (prompt 18): sourced
// verdicts with cryptographic attestations are a defensible agent product —
// the 2026-07 overhaul's "internal-use only" de-listing is superseded. The
// fact-checker app (src/fact-checker-app.js) and the Sheriff Boone NPC in
// /play also buy through this same route.
// POST /api/x402/fact-check — free daily lane → x402 metered overage.
//
// Real-Time Fact Checker.
//   • Free tier: 3 checks/day per IP — the REAL search+LLM chain, never a
//     degraded fake (see 00-CONTEXT.md's no-mocks rule). Response carries
//     `lane: "free"` and `free_remaining_today`.
//   • Above the free tier (quota exhausted OR an X-PAYMENT header is present)
//     the request falls through to the x402 rail: $0.10 base (100_000
//     atomics) per check on Base or Solana USDC. Response carries
//     `lane: "paid"`.
// Per check either way: generate queries, multi-source search, LLM stance
// extraction, weighted verdict, SHA-256 attestation.
//
// Body: { claim: string, strictness?: "high"|"medium"|"low", imageUrl?: string }
// Response 200: { verdict, confidence, claim, strictness, sources,
//                 costBreakdown, cachedAt?, attestation, lane, free_remaining_today? }

import { createHash } from 'crypto';
import { wrap, error, json, readBody } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { generateSearchQueries, analyzeResults } from '../../agents/fact-checker/src/llm-verdict.js';
import { searchAll } from '../../agents/fact-checker/src/search-sources.js';
import { authorityScore } from '../../agents/fact-checker/src/source-authority.js';
import { imageEvidence } from '../../agents/fact-checker/src/image-evidence.js';

const ROUTE = '/api/x402/fact-check';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_BODY_BYTES = 32 * 1024; // claims are short text; 32KB is generous headroom
// Kept in one place and re-exported so the /fact-check page and 402-quote copy
// can render the real cap instead of a hardcoded, driftable number. Must match
// limits.factCheckFreeIp's `limit` in api/_lib/rate-limit.js.
export const FREE_DAILY_LIMIT = 3;

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
		// Upstash REST: the raw request body IS the stored value; TTL goes in the
		// query string. A JSON envelope body would be stored verbatim and corrupt
		// every subsequent read.
		await fetch(`${url}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify(value),
		});
	} catch {
		// Cache write failure is non-fatal.
	}
}

// ── Cache key ─────────────────────────────────────────────────────────────────

function cacheKey(claim, strictness, imageUrl) {
	const hash = createHash('sha256')
		.update(JSON.stringify({ claim, strictness, imageUrl: imageUrl || null }))
		.digest('hex');
	// v2: the key now folds in any attached image so an image-backed check never
	// serves a stale image-free verdict (or vice versa) from the v1 cache.
	return `fact-check:v2:${hash}`;
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

async function runFactCheck(claim, strictness, imageUrl = null) {
	let totalTokens = 0;
	let searchCalls = 0;

	// 0. Image evidence (Consumer 2 of the shared vision helper) runs in parallel
	//    with the web pipeline — a free NIM vision lane describes/transcribes the
	//    attached image and judges its stance. Fail-open: null when no image is
	//    attached or vision is unavailable, so the check never depends on it.
	const imageEvidencePromise = imageUrl
		? imageEvidence(claim, imageUrl).catch(() => null)
		: Promise.resolve(null);

	// 1. Generate 3 search queries.
	const { queries, tokens: queryTokens } = await generateSearchQueries(claim);
	totalTokens += queryTokens;

	// 2. Run searches in parallel across all queries (multi-source internally).
	searchCalls = queries.length;
	const rawResults = await searchAll(queries);

	// 3. Take top 5 unique results.
	const top5 = rawResults.slice(0, 5);

	const imageSource = await imageEvidencePromise;

	// A claim can now be checkable on image evidence alone — only bail when there
	// is neither a web result nor a usable image.
	if (top5.length === 0 && !imageSource) {
		const err = new Error('No search results found for the given claim');
		err.status = 422;
		err.code = 'no_results';
		throw err;
	}

	// 4. LLM stance extraction for top 5.
	const { analyses, tokens: analysisTokens } =
		top5.length > 0 ? await analyzeResults(claim, top5) : { analyses: [], tokens: 0 };
	totalTokens += analysisTokens;

	// 5. Build source objects with authority scores. The image evidence is folded
	//    in as one additional weighted source so it flows through the same
	//    strictness adjustment and weighted verdict as web sources.
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
	if (imageSource) {
		// Strip the helper's diagnostic fields from the verdict-facing source; they
		// are surfaced separately on the response as `imageEvidence`.
		const { description: _d, visibleText: _v, reason: _r, provider: _p, kind: _k, ...verdictSource } = imageSource;
		sources.push(verdictSource);
	}

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

	const result = { verdict, confidence, claim, strictness, sources, costBreakdown, attestation };
	// Surface the image analysis separately so a caller sees what the vision lane
	// read from the attachment (description, transcribed text, stance) without
	// digging it out of the weighted source list.
	if (imageSource) {
		result.imageEvidence = {
			url: imageSource.url,
			description: imageSource.description,
			visibleText: imageSource.visibleText,
			stance: imageSource.stance,
			reason: imageSource.reason,
			provider: imageSource.provider,
		};
	}
	return result;
}

// Cache-checked wrapper shared by both the free and paid lanes so a claim
// already checked (by anyone, on either lane) within the last 7 days never
// re-runs the live chain — same idempotency guarantee both lanes get.
async function checkClaim(claim, strictness, imageUrl) {
	const key = cacheKey(claim, strictness, imageUrl);
	const cached = await redisGet(key);
	if (cached && typeof cached.verdict === 'string') {
		return { ...cached, cachedAt: cached.cachedAt || new Date().toISOString() };
	}
	const result = await runFactCheck(claim, strictness, imageUrl);
	await redisSet(key, result, CACHE_TTL_SECONDS);
	return result;
}

// Validate + normalize the request body. Throws a { status, code, message }
// error on anything malformed — shared by both lanes so a bad request gets
// the identical 400 whether or not a payment would have been required.
function parseFactCheckBody(body) {
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

	const strictness = ['high', 'medium', 'low'].includes(body?.strictness) ? body.strictness : 'medium';

	// Optional image attachment — validated at the boundary as an http(s) URL.
	let imageUrl = null;
	if (body?.imageUrl != null) {
		imageUrl = String(body.imageUrl).trim();
		if (imageUrl && (!/^https?:\/\//i.test(imageUrl) || imageUrl.length > 2048)) {
			const err = new Error('"imageUrl" must be an http(s) URL under 2048 characters');
			err.status = 400;
			err.code = 'invalid_image_url';
			throw err;
		}
		if (!imageUrl) imageUrl = null;
	}

	return { claim, strictness, imageUrl };
}

function parseJsonBody(buf) {
	const raw = buf.toString('utf8');
	try {
		return raw ? JSON.parse(raw) : {};
	} catch {
		const err = new Error('Request body must be valid JSON');
		err.status = 400;
		err.code = 'invalid_json';
		throw err;
	}
}

// ── Bazaar schema ──────────────────────────────────────────────────────────────

const DESCRIPTION =
	'three.ws Real-Time Fact Checker — sourced verdicts with cryptographic attestations you can ' +
	'audit, backed by a published accuracy benchmark. Submit a claim and receive a sourced verdict ' +
	'(supported/contradicted/mixed/insufficient) from live web search and LLM analysis: cited ' +
	'sources, authority weights, confidence score, cost breakdown, and a SHA-256 attestation. ' +
	`${FREE_DAILY_LIMIT} free checks/day per IP (the same real chain, marked lane:"free") before ` +
	'the $0.10 base x402 price per check on Base or Solana USDC. Strictness controls how ' +
	'aggressively low-authority sources are downweighted. See /fact-check for the live benchmark.';

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
		imageUrl: {
			type: 'string',
			format: 'uri',
			maxLength: 2048,
			description:
				'Optional http(s) image attached as evidence (a chart, screenshot, label, or photo). ' +
				'A vision model describes it, transcribes any visible text, and weighs its stance ' +
				'toward the claim alongside web sources. Ignored if vision is unavailable.',
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
	lane: 'paid',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['verdict', 'confidence', 'claim', 'strictness', 'sources', 'costBreakdown', 'attestation', 'lane'],
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
		imageEvidence: {
			type: 'object',
			description: 'Present only when an imageUrl was supplied and vision was available.',
			properties: {
				url: { type: 'string' },
				description: { type: ['string', 'null'] },
				visibleText: { type: ['string', 'null'] },
				stance: { type: 'string', enum: ['supports', 'contradicts', 'neutral'] },
				reason: { type: ['string', 'null'] },
				provider: { type: 'string' },
			},
		},
		cachedAt: { type: 'string', format: 'date-time' },
		attestation: { type: 'string' },
		lane: { type: 'string', enum: ['free', 'paid'], description: 'Which lane served this check.' },
		free_remaining_today: { type: 'number', description: `Present only on lane:"free" responses — free checks left today (of ${FREE_DAILY_LIMIT}).` },
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

// ── Paid lane (x402) ─────────────────────────────────────────────────────────
// Built once, lazily, and reused for every over-quota / already-paying request
// (mirrors api/v1/ai/asr.js's free-lane-then-x402 shape).

let _paid = null;
function paidHandler() {
	if (_paid) return _paid;
	_paid = paidEndpoint({
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
			// The free-lane gate above already buffered the body once (req._factCheckBody);
			// a direct paid call (X-PAYMENT present on the first request) reads it fresh.
			const buf = req._factCheckBody ?? (await readBody(req, MAX_BODY_BYTES));
			const body = parseJsonBody(buf);
			const { claim, strictness, imageUrl } = parseFactCheckBody(body);
			const result = await checkClaim(claim, strictness, imageUrl);
			return { ...result, lane: 'paid' };
		},
	});
	return _paid;
}

// ── Entry point: free daily quota → x402 fall-through ────────────────────────

export default wrap(async function handler(req, res) {
	if (req.method !== 'POST') return paidHandler()(req, res); // let the paid rail's own 405 speak

	// Buffer the body once; the paid rail re-reads the same bytes
	// (req._factCheckBody) so the stream is never consumed twice.
	let buf;
	try {
		buf = await readBody(req, MAX_BODY_BYTES);
	} catch (e) {
		return error(res, e?.status || 413, e?.code || 'payload_too_large', e?.message || `request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
	}
	req._factCheckBody = buf;

	// A payment header means the caller is already on the paid rail.
	const paymentPresent = Boolean(req.headers['x-payment'] || req.headers['payment-signature']);
	if (paymentPresent) return paidHandler()(req, res);

	// Parse/validate against the boundary so genuinely broken input never
	// becomes a payment prompt or burns a free-quota slot: malformed JSON and
	// a present-but-invalid claim stay hard 400s. The one exception is a
	// well-formed body with NO claim at all — that is the shape discovery
	// probes (x402scan's registration crawler POSTs `{}`) send, and registries
	// require a valid 402 challenge on a bare probe. Those fall through to the
	// paid rail, whose challenge carries the bazaar schema that tells the
	// caller how to build a valid body. No quota is spent and nothing can
	// settle here — a paid retry parses its body inside the handler, after
	// verification, against the same validator.
	let body;
	try {
		body = parseJsonBody(buf);
	} catch (e) {
		return error(res, e.status || 400, e.code || 'invalid_json', e.message);
	}
	if (body?.claim === undefined) return paidHandler()(req, res);
	let parsed;
	try {
		parsed = parseFactCheckBody(body);
	} catch (e) {
		return error(res, e.status || 400, e.code || 'bad_request', e.message);
	}

	// Free daily quota (per IP). Exhausted → the x402 402 challenge.
	const rl = await limits.factCheckFreeIp(clientIp(req));
	if (!rl.success) return paidHandler()(req, res);

	try {
		const result = await checkClaim(parsed.claim, parsed.strictness, parsed.imageUrl);
		return json(
			res,
			200,
			{ ...result, lane: 'free', free_remaining_today: Math.max(0, rl.remaining) },
			{ 'cache-control': 'no-store' },
		);
	} catch (e) {
		return error(res, e?.status || 502, e?.code || 'provider_error', e?.message || 'fact-check failed');
	}
});

export { parseFactCheckBody as _parseFactCheckBody, checkClaim as _checkClaim };
