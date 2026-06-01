// GET /api/insights/revenue-vision
//
// Paid endpoint cataloged by the CDP x402 Bazaar (agentic.market) and the
// pay-skills registry. For $0.001 USDC the server hands the caller's
// mission_brief to Claude and returns a structured
// { power_mode, insight, recommended_move, confidence } object. Buyers pay
// programmatically with @x402/fetch — no API keys.
//
// Networks: Base mainnet (EIP-3009 + Permit2 sibling) and Solana mainnet
// (USDC). verifyPayment / settlePayment in x402-spec.js routes per-network:
// Base via X402_FACILITATOR_URL_BASE and Solana via X402_FACILITATOR_URL_SOLANA
// (PayAI by default). The Solana entry is omitted when X402_PAY_TO_SOLANA is
// unset so the 402 challenge stays valid.

import { wrap, cors, error } from '../_lib/http.js';
import {
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
	send402,
	verifyPayment,
	settlePayment,
	encodePaymentResponseHeader,
	permit2VariantOf,
	resolveResourceUrl,
	buildBazaarSchema,
} from '../_lib/x402-spec.js';
import { env } from '../_lib/env.js';
import { llmComplete, LlmUnavailableError } from '../_lib/llm.js';
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	extractIdFromHeader,
	hashRequestPayload,
	paymentIdentifierExtension,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from '../_lib/x402/payment-identifier-server.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';

const ROUTE = '/api/insights/revenue-vision';

const ROUTE_DESCRIPTION =
	'Revenue Vision — agentic growth analysis for AI buyers. Hand over a mission_brief ' +
	'(a free-text growth question or hypothesis) and get back a single prioritized next-best ' +
	'tactical move, a specific data-grounded insight, and an honestly-calibrated confidence ' +
	'rating. Powered by Claude. Pay-per-call in USDC on Base mainnet.';

const DISCOVERY_INPUT_EXAMPLE = {
	agent_codename: 'ledger-bot',
	power_request: 'revenue-vision',
	mission_brief: 'Find the highest-converting buyer segment this week.',
};

const DISCOVERY_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['agent_codename', 'power_request', 'mission_brief'],
	properties: {
		agent_codename: {
			type: 'string',
			description: 'Caller agent name for attribution and rate-limit telemetry.',
		},
		power_request: {
			type: 'string',
			enum: ['revenue-vision'],
			description: 'Power mode requested. Currently only "revenue-vision".',
		},
		mission_brief: {
			type: 'string',
			minLength: 4,
			maxLength: 4000,
			description: 'Free-text growth question or hypothesis to analyze.',
		},
	},
};

const DISCOVERY_OUTPUT_EXAMPLE = {
	power_mode: 'revenue-vision',
	insight:
		'Developer teams at 10–50 employees convert 2.4x better than enterprise prospects on the current funnel.',
	recommended_move:
		'Shift 30% of the paid-acquisition budget to builder-focused onboarding campaigns this sprint.',
	confidence: 'high',
};

const DISCOVERY_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['power_mode', 'insight', 'recommended_move', 'confidence'],
	properties: {
		power_mode: { type: 'string', enum: ['revenue-vision'] },
		insight: {
			type: 'string',
			description: 'A specific, data-grounded observation about the mission.',
		},
		recommended_move: {
			type: 'string',
			description: 'A single tactical action the caller should take next.',
		},
		confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
	},
};

const ROUTE_BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'GET',
			queryParams: DISCOVERY_INPUT_EXAMPLE,
			queryParamsSchema: DISCOVERY_INPUT_SCHEMA,
		},
		output: { type: 'json', example: DISCOVERY_OUTPUT_EXAMPLE },
	},
	// Bazaar meta-schema describing the {input, output} envelope (NOT the raw
	// response body). buildBazaarSchema nests DISCOVERY_OUTPUT_SCHEMA under
	// schema.properties.output.properties.example, which is exactly where the
	// AgentCash / x402scan discovery validators read it from. Setting `schema`
	// to the raw output schema instead makes those validators report the input
	// and output schemas as missing (extensions.bazaar.schema.properties.input
	// and .output absent), so this must mirror the other paid routes.
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: DISCOVERY_INPUT_SCHEMA,
		outputSchema: DISCOVERY_OUTPUT_SCHEMA,
	}),
};

function buildRequirements(resourceUrl) {
	const eip3009 = {
		scheme: 'exact',
		network: NETWORK_BASE_MAINNET,
		amount: env.X402_MAX_AMOUNT_REQUIRED,
		payTo: env.X402_PAY_TO_BASE,
		asset: env.X402_ASSET_ADDRESS_BASE,
		maxTimeoutSeconds: 60,
		resource: resourceUrl,
		extra: { name: 'USD Coin', version: '2', decimals: 6 },
	};
	const out = [eip3009];
	const permit2 = permit2VariantOf(eip3009);
	if (permit2) out.push(permit2);
	if (env.X402_PAY_TO_SOLANA) {
		out.push({
			scheme: 'exact',
			network: NETWORK_SOLANA_MAINNET,
			amount: env.X402_MAX_AMOUNT_REQUIRED,
			payTo: env.X402_PAY_TO_SOLANA,
			asset: env.X402_ASSET_MINT_SOLANA,
			maxTimeoutSeconds: 60,
			resource: resourceUrl,
			extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
		});
	}
	return out;
}

