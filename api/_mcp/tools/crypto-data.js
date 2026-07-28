// crypto_data + token_snapshot — MCP front door onto the /api/v1/x aggregator
// (api/v1/_providers.js). Generated from the live registry so the toolset
// grows automatically as provider prompts land — no hand-enumerated endpoint
// list to keep in sync.
//
// Design (owner-approved, x402-catalog campaign work order 10):
// one generic tool + one curated convenience tool, not one tool per endpoint
// (a 30-tool flood degrades agent tool selection).
//
// Both tools run calls through the SAME engine the REST aggregator uses
// (executeUpstream, with the platform's own upstream key) — never re-fetch an
// upstream directly. An endpoint marked `free` in the registry is served
// within the identical per-IP quota the REST free lane enforces
// (api/v1/x/[...slug].js `serveFreeLane`) so the two doors share one budget
// instead of doubling it. A caller who exhausts the quota, or calls an
// endpoint with no free tier, gets a -32402 JSON-RPC error naming the exact
// REST URL + USDC price to pay via x402 — the platform's one real payment
// rail, never a second payment flow invented for MCP.

import { ENDPOINT_INDEX, providerCatalog } from '../../v1/_providers.js';
import { executeUpstream, resolveUpstreamKey } from '../../_lib/aggregator.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

function toolResult(payload) {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload,
	};
}

function errorResult(message, data) {
	return {
		content: [{ type: 'text', text: message }],
		isError: true,
		structuredContent: data,
	};
}

// Same per-IP identity the REST free lane keys its quota by. `req` is absent
// under some transports (unit tests, non-HTTP dispatch) — fall back to the
// caller's account id, then a shared anonymous bucket.
function callerKey(auth, req) {
	if (req) {
		try {
			return `ip:${clientIp(req)}`;
		} catch {
			/* fall through */
		}
	}
	return auth?.userId ? `user:${auth.userId}` : 'anon';
}

/** Every "provider/endpoint" pair currently registered, for error hints. */
function listPairs() {
	return [...ENDPOINT_INDEX.keys()].sort();
}

/** One line per endpoint, generated fresh from the live registry at call time. */
function describePairs() {
	return providerCatalog()
		.flatMap((p) => p.endpoints.map((e) => `${p.id}/${e.id} — ${e.summary}`))
		.join('\n');
}

/**
 * Run one aggregator call, honoring the endpoint's free-tier quota (if any).
 * Shared by both tools so token_snapshot's fan-out and crypto_data's direct
 * call enforce identically. Never throws — every outcome is a tagged result
 * so callers can degrade gracefully (token_snapshot) or surface a clean
 * payment-required error (crypto_data).
 */
async function runEndpoint({ providerId, endpointId, params, auth, req }) {
	const hit = ENDPOINT_INDEX.get(`${providerId}/${endpointId}`);
	if (!hit) return { ok: false, reason: 'unknown_pair' };
	const { provider, endpoint } = hit;

	if (endpoint.free) {
		const key = callerKey(auth, req);
		const bucket = `${provider.id}:${endpoint.id}:mcp:${key}`;
		const [minR, dayR] = await Promise.all([
			limits.apiV1FreeMin(bucket, endpoint.free.perMin),
			limits.apiV1FreeDay(bucket, endpoint.free.perDay),
		]);
		if (!minR.success || !dayR.success) {
			const blocked = !minR.success ? minR : dayR;
			return {
				ok: false,
				reason: 'quota_exceeded',
				provider: provider.id,
				endpoint: endpoint.id,
				reset: new Date(blocked.reset).toISOString(),
				priceAtomics: endpoint.priceAtomics,
				restUrl: `/api/v1/x/${provider.id}/${endpoint.id}`,
			};
		}
	} else {
		return {
			ok: false,
			reason: 'payment_required',
			provider: provider.id,
			endpoint: endpoint.id,
			priceAtomics: endpoint.priceAtomics,
			restUrl: `/api/v1/x/${provider.id}/${endpoint.id}`,
		};
	}

	const { key: apiKey } = resolveUpstreamKey(provider, null);
	try {
		const data = await executeUpstream({ provider, endpoint, query: params || {}, apiKey });
		return { ok: true, provider: provider.id, endpoint: endpoint.id, data };
	} catch (err) {
		return {
			ok: false,
			reason: 'upstream_error',
			provider: provider.id,
			endpoint: endpoint.id,
			message: err?.message || 'upstream call failed',
			status: err?.status || 502,
		};
	}
}

const READ_ONLY_LIVE_FEED = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

