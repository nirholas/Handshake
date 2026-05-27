// Helper for building paid x402 endpoints with minimal boilerplate.
//
// A paid endpoint runs an 8-step dance: CORS → method-check → access-control
// hook (optional bypass) → SIWX short-circuit (when opted in) → 402 challenge
// (when no payment header) → verify → run the handler → settle → respond
// with the X-PAYMENT-RESPONSE header. We factor that into `paidEndpoint(spec)`
// so each new /api/x402/* file only has to declare its route metadata + a
// handler that returns JSON.
//
// Pricing: each endpoint gets its own `priceAtomics` (USDC has 6 decimals,
// so "1000" = $0.001). Networks default to Base mainnet only; pass
// `networks: ['base', 'solana']` to advertise both. The bazaar discovery
// extension is required — agentic.market's catalog rejects entries without
// it. See api/_lib/x402-spec.js for the v2 wire-format details.
//
// SIWX opt-in (Sign-In-With-X, CAIP-122). Add `siwx: { statement, ttlSeconds?,
// expirationSeconds? }` to opt the endpoint into wallet-signature re-access:
//   - statement: human-readable purpose shown to the wallet on signing.
//   - ttlSeconds: how long the payment grant lasts (null = permanent).
//   - expirationSeconds: SIWX message validity window (default 300s).
// When set, the 402 body declares the `sign-in-with-x` extension, and an
// incoming `SIGN-IN-WITH-X` header skips the X-PAYMENT path for any wallet
// already in siwx_payments. Fresh settlements record a grant automatically.
//
// Per-asset payouts. Pass `payTo: { base?, solana?, bsc? }` to override the
// shared env.X402_PAY_TO_* receivers — used by /api/x402/asset-download so
// each creator can collect USDC to their own wallet without forking the
// helper. Missing keys fall back to env (so a single override doesn't
// disable the other networks).

import { cors, error } from './http.js';
import { env } from './env.js';
import { clientIp } from './rate-limit.js';
import { logPaymentEvent } from './x402/audit-log.js';
import { PAYMENT_EVENT_TOPIC as BSC_PAYMENT_EVENT_TOPIC } from './x402-bsc-direct.js';
import {
	BUILDER_CODE,
	NETWORK_BASE_MAINNET,
	NETWORK_BSC_MAINNET,
	NETWORK_SOLANA_MAINNET,
	X402Error,
	encodePaymentResponseHeader,
	permit2VariantOf,
	resolveResourceUrl,
	send402,
	settlePayment,
	verifyPayment,
} from './x402-spec.js';
import { declareBuilderCodeExtension } from './x402-builder-code.js';
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	enforceRequired,
	extractIdFromHeader,
	hashRequestPayload,
	paymentIdentifierExtension,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from './x402/payment-identifier-server.js';
import {
	authenticateSiwx,
	declareSiwxExtensionFor,
	recordSiwxPayment,
} from './siwx-server.js';
import { normalizeAddress } from './siwx-storage.js';
import {
	buildOffersExtension,
	buildReceiptExtension,
} from './x402/offer-receipt-server.js';
import { recordReceipt } from './x402/receipt-storage.js';
import {
	authenticateAuthHintsRequest,
	declareAuthHintsExtension,
	freeEvmAcceptForAuth,
} from './x402/auth-hints.js';

const NETWORK_ALIASES = {
	base: NETWORK_BASE_MAINNET,
	'base-mainnet': NETWORK_BASE_MAINNET,
	bsc: NETWORK_BSC_MAINNET,
	'bsc-mainnet': NETWORK_BSC_MAINNET,
	solana: NETWORK_SOLANA_MAINNET,
	'solana-mainnet': NETWORK_SOLANA_MAINNET,
};

function resolveNetwork(name) {
	return NETWORK_ALIASES[name] || name;
}

