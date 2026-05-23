// GET /api/x402/model-check?url=<glb-or-gltf>
//
// Paid endpoint cataloged by the CDP x402 Bazaar (agentic.market). For $0.001
// USDC on Base mainnet the server fetches the model bytes, runs the
// glTF-Transform inspector, and returns structural stats + optimization hints.
// Buyers pay programmatically with @x402/fetch — no API keys.
//
// Wire stack: plain Node handler + our internal x402-spec.js (facilitator-
// agnostic verify/settle). The same path /api/mcp uses. Stays alive even when
// CDP creds are absent — the 402 challenge still emits a proper bazaar
// discovery extension so the catalog can index this endpoint. Verify+settle
// routes to whichever facilitator X402_FACILITATOR_URL_BASE points at (PayAI
// by default; set to CDP's URL for first-class CDP-Bazaar settlement).

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
import { inspectModel, suggestOptimizations } from '../_lib/model-inspect.js';
import { assertSafePublicUrl, SsrfBlockedError } from '../_lib/ssrf-guard.js';
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
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';

const REQUIRED_SCOPE = 'x402:bypass';
const accessControl = installAccessControl({ requiredScope: REQUIRED_SCOPE });
const routeConfig = { path: '/api/x402/model-check', method: 'GET', requiredScope: REQUIRED_SCOPE };

const ROUTE = '/api/x402/model-check';
const MAX_FETCH_BYTES = 16 * 1024 * 1024;

const ROUTE_DESCRIPTION =
	'three.ws Model Check — fetch a glTF/GLB model from a URL, run the canonical ' +
	'glTF-Transform inspector, and return structural stats (vertices, triangles, ' +
	'materials, textures, animations, extensions) plus a prioritized list of ' +
	'optimization recommendations. Useful for any agent vetting a 3D asset before ' +
	'minting, embedding, or paying for it. Pay-per-call in USDC on Base mainnet.';

const DISCOVERY_INPUT_EXAMPLE = {
	url: 'https://three.ws/avatar/character-studio/sample.glb',
};

const DISCOVERY_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['url'],
	properties: {
		url: {
			type: 'string',
			format: 'uri',
			description:
				'Public HTTPS URL of a glTF (.gltf) or binary glTF (.glb) model. Max 16 MiB.',
		},
	},
};

const DISCOVERY_OUTPUT_EXAMPLE = {
	url: 'https://three.ws/avatar/character-studio/sample.glb',
	fetchedBytes: 1572864,
	model: {
		container: 'glb',
		generator: 'three.ws CharacterStudio v1.5',
		version: '2.0',
		extensionsUsed: ['KHR_materials_unlit'],
		extensionsRequired: [],
		counts: {
			scenes: 1,
			nodes: 18,
			meshes: 6,
			materials: 4,
			textures: 3,
			animations: 1,
			skins: 1,
			totalVertices: 12480,
			totalTriangles: 24812,
			indexedPrimitives: 6,
			nonIndexedPrimitives: 0,
		},
	},
	suggestions: [
		{
			id: 'texture_size',
			severity: 'info',
			message: 'All textures are within 1024x1024 — good for mobile.',
		},
	],
};

const DISCOVERY_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['url', 'fetchedBytes', 'model', 'suggestions'],
	properties: {
		url: { type: 'string', format: 'uri' },
		fetchedBytes: { type: 'integer' },
		model: {
			type: 'object',
			required: ['container', 'counts'],
			properties: {
				container: { type: 'string', enum: ['glb', 'gltf'] },
				generator: { type: ['string', 'null'] },
				version: { type: ['string', 'null'] },
				extensionsUsed: { type: 'array', items: { type: 'string' } },
				extensionsRequired: { type: 'array', items: { type: 'string' } },
				counts: {
					type: 'object',
					properties: {
						scenes: { type: 'integer' },
						nodes: { type: 'integer' },
						meshes: { type: 'integer' },
						materials: { type: 'integer' },
						textures: { type: 'integer' },
						animations: { type: 'integer' },
						skins: { type: 'integer' },
						totalVertices: { type: 'integer' },
						totalTriangles: { type: 'integer' },
						indexedPrimitives: { type: 'integer' },
						nonIndexedPrimitives: { type: 'integer' },
					},
				},
			},
		},
		suggestions: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'severity', 'message'],
				properties: {
					id: { type: 'string' },
					severity: { type: 'string', enum: ['info', 'warn', 'critical'] },
					message: { type: 'string' },
					estimate: { type: 'string' },
				},
			},
		},
	},
};

