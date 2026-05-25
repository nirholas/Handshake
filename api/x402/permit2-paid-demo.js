// GET /api/x402/permit2-paid-demo
//
// Paid demo endpoint that exercises the Permit2 + EIP-2612 gas-sponsoring path
// end-to-end. Unlike the rest of /api/x402/*, this route does NOT advertise an
// EIP-3009 fallback — the only accept entry is Permit2-with-EIP-2612 — so any
// settling client is forced through `x402ExactPermit2Proxy.settleWithPermit`.
//
// Why: USE-18 needs a target that proves a fresh wallet with USDC but ZERO ETH
// (no gas) can pay through the endpoint. Selling against a route that exposes
// EIP-3009 first hides the bug it's meant to verify, because @x402/evm clients
// will silently pick the EIP-3009 path when one is offered.
//
// The 402 challenge advertises:
//   1. One `exact`+`permit2` accept on Base mainnet (USDC) — emitted only when
//      CDP credentials are set, because Permit2 settlement runs through CDP's
//      x402ExactPermit2Proxy.
//   2. Both `eip2612GasSponsoring` and `erc20ApprovalGasSponsoring` extensions
//      at the top level (build402Body auto-declares them whenever any accept
//      opts into Permit2).
//
// Buyers using @x402/* SDK clients pay with no ETH. The settled response
// surfaces the on-chain tx hash plus a Basescan link so the buyer can confirm
// the EIP-2612 permit + Permit2 transfer landed in a single transaction.

import { wrap, cors, error } from '../_lib/http.js';
import {
	NETWORK_BASE_MAINNET,
	X402Error,
	buildBazaarSchema,
	encodePaymentResponseHeader,
	resolveResourceUrl,
	send402,
	settlePayment,
	verifyPayment,
} from '../_lib/x402-spec.js';
import { env } from '../_lib/env.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/permit2-paid-demo';
const REQUIRED_SCOPE = 'x402:bypass';
const accessControl = installAccessControl({ requiredScope: REQUIRED_SCOPE });
const routeConfig = { path: ROUTE, method: 'GET', requiredScope: REQUIRED_SCOPE };
// Env override: X402_PRICE_PERMIT2_PAID_DEMO=<atomics>. Default = $0.001 USDC.
const PRICE_ATOMICS = priceFor('permit2-paid-demo', '1000');

const ROUTE_DESCRIPTION =
	'Permit2 + EIP-2612 Gas Sponsoring Demo — forces the gasless Permit2 path so ' +
	'a fresh wallet holding USDC but ZERO ETH can complete the flow. The CDP ' +
	'facilitator submits the EIP-2612 permit and the Permit2 transfer atomically ' +
	'in a single transaction via x402ExactPermit2Proxy.settleWithPermit. The ' +
	'response carries the on-chain tx hash + Basescan link so callers can confirm ' +
	'the permit + transfer landed together. Pay $0.001 USDC on Base mainnet.';

const DISCOVERY_INPUT_EXAMPLE = {};

const DISCOVERY_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {},
	additionalProperties: false,
};

const DISCOVERY_OUTPUT_EXAMPLE = {
	ok: true,
	demo: 'permit2-eip2612-gas-sponsoring',
	method: 'permit2',
	supportsEip2612: true,
	payer: '0x4022de2d36c334e73c7a108805cea11c0564f402',
	network: 'eip155:8453',
	asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	amountAtomics: '1000',
	transaction: '0x9c0a7e5ad5c9c0bb6f04f6ad9c52f4f44bb6c5d9c0a7e5ad5c9c0bb6f04f6ad9',
	explorer:
		'https://basescan.org/tx/0x9c0a7e5ad5c9c0bb6f04f6ad9c52f4f44bb6c5d9c0a7e5ad5c9c0bb6f04f6ad9',
	settledAt: '2026-05-21T18:30:00.000Z',
	proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
};

const DISCOVERY_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: [
		'ok',
		'demo',
		'method',
		'payer',
		'network',
		'asset',
		'amountAtomics',
		'transaction',
		'explorer',
		'settledAt',
		'proxy',
	],
	properties: {
		ok: { type: 'boolean', const: true },
		demo: { type: 'string', const: 'permit2-eip2612-gas-sponsoring' },
		method: { type: 'string', const: 'permit2' },
		supportsEip2612: { type: 'boolean' },
		payer: { type: ['string', 'null'] },
		network: { type: 'string' },
		asset: { type: 'string' },
		amountAtomics: { type: 'string' },
		transaction: { type: 'string' },
		explorer: { type: 'string', format: 'uri' },
		settledAt: { type: 'string', format: 'date-time' },
		proxy: {
			type: 'string',
			description:
				'Canonical x402ExactPermit2Proxy address that settled the EIP-2612 ' +
				'permit + Permit2 transfer atomically.',
		},
	},
};

const ROUTE_BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: DISCOVERY_INPUT_EXAMPLE },
		output: { type: 'json', example: DISCOVERY_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: DISCOVERY_INPUT_SCHEMA,
		outputSchema: DISCOVERY_OUTPUT_SCHEMA,
	}),
};

// Canonical x402ExactPermit2Proxy address (same across all EVM chains per
// the USE-18 spec). The facilitator submits settleWithPermit() against this
// contract, atomically applying the EIP-2612 permit and executing the
// Permit2 transfer in a single transaction.
const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