function buildAccept(network, priceAtomics, resourceUrl, payToOverride) {
	const common = {
		scheme: 'exact',
		amount: String(priceAtomics),
		maxTimeoutSeconds: 60,
		resource: resourceUrl,
	};
	if (network === NETWORK_BASE_MAINNET) {
		return {
			...common,
			network: NETWORK_BASE_MAINNET,
			payTo: payToOverride?.base || env.X402_PAY_TO_BASE,
			asset: env.X402_ASSET_ADDRESS_BASE,
			// EIP-712 domain name must match the on-chain USDC contract — Base
			// USDC's domain is "USD Coin" (not "USDC"), or signatures fail.
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		};
	}
	if (network === NETWORK_SOLANA_MAINNET) {
		return {
			...common,
			network: NETWORK_SOLANA_MAINNET,
			payTo: payToOverride?.solana || env.X402_PAY_TO_SOLANA,
			asset: env.X402_ASSET_MINT_SOLANA,
			// PayAI requires this account as fee payer; without it /verify rejects.
			extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
		};
	}
	if (network === NETWORK_BSC_MAINNET) {
		const contract = payToOverride?.bsc || env.X402_PAY_TO_BSC;
		// Contract-mediated "direct" scheme — the client calls
		// ThreeWSPayments.pay(bytes32) from their own wallet (see x402-bsc-direct.js).
		return {
			...common,
			scheme: 'direct',
			network: NETWORK_BSC_MAINNET,
			payTo: contract,
			asset: env.X402_ASSET_ADDRESS_BSC,
			extra: {
				name: 'Binance-Peg USD Coin',
				decimals: 6,
				contract,
				method: 'pay(bytes32)',
				eventTopic: BSC_PAYMENT_EVENT_TOPIC,
			},
		};
	}
	throw new X402Error('unsupported_network', `paidEndpoint: unsupported network ${network}`, 500);
}

function buildRequirements({ priceAtomics, networks, resourceUrl, payToOverride }) {
	const out = [];
	for (const name of networks) {
		const net = resolveNetwork(name);
		const baseTo = payToOverride?.base || env.X402_PAY_TO_BASE;
		const solTo = payToOverride?.solana || env.X402_PAY_TO_SOLANA;
		const bscTo = payToOverride?.bsc || env.X402_PAY_TO_BSC;
		if (net === NETWORK_BASE_MAINNET && !baseTo) continue;
		if (net === NETWORK_SOLANA_MAINNET && !solTo) continue;
		if (net === NETWORK_BSC_MAINNET && !bscTo) continue;
		const accept = buildAccept(net, priceAtomics, resourceUrl, payToOverride);
		out.push(accept);
		// For EVM `exact` networks, advertise a Permit2 sibling so @x402/* SDK
		// clients can pick the gasless Permit2-via-EIP-2612 path. The EIP-3009
		// entry stays first so the browser modal (which only signs
		// transferWithAuthorization) keeps selecting it. send402/build402Body
		// auto-declares the eip2612GasSponsoring extension when this sibling
		// is present — no per-endpoint opt-in needed.
		const sibling = permit2VariantOf(accept);
		if (sibling) out.push(sibling);
	}
	if (!out.length) {
		throw new X402Error(
			'no_payto_configured',
			'paidEndpoint: no X402_PAY_TO_* configured for any requested network',
			500,
		);
	}
	return out;
}

