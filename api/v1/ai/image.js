// POST /api/v1/ai/image — text→image for agents, over x402.
//
// Productizes the platform's text→image lanes (api/_mcp3d/text-to-image.js:
// NVIDIA NIM FLUX, Google Vertex/Gemini image, Replicate backstop) as a single
// versioned, bazaar-discoverable endpoint with a free daily quota funnel:
//
//   • First N images/day per IP are FREE (payment bypassed).             ← funnel
//   • Past the quota, the call falls through to x402: $0.02 USDC/image.   ← revenue
//
// A generated image is persisted to R2 by the lane itself and returned as a
// durable https URL. No API key, no account — an agent can try it wallet-free,
// then pay per image once it's past the free tier.
//
//   GET  /api/v1/ai/image            → compact discovery doc (price, quota, lanes)
//   GET  /api/v1/ai/image?health=1   → per-lane configured/reachable, no quota burn
//   POST /api/v1/ai/image            → { prompt, aspect_ratio?, seed? } → image
//
// Honest degradation: with NO image lane configured the POST returns 503
// `not_configured` naming the env vars to set (NVIDIA_API_KEY /
// GOOGLE_CLOUD_PROJECT + GCP_SERVICE_ACCOUNT_JSON / REPLICATE_API_TOKEN); it
// starts serving the moment any one of them lands.

import { paidEndpoint } from '../../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../../_lib/x402-spec.js';
import { installAccessControl } from '../../_lib/x402/access-control.js';
import { withService, declareHttpDiscovery } from '../../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../../_lib/x402-prices.js';
import { cors, error, json, method, wrap, readBody } from '../../_lib/http.js';
import { clientIp } from '../../_lib/rate-limit.js';
import { textToImage } from '../../_mcp3d/text-to-image.js';
import {
	imageLaneConfig,
	imageLaneHealth,
	missingLaneEnv,
	dimensionsFor,
	providerLabel,
	isProviderRefusal,
	refusalReason,
	SUPPORTED_ASPECT_RATIOS,
} from '../../_lib/ai-image-lanes.js';
import { peekFreeQuota, consumeFreeQuota, freePerDay } from '../../_lib/ai-image-quota.js';

const ROUTE = '/api/v1/ai/image';
const PRICE_ATOMICS = priceFor('ai-image', '20000'); // $0.02 USDC per image above quota
const MAX_PROMPT = 2000;
const MIN_PROMPT = 3;
const MAX_SEED = 4_294_967_295; // uint32 — the widest seed the flux lanes accept
const MAX_BODY_BYTES = 16_384; // generous ceiling for a { prompt, aspect_ratio, seed } JSON body

// ── Bazaar discovery (uniqueness first) ──────────────────────────────────────

const DESCRIPTION =
	'Text-to-image for agents over x402 — pay $0.02 USDC per image, no API key, ' +
	'no account; runs on NVIDIA NIM / Google Vertex lanes. The first 5 images per ' +
	'day per IP are free, then each image is a single on-chain USDC micropayment. ' +
	'Returns a durable https URL to the rendered PNG/JPEG.';

const INPUT_EXAMPLE = { prompt: 'a brass owl figurine on a plain white background', aspect_ratio: '1:1' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['prompt'],
	properties: {
		prompt: {
			type: 'string',
			minLength: MIN_PROMPT,
			maxLength: MAX_PROMPT,
			description: 'The image description to render.',
		},
		aspect_ratio: {
			type: 'string',
			enum: [...SUPPORTED_ASPECT_RATIOS],
			default: '1:1',
			description: 'Output aspect ratio. Defaults to 1:1.',
		},
		seed: {
			type: 'integer',
			minimum: 0,
			maximum: MAX_SEED,
			description: 'Optional deterministic seed (honored on the NIM / Replicate flux lanes; ignored by Vertex/Gemini, which has no seed parameter).',
		},
	},
};

