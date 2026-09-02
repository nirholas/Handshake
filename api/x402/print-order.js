// POST /api/x402/print-order
//
// An AI agent pays, and a physical object gets manufactured and shipped to a
// real address. As far as we know this is the first API where that is the whole
// transaction: no account, no card, no human in the loop on the buying side.
// The agent quotes the job for free at POST /api/print/quote, gets back an
// HMAC-signed quote token, and settles that token's exact total here in USDC on
// Solana.
//
// The order of operations is the product:
//
//   1. the quote token is verified and the shipping address validated BEFORE
//      any 402 is issued, so a malformed order is refused for free (422) and a
//      caller never pays for something that was going to be rejected;
//   2. the 402 quotes the token's own total, not a list price. Every order is
//      its own amount, because a print is its own object;
//   3. the handler opens the order and moves it to `quoted`;
//   4. settlement happens in the wrapper, and only once it succeeds does the
//      post-settlement hook move the order paid -> screening. An order that
//      never settled therefore never reaches the production floor.
//
// A probe with no body (x402 catalogs do this constantly) gets a well-formed
// challenge at the catalog's floor price with a description that says where the
// real price comes from. Nothing can settle against it: a paid retry still has
// to carry a token this server signed.
//
// The buyer keeps a receipt they can read without an account: the response
// carries the order id, and GET /api/print/orders/:id serves its timeline.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema, paymentRequirements, send402 } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { cors, error, readBody } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { loadCatalog, verifyQuote } from '../_lib/print/quote.js';
import {
	PrintStoreError,
	createOrder,
	normalizeShipping,
	transition,
} from '../_lib/print-store.js';

const ROUTE = '/api/x402/print-order';
const SERVICE_NAME = 'three.ws Materialize';
const TAGS = ['3d-printing', 'manufacturing', 'physical', 'commerce', 'fulfillment'];

const DESCRIPTION =
	'Order a real, physical 3D print of any model and have it manufactured and ' +
	'shipped to a street address, paying in USDC. Quote first at ' +
	'POST /api/print/quote (free, keyless) with a creationId or a glbUrl, a ' +
	'materialId from GET /api/print/catalog, a target height in millimetres and ' +
	'an ISO country code; that returns a printability report, an itemized price ' +
	'and a signed quote token. Post the token plus a shipping address here and ' +
	'the 402 challenge quotes that quote\'s exact total. Settling it opens a real ' +
	'manufacturing job: safety screening, production, tracked shipping, and a ' +
	'certificate of authenticity attested on Solana. Track it at ' +
	'GET /api/print/orders/{id}. Materials, constraints and lead times are all ' +
	'in the catalog; a mesh that cannot be printed is refused before payment.';

const INPUT_EXAMPLE = {
	token: 'pq1.eyJ2IjoxLCJtIjoicmVzaW4tc3RhbmRhcmQifQ.T0tFTg',
	shipping: {
		name: 'Ada Lovelace',
		line1: '12 Analytical Way',
		city: 'London',
		postal_code: 'EC1A 1AA',
		country: 'GB',
	},
};

