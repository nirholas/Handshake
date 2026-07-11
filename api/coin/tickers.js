// GET /api/coin/tickers?id=<coingecko-id>&page=1
// ---------------------------------------------------------------------------
// Exchange listings for one coin — powers the Markets table on the /coin/:id
// detail page. Proxies CoinGecko /coins/{id}/tickers ordered by converted
// volume with ±2% depth, slims each ticker to what the table renders, and
// truncates contract-address pair symbols (DEX listings report raw 0x/base58
// addresses as symbols) so every pair stays legible. Cached in-memory 120s +
// CDN s-maxage.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch, isPlausibleCoinId } from '../_lib/coingecko.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// A pair symbol that is really a contract address (EVM 0x… or a base58 mint)
// renders as an unreadable wall of characters — shorten to a 6-char prefix.
const ADDRESS_SYMBOL_RE = /^(0x[0-9a-fA-F]{8,}|[1-9A-HJ-NP-Za-km-z]{32,64})$/;

function pairSymbol(s) {
	const v = str(s);
	if (!v) return null;
	return ADDRESS_SYMBOL_RE.test(v) ? `${v.slice(0, 6)}…` : v.toUpperCase();
}

function shapeTicker(t) {
	const base = pairSymbol(t.base);
	const target = pairSymbol(t.target);
	const tradeUrl = str(t.trade_url);
	return {
		exchange: {
			id: str(t.market?.identifier),
			name: str(t.market?.name),
			logo: str(t.market?.logo),
		},
		base,
		target,
		pair: base && target ? `${base}/${target}` : null,
		price_usd: num(t.converted_last?.usd),
		volume_usd: num(t.converted_volume?.usd),
		spread_pct: num(t.bid_ask_spread_percentage),
		depth_up_usd: num(t.cost_to_move_up_usd),
		depth_down_usd: num(t.cost_to_move_down_usd),
		trust: t.trust_score === 'green' || t.trust_score === 'yellow' || t.trust_score === 'red' ? t.trust_score : null,
		stale: Boolean(t.is_stale || t.is_anomaly),
		// Only ever hand the client an http(s) URL — trade_url is upstream-controlled.
		trade_url: tradeUrl && /^https?:\/\//i.test(tradeUrl) ? tradeUrl : null,
		coin_id: str(t.coin_id),
		target_coin_id: str(t.target_coin_id),
		last_traded: str(t.timestamp),
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const id = (params.get('id') || '').trim().toLowerCase();
	if (!isPlausibleCoinId(id)) {
		return error(res, 400, 'bad_id', 'id must be a CoinGecko coin id (lowercase slug)');
	}
	const page = parseInt(params.get('page') || '1', 10) || 1;
	if (page < 1 || page > 10) {
		return error(res, 400, 'bad_page', 'page must be an integer between 1 and 10');
	}

	try {
		const raw = await geckoFetch(
			`/coins/${id}/tickers?page=${page}&order=converted_volume_desc&depth=true&include_exchange_logo=true`,
			{ ttlMs: 120_000, timeoutMs: 10_000 },
		);
		const tickers = (raw?.tickers || []).map(shapeTicker);
		return json(res, 200, { tickers, page, count: tickers.length }, {
			'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
		});
	} catch (err) {
		if (err?.status === 404)
			return error(res, 404, 'not_found', `no coin found for "${id}"`);
		return error(res, 502, 'upstream_error', 'exchange listings are unavailable right now — retry shortly');
	}
});
