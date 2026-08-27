// x402 `auth-hints` extension — declare authentication paths a client can use
// instead of paying via x402.
//
// Spec: /tmp/x402-docs/specs/extensions/extension-auth-hints.md
//
// The extension surfaces in a 402 response under `extensions["auth-hints"]`
// and maps specific `accepts[]` entries to required authentication methods.
// We use it to advertise FREE-tier accept entries (amount=0) that require
// either an OAuth 2.0 access token or a Sign-In-With-X proof. The paid-
// endpoint helper short-circuits the payment dance when a valid auth header
// is present, granting access without settling on-chain.
//
// Auth credentials travel as standard HTTP headers — NOT inside the x402
// PaymentPayload:
//
//   OAuth 2.0 (Bearer):   Authorization: Bearer <access-token>
//   Sign-In-With-X:       SIGN-IN-WITH-X: <base64-encoded-siwx-proof>
//
// The base64 SIWX proof format is the standard CAIP-122 envelope used by the
// `sign-in-with-x` extension (parsed via @x402/extensions/sign-in-with-x).
//
// Difference from the existing `siwx-server.js` flow:
//   - siwx-server.js gates SIWX on a PRIOR paid grant (the wallet must have
//     paid once for this resource before SIWX re-entry works).
//   - auth-hints SIWX is a free alternative to payment — the wallet just
//     needs to sign a fresh CAIP-122 challenge.

import {
	parseSIWxHeader,
	validateSIWxMessage,
	verifySIWxSignature,
} from '@x402/extensions/sign-in-with-x';
import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { evmTransport } from '../evm/rpc.js';

import { env } from '../env.js';
import { authenticateBearer, hasScope } from '../auth.js';
import { siwxStorage, normalizeAddress } from '../siwx-storage.js';

export const AUTH_HINTS_EXTENSION_KEY = 'auth-hints';
export const SIWX_HEADER = 'sign-in-with-x';

// JSON-Schema for the extension body, kept inline so the 402 response is
// self-describing for validators that don't fetch the spec separately. Mirrors
// the schema fragment from the auth-hints spec.
const AUTH_HINTS_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['authRequirements'],
	properties: {
		authRequirements: {
			type: 'array',
			minItems: 1,
			items: {
				type: 'object',
				required: ['acceptIndexes', 'methods'],
				properties: {
					acceptIndexes: {
						type: 'array',
						items: { type: 'integer', minimum: 0 },
						description: 'Indexes into accepts[] this requirement applies to.',
					},
					methods: {
						type: 'array',
						minItems: 1,
						items: {
							type: 'object',
							required: ['type'],
							properties: { type: { type: 'string' } },
						},
					},
				},
			},
		},
	},
};

function buildOauth2Method({
	tokenType = 'Bearer',
	authorizationServer = env.APP_ORIGIN,
	tokenEndpoint = `${env.APP_ORIGIN}/api/oauth/token`,
	registrationEndpoint = `${env.APP_ORIGIN}/api/oauth/register`,
} = {}) {
	const method = {
		type: 'oauth2',
		tokenType,
		authorizationServer,
		tokenEndpoint,
	};
	if (registrationEndpoint) method.registrationEndpoint = registrationEndpoint;
	return method;
}

function buildSiwxMethod() {
	return { type: 'sign-in-with-x' };
}

function validateAuthRequirements(authRequirements) {
	if (!Array.isArray(authRequirements) || authRequirements.length === 0) {
		throw new Error('declareAuthHintsExtension: authRequirements must be a non-empty array');
	}
	for (const r of authRequirements) {
		if (!Array.isArray(r.acceptIndexes) || r.acceptIndexes.length === 0) {
			throw new Error('declareAuthHintsExtension: acceptIndexes must be a non-empty array');
		}
		if (!r.acceptIndexes.every((i) => Number.isInteger(i) && i >= 0)) {
			throw new Error('declareAuthHintsExtension: acceptIndexes must be non-negative integers');
		}
		if (!Array.isArray(r.methods) || r.methods.length === 0) {
			throw new Error('declareAuthHintsExtension: methods must be a non-empty array');
		}
		for (const m of r.methods) {
			if (!m || typeof m.type !== 'string') {
				throw new Error('declareAuthHintsExtension: each method needs a string `type`');
			}
		}
	}
}

