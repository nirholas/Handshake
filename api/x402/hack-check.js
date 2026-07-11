// GET /api/x402/hack-check?protocol=&limit=
//
// Exploit History Check — $0.002 USDC per call on Solana or Base. Runs a
// protocol name against the full historical DeFi exploit database and returns
// a clean / incident-history verdict with every matching incident (date,
// amount, technique, chains, recovered funds) plus market-wide loss stats.
// Omit ?protocol= for the latest incidents market-wide.
//
// Data is live: api.llama.fi/hacks (keyless), cached 10 min in-memory — the
// same upstream the free /api/defi/hacks page endpoint renders; this paid
// surface adds the per-protocol verdict agents act on. A truthful zero-match
// answer is a valid billable result; upstream outages throw BEFORE settlement.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import listing from '../_lib/service-catalog/services/hack-check.js';

const ROUTE = '/api/x402/hack-check';
const DESCRIPTION = listing.description;

const TTL_MS = 600_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

let _cache = null; // { hacks, stats, expiresAt }

function normalizeChains(chain) {
	if (Array.isArray(chain)) return chain.filter((c) => typeof c === 'string' && c.length);
	if (typeof chain === 'string' && chain.length) return [chain];
	return [];
}

async function loadDataset() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache;

	const r = await fetch('https://api.llama.fi/hacks', {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!r.ok) throw new Error(`llama hacks ${r.status}`);
	const raw = await r.json();
	if (!Array.isArray(raw)) throw new Error('unexpected upstream shape');

	const hacks = [];
	for (const h of raw) {
		const dateSec = Number(h?.date);
		if (!Number.isFinite(dateSec)) continue;
		const amount = Number(h?.amount);
		const returned = Number(h?.returnedFunds);
		hacks.push({
			date: new Date(dateSec * 1000).toISOString(),
			_dateMs: dateSec * 1000,
			name: typeof h.name === 'string' && h.name.length ? h.name : 'Unknown',
			amount_usd: Number.isFinite(amount) && amount >= 0 ? amount : null,
			technique: typeof h.technique === 'string' ? h.technique : null,
			classification: typeof h.classification === 'string' ? h.classification : null,
			chains: normalizeChains(h.chain),
			bridge: h.bridgeHack === true,
			returned_usd: Number.isFinite(returned) && returned > 0 ? returned : null,
			source: typeof h.source === 'string' && /^https?:\/\//i.test(h.source) ? h.source : null,
		});
	}
	hacks.sort((a, b) => b._dateMs - a._dateMs);

	const cutoff = now - YEAR_MS;
	let totalAllTime = 0;
	let total12mo = 0;
	let incidents12mo = 0;
	let bridgeAllTime = 0;
	for (const h of hacks) {
		const amt = h.amount_usd || 0;
		totalAllTime += amt;
		if (h.bridge) bridgeAllTime += amt;
		if (h._dateMs >= cutoff) {
			total12mo += amt;
			incidents12mo += 1;
		}
	}

	_cache = {
		hacks,
		stats: {
			total_stolen_all_time: totalAllTime,
			total_stolen_12mo: total12mo,
			incidents_12mo: incidents12mo,
			bridge_hack_share_pct: totalAllTime > 0 ? (bridgeAllTime / totalAllTime) * 100 : 0,
		},
		expiresAt: now + TTL_MS,
	};
	return _cache;
}

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	...listing.inputSchema,
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['query', 'verdict', 'matches', 'total_lost_usd', 'incidents', 'stats', 'ts'],
	properties: {
		query: { type: ['string', 'null'] },
		verdict: { type: 'string', enum: ['clean', 'incident-history', 'market-wide'] },
		matches: { type: 'integer' },
		total_lost_usd: { type: 'number' },
		incidents: {
			type: 'array',
			items: {
				type: 'object',
				required: ['date', 'name', 'amount_usd'],
				properties: {
					date: { type: 'string', format: 'date-time' },
					name: { type: 'string' },
					amount_usd: { type: ['number', 'null'] },
					technique: { type: ['string', 'null'] },
					classification: { type: ['string', 'null'] },
					chains: { type: 'array', items: { type: 'string' } },
					bridge: { type: 'boolean' },
					returned_usd: { type: ['number', 'null'] },
					source: { type: ['string', 'null'] },
				},
			},
		},
		stats: {
			type: 'object',
			required: ['total_stolen_all_time', 'total_stolen_12mo', 'incidents_12mo', 'bridge_hack_share_pct'],
			properties: {
				total_stolen_all_time: { type: 'number' },
				total_stolen_12mo: { type: 'number' },
				incidents_12mo: { type: 'integer' },
				bridge_hack_share_pct: { type: 'number' },
			},
		},
		ts: { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['protocol due-diligence', 'exploit history lookup', 'integration risk check'],
	input: {
		type: 'query',
		example: listing.input,
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: listing.outputExample,
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('hack-check', '2000'), // $0.002 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: listing.serviceName,
		tags: listing.tags,
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const params = new URL(req.url, 'http://x').searchParams;
		const protocol = (params.get('protocol') || '').trim().slice(0, 80) || null;
		const limitRaw = Number(params.get('limit') || '10');
		const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 10));

		let data = null;
		try { data = await loadDataset(); } catch { /* refund below */ }
		if (!data || !data.hacks.length) {
			throw Object.assign(new Error('exploit database is temporarily unavailable'), {
				status: 503,
				code: 'data_unavailable',
			});
		}

		let matched = data.hacks;
		let verdict = 'market-wide';
		if (protocol) {
			const needle = protocol.toLowerCase();
			matched = data.hacks.filter((h) => h.name.toLowerCase().includes(needle));
			verdict = matched.length ? 'incident-history' : 'clean';
		}

		const totalLost = matched.reduce((s, h) => s + (h.amount_usd || 0), 0);
		const incidents = matched.slice(0, limit).map(({ _dateMs, ...h }) => h);

		return {
			query: protocol,
			verdict,
			matches: matched.length,
			total_lost_usd: totalLost,
			incidents,
			stats: data.stats,
			ts: new Date().toISOString(),
		};
	},
});