export const toolDefs = [
	{
		name: 'crypto_data',
		title: 'Crypto Data API',
		annotations: READ_ONLY_LIVE_FEED,
		get description() {
			return (
				'Call any endpoint in the three.ws free crypto data API (the same aggregator behind ' +
				'GET /api/v1/x/*): DEX pairs, CoinGecko/DefiLlama market data, Jupiter Solana prices ' +
				'and swap quotes, and direct Solana RPC reads. Endpoints marked free run within a ' +
				'per-IP quota, no wallet needed; an endpoint with no free tier (or an exhausted quota) ' +
				'returns a payment-required error naming the exact REST URL and USDC price to pay via ' +
				'x402.\n\nLive provider/endpoint pairs on this deployment:\n' + describePairs()
			);
		},
		inputSchema: {
			type: 'object',
			required: ['provider', 'endpoint'],
			properties: {
				provider: {
					type: 'string',
					description: 'Registered provider id, e.g. "coingecko", "dexscreener", "jupiter", "solana", "defillama".',
				},
				endpoint: {
					type: 'string',
					description: 'Endpoint id under that provider, e.g. "price", "token", "quote".',
				},
				params: {
					type: 'object',
					description: 'Endpoint-specific query params — see the endpoint summary in the tool description for required fields.',
					additionalProperties: true,
					default: {},
				},
			},
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			const providerId = String(args?.provider || '').trim();
			const endpointId = String(args?.endpoint || '').trim();
			const pairKey = `${providerId}/${endpointId}`;
			if (!ENDPOINT_INDEX.has(pairKey)) {
				return errorResult(
					`unknown provider/endpoint "${pairKey}". Valid pairs:\n${listPairs().join('\n')}`,
					{ error: 'unknown_pair', valid_pairs: listPairs() },
				);
			}

			const result = await runEndpoint({ providerId, endpointId, params: args?.params, auth, req });
			if (result.ok) {
				return toolResult({ provider: result.provider, endpoint: result.endpoint, data: result.data });
			}
			if (result.reason === 'quota_exceeded' || result.reason === 'payment_required') {
				throw rpcError(-32402, `payment required for ${pairKey}`, {
					scheme: 'x402',
					provider: result.provider,
					endpoint: result.endpoint,
					amount_usdc_atomics: result.priceAtomics,
					pay_via: `${result.restUrl} — send an X-PAYMENT header (see docs/x402.md) for pay-per-call USDC`,
					...(result.reset ? { free_tier_reset: result.reset } : {}),
				});
			}
			return errorResult(`${pairKey} upstream error: ${result.message}`, result);
		},
	},
	{
		name: 'token_snapshot',
		title: 'Crypto token snapshot',
		annotations: READ_ONLY_LIVE_FEED,
		description:
			'One-call snapshot for a Solana token mint, fanning out to whichever free crypto-data ' +
			'providers are registered on this deployment (DexScreener pairs, Jupiter price, Solana RPC ' +
			'supply) and merging what answers — degrades gracefully around any provider that is absent, ' +
			'unconfigured, or fails, never throwing on a partial result. Example mint: the $THREE CA ' +
			'"FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump". For pump.fun-specific bonding-curve / ' +
			'launch data use the pump_snapshot tool instead — this tool covers general market data.',
		inputSchema: {
			type: 'object',
			required: ['mint'],
			properties: {
				mint: { type: 'string', description: 'Base58 Solana token mint address.' },
			},
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			const mint = String(args?.mint || '').trim();
			if (!mint) return errorResult('"mint" is required', { error: 'validation_error' });

			// Fixed, small candidate set (not every registered provider) — a
			// snapshot is meant to answer "what is this token" in one call, not
			// fan out to every provider that happens to accept a mint-shaped param.
			const CANDIDATES = [
				{ provider: 'dexscreener', endpoint: 'token', params: { addresses: mint } },
				{ provider: 'jupiter', endpoint: 'price', params: { ids: mint } },
				{ provider: 'solana', endpoint: 'token-supply', params: { mint } },
			];

			const snapshot = { mint, sources: [], skipped: [], failed: [] };
			for (const c of CANDIDATES) {
				if (!ENDPOINT_INDEX.has(`${c.provider}/${c.endpoint}`)) {
					snapshot.skipped.push({
						provider: c.provider,
						endpoint: c.endpoint,
						reason: 'not_registered_on_this_deployment',
					});
					continue;
				}
				const r = await runEndpoint({ providerId: c.provider, endpointId: c.endpoint, params: c.params, auth, req });
				if (r.ok) {
					snapshot[c.provider] = r.data;
					snapshot.sources.push(c.provider);
				} else {
					snapshot.failed.push({ provider: c.provider, endpoint: c.endpoint, reason: r.reason, message: r.message });
				}
			}

			if (snapshot.sources.length === 0) {
				return errorResult(`no registered provider could resolve ${mint}`, snapshot);
			}
			return toolResult(snapshot);
		},
	},
];