const SYSTEM_PROMPT =
	'You are Revenue Vision, an agentic growth analyst. Reply with a single JSON object ' +
	'exactly matching the schema {"power_mode":"revenue-vision","insight":string,"recommended_move":string,"confidence":"high"|"medium"|"low"}. ' +
	'The insight should be specific and quantitative when possible. The recommended_move should be one concrete tactical action. ' +
	'Calibrate confidence honestly: "high" only when you can defend the claim, otherwise "medium" or "low". ' +
	'No prose, no markdown, no preamble.';

async function callLlm(missionBrief, agentCodename) {
	const { text } = await llmComplete({
		system: SYSTEM_PROMPT,
		user: `Caller agent: ${agentCodename}\nMission brief: ${missionBrief}\n\nReturn the JSON object only.`,
		maxTokens: 800,
	});
	const match = text.match(/\{[\s\S]*\}/);
	const parsed = JSON.parse(match ? match[0] : text);
	const allowedConfidence = new Set(['high', 'medium', 'low']);
	return {
		power_mode: 'revenue-vision',
		insight: String(parsed.insight || '').trim(),
		recommended_move: String(parsed.recommended_move || '').trim(),
		confidence: allowedConfidence.has(parsed.confidence) ? parsed.confidence : 'medium',
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET');
		return error(res, 405, 'method_not_allowed', 'use GET');
	}

	const resourceUrl = resolveResourceUrl(req, ROUTE);
	const requirements = buildRequirements(resourceUrl);
	const service = withService({
		serviceName: 'three.ws Revenue Vision',
		tags: ['ai', 'analysis', 'growth', 'insight', 'claude'],
	});
	const challenge = {
		resourceUrl,
		accepts: requirements,
		description: ROUTE_DESCRIPTION,
		bazaar: ROUTE_BAZAAR,
		extensions: { [PAYMENT_IDENTIFIER]: paymentIdentifierExtension(false) },
		serviceName: service.serviceName,
		tags: service.tags,
		iconUrl: service.iconUrl,
	};

	const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
	if (!paymentHeader) return send402(res, challenge);

	// USE-15: idempotency cache lookup before paying for /verify.
	const paymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({
		method: req.method,
		url: req.url,
		body: null,
	});
	if (paymentId) {
		const lookup = await checkCache({ route: ROUTE, paymentId, payloadHash });
		if (lookup.kind === 'hit') return writeCachedResponse(res, lookup.entry);
		if (lookup.kind === 'conflict') {
			return writeConflict(res, {
				route: ROUTE,
				attemptedHash: lookup.attemptedHash,
				existingHash: lookup.existingHash,
			});
		}
	}

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements });
	} catch (err) {
		if (err.status === 402) return send402(res, { ...challenge, error: err.message });
		return error(res, err.status || 502, err.code || 'verify_failed', err.message);
	}

	const agentCodename = String(req.query?.agent_codename || '').trim();
	const powerRequest = String(req.query?.power_request || '').trim();
	const missionBrief = String(req.query?.mission_brief || '').trim();

	if (!agentCodename || agentCodename.length > 120)
		return error(res, 400, 'invalid_agent_codename', 'agent_codename is required (≤120 chars)');
	if (powerRequest !== 'revenue-vision')
		return error(res, 400, 'invalid_power_request', 'power_request must be "revenue-vision"');
	if (missionBrief.length < 4 || missionBrief.length > 4000)
		return error(res, 400, 'invalid_mission_brief', 'mission_brief must be 4–4000 chars');

	let result;
	try {
		result = await callLlm(missionBrief, agentCodename);
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(res, 503, 'llm_unavailable', 'revenue vision is not available right now');
		}
		return error(res, err.status || 502, err.code || 'upstream_error', err.message);
	}

	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		return error(res, err.status || 502, err.code || 'settle_failed', err.message);
	}

	const paymentResponseHeader = encodePaymentResponseHeader(settled);
	const contentType = 'application/json; charset=utf-8';
	const body = JSON.stringify(result);

	res.setHeader('x-payment-response', paymentResponseHeader);
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', contentType);
	res.end(body);

	if (paymentId) {
		await storeResponse({
			route: ROUTE,
			paymentId,
			payloadHash,
			status: 200,
			body,
			contentType,
			paymentResponseHeader,
		});
	}
});
