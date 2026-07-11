// GET /api/x402/gas-oracle
//
// Multi-Chain Gas Oracle — $0.001 USDC per call on Solana or Base. Live
// transaction-fee intelligence across the chains agents actually settle on:
// Ethereum and Base each return slow / standard / fast tiers computed from
// real eth_feeHistory percentiles over the last 20 blocks (no third-party
// gas API), and Solana returns recent priority-fee percentiles plus the base
// signature fee.
//
// Computed directly from public RPC quorums with per-chain failover. A chain
// whose RPCs are all unreachable reports null while the rest of the report
// stays live (documented in the output schema); if EVERY chain fails the
// handler throws BEFORE settlement so the buyer is never charged.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import listing from '../_lib/service-catalog/services/gas-oracle.js';

const ROUTE = '/api/x402/gas-oracle';
const DESCRIPTION = listing.description;

const TTL_MS = 15_000;

// Keyless public JSON-RPC endpoints per chain, tried in order (same failover
// approach as the free ETH-only /api/coin/gas page endpoint).
const EVM_RPCS = {
	ethereum: [
		'https://ethereum-rpc.publicnode.com',
		'https://eth.llamarpc.com',
		'https://rpc.ankr.com/eth',
		'https://cloudflare-eth.com',
	],
	base: [
		'https://mainnet.base.org',
		'https://base-rpc.publicnode.com',
		'https://base.llamarpc.com',
	],
};

const SOLANA_RPCS = [
	'https://solana-rpc.publicnode.com',
	'https://api.mainnet-beta.solana.com',
];

let _cache = null; // { value, expiresAt }

const hexToNum = (h) => (typeof h === 'string' ? parseInt(h, 16) : Number(h));
const weiToGwei = (wei) => wei / 1e9;

function median(arr) {
	if (!arr.length) return 0;
	const s = [...arr].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(sorted, p) {
	if (!sorted.length) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

async function rpc(url, methodName, params) {
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: methodName, params }),
		signal: AbortSignal.timeout(6000),
	});
	if (!resp.ok) throw new Error(`rpc ${resp.status}`);
	const body = await resp.json();
	if (body.error) throw new Error(body.error.message || 'rpc error');
	return body.result;
}

// slow/standard/fast tiers from a 20-block eth_feeHistory: pending base fee +
// the median 25th/50th/90th priority-fee percentile across sampled blocks.
async function evmGas(chain) {
	let lastErr;
	for (const url of EVM_RPCS[chain]) {
		try {
			const fh = await rpc(url, 'eth_feeHistory', ['0x14', 'latest', [25, 50, 90]]);
			if (!fh?.baseFeePerGas?.length || !fh?.reward?.length) continue;

			const baseFees = fh.baseFeePerGas.map(hexToNum).filter(Number.isFinite);
			const baseFee = baseFees[baseFees.length - 1];
			const cols = [[], [], []];
			for (const row of fh.reward) {
				if (!Array.isArray(row)) continue;
				row.forEach((v, i) => {
					const n = hexToNum(v);
					if (Number.isFinite(n) && i < 3) cols[i].push(n);
				});
			}
			const priorities = cols.map(median);
			return {
				base_fee_gwei: weiToGwei(baseFee),
				tiers: ['slow', 'standard', 'fast'].map((key, i) => ({
					key,
					priority_fee_gwei: weiToGwei(priorities[i]),
					gas_price_gwei: weiToGwei(baseFee + priorities[i]),
				})),
			};
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr || new Error(`all ${chain} RPCs failed`);
}

// Solana fee posture: recent prioritization fees (micro-lamports per compute
// unit) as p25/p50/p90 across the sampled slots, plus the fixed base
// signature fee.
async function solanaGas() {
	let lastErr;
	for (const url of SOLANA_RPCS) {
		try {
			const fees = await rpc(url, 'getRecentPrioritizationFees', [[]]);
			if (!Array.isArray(fees) || !fees.length) continue;
			const values = fees
				.map((f) => Number(f?.prioritizationFee))
				.filter((n) => Number.isFinite(n) && n >= 0)
				.sort((a, b) => a - b);
			if (!values.length) continue;
			return {
				priority_fee_micro_lamports: {
					p25: percentile(values, 25),
					p50: percentile(values, 50),
					p90: percentile(values, 90),
				},
				base_fee_lamports: 5000,
				sampled_slots: values.length,
			};
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr || new Error('all Solana RPCs failed');
}

async function loadGas() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const [eth, base, sol] = await Promise.allSettled([
		evmGas('ethereum'),
		evmGas('base'),
		solanaGas(),
	]);
	const value = {
		ethereum: eth.status === 'fulfilled' ? eth.value : null,
		base: base.status === 'fulfilled' ? base.value : null,
		solana: sol.status === 'fulfilled' ? sol.value : null,
	};
	if (!value.ethereum && !value.base && !value.solana) {
		throw new Error('all chains failed');
	}
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	...listing.inputSchema,
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ethereum', 'base', 'solana', 'ts'],
	properties: {
		ethereum: {
			type: ['object', 'null'],
			description: 'null only when every Ethereum RPC in the failover set is unreachable.',
			properties: {
				base_fee_gwei: { type: 'number' },
				tiers: {
					type: 'array',
					items: {
						type: 'object',
						required: ['key', 'priority_fee_gwei', 'gas_price_gwei'],
						properties: {
							key: { type: 'string', enum: ['slow', 'standard', 'fast'] },
							priority_fee_gwei: { type: 'number' },
							gas_price_gwei: { type: 'number' },
						},
					},
				},
			},
		},
		base: {
			type: ['object', 'null'],
			description: 'Same shape as ethereum; null only when every Base RPC is unreachable.',
		},
		solana: {
			type: ['object', 'null'],
			properties: {
				priority_fee_micro_lamports: {
					type: 'object',
					required: ['p25', 'p50', 'p90'],
					properties: {
						p25: { type: 'number' },
						p50: { type: 'number' },
						p90: { type: 'number' },
					},
				},
				base_fee_lamports: { type: 'integer' },
				sampled_slots: { type: 'integer' },
			},
		},
		ts: { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['fee estimation', 'settlement timing', 'multi-chain gas monitoring'],
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
	priceAtomics: priceFor('gas-oracle', '1000'), // $0.001 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: listing.serviceName,
		tags: listing.tags,
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler() {
		let gas = null;
		try { gas = await loadGas(); } catch { /* refund below */ }
		if (!gas) {
			throw Object.assign(new Error('gas data is temporarily unavailable on every chain'), {
				status: 503,
				code: 'data_unavailable',
			});
		}
		return { ...gas, ts: new Date().toISOString() };
	},
});
