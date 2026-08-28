// POST /api/x402/knock?to=<username>
//
// Pay a person's price and get one message through to them, in person.
//
// This is the paid half of Knock. The recipient sets what a moment of their
// attention costs; this endpoint quotes that price as an x402 challenge,
// settles the USDC straight to the recipient's own wallet (never the
// platform's: `payTo` is their address, and a priced door cannot be opened
// without one), and only then accepts the message. The accepted message
// becomes a companion event whose importance is derived from the amount paid,
// which is what makes the recipient's 3D companion walk on screen wherever
// they are and deliver it out loud, with the sender's name and the price.
//
// Solana is the default and the lead network. Base is advertised only when the
// recipient set an address for it.
//
// The order of operations is the whole design:
//
//   1. the body is read and validated against THIS door's limits BEFORE any
//      402 is issued, so nobody ever pays for a message that was going to be
//      rejected for being too long, or for knocking at a door that is shut,
//      full for the day, or has blocked them;
//   2. the price and payout come from the door row, per request;
//   3. settlement happens in the wrapper;
//   4. the handler records and delivers, and returns a receipt URL the sender
//      can poll for a reply without holding an account here.
//
// A request with no body and no payment header is a discovery probe (x402
// catalogs do this). It gets a valid challenge at the door's real price.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema, paymentRequirements, send402 } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { cors, error, readBody as readRawBody } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { formatUsdc, normalizeHandle } from '../_lib/knock/policy.js';
import { publicDoorByHandle, payoutFor } from '../_lib/knock/store.js';
import { checkDoor, deliverKnock } from '../_lib/knock/deliver.js';
import { receiptUrl } from '../_lib/knock/receipt.js';

const ROUTE = '/api/x402/knock';

const DESCRIPTION =
	'Knock on a real person\'s door. Every three.ws account can publish a ' +
	'priced door at /knock/<username>; paying its price buys you exactly one ' +
	'message through to that person, delivered out loud and in person by their ' +
	'3D companion, which walks on screen wherever they are on the site and ' +
	'says who you are and what you paid. The USDC settles directly to the ' +
	'recipient, not to three.ws. Read GET /api/knock/door?handle=<username> ' +
	'for a door\'s exact price and limits before you pay, or ' +
	'GET /api/knock/directory for every open door. The response carries a ' +
	'receipt URL you can poll for a reply without needing an account.';

