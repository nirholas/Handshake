// POST /api/x402/cross-chain
//
// Cross-Chain Bridge Status Monitor — paid x402 endpoint, $0.005 USDC per call.
//
// Probes the live health and latency of major Solana cross-chain bridge providers
// in parallel (Wormhole, Li.Fi, deBridge). Each probe fires a real HTTP request
// against the provider's public status/health API, measures round-trip latency,
// and classifies the result as operational / degraded / down.
//
// Body: { "mode": "bridge_status" }
// Response: {
//   mode, bridges: [{ chain, status, latency_ms, provider }],
//   down_count, signal, headline, confidence, ts
// }
//
// A bridge with status "down" is a platform risk — cross-chain settlement for
// that provider may fail silently until the bridge recovers. The autonomous loop
// records this as an oracle signal (topic: bridge_status) so the sniper gate
// can factor cross-chain ecosystem health into conviction.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/cross-chain';

const DESCRIPTION =
	'Cross-Chain Bridge Status Monitor — pay $0.005 USDC to receive the live ' +
	'operational status and latency of major Solana bridge providers (Wormhole, ' +
	'Li.Fi, deBridge). Any bridge with status=down is flagged as a platform risk.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		mode: {
			type: 'string',
			enum: ['bridge_status'],
			description: 'Operation mode. Only "bridge_status" is supported.',
			default: 'bridge_status',
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mode', 'bridges', 'down_count', 'signal', 'ts'],
	properties: {
		mode: { type: 'string' },
		bridges: {
			type: 'array',
			items: {
				type: 'object',
				required: ['chain', 'status', 'provider'],
				properties: {
					chain:      { type: 'string' },
					status:     { type: 'string', enum: ['operational', 'degraded', 'down'] },
					latency_ms: { type: ['number', 'null'] },
					provider:   { type: 'string' },
				},
			},
		},
		down_count: { type: 'number' },
		signal:     { type: 'string', enum: ['bullish', 'neutral', 'bearish'] },
		headline:   { type: 'string' },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
		ts:         { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['bridge monitoring', 'cross-chain risk', 'platform health'],
	input: {
		type: 'json',
		example: { mode: 'bridge_status' },
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: {
			mode: 'bridge_status',
			bridges: [
				{ chain: 'wormhole', status: 'operational', latency_ms: 210, provider: 'wormholescan' },
				{ chain: 'lifi',     status: 'operational', latency_ms: 334, provider: 'li.fi' },
				{ chain: 'debridge', status: 'degraded',    latency_ms: 1870, provider: 'dln.trade' },
			],
			down_count: 0, signal: 'neutral', headline: 'All Solana bridges operational',
			confidence: 0.82, ts: '2026-06-28T12:00:00Z',
		},
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Latency thresholds for status classification.
const DEGRADED_MS = 2000;  // > 2s response = degraded
const TIMEOUT_MS  = 5000;  // > 5s response = down (or error)

// Bridge providers and their live health endpoints.
//
// Wormhole: public guardian health API used by wormholescan.io.
// Li.Fi:    chains API filtered to SVM (Solana Virtual Machine) chain type —
//           a missing or empty response means the Solana bridge lane is dark.
// deBridge: DLN gate-status API that reports per-chain operational gates.
const BRIDGE_PROBES = [
	{
		chain:    'wormhole',
		provider: 'wormholescan',
		url:      'https://api.wormholescan.io/api/v1/health',
		check: (data) => {
			// Wormhole guardian API returns { status: "OK" } when healthy.
			const s = String(data?.status || '').toLowerCase();
			return s === 'ok' || s === 'healthy';
		},
	},
	{
		chain:    'lifi',
		provider: 'li.fi',
		url:      'https://li.quest/v1/chains?chainTypes=SVM',
		check: (data) => {
			// Li.Fi chains endpoint returns { chains: [...] }. A non-empty array
			// means the Solana lane is advertised; an empty one (or a body without
			// the array) means Li.Fi is not routing SVM right now, which is the
			// outage this probe exists to catch.
			const chains = Array.isArray(data?.chains) ? data.chains : [];
			return chains.length > 0;
		},
	},
	{
		chain:    'debridge',
		provider: 'dln.trade',
		url:      'https://stats-api.dln.trade/api/GatesStatus',
		check: (data) => {
			// deBridge gate status returns an array of gate objects. A 200 response
			// with a non-empty array means the DLN is advertising settlement gates.
			return Array.isArray(data) ? data.length > 0 : !!data;
		},
	},
];

async function probebridge({ chain, provider, url, check }) {
	const t0 = Date.now();
	let latency_ms = null;
	let status = 'down';

	try {
		const res = await fetch(url, {
			headers: { Accept: 'application/json', 'User-Agent': 'threews-x402/1.0' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		latency_ms = Date.now() - t0;

		if (!res.ok) {
			status = 'down';
		} else {
			// A 200 whose body will not parse as JSON is an error page from an
			// edge/proxy in front of the provider, not a healthy API. Leave `data`
			// null and let check() judge it. Every probe below reads a required
			// field, so a null body classifies as down, which is the honest call.
			let data = null;
			try { data = await res.json(); } catch { /* null body → check() reports down */ }
			const isUp = check(data);
			if (!isUp) {
				status = 'down';
			} else if (latency_ms > DEGRADED_MS) {
				status = 'degraded';
			} else {
				status = 'operational';
			}
		}
	} catch {
		latency_ms = latency_ms ?? (Date.now() - t0);
		status = 'down';
	}

	return { chain, status, latency_ms, provider };
}

function classifySignal(bridges) {
	const total      = bridges.length;
	const downCount  = bridges.filter((b) => b.status === 'down').length;
	const degraded   = bridges.filter((b) => b.status === 'degraded').length;

	let signal, headline, confidence;

	if (downCount === 0 && degraded === 0) {
		signal     = 'bullish';
		headline   = `All ${total} Solana bridge providers operational`;
		confidence = 0.85;
	} else if (downCount === total) {
		signal     = 'bearish';
		headline   = `All ${total} Solana bridge providers are down — cross-chain settlement blocked`;
		confidence = 0.95;
	} else if (downCount > 0) {
		const names = bridges.filter((b) => b.status === 'down').map((b) => b.chain).join(', ');
		signal     = 'bearish';
		headline   = `${downCount}/${total} Solana bridge${downCount > 1 ? 's' : ''} down (${names}) — settlement risk`;
		confidence = 0.80;
	} else {
		// Only degraded, no outright down
		signal     = 'neutral';
		headline   = `${degraded}/${total} Solana bridge${degraded > 1 ? 's' : ''} degraded — latency elevated`;
		confidence = 0.72;
	}

	return { signal, headline, confidence, down_count: downCount };
}

export default paidEndpoint({
	route:        ROUTE,
	method:       'POST',
	priceAtomics: priceFor('cross_chain_bridge_status', '5000'), // $0.005 USDC
	networks:     ['solana', 'base'],
	description:  DESCRIPTION,
	bazaar:       BAZAAR,
	service: withService({
		serviceName: 'three.ws Cross-Chain Bridge Status',
		tags: ['bridge', 'cross-chain', 'health', 'solana', 'wormhole', 'lifi'],
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		// Parse body — mode must be "bridge_status" (the only supported mode).
		let mode = 'bridge_status';
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			if (body.mode) mode = String(body.mode).trim();
		} catch { /* default */ }

		if (mode !== 'bridge_status') {
			throw Object.assign(new Error(`unsupported mode: ${mode}`), {
				status: 400,
				code: 'unsupported_mode',
			});
		}

		// Probe all bridges in parallel — no bridge failure aborts the others.
		const bridges = await Promise.all(BRIDGE_PROBES.map((probe) => probebridge(probe)));

		const { signal, headline, confidence, down_count } = classifySignal(bridges);

		return {
			mode,
			bridges,
			down_count,
			signal,
			headline,
			confidence,
			ts: new Date().toISOString(),
		};
	},
});
