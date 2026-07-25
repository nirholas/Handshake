// Hosted x402 paywall for agent-published services (the `monetize_endpoint` tool).
//
//   GET|POST /api/x402/service/<slug>
//
// Each agent that runs `monetize_endpoint` gets a row in agent_paid_services and
// a stable resource URL here. This handler loads the row per request, wraps it
// in the shared paidEndpoint() x402 dance with the price the agent set and the
// agent's OWN wallet as the payee, and — only after the buyer's USDC settles —
// proxies the call through to the agent's upstream `target_url` (SSRF-guarded)
// and returns its response. That is the agent earning USDC: the buyer pays the
// agent, the agent's API does the work.
//
// The slug arrives as ?slug=<slug> via the vercel rewrite for
// /api/x402/service/(.*). Unknown / archived slugs 404 before any 402 challenge.

import { error, cors, readBody as readRawBody } from '../_lib/http.js';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { safeFetchJson, SsrfError } from '../_lib/ssrf.js';
import {
	getActiveServiceBySlug,
	serviceResourceUrl,
	atomicsToUsdc,
} from '../_lib/agent-paid-services.js';

function slugFromReq(req) {
	const fromQuery = req.query?.slug;
	if (fromQuery) return String(Array.isArray(fromQuery) ? fromQuery[0] : fromQuery);
	const path = new URL(req.url, 'http://x').pathname;
	const m = path.match(/\/api\/x402\/service\/([^/?]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

// Read the buyer's JSON body for a POST proxy. paidEndpoint hands us the raw
// req; we drain it once here (the payment header is already verified by then).
async function readBody(req) {
	try {
		const chunks = [await readRawBody(req, 1_000_000)];
		const raw = Buffer.concat(chunks).toString('utf8');
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

// Build the bazaar discovery extension for a service row so the live 402 mirrors
// what /.well-known/x402.json advertises.
function bazaarFor(row, resourceUrl) {
	const inputSchema = row.input_schema || { type: 'object', additionalProperties: true };
	return {
		description: row.description,
		useCases: ['agent service', 'x402 paid api'],
		input: {
			type: 'json',
			example: {},
			schema: inputSchema,
		},
		output: {
			type: 'json',
			example: {},
		},
		schema: buildBazaarSchema({
			method: row.target_method,
			bodySchema: row.target_method === 'POST' ? inputSchema : undefined,
		}),
		resource: resourceUrl,
	};
}

export default async function handler(req, res) {
	// OPTIONS preflight is handled by paidEndpoint too, but we may 404 before we
	// build it, so answer CORS up front for the not-found path.
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	const slug = slugFromReq(req);
	if (!slug) return error(res, 400, 'bad_request', 'missing service slug');

	let row;
	try {
		row = await getActiveServiceBySlug(slug);
	} catch (err) {
		console.error('[x402/service] lookup failed', err?.message || err);
		return error(res, 502, 'lookup_failed', 'could not load service');
	}
	if (!row) return error(res, 404, 'not_found', `no paid service at /api/x402/service/${slug}`);

	const method = row.target_method === 'POST' ? 'POST' : 'GET';
	const resourceUrl = serviceResourceUrl(slug);
	const network = row.network === 'solana' ? 'solana' : 'base';
	const payTo = network === 'solana' ? { solana: row.payout_address } : { base: row.payout_address };

	const paid = paidEndpoint({
		route: `/api/x402/service/${slug}`,
		method,
		priceAtomics: row.price_atomics,
		networks: [network],
		description: row.description,
		bazaar: bazaarFor(row, resourceUrl),
		service: withService({
			serviceName: row.name,
			tags: ['agent', 'monetized', network],
		}),
		// Settle the buyer's USDC to the AGENT's own wallet, not the platform's.
		payTo,
		resourceUrlBuilder: () => resourceUrl,

		async handler({ req: pReq }) {
			const body = method === 'POST' ? await readBody(pReq) : undefined;
			// Forward the buyer's query params (minus our routing slug) on GET.
			let targetUrl = row.target_url;
			if (method === 'GET') {
				try {
					const incoming = new URL(pReq.url, 'http://x').searchParams;
					incoming.delete('slug');
					const qs = incoming.toString();
					if (qs) {
						const u = new URL(row.target_url);
						for (const [k, v] of incoming) u.searchParams.set(k, v);
						targetUrl = u.href;
					}
				} catch {
					/* fall back to the bare target_url */
				}
			}

			let upstream;
			try {
				upstream = await safeFetchJson(targetUrl, { method, body });
			} catch (err) {
				if (err instanceof SsrfError) {
					throw Object.assign(new Error(`upstream blocked: ${err.message}`), {
						status: 502,
						code: 'upstream_blocked',
					});
				}
				throw Object.assign(new Error(`upstream request failed: ${err?.message || err}`), {
					status: 502,
					code: 'upstream_failed',
				});
			}
			if (!upstream.ok) {
				throw Object.assign(new Error(`upstream returned ${upstream.status}`), {
					status: 502,
					code: 'upstream_error',
				});
			}
			return {
				service: row.name,
				price_usdc: atomicsToUsdc(row.price_atomics),
				network,
				result: upstream.data,
			};
		},
	});

	return paid(req, res);
}