const SHIPPING_SCHEMA = {
	type: 'object',
	required: ['name', 'line1', 'city', 'postal_code', 'country'],
	description:
		'The delivery address. Minimum fields only: this is the sole personal data the ' +
		'platform stores, it is never logged and never enters an analytics event.',
	properties: {
		name: { type: 'string', maxLength: 120 },
		line1: { type: 'string', maxLength: 120 },
		line2: { type: 'string', maxLength: 120 },
		city: { type: 'string', maxLength: 120 },
		region: { type: 'string', maxLength: 120, description: 'State, province or region.' },
		postal_code: { type: 'string', maxLength: 120 },
		country: { type: 'string', maxLength: 2, description: 'ISO 3166-1 alpha-2. Must match the country the quote was priced for.' },
		phone: { type: 'string', maxLength: 120, description: 'Optional. Couriers ask for one on international parcels.' },
	},
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['token', 'shipping'],
	properties: {
		token: {
			type: 'string',
			description: 'The signed quote token from POST /api/print/quote. It carries the material, size, quantity, destination and total, so the price cannot be altered in transit. Valid for 24 hours.',
		},
		shipping: SHIPPING_SCHEMA,
		note: { type: 'string', maxLength: 500, description: 'Optional note for the operator, kept on the order timeline.' },
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	order_id: 'c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a',
	status: 'screening',
	paid_usdc: '48.20',
	material: 'resin-standard',
	quantity: 1,
	target_height_mm: 140,
	lead_time_days: 12,
	track_url: 'https://three.ws/api/print/orders/c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a',
};

const BAZAAR = {
	description: DESCRIPTION,
	useCases: [
		'Turn a generated 3D model into a physical object delivered to a customer',
		'Let an autonomous agent fulfil a merchandise order end to end',
		'Prototype a part in resin, nylon or full-color sandstone without an account',
	],
	input: { type: 'json', example: INPUT_EXAMPLE, schema: INPUT_SCHEMA },
	output: { type: 'json', example: OUTPUT_EXAMPLE },
	schema: buildBazaarSchema({ method: 'POST', bodySchema: INPUT_SCHEMA, outputSchema: { type: 'object' } }),
};

export const BAZAAR_SCHEMA = BAZAAR;

/**
 * The cheapest order this catalog can produce, in USDC atomics. Directories and
 * probe challenges quote it as the from-price; a real order always quotes its
 * own signed total instead.
 */
export function floorPriceAtomics(catalog = loadCatalog()) {
	return String(Math.round(Number(catalog.pricing.minOrderUsdc) * 1_000_000));
}

function usdcAtomics(total) {
	return String(Math.round(Number(total) * 1_000_000));
}

async function readJsonBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	try {
		const raw = (await readBody(req, 20_000)).toString('utf8').trim();
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

/** The catalog-floor challenge, for a probe that named no order. */
function probeChallenge(res, errText) {
	const resourceUrl = `${env.APP_ORIGIN}${ROUTE}`;
	return send402(res, {
		resourceUrl,
		accepts: paymentRequirements(resourceUrl, { amount: floorPriceAtomics() }),
		description: DESCRIPTION,
		bazaar: BAZAAR,
		error: errText,
		serviceName: SERVICE_NAME,
		tags: TAGS,
	});
}

export default async function handler(req, res) {
	// CORS first: this file answers the probe challenge and its own pre-settle
	// 4xx bodies before delegating, so a browser client must be able to read them.
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;

	const paymentPresent = Boolean(req.headers['x-payment'] || req.headers['payment-signature']);
	const body = await readJsonBody(req);
	req.body = body;

	const hasOrder = Boolean(body && (body.token || body.shipping));
	if (!hasOrder) {
		if (paymentPresent) {
			return error(res, 400, 'token_required', 'a signed quote token from POST /api/print/quote is required');
		}
		return probeChallenge(
			res,
			'Quote the job first at POST /api/print/quote, then retry here with that token and a shipping address for its exact price.',
		);
	}

	// ── Pre-settle validation ────────────────────────────────────────────────
	// Everything that can refuse this order runs here, before a 402 is issued
	// and long before a settle. A caller is never charged for an order we were
	// always going to reject.
	const quote = verifyQuote(typeof body.token === 'string' ? body.token : '');
	if (!quote) {
		return error(res, 422, 'quote_invalid', 'that quote is expired or was not issued by this server. Request a fresh one from POST /api/print/quote.');
	}
	if (!quote.sourceUrl) {
		return error(res, 422, 'quote_invalid', 'that quote does not name a model to print');
	}

	let shipping;
	try {
		shipping = normalizeShipping(body.shipping);
	} catch (err) {
		if (err instanceof PrintStoreError) {
			return error(res, 422, err.code, err.message, err.field ? { field: err.field } : {});
		}
		throw err;
	}
	if (quote.country && shipping.country !== quote.country) {
		return error(res, 422, 'destination_mismatch', `this quote was priced for shipping to ${quote.country}. Re-quote for ${shipping.country}.`, {
			quoted_country: quote.country,
			shipping_country: shipping.country,
		});
	}

	const priceAtomics = usdcAtomics(quote.total);
	const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

	const inner = paidEndpoint({
		route: ROUTE,
		method: 'POST',
		// This order's own total, from the token this server signed. Not a list
		// price: a print is priced per object, per size, per destination.
		priceAtomics,
		// Solana leads and is the rail we settle ourselves. Base follows so an
		// EVM-native agent can still buy a print.
		networks: ['solana', 'base'],
		description: `${DESCRIPTION} Currently quoting: ${quote.quantity} x ${quote.materialId} at ${quote.targetHeightMm} mm to ${quote.country}, ${Number(quote.total).toFixed(2)} USDC.`,
		bazaar: BAZAAR,
		service: withService({ serviceName: SERVICE_NAME, tags: TAGS }),
		// A duplicate call ships a second physical object to someone's house, which
		// is the exact case this rail's idempotency key exists for. Required, and
		// the 402 advertises it so a caller learns the contract before paying.
		paymentIdentifier: { required: true },
		async handler({ payer }) {
			// The order is opened and quoted here, NOT paid. Settlement happens in
			// the wrapper after this returns; promoting to paid before it settled
			// would be how an unpaid job reaches the production floor.
			const order = await createOrder({
				payerWallet: payer || null,
				quote,
				itemization: {
					token: body.token,
					total: quote.total,
					materialId: quote.materialId,
					finishId: quote.finishId,
					targetHeightMm: quote.targetHeightMm,
					quantity: quote.quantity,
					hollow: quote.hollow,
					country: quote.country,
					volumeCm3: quote.volumeCm3,
					leadTimeDays: quote.leadTimeDays,
					reportHash: quote.reportHash,
					expiresAt: quote.expiresAt,
					lane: 'x402',
				},
				report: { report_hash: quote.reportHash, volume_cm3: quote.volumeCm3 },
				sourceGlbUrl: quote.sourceUrl,
				creationId: quote.creationId || null,
				shipping,
				paymentChain: 'solana',
			});
			await transition({
				orderId: order.id,
				to: 'quoted',
				note: note ? `Agent order over x402. ${note}` : 'Agent order over x402, awaiting settlement.',
				actor: 'system',
			});
			return {
				ok: true,
				order_id: order.id,
				// Overwritten by the post-settlement hook below once the money is
				// actually on chain. If that hook ever fails, the honest value is
				// this one, and the operator console reconciles it.
				status: 'quoted',
				paid_usdc: Number(quote.total).toFixed(2),
				material: quote.materialId,
				finish: quote.finishId,
				quantity: quote.quantity,
				target_height_mm: quote.targetHeightMm,
				lead_time_days: quote.leadTimeDays,
				ship_to: { city: shipping.city, country: shipping.country },
				track_url: `${env.APP_ORIGIN}/api/print/orders/${order.id}`,
			};
		},
		// Runs after settlement succeeds and before the response is flushed, so
		// the status the buyer reads is the status the order is actually in.
		async metered({ result, settled, payer }) {
			const orderId = result?.order_id;
			if (!orderId) return null;
			const signature = settled?.transaction || null;
			await transition({
				orderId,
				to: 'paid',
				note: signature ? `x402 settlement confirmed: ${signature}` : 'x402 settlement confirmed.',
				actor: 'system',
				patch: {
					payment_signature: signature,
					payment_chain: settled?.network?.startsWith('eip155') ? 'base' : 'solana',
					payment_amount_atomics: priceAtomics,
				},
			});
			await transition({
				orderId,
				to: 'screening',
				note: 'Queued for the fabrication safety screen.',
				actor: 'system',
			});
			return {
				status: 'screening',
				paid: true,
				payer: payer || null,
				settlement_signature: signature,
			};
		},
	});

	return inner(req, res);
}