// `spec.bazaar` is the v2 discoverable extension shape: { discoverable: true,
// info: { input, output }, schema }. See model-check.js for a worked example.
// `spec.handler({ req, res, requirement, payer })` is called only AFTER the
// payment verifies. It should return a JSON-serializable result; throwing an
// Error with .status + .code maps to a clean error response. Throwing an
// X402Error with status=402 re-emits the 402 challenge (e.g. wrong network).
//
// `spec.accessControl` (optional) — async (req, routeConfig) => result hook
// matching the v2 SDK onProtectedRequest contract. Built via
// installAccessControl() from api/_lib/x402/access-control.js. Returns:
//   • { grantAccess: true, reason, callerId, headers? } → bypass payment,
//     invoke the handler with `bypass = { reason, callerId, subscription?,
//     oauth? }` instead of `requirement`/`payer`, and skip settlement.
//   • { abort: true, status, reason, headers? } → reject the request with the
//     given status (default 403) and message.
//   • null / undefined → continue to the normal 402 flow.
//
// `spec.requiredScope` (optional) — OAuth scope the route declares for
// bypass-via-Bearer. Passed to the hook in routeConfig.requiredScope.
export function paidEndpoint(spec) {
	const {
		route,
		method = 'GET',
		priceAtomics = env.X402_MAX_AMOUNT_REQUIRED,
		networks = ['base', 'solana'],
		description,
		mimeType = 'application/json',
		bazaar,
		handler,
		// ERC-8021 builder-code attribution. Optional per-route service codes
		// — e.g. a multi-service route declares ["pose-studio", "openai-proxy"]
		// so the on-chain CBOR suffix records every internal service that
		// participated. The app code (`a`) is pulled from env so every route
		// attributes to the same X402_BUILDER_CODE_APP. When env is unset, no
		// builder-code extension is declared and echo verification is skipped.
		services,
		accessControl,
		requiredScope = null,
		// USE-15: payment-identifier idempotency. Defaults to optional so any
		// caller can opt in. Set `{ required: true }` for routes where a
		// duplicate call is materially expensive or observable (oracle
		// submissions, fact-check writes, on-chain mints). `ttlSeconds`
		// overrides the env default (X402_IDEMPOTENCY_TTL_SECONDS).
		paymentIdentifier = {},
		// Optional per-route payout overrides — { base?, solana?, bsc? }. When
		// set, replaces env.X402_PAY_TO_* on a network-by-network basis.
		// Missing keys fall back to env so a single override doesn't disable
		// the other networks.
		payTo,
		// Optional SIWX (Sign-In-With-X, CAIP-122) opt-in. See file header.
		siwx,
		// Optional per-request resource URL. Default = route path. For routes
		// that serve multiple distinct goods through query params (e.g.
		// /api/x402/asset-download?slug=…), pass (req) => string to make each
		// good its own SIWX grant key. The 402 challenge AND the SIWX message
		// both use this URL, so the client signs against the same string we
		// look up in siwx_payments.
		resourceUrlBuilder,
		// USE-21: `auth-hints` extension. Declares OAuth2 and/or SIWX as
		// alternatives to paying for this endpoint. When set, the 402 body
		// surfaces an `auth-hints` extension AND one zero-amount accepts[]
		// entry per declared method, mapping authRequirements → acceptIndexes.
		// A valid `Authorization: Bearer …` or `SIGN-IN-WITH-X: …` header
		// short-circuits the payment dance with no facilitator settle and no
		// X-PAYMENT-RESPONSE — the handler runs with `auth = { method, ... }`
		// in place of `requirement`/`payer`.
		//
		// Shape:
		//   authHints: {
		//     oauth2: { requiredScope, tokenType?, authorizationServer?,
		//               tokenEndpoint?, registrationEndpoint? } | true,
		//     siwx:   true,
		//   }
		// Passing `true` for either method opts in with sensible defaults.
		authHints,
		// USE-17: Offer & Receipt extension. Defaults to `{}` which enables the
		// extension when OFFER_RECEIPT_SIGNING_PRIVATE_KEY (eip712) or
		// OFFER_RECEIPT_JWK (jws) is configured. Set `offerReceipt: false` to
		// opt out, or `offerReceipt: { includeTxHash: true }` on routes that
		// feed reputation systems where on-chain verifiability is more
		// important than payer privacy. `offerValiditySeconds` overrides the
		// 300-second default for how long signed offers stay valid.
		offerReceipt = {},
		// USE-13: Bazaar resource-level service metadata. Set per route so the
		// facilitator can group / search / icon-ify the catalog entry. Pass
		// `service: { serviceName, tags, iconUrl }` or use withService() from
		// api/_lib/x402/bazaar-helpers.js to merge with three.ws defaults.
		// Fields fall through to build402Body which gates each on the spec
		// validation rules (printable ASCII, length caps, https URL).
		service,
	} = spec;

	if (!route) throw new Error('paidEndpoint: route is required');
	if (!description) throw new Error('paidEndpoint: description is required');
	if (!bazaar) throw new Error('paidEndpoint: bazaar discovery extension is required');
	if (typeof handler !== 'function') throw new Error('paidEndpoint: handler must be a function');
	if (accessControl != null && typeof accessControl !== 'function') {
		throw new Error('paidEndpoint: accessControl must be a function when provided');
	}
	if (siwx && typeof siwx.statement !== 'string') {
		throw new Error('paidEndpoint: siwx.statement is required when siwx is set');
	}

	const routeConfig = { path: route, method: method.toUpperCase(), requiredScope };
	const allowMethods = `${method.toUpperCase()},OPTIONS`;
	const pidRequired = Boolean(paymentIdentifier.required);
	const pidTtlSeconds = paymentIdentifier.ttlSeconds;
	const pidExtension = paymentIdentifierExtension(pidRequired);

	return async function paidHandler(req, res) {
		const requestStartTime = Date.now();
		if (cors(req, res, { methods: allowMethods, origins: '*' })) return;
		if (req.method !== method.toUpperCase()) {
			res.setHeader('allow', method.toUpperCase());
			return error(res, 405, 'method_not_allowed', `use ${method.toUpperCase()}`);
		}

		const resourceUrl =
			typeof resourceUrlBuilder === 'function'
				? resourceUrlBuilder(req)
				: resolveResourceUrl(req, route);
		let requirements;
		try {
			requirements = buildRequirements({
				priceAtomics,
				networks,
				resourceUrl,
				payToOverride: payTo,
			});
		} catch (err) {
			return error(
				res,
				err.status || 500,
				err.code || 'misconfigured',
				err.message || 'paid endpoint misconfigured',
			);
		}

		// USE-21 auth-hints: append zero-amount accept entries for each declared
		// auth method and build the auth-hints extension. The free entries
		// reuse the Base USDC asset block so schema-checking clients accept
		// them; amount="0" is the actual paywall bypass — these entries can
		// only be "settled" by presenting the matching auth header, never via
		// X-PAYMENT. The auth-hints extension maps each method to the index
		// of its free entry so the buyer client knows which entry corresponds
		// to which auth method.
		let authHintsExtension = null;
		if (authHints) {
			const baseTo = payTo?.base || env.X402_PAY_TO_BASE;
			if (baseTo) {
				const declarations = {};
				if (authHints.oauth2) {
					const oauthCfg = authHints.oauth2 === true ? {} : authHints.oauth2;
					const idx = requirements.length;
					requirements.push(
						freeEvmAcceptForAuth({
							network: NETWORK_BASE_MAINNET,
							asset: env.X402_ASSET_ADDRESS_BASE,
							payTo: baseTo,
							authType: 'oauth2',
						}),
					);
					declarations.oauth2 = { ...oauthCfg, acceptIndexes: [idx] };
				}
				if (authHints.siwx) {
					const idx = requirements.length;
					requirements.push(
						freeEvmAcceptForAuth({
							network: NETWORK_BASE_MAINNET,
							asset: env.X402_ASSET_ADDRESS_BASE,
							payTo: baseTo,
							authType: 'sign-in-with-x',
						}),
					);
					declarations.siwx = { acceptIndexes: [idx] };
				}
				if (declarations.oauth2 || declarations.siwx) {
					authHintsExtension = declareAuthHintsExtension(declarations);
				}
			}
		}

		// Build the builder-code extension once per challenge so the same block
		// is advertised in the 402 body AND passed to verifyPayment for echo
		// validation. If a route declares services, override the auto-declared
		// block from build402Body.
		const appCode = env.X402_BUILDER_CODE_APP;
		const builderCode =
			appCode && Array.isArray(services) && services.length
				? declareBuilderCodeExtension({ a: appCode, s: services })
				: appCode
					? declareBuilderCodeExtension({ a: appCode })
					: null;

		// SIWX extension advertised on every 402 when the endpoint opts in.
		// `requirements[].network` lists every CAIP-2 chain we'll accept a
		// signature for — the upstream helper turns it into supportedChains
		// and enriches the info block (domain/uri/nonce/issuedAt) per request.
		const siwxExtensions = siwx
			? await declareSiwxExtensionFor({
					networks: requirements.map((r) => r.network),
					resourceUrl,
					statement: siwx.statement,
					expirationSeconds: siwx.expirationSeconds,
				})
			: null;

		const extraExtensions = {
			[PAYMENT_IDENTIFIER]: pidExtension,
			...(builderCode ? { [BUILDER_CODE]: builderCode } : {}),
			...(siwxExtensions || {}),
			...(authHintsExtension || {}),
		};

		// USE-17: sign one offer per accepts[] entry (when issuer is
		// configured AND the route hasn't opted out). Failing here returns
		// null — we never want a missing signing key to break the 402 dance,
		// since the protocol stays valid without the extension.
		if (offerReceipt !== false) {
			const offersFragment = await buildOffersExtension(
				resourceUrl,
				requirements,
				offerReceipt || {},
			);
			if (offersFragment) Object.assign(extraExtensions, offersFragment);
		}

		const challenge = {
			resourceUrl,
			accepts: requirements,
			description,
			mimeType,
			bazaar,
			extensions: extraExtensions,
			...(service?.serviceName ? { serviceName: service.serviceName } : {}),
			...(Array.isArray(service?.tags) && service.tags.length ? { tags: service.tags } : {}),
			...(service?.iconUrl ? { iconUrl: service.iconUrl } : {}),
		};

		// USE-21: auth-hints fast path. If the endpoint declared OAuth/SIWX as
		// payment alternatives and the request carries a valid Authorization
		// Bearer or SIGN-IN-WITH-X header, bypass the payment dance entirely.
		// Runs BEFORE the generic access-control hook so the auth-hints
		// principal is what reaches the handler. The SIWX path here does NOT
		// require a prior on-chain payment (unlike the USE-16 returning-buyer
		// SIWX flow further down).
		if (authHintsExtension) {
			const result = await authenticateAuthHintsRequest(req, {
				audience: env.MCP_RESOURCE,
				requiredScope: authHints?.oauth2?.requiredScope || requiredScope || null,
				resourceUrl,
			}).catch((err) => ({ ok: false, reason: 'auth_hints_failure', detail: err.message }));
			if (result && !result.ok) {
				return error(
					res,
					result.reason === 'insufficient_scope' ? 403 : 401,
					result.reason || 'auth_failed',
					result.detail || 'auth-hints verification failed',
				);
			}
			if (result?.ok) {
				let bypassResult;
				try {
					bypassResult = await handler({
						req,
						res,
						bypass: {
							reason: `auth-hints:${result.principal.method}`,
							callerId: result.principal.userId
								? `oauth:${result.principal.userId}`
								: `siwx:${result.principal.address}`,
							subscription: null,
							oauth:
								result.principal.method === 'oauth2'
									? {
											userId: result.principal.userId,
											scope: result.principal.scope,
											clientId: result.principal.clientId,
										}
									: null,
							siwx:
								result.principal.method === 'sign-in-with-x'
									? {
											address: result.principal.address,
											network: result.principal.network,
										}
									: null,
						},
						auth: result.principal,
						requirement: null,
						payer: null,
					});
				} catch (err) {
					if (err instanceof X402Error && err.status === 402) {
						return send402(res, { ...challenge, error: err.message });
					}
					return error(
						res,
						err.status || 500,
						err.code || 'internal_error',
						err.message,
					);
				}
				if (res.writableEnded) return;
				res.setHeader('x-payment-bypass', `auth-hints:${result.principal.method}`);
				res.setHeader('cache-control', 'no-store');
				res.setHeader('content-type', `${mimeType}; charset=utf-8`);
				res.end(
					typeof bypassResult === 'string' ? bypassResult : JSON.stringify(bypassResult),
				);
				logPaymentEvent({
					eventType: 'bypass_granted',
					route,
					resourceUrl,
					payer: result.principal.userId || result.principal.address || null,
					durationMs: Date.now() - requestStartTime,
					ipAddress: clientIp(req),
					userAgent: req.headers?.['user-agent']?.slice(0, 512) || null,
					metadata: { reason: `auth-hints:${result.principal.method}` },
				});
				return;
			}
		}

		// Access-control hook (USE-23). Runs before the 402 so internal /
		// subscription / OAuth callers can bypass payment entirely. Headers
		// from `acResult.headers` are applied in both grant + abort paths.
		if (accessControl) {
			let acResult;
			try {
				acResult = await accessControl(req, routeConfig);
			} catch (err) {
				return error(
					res,
					err.status || 500,
					err.code || 'access_control_failed',
					err.message || 'access control failed',
				);
			}
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
				let bypassResult;
				try {
					bypassResult = await handler({
						req,
						res,
						bypass: {
							reason: acResult.reason,
							callerId: acResult.callerId,
							subscription: acResult.subscription || null,
							oauth: acResult.oauth || null,
						},
						requirement: null,
						payer: null,
					});
				} catch (err) {
					if (err instanceof X402Error && err.status === 402) {
						return send402(res, { ...challenge, error: err.message });
					}
					return error(
						res,
						err.status || 500,
						err.code || 'internal_error',
						err.message,
					);
				}
				if (res.writableEnded) return;
				if (acResult.headers) {
					for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
				}
				res.setHeader('x-payment-bypass', acResult.reason || 'granted');
				res.setHeader('cache-control', 'no-store');
				res.setHeader('content-type', `${mimeType}; charset=utf-8`);
				res.end(
					typeof bypassResult === 'string' ? bypassResult : JSON.stringify(bypassResult),
				);
				logPaymentEvent({
					eventType: 'bypass_granted',
					route,
					resourceUrl,
					payer: acResult.callerId || null,
					durationMs: Date.now() - requestStartTime,
					ipAddress: clientIp(req),
					userAgent: req.headers?.['user-agent']?.slice(0, 512) || null,
					metadata: { reason: acResult.reason || 'access_control' },
				});
				return;
			}
		}

		const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];

		// SIWX short-circuit. A returning wallet sends `SIGN-IN-WITH-X: <base64>`
		// instead of paying; we verify the CAIP-122 signature and skip the
		// facilitator round-trip entirely. Only runs when the endpoint opted
		// in and no X-PAYMENT was sent — paid requests still take precedence.
		if (siwx && !paymentHeader) {
			const auth = await authenticateSiwx({ req, resourceUrl });
			if (auth?.ok) {
				let result;
				try {
					result = await handler({
						req,
						res,
						requirement: null,
						payer: auth.address,
						siwx: { address: auth.address, network: auth.network },
					});
				} catch (err) {
					if (err instanceof X402Error && err.status === 402) {
						return send402(res, { ...challenge, error: err.message });
					}
					return error(
						res,
						err.status || 500,
						err.code || 'internal_error',
						err.message,
					);
				}
				if (res.writableEnded) return;
				res.setHeader('x-siwx-address', auth.address);
				res.setHeader('cache-control', 'no-store');
				res.setHeader('content-type', `${mimeType}; charset=utf-8`);
				res.end(typeof result === 'string' ? result : JSON.stringify(result));
				logPaymentEvent({
					eventType: 'siwx_access',
					route,
					resourceUrl,
					payer: auth.address,
					network: auth.network || null,
					durationMs: Date.now() - requestStartTime,
					ipAddress: clientIp(req),
					userAgent: req.headers?.['user-agent']?.slice(0, 512) || null,
				});
				return;
			}
			if (auth && !auth.ok) {
				// 402 from siwx means "valid signature, no grant" → re-issue the
				// challenge so the client can fall back to paying. Anything else
				// (parse / signature failure) is a hard client error.
				if (auth.status === 402) {
					return send402(res, { ...challenge, error: auth.error });
				}
				return error(res, auth.status, auth.code, auth.error);
			}
			// auth === null → no SIGN-IN-WITH-X header → fall through to 402.
		}

		if (!paymentHeader) return send402(res, challenge);

		// USE-15: required-mode rejects the call before we burn an RPC round-trip.
		try {
			enforceRequired({ paymentHeader, required: pidRequired });
		} catch (err) {
			if (err instanceof X402Error && err.status >= 400 && err.status < 500) {
				return error(res, err.status, err.code, err.message);
			}
			throw err;
		}

		// USE-15: deduplicate before /verify. Hashing the request URL is enough
		// for our GET-only paid endpoints — none of them read request bodies.
		// When/if a POST endpoint joins the family, the handler can buffer
		// `req.body` and pass it in here.
		const paymentId = extractIdFromHeader(paymentHeader);
		const payloadHash = hashRequestPayload({
			method: req.method,
			url: req.url,
			body: null,
		});
		if (paymentId) {
			const lookup = await checkCache({ route, paymentId, payloadHash });
			if (lookup.kind === 'hit') {
				return writeCachedResponse(res, lookup.entry);
			}
			if (lookup.kind === 'conflict') {
				return writeConflict(res, {
					route,
					attemptedHash: lookup.attemptedHash,
					existingHash: lookup.existingHash,
				});
			}
		}

		let verified;
		try {
			verified = await verifyPayment({ paymentHeader, requirements, builderCode });
		} catch (err) {
			if (err.status === 402) return send402(res, { ...challenge, error: err.message });
			return error(res, err.status || 502, err.code || 'verify_failed', err.message);
		}

		let result;
		try {
			result = await handler({
				req,
				res,
				requirement: verified.requirement,
				payer: verified.payer,
			});
		} catch (err) {
			if (err instanceof X402Error && err.status === 402) {
				return send402(res, { ...challenge, error: err.message });
			}
			return error(res, err.status || 500, err.code || 'internal_error', err.message);
		}

		// Handler may end the response itself (e.g. binary body); only settle +
		// emit JSON when it returned a value and didn't already flush.
		if (res.writableEnded) return;

		let settled;
		try {
			settled = await settlePayment({ verified });
		} catch (err) {
			logPaymentEvent({
				eventType: 'payment_failed',
				route,
				resourceUrl,
				payer: verified.payer || null,
				network: verified.requirement?.network || null,
				amountAtomics: verified.requirement?.amount || null,
				asset: verified.requirement?.asset || null,
				settlementStatus: 'failed',
				durationMs: Date.now() - requestStartTime,
				ipAddress: clientIp(req),
				userAgent: req.headers?.['user-agent']?.slice(0, 512) || null,
				metadata: { error: err.message, code: err.code },
			});
			return error(res, err.status || 502, err.code || 'settle_failed', err.message);
		}

		// Record the SIWX grant so the wallet can re-access via signature next
		// time. siwx-storage.recordPayment is idempotent (upsert on PK), so a
		// retried settle is safe. The on-chain payment is final; if Neon
		// hiccups we surface 502 — the buyer can retry without paying twice.
		if (siwx && verified.payer) {
			try {
				await recordSiwxPayment({
					resourceUrl,
					payer: normalizeAddress(verified.requirement.network, verified.payer),
					network: verified.requirement.network,
					ttlSeconds: siwx.ttlSeconds ?? null,
				});
				logPaymentEvent({
					eventType: 'siwx_grant',
					route,
					resourceUrl,
					payer: verified.payer,
					network: verified.requirement.network,
					ipAddress: clientIp(req),
					userAgent: req.headers?.['user-agent']?.slice(0, 512) || null,
					metadata: { ttlSeconds: siwx.ttlSeconds ?? null },
				});
			} catch (err) {
				return error(res, 502, 'siwx_record_failed', err.message);
			}
		}

		// USE-17: issue a signed receipt for the settled payment and stash it
		// in the response extensions envelope. Persist asynchronously so the
		// /api/x402/my-receipts buyer-lookup path can serve it later — the
		// recordReceipt write is fire-and-forget so a Neon hiccup never
		// surfaces as a 5xx on a payment that already settled on-chain.
		let responseExtensions;
		if (offerReceipt !== false) {
			const receiptBuilt = await buildReceiptExtension(
				resourceUrl,
				settled,
				offerReceipt || {},
			);
			if (receiptBuilt) {
				responseExtensions = receiptBuilt.extensionFragment;
				recordReceipt({
					resourceUrl,
					signedReceipt: receiptBuilt.signedReceipt,
					settled,
				});
			}
		}

		const paymentResponseHeader = encodePaymentResponseHeader(settled, responseExtensions);
		const contentType = `${mimeType}; charset=utf-8`;
		const body = typeof result === 'string' ? result : JSON.stringify(result);

		res.setHeader('x-payment-response', paymentResponseHeader);
		res.setHeader('cache-control', 'no-store');
		res.setHeader('content-type', contentType);
		res.end(body);

		logPaymentEvent({
			eventType: 'payment_settled',
			route,
			resourceUrl,
			payer: settled.payer || verified.payer || null,
			network: settled.network || verified.requirement?.network || null,
			amountAtomics: verified.requirement?.amount || null,
			asset: verified.requirement?.asset || null,
			txHash: settled.transaction || null,
			settlementStatus: 'success',
			facilitatorResponse: settled,
			durationMs: Date.now() - requestStartTime,
			ipAddress: clientIp(req),
			userAgent: req.headers?.['user-agent']?.slice(0, 512) || null,
		});

		if (paymentId) {
			await storeResponse({
				route,
				paymentId,
				payloadHash,
				status: 200,
				body,
				contentType,
				paymentResponseHeader,
				ttlSeconds: pidTtlSeconds,
			});
		}
	};
}
