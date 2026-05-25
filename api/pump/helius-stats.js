// GET /api/pump/helius-stats
// --------------------------
// Lightweight network/feed health endpoint for the /pumpfun page. Returns:
//   - sol_price (USD, cached upstream)
//   - helius { enabled, slot, blockTime, network } when HELIUS_API_KEY is set
//   - feed { mints, graduations } counts from the in-process replay buffer
//
// Designed to be polled every ~5s by the page to drive the live network panel
// next to the "Powered by Helius" pill. When Helius is not configured the
// `helius.enabled` flag is false and the page falls back to attribution-only.
//
// Public, cacheable for 3s. No auth.

import { cors, json, method, wrap } from '../_lib/http.js';
import { recentBuffered } from '../_lib/pumpfun-ws-feed.js';

let _solCache = { price: 0, at: 0 };
let _heliusCache = { value: null, at: 0 };

async function getSolPrice() {
	if (Date.now() - _solCache.at < 60_000 && _solCache.price > 0) return _solCache.price;
	try {
		const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true');
		const d = await r.json();
		const p = d?.solana?.usd;
		const c = d?.solana?.usd_24h_change;
		if (p > 0) _solCache = { price: p, change_24h: c, at: Date.now() };
	} catch {}
	return _solCache.price || 0;
}

async function getHeliusInfo() {
	const rpcUrl = process.env.SOLANA_RPC_URL || '';
	const isHelius = rpcUrl.includes('helius-rpc.com');
	if (!isHelius) return { enabled: false };
	if (Date.now() - _heliusCache.at < 4_000 && _heliusCache.value) return _heliusCache.value;
	try {
		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), 1500);
		const r = await fetch(rpcUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: ctrl.signal,
			body: JSON.stringify({
				jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }],
			}),
		});
		clearTimeout(tid);
		const d = await r.json();
		const slot = Number(d?.result) || null;
		const value = { enabled: true, slot, network: 'mainnet', endpoint: 'helius-rpc' };
		_heliusCache = { value, at: Date.now() };
		return value;
	} catch {
		const value = { enabled: true, slot: null, network: 'mainnet', error: 'unreachable' };
		_heliusCache = { value, at: Date.now() };
		return value;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const [solPrice, helius] = await Promise.all([getSolPrice(), getHeliusInfo()]);

	const mints = recentBuffered({ kind: 'mint', limit: 25 });
	const grads = recentBuffered({ kind: 'graduation', limit: 25 });
	const now = Math.floor(Date.now() / 1000);
	const window60 = (arr, key) => arr.filter((e) => {
		const t = e?.data?.[key] || e?.data?.timestamp || e?.data?.created_at || 0;
		return t && now - t <= 60;
	}).length;
	const window3600 = (arr, key) => arr.filter((e) => {
		const t = e?.data?.[key] || e?.data?.timestamp || e?.data?.created_at || 0;
		return t && now - t <= 3600;
	}).length;

	return json(res, 200, {
		sol_price: solPrice || null,
		sol_change_24h: _solCache.change_24h ?? null,
		helius,
		feed: {
			mints_per_min: window60(mints, 'created_at'),
			graduations_per_hour: window3600(grads, 'timestamp'),
			buffered_mints: mints.length,
			buffered_graduations: grads.length,
		},
		ts: Date.now(),
	}, { 'cache-control': 'public, max-age=3' });
});
