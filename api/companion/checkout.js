// POST /api/companion/checkout - read a payment screen and say what it costs.
//
// The caller is the checkout companion browser extension
// (extensions/checkout-companion). It sends a REDACTED extract of a checkout
// page and gets back a short list of plain findings plus one line for the
// avatar to say out loud.
//
// What this endpoint deliberately is not:
//
//   - It is not a store. Nothing about the page is written to the database.
//     A checkout page is the most sensitive screen a person visits, and the
//     safest place to put a record of one is nowhere. The response is computed
//     and forgotten; only the aggregate spend counter the LLM chain already
//     keeps survives the request.
//   - It is not a legal opinion. api/_lib/companion/checkout.js strips any
//     model output that renders one, and the arithmetic findings state a
//     difference between two numbers, never a judgment about it.
//   - It is not a blocker. It has no way to stop a payment and never claims to.
//     The person reads it and decides.
//
// Auth is a session OR the companion bridge token, matching /api/companion/
// ingest. The bridge token exists because the extension can hold a credential
// but cannot rely on a first-party cookie surviving in every browser it runs
// in, and rotating that one token in the UI cuts off every device at once.
//
// Body: {
//   url:      string  (required) the checkout page, used for its host only
//   title:    string  (optional) the page title
//   text:     string  (required) visible page text, already redacted client-side
//   currency: string  (optional) ISO code, defaults to USD
//   amounts:  [{ value: integer minor units, role, context, currency }]
//   quoted:   { value: integer minor units } | null   what they were shown earlier
// }

import { z } from 'zod';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { getRequestUser } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { loadUserProviderKeys } from '../_lib/provider-keys.js';
import { userForIngestToken } from '../_lib/companion/store.js';
import { analyzeCheckout } from '../_lib/companion/checkout.js';
import { llmComplete, llmConfigured } from '../_lib/llm.js';

const AMOUNT_ROLES = [
	'total',
	'subtotal',
	'line',
	'fee',
	'surcharge',
	'handling',
	'processing',
	'service',
	'tax',
	'shipping',
	'discount',
	'unknown',
];

const amount = z.object({
	// Integer minor units only. The content script parses "$49.99" next to the
	// DOM node that gave it the currency; a float arriving here would mean the
	// parse happened somewhere that could not know the currency's exponent.
	value: z.number().int().min(-100_000_000).max(100_000_000),
	currency: z.string().length(3).optional(),
	role: z.enum(AMOUNT_ROLES).default('unknown'),
	context: z.string().max(120).optional(),
});

const body = z.object({
	url: z.string().url().max(2048),
	title: z.string().max(300).optional(),
	text: z.string().min(1).max(60_000),
	currency: z.string().length(3).optional(),
	amounts: z.array(amount).max(60).default([]),
	quoted: z.object({ value: z.number().int(), currency: z.string().length(3).optional() }).nullable().optional(),
});

async function anthropicKeyFor(userId) {
	try {
		const [row] = await sql`select provider_keys from users where id = ${userId}`;
		const keys = await loadUserProviderKeys(row?.provider_keys);
		return keys.anthropic || null;
	} catch {
		return null;
	}
}

/**
 * Resolve the caller from a session or the companion bridge token.
 * Returns the user row, or null when neither credential is present or valid.
 */
async function callerFor(req, res) {
	const auth = req.headers.authorization || '';
	const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
	if (bearer) {
		const user = await userForIngestToken(bearer);
		if (user) return user;
	}
	return getRequestUser(req, res);
}

export default wrap(async function handler(req, res) {
	// The extension calls from its own origin, which is not a three.ws page, so
	// the browser sends `Origin: chrome-extension://<id>` and this must answer
	// it. `*` is right here precisely because the endpoint is credentialed by an
	// Authorization header rather than a cookie for that caller, and it writes
	// nothing: there is no state for a hostile page to change by calling it.
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (method(req, res, ['POST'])) return;

	const user = await callerFor(req, res);
	if (!user) {
		return error(res, 401, 'unauthorized', 'sign in to three.ws or send your companion bridge token');
	}

	const limit = await limits.companionCheckout(user.id);
	if (!limit.success) return rateLimited(res, limit);

	const input = parse(body, await readJson(req));

	const key = await anthropicKeyFor(user.id);
	const configured = llmConfigured({ anthropicKey: key });

	const result = await analyzeCheckout(input, {
		// The reading pass is optional by construction. When no provider is
		// reachable `analyzeCheckout` reports reading_status and still returns
		// every arithmetic finding, so a page whose total is $12.50 above the
		// quoted price is caught with no model in the loop at all.
		complete: configured
			? async ({ system, user: prompt }) => {
					const { text } = await llmComplete({
						system,
						user: prompt,
						maxTokens: 700,
						anthropicKey: key,
						timeoutMs: 20_000,
						track: { userId: user.id, tool: 'companion_checkout' },
					});
					return text;
				}
			: null,
	});

	// no-store: the response describes a payment screen. It has no business in
	// a CDN, a proxy, or the browser's disk cache.
	return json(res, 200, result, { 'cache-control': 'no-store' });
});