const ROUTE_BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'GET',
			queryParams: DISCOVERY_INPUT_EXAMPLE,
		},
		output: { type: 'json', example: DISCOVERY_OUTPUT_EXAMPLE },
	},
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
	// permit2VariantOf returns null without CDP credentials (PayAI doesn't
	// settle Permit2). When CDP is configured, append a sibling so SDK clients
	// can take the gasless EIP-2612 path; build402Body will auto-declare the
	// matching gas-sponsoring extensions in response.extensions.
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

async function fetchAndInspect(targetUrl) {
	let parsed;
	try {
		parsed = await assertSafePublicUrl(targetUrl, { allowHttp: true });
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			const e = new Error(err.message);
			e.code = 'invalid_url';
			e.status = 400;
			throw e;
		}
		throw err;
	}
	let upstream;
	try {
		upstream = await fetch(parsed.toString(), {
			redirect: 'follow',
			headers: { accept: 'model/gltf-binary,model/gltf+json,application/octet-stream' },
			signal: AbortSignal.timeout(20_000),
		});
	} catch (err) {
		const e = new Error(`could not fetch model: ${err.message}`);
		e.code = 'fetch_failed';
		e.status = 502;
		throw e;
	}
	if (!upstream.ok) {
		const err = new Error(`upstream returned ${upstream.status} ${upstream.statusText}`);
		err.code = 'fetch_failed';
		err.status = 502;
		throw err;
	}
	const contentLength = Number(upstream.headers.get('content-length') || 0);
	if (contentLength && contentLength > MAX_FETCH_BYTES) {
		const err = new Error(`model is ${contentLength} bytes; max is ${MAX_FETCH_BYTES}`);
		err.code = 'too_large';
		err.status = 413;
		throw err;
	}
	const buf = new Uint8Array(await upstream.arrayBuffer());
	if (buf.byteLength > MAX_FETCH_BYTES) {
		const err = new Error(`model is ${buf.byteLength} bytes; max is ${MAX_FETCH_BYTES}`);
		err.code = 'too_large';
		err.status = 413;
		throw err;
	}
	let info;
	try {
		info = await inspectModel(buf, { fileSize: buf.byteLength });
	} catch (err) {
		const e = new Error(err.message || 'failed to parse model');
		e.code = 'invalid_model';
		e.status = 422;
		throw e;
	}
	return {
		url: parsed.toString(),
		fetchedBytes: buf.byteLength,
		model: info,
		suggestions: suggestOptimizations(info),
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
		serviceName: 'three.ws Model Check',
		tags: ['3d', 'gltf', 'glb', 'inspection', 'validation'],
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

	// USE-23: access-control hook short-circuits payment for internal /
	// subscription / OAuth callers before we even read the X-PAYMENT header.
	const acResult = await accessControl(req, routeConfig);
	if (acResult?.abort) {
		if (acResult.headers) {
			for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		}
		return error(
			res,
			acResult.status || 403,
			acResult.code || 'access_denied',
			acResult.reason || 'access denied',
		);
	}
	if (acResult?.grantAccess) {
		const target = String(req.query?.url || '').trim();
		if (!target) return error(res, 400, 'missing_url', 'query param "url" is required');
		let result;
		try {
			result = await fetchAndInspect(target);
		} catch (err) {
			return error(res, err.status || 500, err.code || 'internal_error', err.message);
		}
		if (acResult.headers) {
			for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		}
		res.setHeader('x-payment-bypass', acResult.reason || 'granted');
		res.setHeader('cache-control', 'no-store');
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(JSON.stringify(result));
		return;
	}

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

	const target = String(req.query?.url || '').trim();
	if (!target) return error(res, 400, 'missing_url', 'query param "url" is required');

	let result;
	try {
		result = await fetchAndInspect(target);
	} catch (err) {
		return error(res, err.status || 500, err.code || 'internal_error', err.message);
	}

	let settled;
	try {
		settled = await settlePayment({
			paymentPayload: verified.paymentPayload,
			requirement: verified.requirement,
		});
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
