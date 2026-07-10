// GET /api/coin/gas
// ---------------------------------------------------------------------------
// Live Ethereum gas oracle for the /gas page. Computes three fee tiers
// (slow / standard / fast) from real on-chain data — no third-party gas API,
// no key. It reads eth_feeHistory over the last ~20 blocks from a public RPC
// (with failover) and derives each tier as base fee + a priority-fee
// percentile (25th / 50th / 90th). Adds USD cost estimates for common actions
// using the live ETH price from CoinGecko. Cached 15s in-memory + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';

// Keyless public JSON-RPC endpoints, tried in order until one answers.
const RPCS = [
	'https://ethereum-rpc.publicnode.com',
	'https://eth.llamarpc.com',
	'https://rpc.ankr.com/eth',
	'https://cloudflare-eth.com',
];

// Gas units for the actions we price. Transfer is exact (21000); the rest are
// representative typical costs so the USD figures are grounded, not invented.
const ACTIONS = [
	{ key: 'transfer', label: 'ETH transfer', gas: 21_000 },
	{ key: 'erc20', label: 'Token transfer', gas: 65_000 },
	{ key: 'swap', label: 'DEX swap', gas: 150_000 },
	{ key: 'nft', label: 'NFT mint', gas: 200_000 },
];

let _cache = null; // { value, expiresAt }
const TTL_MS = 15_000;

const hexToNum = (h) => (typeof h === 'string' ? parseInt(h, 16) : Number(h));
const weiToGwei = (wei) => wei / 1e9;

async function rpc(url, method, params) {
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		signal: AbortSignal.timeout(6000),
	});
	if (!resp.ok) throw new Error(`rpc ${resp.status}`);
	const body = await resp.json();
	if (body.error) throw new Error(body.error.message || 'rpc error');
	return body.result;
}

// Try each RPC until one returns a fee history; the first healthy provider wins.
async function feeHistory() {
	let lastErr;
	for (const url of RPCS) {
		try {
			// 20 blocks, priority-fee percentiles for slow/standard/fast tiers.
			const fh = await rpc(url, 'eth_feeHistory', ['0x14', 'latest', [25, 50, 90]]);
			if (fh?.baseFeePerGas?.length && fh?.reward?.length) return fh;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr || new Error('all RPCs failed');
}

function computeTiers(fh) {
	const baseFees = fh.baseFeePerGas.map(hexToNum).filter(Number.isFinite);
	// Pending block's projected base fee is the last entry feeHistory returns.
	const baseFee = baseFees[baseFees.length - 1];

	// Median each percentile column across the sampled blocks — resistant to a
	// single spiky block skewing a tier.
	const cols = [[], [], []];
	for (const row of fh.reward) {
		if (!Array.isArray(row)) continue;
		row.forEach((v, i) => {
			const n = hexToNum(v);
			if (Number.isFinite(n) && i < 3) cols[i].push(n);
		});
	}
	const median = (arr) => {
		if (!arr.length) return 0;
		const s = [...arr].sort((a, b) => a - b);
		const m = Math.floor(s.length / 2);
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	};
	const priorities = cols.map(median);

	const tiers = ['slow', 'standard', 'fast'].map((key, i) => {
		const priority = priorities[i];
		const total = baseFee + priority;
		return {
			key,
			base_fee_gwei: weiToGwei(baseFee),
			priority_fee_gwei: weiToGwei(priority),
			gas_price_gwei: weiToGwei(total),
			gas_price_wei: total,
		};
	});
	return { baseFeeGwei: weiToGwei(baseFee), tiers };
}

async function build() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const [fhResult, priceResult] = await Promise.allSettled([
		feeHistory(),
		geckoFetch('/simple/price?ids=ethereum&vs_currencies=usd', { ttlMs: 60_000 }),
	]);
	if (fhResult.status !== 'fulfilled') throw fhResult.reason || new Error('no fee history');

	const { baseFeeGwei, tiers } = computeTiers(fhResult.value);
	const ethUsd =
		priceResult.status === 'fulfilled' ? Number(priceResult.value?.ethereum?.usd) : null;
	const ethPrice = Number.isFinite(ethUsd) ? ethUsd : null;

	// Cost per action = gasPrice(gwei) × 1e-9 ETH/gwei × gasUnits × ETH price.
	const withCosts = tiers.map((t) => ({
		...t,
		actions: ACTIONS.map((a) => ({
			key: a.key,
			label: a.label,
			gas: a.gas,
			usd: ethPrice != null ? t.gas_price_gwei * 1e-9 * a.gas * ethPrice : null,
		})),
	}));

	const value = {
		tiers: withCosts,
		base_fee_gwei: baseFeeGwei,
		eth_price_usd: ethPrice,
		actions: ACTIONS.map((a) => ({ key: a.key, label: a.label, gas: a.gas })),
		updated_at: now,
	};
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const payload = await build();
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=10, s-maxage=15, stale-while-revalidate=60',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'gas data is unavailable right now — retry shortly',
		);
	}
});