/**
 * Build the `auth-hints` extension entry for a 402 PaymentRequired body.
 *
 * Two calling conventions:
 *   • Pass `{ authRequirements: [...] }` to declare requirements verbatim.
 *   • Pass `{ oauth2, siwx }` as shorthand where each entry is
 *     `{ acceptIndexes: number[], ...methodFields }`. We expand each into a
 *     full authRequirements entry with one method.
 *
 * Returns an object suitable for spreading into `build402Body`'s `extensions`
 * argument: `extensions: { ...declareAuthHintsExtension({...}) }`.
 */
export function declareAuthHintsExtension(input) {
	if (!input || typeof input !== 'object') {
		throw new Error('declareAuthHintsExtension: input is required');
	}

	let authRequirements;
	if (Array.isArray(input.authRequirements)) {
		authRequirements = input.authRequirements;
	} else {
		authRequirements = [];
		if (input.oauth2) {
			if (!Array.isArray(input.oauth2.acceptIndexes)) {
				throw new Error('declareAuthHintsExtension: oauth2.acceptIndexes is required');
			}
			authRequirements.push({
				acceptIndexes: input.oauth2.acceptIndexes,
				methods: [buildOauth2Method(input.oauth2)],
			});
		}
		if (input.siwx) {
			if (!Array.isArray(input.siwx.acceptIndexes)) {
				throw new Error('declareAuthHintsExtension: siwx.acceptIndexes is required');
			}
			authRequirements.push({
				acceptIndexes: input.siwx.acceptIndexes,
				methods: [buildSiwxMethod()],
			});
		}
	}

	validateAuthRequirements(authRequirements);

	return {
		[AUTH_HINTS_EXTENSION_KEY]: {
			info: { authRequirements },
			schema: AUTH_HINTS_SCHEMA,
		},
	};
}

// Zero-amount EVM accept that signals "free when authenticated". The payment
// dance for such entries is short-circuited in paid-endpoint.js when a valid
// auth header is presented. Asset + payTo are still real values so schema
// validators that don't special-case amount=0 still accept the entry.
export function freeEvmAcceptForAuth({ network, asset, payTo, authType }) {
	return {
		scheme: 'exact',
		network,
		amount: '0',
		asset,
		payTo,
		maxTimeoutSeconds: 60,
		extra: {
			name: 'USD Coin',
			version: '2',
			decimals: 6,
			authRequired: authType,
		},
	};
}

// ─── Header verification ────────────────────────────────────────────────────

function extractBearerToken(req) {
	const h = req.headers?.authorization || req.headers?.Authorization || '';
	if (typeof h !== 'string') return null;
	if (!h.toLowerCase().startsWith('bearer ')) return null;
	return h.slice(7).trim() || null;
}