const OUTPUT_EXAMPLE = {
	url: 'https://three.ws/cdn/forge/refs/6f1c0c2e-2a4d-4b6e-9b1a-3c5d7e9f0a1b.jpg',
	provider: 'nvidia-nim',
	model: 'black-forest-labs/flux.1-schnell',
	width: 1024,
	height: 1024,
	aspect_ratio: '1:1',
	seed: null,
	free: true,
	quota: { used: 1, limit: 5, remaining: 4, resetAt: '2026-07-08T00:00:00.000Z' },
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['url', 'provider', 'width', 'height'],
	properties: {
		url: { type: 'string', format: 'uri', description: 'Durable https URL to the rendered image.' },
		provider: { type: 'string', description: 'Lane that served the image: nvidia-nim | vertex | replicate.' },
		model: { type: 'string' },
		width: { type: 'integer' },
		height: { type: 'integer' },
		aspect_ratio: { type: 'string' },
		seed: { type: ['integer', 'null'] },
		free: { type: 'boolean', description: 'True when served from the free daily quota (no payment).' },
		quota: {
			type: 'object',
			properties: {
				used: { type: 'integer' },
				limit: { type: 'integer' },
				remaining: { type: 'integer' },
				resetAt: { type: 'string', format: 'date-time' },
			},
		},
	},
};

const BAZAAR = declareHttpDiscovery({
	method: 'POST',
	bodyType: 'json',
	input: INPUT_EXAMPLE,
	inputSchema: INPUT_SCHEMA,
	output: { example: OUTPUT_EXAMPLE, schema: OUTPUT_SCHEMA },
});

// ── Handler helpers ──────────────────────────────────────────────────────────

function badRequest(code, message) {
	return Object.assign(new Error(message), { status: 400, code });
}

// Validate + normalize the request body. Throws a 400 on any client fault, so a
// paid caller is never charged for a malformed request (the throw lands before
// settlement) and a free caller never spends a quota slot on one.
function parseImageRequest(rawBody) {
	let body;
	try {
		body = JSON.parse(rawBody || '{}');
	} catch {
		throw badRequest('invalid_json', 'Request body must be valid JSON.');
	}

	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	if (!prompt) throw badRequest('invalid_prompt', '"prompt" is required and must be a non-empty string.');
	if (prompt.length < MIN_PROMPT) throw badRequest('invalid_prompt', `"prompt" must be at least ${MIN_PROMPT} characters.`);
	if (prompt.length > MAX_PROMPT) throw badRequest('prompt_too_long', `"prompt" must be at most ${MAX_PROMPT} characters.`);

	let aspectRatio = '1:1';
	if (body?.aspect_ratio != null) {
		aspectRatio = String(body.aspect_ratio);
		if (!SUPPORTED_ASPECT_RATIOS.includes(aspectRatio)) {
			throw badRequest('invalid_aspect_ratio', `"aspect_ratio" must be one of: ${SUPPORTED_ASPECT_RATIOS.join(', ')}.`);
		}
	}

	let seed;
	if (body?.seed != null) {
		if (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > MAX_SEED) {
			throw badRequest('invalid_seed', `"seed" must be an integer between 0 and ${MAX_SEED}.`);
		}
		seed = body.seed;
	}

	return { prompt, aspectRatio, seed };
}

// Map a text-to-image lane error onto a designed HTTP status. A safety refusal
// is a terminal verdict about the prompt (422, never retried); a rate-limit /
// outage / billing failure is transient (429 / 503). The paidEndpoint wrapper
// turns any throw here into an error response WITHOUT settling, so the buyer is
// never charged for a failed generation.
function mapLaneError(err) {
	if (isProviderRefusal(err)) {
		return Object.assign(new Error(refusalReason(err)), { status: 422, code: 'content_refused' });
	}
	if (err?.code === 'unconfigured') {
		return Object.assign(
			new Error(`No image lane is configured. Set one of: ${missingLaneEnv().join(', ')}.`),
			{ status: 503, code: 'not_configured' },
		);
	}
	if (err?.code === 'rate_limited') {
		const retryAfter = Number.isFinite(err.retryAfter) ? err.retryAfter : 10;
		return Object.assign(new Error('Image generation is briefly busy — retry shortly.'), {
			status: 429,
			code: 'rate_limited',
			retryAfter,
		});
	}
	if (err?.code === 'provider_unreachable' || err?.code === 'billing') {
		return Object.assign(new Error('The image lane is temporarily unavailable — retry shortly.'), {
			status: 503,
			code: 'lane_unavailable',
		});
	}
	return Object.assign(new Error(err?.message || 'Image generation failed.'), {
		status: 502,
		code: 'generation_failed',
	});
}

