// Re-listed per the 2026-07-08 storefront cleanup (prompt 18): sourced
// verdicts with cryptographic attestations are a defensible agent product —
// the 2026-07 overhaul's "internal-use only" de-listing is superseded. The
// fact-checker app (src/fact-checker-app.js) and the Sheriff Boone NPC in
// /play also buy through this same route.
// POST /api/x402/fact-check — free daily lane → x402 metered overage.
//
// Real-Time Fact Checker.
//   • Free tier: 3 checks/day per IP — the REAL search+LLM chain, never a
//     degraded fake (see CLAUDE.md's no-mocks rule). Response carries
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
import { cors, wrap, error, json, readBody } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { priceFor } from '../_lib/x402-prices.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { generateSearchQueries, analyzeResults } from '../../agents/fact-checker/src/llm-verdict.js';
import { searchAll } from '../../agents/fact-checker/src/search-sources.js';
import { authorityScore } from '../../agents/fact-checker/src/source-authority.js';
import { imageEvidence } from '../../agents/fact-checker/src/image-evidence.js';
import { fetchUpstream } from '../_lib/upstream-fetch.js';

const ROUTE = '/api/x402/fact-check';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_BODY_BYTES = 32 * 1024; // claims are short text; 32KB is generous headroom
// Wall-clock budget for one live check. The edge cuts a request off at 60s, and
// an unbudgeted pipeline could exceed that on its own (two 30s LLM chains plus
// a 20s grounded search), which is what turned slow checks into 502s carrying
// nothing at all. 45s leaves the response, x402 settlement, and the cache write
// comfortably inside the edge window while still allowing a slow-but-real check
// to finish. Env-tunable for operators fronting the API with a different edge.
const PIPELINE_BUDGET_MS = Math.max(
	10_000,
	Number(process.env.FACT_CHECK_BUDGET_MS) || 45_000,
);
// Stage caps carved out of that budget, sized from measured stage cost (query
// generation ~8s, grounded search sub-second to ~20s worst case). Each stage
// actually gets min(cap, time still left), so an early overrun steals from the
// stages behind it rather than from the edge's patience.
const QUERY_STAGE_CAP_MS = 12_000;
const SEARCH_STAGE_CAP_MS = 20_000;
const IMAGE_STAGE_CAP_MS = 20_000;
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
		// This is a PAID endpoint: a stalled cache read must never hold the
		// caller's request open. The cache is an optimisation, so a slow or dead
		// Upstash degrades to a miss (the catch below) rather than to a hang.
		const r = await fetchUpstream(`${url}/get/${encodeURIComponent(key)}`, {
			headers: { authorization: `Bearer ${token}` },
		}, { timeoutMs: 2_000, attempts: 2, label: 'fact-check-cache-get' });
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
		await fetchUpstream(`${url}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify(value),
		}, { timeoutMs: 2_000, attempts: 1, label: 'fact-check-cache-set' });
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

// Verdict = direction of the stance-BEARING evidence, gated by how much of the
// evidence engaged the claim at all. The pre-2026-08 version divided by TOTAL
// weight (neutral sources included), so three tangential results could drown
// two clear confirmations below the 0.65 bar, and an all-neutral result set
// still returned "mixed", which is how the 2026-07-08 benchmark collapsed to
// 20% (every class predicted "mixed"). Rules now:
//   • <2 sources, zero weight, or zero stance-bearing weight -> insufficient:
//     evidence that never engages the claim is absence of evidence, not
//     disagreement.
//   • A single stance-bearing source lost in otherwise-silent evidence
//     (coverage <30%) is also insufficient: one loosely-matched page must not
//     decide a verdict on its own.
//   • Direction is judged over stance-bearing weight only: >=70% one way ->
//     supported/contradicted; anything else -> mixed.
//   • `partial` weight is stance-bearing but takes neither side. A source that
//     reports the claim as true in one respect and wrong in another is not a
//     confirmation, so it dilutes dominance and pushes the result toward mixed.
//     This is the SECOND route to a mixed verdict and the one that matters:
//     before the stance existed, `mixed` was reachable only when sources
//     disagreed with EACH OTHER, which well-sourced evidence about a well-known
//     half-truth ("a tomato is a vegetable", "Napoleon was short") never does.
//     Every source reads the same nuance and the old vocabulary forced each of
//     them to project it onto one side, so the 2026-08-10 benchmark scored the
//     whole mixed class 0/10 with 7 of them landing on `contradicted`.
//   • Confidence blends dominance with coverage, so a unanimous verdict from
//     thin engagement scores lower than one from broad engagement. For `mixed`
//     the dominance term is how strongly the evidence establishes mixedness
//     itself (partial weight, plus opposed stances counted as the joint
//     evidence of a split that they are), never how lopsided the split was.
function computeVerdict(sources) {
	if (sources.length < 2) {
		return { verdict: 'insufficient', confidence: 0.2 };
	}

	let weightedSupport = 0;
	let weightedContra = 0;
	let weightedPartial = 0;
	let totalWeight = 0;
	let stanceBearing = 0;

	for (const s of sources) {
		totalWeight += s.weight;
		if (s.stance === 'supports') {
			weightedSupport += s.weight;
			stanceBearing++;
		} else if (s.stance === 'contradicts') {
			weightedContra += s.weight;
			stanceBearing++;
		} else if (s.stance === 'partial') {
			weightedPartial += s.weight;
			stanceBearing++;
		}
	}

	const stanceWeight = weightedSupport + weightedContra + weightedPartial;
	if (totalWeight === 0 || stanceWeight === 0) {
		return { verdict: 'insufficient', confidence: 0.3 };
	}

	const coverage = stanceWeight / totalWeight;
	if (stanceBearing === 1 && coverage < 0.3) {
		return { verdict: 'insufficient', confidence: 0.35 };
	}

	const supportRatio = weightedSupport / stanceWeight;
	const contraRatio = weightedContra / stanceWeight;
	const partialRatio = weightedPartial / stanceWeight;
	const confidence = (dominance) =>
		Math.round(Math.min(0.98, dominance * (0.6 + 0.4 * Math.min(1, coverage * 2))) * 100) / 100;

	if (supportRatio >= 0.7) {
		return { verdict: 'supported', confidence: confidence(supportRatio) };
	}
	if (contraRatio >= 0.7) {
		return { verdict: 'contradicted', confidence: confidence(contraRatio) };
	}
	// Neither side owns the evidence. How strongly is that established? Weight
	// that says "partly true" states it outright; a pair of opposed stances states
	// it jointly, so the smaller side counts twice (its mirror on the other side
	// is the other half of the same fact about the evidence).
	const mixedness = Math.min(1, partialRatio + 2 * Math.min(supportRatio, contraRatio));
	return { verdict: 'mixed', confidence: confidence(mixedness) };
}

// ── Core fact-check pipeline ───────────────────────────────────────────────────

/**
 * Resolve `promise`, or `fallback` if it has not settled within `ms`.
 * Used for optional stages whose absence degrades the check instead of failing
 * it, so a stalled helper can never spend the whole request's budget.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms  Non-positive means "no budget left" — take the fallback now.
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, fallback) {
	if (!(ms > 0)) return Promise.resolve(fallback);
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((resolve) => {
			timer = setTimeout(() => resolve(fallback), ms);
			timer.unref?.();
		}),
	]);
}

async function runFactCheck(claim, strictness, imageUrl = null) {
	let totalTokens = 0;
	let searchCalls = 0;
	// Degradations collected as the pipeline runs. Anything in here means the
	// verdict rests on less than the full chain, which both the response and the
	// caching decision below have to respect.
	const degradations = [];

	// Every stage is bounded by what is left of the shared budget, so a slow
	// stage costs the stages behind it rather than the whole request. Without
	// this the pipeline could outlive the edge's 60s cut-off and return a 502
	// carrying nothing, discarding evidence it had already gathered.
	const deadline = Date.now() + PIPELINE_BUDGET_MS;
	const remainingMs = () => deadline - Date.now();
	const stageBudget = (cap) => Math.max(0, Math.min(cap, remainingMs()));

	// 0. Image evidence (Consumer 2 of the shared vision helper) runs in parallel
	//    with the web pipeline — a free NIM vision lane describes/transcribes the
	//    attached image and judges its stance. Fail-open: null when no image is
	//    attached or vision is unavailable, so the check never depends on it.
	const imageEvidencePromise = imageUrl
		? withDeadline(
				imageEvidence(claim, imageUrl).catch(() => null),
				stageBudget(IMAGE_STAGE_CAP_MS),
				null,
			)
		: Promise.resolve(null);

	// 1. Generate 3 search queries.
	const {
		queries,
		tokens: queryTokens,
		degraded: queryDegraded,
	} = await generateSearchQueries(claim, { budgetMs: stageBudget(QUERY_STAGE_CAP_MS) });
	totalTokens += queryTokens;
	if (queryDegraded) degradations.push(queryDegraded);

	// 2. Run searches in parallel across all queries (multi-source internally).
	searchCalls = queries.length;
	const rawResults = await searchAll(queries, { budgetMs: stageBudget(SEARCH_STAGE_CAP_MS) });

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

	// 4. LLM stance extraction for top 5. Whatever is left of the budget goes
	//    here; if the earlier stages consumed it, analyzeResults degrades to
	//    neutral stances rather than starting a turn it cannot finish.
	const {
		analyses,
		tokens: analysisTokens,
		degraded: analysisDegraded,
	} = top5.length > 0
		? await analyzeResults(claim, top5, { budgetMs: remainingMs() })
		: { analyses: [], tokens: 0 };
	totalTokens += analysisTokens;
	if (analysisDegraded) degradations.push(analysisDegraded);

	// 5. Build source objects with authority scores. The image evidence is folded
	//    in as one additional weighted source so it flows through the same
	//    strictness adjustment and weighted verdict as web sources.
	const sources = top5.map((r, i) => {
		// Score the PUBLISHER host, not the link. Vertex-grounded results arrive
		// with `url` set to an opaque vertexaisearch.cloud.google.com redirect
		// (Google's required attribution wrapper) and the real host carried
		// separately as `domain`; scoring the redirect would give every grounded
		// source the same unknown-domain default and silently disable authority
		// weighting. Every other rung returns a publisher URL and no `domain`,
		// so it falls through to the URL path unchanged.
		const authority = authorityScore(r.domain ? `https://${r.domain}` : r.url);
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
	// A degraded check still returns real sources, but it did not get the full
	// chain — say so on the response rather than letting an `insufficient`
	// verdict read as "we checked and the evidence was thin". checkClaim() also
	// reads this to keep the result out of the 7-day cache.
	if (degradations.length) result.degraded = degradations;
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
	// Never cache a degraded check. It is a snapshot of a provider outage, not of
	// the claim: caching it would pin an `insufficient` verdict on a perfectly
	// checkable claim for seven days and serve that to every later caller,
	// including the paid lane. Skipping the write costs one re-run and keeps the
	// cache holding only full-chain answers.
	if (!result.degraded) await redisSet(key, result, CACHE_TTL_SECONDS);
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
					stance: { type: 'string', enum: ['supports', 'contradicts', 'partial', 'neutral'] },
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
				stance: { type: 'string', enum: ['supports', 'contradicts', 'partial', 'neutral'] },
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
		priceAtomics: priceFor('fact-check', '100000'), // $0.10
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
	// The paid rail sets these on every response it writes; the free lane runs
	// outside it, so without this a cross-origin caller passed the OPTIONS
	// preflight (answered by the paid rail) and then had the actual free-lane
	// 200/400 blocked by the browser for lacking allow-origin. Same header set,
	// same allowed methods, so both lanes look identical to a CORS reader.
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
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

export {
	parseFactCheckBody as _parseFactCheckBody,
	checkClaim as _checkClaim,
	computeVerdict as _computeVerdict,
};
