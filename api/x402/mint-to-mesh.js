// Re-listed per the 2026-07-08 storefront cleanup (prompt 18): turning an
// arbitrary on-chain SPL mint into an instantly renderable, themed 3D asset
// on demand is a real, distinct capability (Forge is prompt-driven generation
// — this is deterministic token-to-mesh rendering). The Mei foundry NPC in
// /play also buys through this same route.
// GET /api/x402/mint-to-mesh?mint=<solana-mint>
//
// Paid endpoint cataloged by the CDP x402 Bazaar (agentic.market) and the
// pay-skills registry. For $0.001 USDC the server reads the token's on-chain
// Metaplex metadata, resolves the off-chain JSON, fetches the image (when one
// is exposed), and returns a themed binary glTF cube ready for any Three.js /
// Babylon.js / model-viewer instance to render.
//
// The cube is procedurally synthesized per request via @gltf-transform — no
// templated asset, no headless WebGL, no S3. Output ships as base64 inside a
// JSON envelope so x402 facilitators that struggle with binary bodies still
// receive a clean response.
//
// Networks: Base mainnet (EIP-3009 + Permit2 sibling) and Solana mainnet
// (USDC). verifyPayment / settlePayment in x402-spec.js routes per-network:
// Base via X402_FACILITATOR_URL_BASE and Solana via X402_FACILITATOR_URL_SOLANA
// (PayAI by default for both). The Solana entry is omitted when
// X402_PAY_TO_SOLANA is unset so the 402 challenge stays valid.

import { wrap, cors, error } from '../_lib/http.js';
import {
	send402,
	verifyPayment,
	settlePayment,
	encodePaymentResponseHeader,
	buildExactRequirements,
	resolveResourceUrl,
	buildBazaarSchema,
} from '../_lib/x402-spec.js';
import { env } from '../_lib/env.js';
import { createThemedGLB, colorFromMint } from '../_lib/glb-themer.js';
import { fetchTokenMeta } from '../_lib/solana-token-meta.js';
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	claimSlotOrRespond,
	extractIdFromHeader,
	hashPaymentProof,
	hashRequestPayload,
	paymentIdentifierExtension,
	releaseSlot,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from '../_lib/x402/payment-identifier-server.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';

const REQUIRED_SCOPE = 'x402:bypass';
const accessControl = installAccessControl({ requiredScope: REQUIRED_SCOPE });
const routeConfig = {
	path: '/api/x402/mint-to-mesh',
	method: 'GET',
	requiredScope: REQUIRED_SCOPE,
};

const ROUTE = '/api/x402/mint-to-mesh';

const ROUTE_DESCRIPTION =
	'three.ws Mint to Mesh — pass a Solana fungible-token mint, get back a binary ' +
	'glTF (GLB) cube themed for that token. The cube is colored from a stable hash ' +
	'of the mint and (when the off-chain metadata exposes a PNG/JPEG) carries the ' +
	'token image as a baseColor texture on every face. Asset.extras carry the full ' +
	'on-chain Metaplex metadata so downstream agents can introspect mint, name, ' +
	'symbol, and timestamp. Useful for any agent that needs an instantly renderable ' +
	'3D representation of a token (in-game items, leaderboards, NFT-of-token, AR ' +
	'previews). Pay-per-call in USDC on Base mainnet.';

const DISCOVERY_INPUT_EXAMPLE = {
	mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
};

const DISCOVERY_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mint'],
	properties: {
		mint: {
			type: 'string',
			minLength: 32,
			maxLength: 44,
			description: 'Base58 SPL mint address on Solana mainnet.',
		},
	},
};

const DISCOVERY_OUTPUT_EXAMPLE = {
	mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	theme: {
		name: 'three',
		symbol: 'THREE',
		color: [0.92, 0.45, 0.18],
		hasImage: false,
	},
	glb: {
		mimeType: 'model/gltf-binary',
		bytes: 50768,
		base64: 'Z2xURgIAAADQxAAA…(truncated; full GLB bytes are returned on a real call)',
	},
};