function readSiwxHeader(req) {
	const raw =
		req.headers?.[SIWX_HEADER] ||
		req.headers?.['SIGN-IN-WITH-X'] ||
		req.headers?.['Sign-In-With-X'];
	return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

// Lazy viem client used to verify EIP-1271 / EIP-6492 smart-wallet signatures.
// Mirrors siwx-server.js so both code paths share the same RPC.
let _baseClient;
function getEvmVerifier() {
	if (!env.BASE_RPC_URL) return undefined;
	if (!_baseClient) {
		// BASE_RPC_URL stays primary (a private node, so buyer addresses are not
		// broadcast to public RPCs on the happy path); the shared Base endpoints
		// only take over when it fails, so a dead private node cannot block
		// every smart-wallet sign-in.
		_baseClient = createPublicClient({ chain: base, transport: evmTransport(base.id, { primaryUrl: env.BASE_RPC_URL }) });
	}
	return _baseClient.verifyMessage.bind(_baseClient);
}

/**
 * Verify a SIGN-IN-WITH-X header against the auth-hints contract:
 *   - parse the CAIP-122 envelope (delegated to @x402/extensions)
 *   - validate the message belongs to this resource and hasn't expired
 *   - verify the signature (EOA, EIP-1271, EIP-6492, or Solana ed25519)
 *   - burn the nonce so the same proof can't be replayed
 *
 * Returns `{ ok: true, principal: { ... } }` on success.
 * Returns `{ ok: false, reason }` when a header was presented but failed any
 * step — the caller should reject the request rather than silently falling
 * through to the payment flow.
 */
export async function verifyAuthHintsSiwx({ req, resourceUrl }) {
	const header = readSiwxHeader(req);
	if (!header) return null;

	let payload;
	try {
		payload = parseSIWxHeader(String(header));
	} catch {
		return { ok: false, reason: 'invalid_siwx_proof' };
	}

	const validation = await validateSIWxMessage(payload, resourceUrl, {
		maxAge: 5 * 60 * 1000,
		checkNonce: async (n) => !(await siwxStorage.hasUsedNonce(n)),
	});
	if (!validation.valid) {
		return { ok: false, reason: 'invalid_siwx_message', detail: validation.error };
	}

	const verification = await verifySIWxSignature(payload, { evmVerifier: getEvmVerifier() });
	if (!verification.valid || !verification.address) {
		return { ok: false, reason: 'invalid_siwx_signature', detail: verification.error };
	}

	const address = normalizeAddress(payload.chainId, verification.address);

	// Atomically claim the nonce so the proof can't be replayed against this
	// endpoint. The claim is the authoritative gate, not the earlier
	// checkNonce read: under concurrency two requests bearing the same proof
	// both pass validation, but only one wins the INSERT — the loser is a
	// replay and must be rejected here rather than granted free access.
	const claimed = await siwxStorage.recordNonce(payload.nonce, {
		resource: resourceUrl,
		address,
	});
	if (!claimed) {
		return { ok: false, reason: 'siwx_nonce_replayed' };
	}

	return {
		ok: true,
		principal: {
			method: 'sign-in-with-x',
			address,
			network: payload.chainId,
		},
	};
}

/**
 * Try OAuth Bearer auth as advertised by an `auth-hints` extension.
 * Returns:
 *   • null                                  → header absent, caller should fall through.
 *   • { ok: false, reason }                 → header present but invalid (reject).
 *   • { ok: true, principal: {...} }        → authenticated.
 */
export async function verifyAuthHintsOauth(req, { audience, requiredScope } = {}) {
	const bearer = extractBearerToken(req);
	if (!bearer) return null;
	const claims = await authenticateBearer(bearer, {
		audience: audience || env.MCP_RESOURCE,
	});
	if (!claims) return { ok: false, reason: 'invalid_token' };
	if (requiredScope && !hasScope(claims.scope, requiredScope)) {
		return { ok: false, reason: 'insufficient_scope' };
	}
	return {
		ok: true,
		principal: {
			method: 'oauth2',
			source: claims.source,
			userId: claims.userId,
			scope: claims.scope,
			clientId: claims.clientId || null,
		},
	};
}

/**
 * Attempt to authenticate a request via the headers signaled by an `auth-hints`
 * extension. Tries OAuth Bearer first (cheap, in-process verify), then SIWX.
 *
 * Returns null when no auth header was presented, `{ ok: false, reason }` when
 * a header was presented but failed verification, and
 * `{ ok: true, principal }` on success.
 */
export async function authenticateAuthHintsRequest(req, opts = {}) {
	const oauthResult = await verifyAuthHintsOauth(req, opts);
	if (oauthResult) return oauthResult;
	if (opts.resourceUrl) {
		const siwxResult = await verifyAuthHintsSiwx({ req, resourceUrl: opts.resourceUrl });
		if (siwxResult) return siwxResult;
	}
	return null;
}

export const __test = {
	AUTH_HINTS_SCHEMA,
	buildOauth2Method,
	buildSiwxMethod,
	validateAuthRequirements,
};