const INPUT_EXAMPLE = {
	from: 'Ada (research agent)',
	subject: 'Your x402 settle path',
	message: 'I index x402 endpoints and yours is the only one settling on Solana. Two questions about the facilitator, happy to pay for the time.',
	url: 'https://example.com/ada',
	sender_kind: 'agent',
	request_id: 'ada-2026-08-28-001',
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['from', 'message'],
	properties: {
		from: { type: 'string', maxLength: 64, description: 'Who is knocking. Shown and spoken to the recipient.' },
		message: { type: 'string', maxLength: 2000, description: 'The message. Length ceiling is per-door; read it from /api/knock/door.' },
		subject: { type: 'string', maxLength: 120, description: 'One line the companion says out loud. The body is shown, never read aloud.' },
		url: { type: 'string', maxLength: 400, description: 'An http(s) link the recipient can follow to check you out.' },
		sender_kind: { type: 'string', enum: ['agent', 'human', 'unknown'], description: 'Self-declared. Shown in the inbox, never trusted for access.' },
		request_id: { type: 'string', maxLength: 80, description: 'Idempotency key. A retry after a settled payment returns the first knock instead of knocking twice.' },
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	knock_id: 'c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a',
	delivered_to: 'nirholas',
	announced: true,
	importance: 74,
	paid: '$0.05',
	receipt_url: 'https://three.ws/api/knock/reply?id=c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a&token=…',
	duplicate: false,
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'knock_id', 'delivered_to', 'receipt_url'],
	properties: {
		ok: { type: 'boolean', const: true },
		knock_id: { type: 'string', format: 'uuid' },
		delivered_to: { type: 'string' },
		announced: { type: 'boolean', description: 'True when the amount paid put this above the recipient\'s interrupt threshold.' },
		importance: { type: 'integer', minimum: 0, maximum: 100 },
		paid: { type: 'string' },
		receipt_url: { type: 'string', format: 'uri' },
		duplicate: { type: 'boolean' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyType: 'json', body: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export const BAZAAR_SCHEMA = BAZAAR;

// Representative price for a probe with no ?to=. No money can settle against
// it: a paid retry still needs a handle, and the handler below never runs
// without a resolved door.
const PROBE_PRICE_ATOMICS = '50000';

export default async function handler(req, res) {
	// CORS first: this file answers the discovery challenge and its own 4xx
	// bodies before delegating, so a browser client must be able to read them.
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;

	const paymentPresent = Boolean(req.headers['x-payment'] || req.headers['payment-signature']);
	const handle = normalizeHandle(req.query?.to);

	if (!handle) {
		if (paymentPresent) return error(res, 400, 'to_required', 'query parameter "to" is required');
		return probeChallenge(res, 'query parameter "to" is required. Retry with ?to=<username> for that door\'s exact price.');
	}

	const door = await publicDoorByHandle(handle);
	if (!door) {
		if (paymentPresent) return error(res, 404, 'no_door', `no open door for "${handle}"`);
		return probeChallenge(res, `no open door for "${handle}". GET /api/knock/directory lists every open one.`);
	}

	// A free door has nothing to charge for. Point the caller at the free lane
	// rather than inventing a price.
	if (String(door.price_atomics) === '0') {
		return error(res, 400, 'free_door', `${door.display_name || handle} takes free knocks`, {
			endpoint: `${env.APP_ORIGIN}/api/knock/send`,
			protocol: 'http',
		});
	}

	// Buffer the body once, here, and hand it to both the pre-flight check and
	// the settled handler. Reading the stream twice would hang.
	const body = await readJsonBody(req);
	req.body = body;

	// Pre-flight. When the caller already sent a message we run every refusal
	// (shut door, daily cap, block list, length limits) BEFORE the 402 is
	// issued, so a knock that was never going to land is refused for free and
	// with a specific reason rather than after a payment.
	//
	// A probe with no body skips this and gets the door's real challenge from
	// the wrapper below, priced and addressed to the recipient's own wallet.
	let clean = null;
	if (body && (body.message || body.from)) {
		try {
			({ clean } = await checkDoor(door.user_id, body));
		} catch (err) {
			if (err?.code && err?.status) return error(res, err.status, err.code, err.message);
			throw err;
		}
	}

	const payout = await payoutFor(door.user_id);
	const inner = paidEndpoint({
		route: ROUTE,
		method: 'POST',
		priceAtomics: String(door.price_atomics),
		networks: networksFor(payout),
		description: `${DESCRIPTION} Currently quoting: ${door.display_name || handle} at ${formatUsdc(door.price_atomics)}.`,
		bazaar: BAZAAR,
		service: withService({
			serviceName: 'three.ws Knock',
			tags: ['knock', 'attention', 'messaging', 'agent-to-human', 'x402'],
		}),
		// The recipient's own wallet. This is the whole point: three.ws never
		// takes custody of what a knock is worth.
		payTo: buildPayTo(payout),
		// Each door is its own good, so each gets its own resource URL. Without
		// this, a payment for one person's door would look like a payment for
		// everyone's.
		resourceUrlBuilder: () => `${env.APP_ORIGIN}${ROUTE}?to=${encodeURIComponent(handle)}`,
		async handler({ requirement, payer }) {
			// A payer who sent payment but no valid message is validated here.
			// The wrapper settles only AFTER this returns, so a throw refuses the
			// knock without moving any money.
			const resolved = clean ?? (await checkDoor(door.user_id, body)).clean;
			const { knock, duplicate, importance } = await deliverKnock({
				userId: door.user_id,
				clean: resolved,
				payment: {
					payerWallet: payer ?? null,
					network: requirement?.network ?? null,
					amountAtomics: requirement?.amount ?? String(door.price_atomics),
					asset: requirement?.asset ?? null,
				},
			});
			return {
				ok: true,
				knock_id: knock.id,
				delivered_to: door.display_name || handle,
				// A paid knock always scores above the default interrupt bar, but
				// the recipient can raise their own, so this reports the score
				// rather than promising an interruption.
				announced: importance >= 60,
				importance,
				paid: formatUsdc(requirement?.amount ?? door.price_atomics),
				receipt_url: receiptUrl(knock.id),
				duplicate,
			};
		},
	});

	return inner(req, res);
}

// Used only when there is no door to quote (no handle, or a handle nobody has
// opened a door for). It advertises the platform receiver at a representative
// price purely so x402 catalogs get a well-formed challenge; nothing can settle
// against it, because a paid retry still has to name a real door.
function probeChallenge(res, errText) {
	const resourceUrl = `${env.APP_ORIGIN}${ROUTE}`;
	return send402(res, {
		resourceUrl,
		accepts: paymentRequirements(resourceUrl, { amount: PROBE_PRICE_ATOMICS }),
		description: DESCRIPTION,
		bazaar: BAZAAR,
		error: errText,
		serviceName: 'three.ws Knock',
		tags: ['knock', 'attention', 'messaging', 'agent-to-human', 'x402'],
	});
}

function buildPayTo(payout) {
	const out = {};
	if (payout?.pay_to_solana) out.solana = payout.pay_to_solana;
	if (payout?.pay_to_base) out.base = payout.pay_to_base;
	return Object.keys(out).length ? out : undefined;
}

// Solana leads: it is the home chain and the rail we settle ourselves. Base is
// offered only when the recipient gave an address for it.
function networksFor(payout) {
	const nets = [];
	if (payout?.pay_to_solana) nets.push('solana');
	if (payout?.pay_to_base) nets.push('base');
	return nets.length ? nets : ['solana'];
}

async function readJsonBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	try {
		const raw = (await readRawBody(req, 200_000)).toString('utf8').trim();
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}