// Single Permit2-forced accept entry — no EIP-3009 sibling. The Bazaar
// browser modal in public/x402.js doesn't sign Permit2, so this endpoint is
// SDK-only by design (paying through it requires @x402/evm or compatible).
function buildRequirements(resourceUrl) {
	if (!env.X402_PAY_TO_BASE) {
		throw new X402Error(
			'no_payto_configured',
			'permit2-paid-demo: X402_PAY_TO_BASE is not set',
			500,
		);
	}
	if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
		// Permit2 settlement is a CDP-only path — without CDP creds the
		// facilitator can't call settleWithPermit. Surface a clean 402 so the
		// client doesn't waste an EIP-2612 signature on a route we can't honor.
		throw new X402Error(
			'permit2_facilitator_unavailable',
			'permit2-paid-demo requires CDP_API_KEY_ID + CDP_API_KEY_SECRET ' +
				'(Permit2 settlement runs through CDP x402ExactPermit2Proxy)',
			402,
		);
	}
	return [
		{
			scheme: 'exact',
			network: NETWORK_BASE_MAINNET,
			amount: PRICE_ATOMICS,
			payTo: env.X402_PAY_TO_BASE,
			asset: env.X402_ASSET_ADDRESS_BASE,
			maxTimeoutSeconds: 60,
			resource: resourceUrl,
			// `name` + `version` MUST match Base USDC's on-chain EIP-712 domain;
			// `assetTransferMethod: 'permit2'` is what @x402/evm's ExactEvmScheme
			// keys on, and `supportsEip2612: true` tells the scheme to sign an
			// EIP-2612 permit when its Permit2 allowance is insufficient so the
			// facilitator can submit it via settleWithPermit.
			extra: {
				name: 'USD Coin',
				version: '2',
				decimals: 6,
				assetTransferMethod: 'permit2',
				supportsEip2612: true,
			},
		},
	];
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET');
		return error(res, 405, 'method_not_allowed', 'use GET');
	}

	const resourceUrl = resolveResourceUrl(req, ROUTE);
	const service = withService({
		serviceName: 'three.ws Permit2 Demo',
		tags: ['x402', 'permit2', 'eip2612', 'gasless', 'demo'],
	});
	let requirements;
	try {
		requirements = buildRequirements(resourceUrl);
	} catch (err) {
		if (err instanceof X402Error && err.status === 402) {
			return send402(res, {
				resourceUrl,
				accepts: [],
				description: ROUTE_DESCRIPTION,
				bazaar: ROUTE_BAZAAR,
				error: err.message,
				serviceName: service.serviceName,
				tags: service.tags,
				iconUrl: service.iconUrl,
			});
		}
		return error(
			res,
			err.status || 500,
			err.code || 'misconfigured',
			err.message || 'permit2-paid-demo misconfigured',
		);
	}

	const challenge = {
		resourceUrl,
		accepts: requirements,
		description: ROUTE_DESCRIPTION,
		bazaar: ROUTE_BAZAAR,
		serviceName: service.serviceName,
		tags: service.tags,
		iconUrl: service.iconUrl,
	};

	// USE-23: bypass payment for internal / subscription / OAuth callers.
	// The Permit2 demo skips its payload-shape check on bypass — the bypass
	// caller never signed a payment, so there's nothing to validate.
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
		const result = {
			ok: true,
			demo: 'permit2-eip2612-gas-sponsoring',
			method: 'permit2',
			supportsEip2612: true,
			bypass: acResult.reason,
			payer: null,
			network: requirements[0]?.network || null,
			asset: requirements[0]?.asset || null,
			amountAtomics: requirements[0]?.amount || null,
			transaction: null,
			explorer: null,
			settledAt: null,
			proxy: X402_EXACT_PERMIT2_PROXY,
		};
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

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements });
	} catch (err) {
		if (err.status === 402) return send402(res, { ...challenge, error: err.message });
		return error(res, err.status || 502, err.code || 'verify_failed', err.message);
	}

	// Guard against an SDK that ignored our `assetTransferMethod: 'permit2'`
	// hint and sent an EIP-3009 payload anyway. We only advertise Permit2 on
	// this route, so anything else is a client bug — fail with a clean 402
	// rather than letting the facilitator reject the mismatched payload.
	const inner = verified.paymentPayload?.payload;
	if (!inner || typeof inner !== 'object' || !inner.permit2Authorization) {
		return send402(res, {
			...challenge,
			error:
				'permit2-paid-demo only accepts Permit2 payloads — the payload had no ' +
				'permit2Authorization. Use @x402/evm or another client that supports ' +
				'the Permit2 asset-transfer method with EIP-2612 gas sponsoring.',
		});
	}

	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		return error(res, err.status || 502, err.code || 'settle_failed', err.message);
	}

	const txHash = settled.transaction;
	const result = {
		ok: true,
		demo: 'permit2-eip2612-gas-sponsoring',
		method: 'permit2',
		supportsEip2612: true,
		payer: settled.payer || verified.payer || null,
		network: verified.requirement.network,
		asset: verified.requirement.asset,
		amountAtomics: verified.requirement.amount,
		transaction: txHash,
		explorer: `https://basescan.org/tx/${txHash}`,
		settledAt: new Date().toISOString(),
		proxy: X402_EXACT_PERMIT2_PROXY,
	};

	res.setHeader('x-payment-response', encodePaymentResponseHeader(settled));
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify(result));
});