// Generate one image and shape the response. Shared by the free-bypass path and
// the paid path — `free` distinguishes them so the response is honest about
// whether a payment happened, and the quota slot is spent ONLY on the free path
// and ONLY after a real image is delivered.
async function generateAndRespond({ prompt, aspectRatio, seed }, { free, ip }) {
	const config = imageLaneConfig();
	if (!config.anyConfigured) {
		throw Object.assign(
			new Error(`No image lane is configured. Set one of: ${missingLaneEnv().join(', ')}.`),
			{ status: 503, code: 'not_configured' },
		);
	}

	let result;
	try {
		result = await textToImage(prompt, { aspectRatio, seed });
	} catch (err) {
		throw mapLaneError(err);
	}

	const url = result?.imageUrl;
	if (!url || !/^https?:\/\//.test(url)) {
		throw Object.assign(new Error('Image lane returned no usable image URL.'), {
			status: 502,
			code: 'generation_failed',
		});
	}

	const { width, height } = dimensionsFor(aspectRatio);
	let quota = null;
	if (free) quota = await consumeFreeQuota(ip);

	return {
		url,
		provider: providerLabel(result),
		model: result.model || null,
		width,
		height,
		aspect_ratio: aspectRatio,
		seed: Number.isInteger(seed) ? seed : null,
		free: Boolean(free),
		...(quota ? { quota } : {}),
	};
}

// ── Paid endpoint (free-quota funnel → x402) ─────────────────────────────────

const paidImage = paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: PRICE_ATOMICS,
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws AI Image',
		tags: ['image', 'text-to-image', 'ai', 'agent', 'solana'],
	}),
	requiredScope: 'x402:bypass',
	// Free-tier funnel: an IP still under its daily quota bypasses payment. The
	// slot is only spent AFTER a real image ships (in generateAndRespond), so a
	// validation error / refusal / outage never burns a free generation. Peek is
	// read-only and fails open, so a Redis hiccup can't wrongly demand payment.
	accessControl: installAccessControl({
		requiredScope: 'x402:bypass',
		resolveCaller: async ({ req }) => {
			const ip = clientIp(req);
			const q = await peekFreeQuota(ip);
			if (q.allowed) {
				return { grantAccess: true, reason: 'ai_image_free_daily', callerId: `ip:${ip}` };
			}
			return null;
		},
	}),

	async handler({ req, bypass }) {
		const buf = await readBody(req, MAX_BODY_BYTES);
		const parsed = parseImageRequest(buf.toString('utf8'));
		const free = bypass?.reason === 'ai_image_free_daily';
		return generateAndRespond(parsed, { free, ip: clientIp(req) });
	},
});

// ── GET surfaces: discovery + health (both free, no quota burn) ──────────────

const health = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	const report = await imageLaneHealth();
	return json(res, report.configured ? 200 : 503, { ...report, generated_at: new Date().toISOString() });
});

const discovery = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	const config = imageLaneConfig();
	return json(res, 200, {
		route: ROUTE,
		method: 'POST',
		description: DESCRIPTION,
		free_tier: { images_per_day_per_ip: freePerDay(), then: 'x402 pay-per-image' },
		price_usdc: (Number(PRICE_ATOMICS) / 1e6).toFixed(6),
		price_atomics: String(PRICE_ATOMICS),
		networks: ['solana', 'base'],
		input: INPUT_SCHEMA,
		output_example: OUTPUT_EXAMPLE,
		lanes_configured: { nim: config.nim, vertex: config.vertex, replicate: config.replicate },
		health: `${ROUTE}?health=1`,
	});
});

// Single default export multiplexes the path: GET ?health=1 → health probe,
// other GET → discovery doc, everything else → the paid POST endpoint (which
// owns CORS/method enforcement, the free-quota bypass, and the 402 challenge).
export default function handler(req, res) {
	if (req.method === 'GET') {
		let hasHealth = false;
		try {
			hasHealth = new URL(req.url, 'http://localhost').searchParams.has('health');
		} catch { /* malformed url → treat as discovery */ }
		return hasHealth ? health(req, res) : discovery(req, res);
	}

	// Honest degradation: with NO image lane configured, answer every POST with a
	// clean 503 that NAMES the env vars to set — before the payment dance, so a
	// buyer is never challenged (or charged) for a good we cannot deliver. This
	// runs here rather than inside the paid handler because a handler throw for a
	// 5xx is sanitized to a generic "internal error" by the error boundary, which
	// would hide the actionable env-var list. The moment any lane env lands, this
	// check passes and the funnel (free quota → 402) takes over unchanged.
	if (req.method === 'POST' && !imageLaneConfig().anyConfigured) {
		if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
		return error(
			res,
			503,
			'not_configured',
			`No image lane is configured. Set one of: ${missingLaneEnv().join(', ')}.`,
		);
	}

	return paidImage(req, res);
}
