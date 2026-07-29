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
// SOL spot comes from the canonical shared module (same 60s cache, but seven
// failover sources instead of a lone CoinGecko fetch, so a keyless-tier 429 no
// longer blanks the panel). solPriceInfo() exposes the cache age and the 24h
// change this endpoint reports, without a second network read.
import { solPriceUsd, solPriceInfo, solChange24hPct } from '../_lib/sol-price.js';

let _heliusCache = { value: null, at: 0 };

async function getHeliusInfo() {
	const apiKey = process.env.HELIUS_API_KEY || '';
	// Key-only configs (no SOLANA_RPC_URL) still get a working probe endpoint —
	// otherwise enabled:true would pair with a guaranteed-unreachable empty URL.
	const rpcUrl =
		process.env.SOLANA_RPC_URL ||
		(apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : '');
	const isHelius = !!apiKey || rpcUrl.includes('helius-rpc.com') || rpcUrl.includes('helius.dev');
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

	const [solPrice, change24h, helius] = await Promise.all([
		solPriceUsd(),
		solChange24hPct(),
		getHeliusInfo(),
	]);
	const priceInfo = solPriceInfo();

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
		sol_price_stale: priceInfo.stale,
		sol_change_24h: change24h,
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