const DISCOVERY_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mint', 'theme', 'glb'],
	properties: {
		mint: { type: 'string' },
		theme: {
			type: 'object',
			required: ['name', 'symbol', 'color', 'hasImage'],
			properties: {
				name: { type: ['string', 'null'] },
				symbol: { type: ['string', 'null'] },
				color: {
					type: 'array',
					minItems: 3,
					maxItems: 3,
					items: { type: 'number', minimum: 0, maximum: 1 },
					description: 'RGB triplet in [0,1] used as baseColorFactor.',
				},
				imageUrl: { type: ['string', 'null'], format: 'uri' },
				hasImage: {
					type: 'boolean',
					description:
						'True when a PNG/JPEG image was fetched and embedded as a baseColor texture.',
				},
			},
		},
		glb: {
			type: 'object',
			required: ['mimeType', 'bytes', 'base64'],
			properties: {
				mimeType: { type: 'string', const: 'model/gltf-binary' },
				bytes: { type: 'integer', minimum: 1 },
				base64: {
					type: 'string',
					description: 'Base64-encoded binary glTF (GLB). Decode for the raw .glb file.',
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
	// Solana-first accepts, Base gated on baseSettleable() (CDP or opt-in) plus its
	// gasless Permit2 sibling under CDP — see buildExactRequirements.
	return buildExactRequirements(resourceUrl);
}

// Loose Solana base58 sanity check. Real validation happens in solanaPubkey()
// inside fetchTokenMeta — this just rejects obvious garbage early so we don't
// pay for an RPC round trip on it.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function buildMesh(mint) {
	let meta;
	try {
		meta = await fetchTokenMeta(mint);
	} catch (err) {
		const e = new Error(err.message || 'failed to read on-chain metadata');
		e.code = err.code || 'meta_fetch_failed';
		e.status = err.status || 502;
		throw e;
	}
	const color = colorFromMint(mint);
	const glb = await createThemedGLB({
		mint: meta.mint,
		name: meta.name,
		symbol: meta.symbol,
		image: meta.image?.bytes || null,
		imageMimeType: meta.image?.mimeType || null,
		color,
		extras: {
			description: meta.description || undefined,
			imageUrl: meta.imageUrl || undefined,
			externalUrl: meta.externalUrl || undefined,
			offchainUri: meta.uri || undefined,
		},
	});
	return {
		mint: meta.mint,
		theme: {
			name: meta.name,
			symbol: meta.symbol,
			color,
			imageUrl: meta.imageUrl,
			hasImage: !!meta.image,
		},
		glb: {
			mimeType: 'model/gltf-binary',
			bytes: glb.byteLength,
			base64: Buffer.from(glb).toString('base64'),
		},
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
		serviceName: 'three.ws Mint to Mesh',
		tags: ['3d', 'gltf', 'solana', 'token', 'render'],
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

	// USE-23: bypass payment for internal / subscription / OAuth callers.
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
		const mint = String(req.query?.mint || '').trim();
		if (!mint) return error(res, 400, 'missing_mint', 'query param "mint" is required');
		if (!BASE58_RE.test(mint))
			return error(
				res,
				400,
				'invalid_mint',
				'mint must be a base58 SPL address (32–44 chars)',
			);
		let result;
		try {
			result = await buildMesh(mint);
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
	const clientPaymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({
		method: req.method,
		url: req.url,
		body: null,
	});
	const paymentHash = hashPaymentProof(paymentHeader);
	// Always-on replay guard: the payment-identifier extension is client-opt-in,
	// so when the client omits it we fall back to the proof hash itself as the
	// dedup key (reproducible only by the original payer), making replay
	// protection unconditional. Same idiom as api/_lib/x402-paid-endpoint.js.
	const paymentId = clientPaymentId || (paymentHash ? `proof:${paymentHash}` : null);
	// Close the check-then-act window: N concurrent requests carrying the same
	// payment could all miss the cache, all run the paid work, and all settle
	// before the first response was stored. The NX claim admits exactly one;
	// the rest are answered inside claimSlotOrRespond (replay/conflict/in-flight).
	let ownsReservation = false;
	if (paymentId) {
		const lookup = await checkCache({ route: ROUTE, paymentId, payloadHash, paymentHash });
		if (lookup.kind === 'hit') return writeCachedResponse(res, lookup.entry);
		if (lookup.kind === 'conflict') {
			return writeConflict(res, {
				route: ROUTE,
				attemptedHash: lookup.attemptedHash,
				existingHash: lookup.existingHash,
				reason: lookup.reason,
			});
		}
		ownsReservation = await claimSlotOrRespond({ res, route: ROUTE, paymentId, payloadHash, paymentHash });
		if (!ownsReservation) return;
	}

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements });
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		if (err.status === 402) return send402(res, { ...challenge, error: err.message });
		return error(res, err.status || 502, err.code || 'verify_failed', err.message);
	}

	const mint = String(req.query?.mint || '').trim();
	if (!mint) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(res, 400, 'missing_mint', 'query param "mint" is required');
	}
	if (!BASE58_RE.test(mint)) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(res, 400, 'invalid_mint', 'mint must be a base58 SPL address (32–44 chars)');
	}

	let result;
	try {
		result = await buildMesh(mint);
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(res, err.status || 500, err.code || 'internal_error', err.message);
	}

	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
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
			paymentHash,
			status: 200,
			body,
			contentType,
			paymentResponseHeader,
		});
	}
});
