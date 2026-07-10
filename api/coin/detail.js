// GET /api/coin/detail?id=<coingecko-id>
// GET /api/coin/detail?contract=<solana-mint>
// ---------------------------------------------------------------------------
// Rich profile for one coin — powers the /coin/:id detail page (adopted from
// the cryptocurrency.cv coin pages). Proxies CoinGecko /coins/{id} (or the
// Solana contract lookup when the page is given a mint address), slims the
// multi-hundred-KB upstream payload to exactly what the page renders, and
// sanitizes the description to plain text server-side so the client never
// touches upstream HTML. Cached in-memory 60s + CDN s-maxage.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch, isPlausibleCoinId, htmlToText } from '../_lib/coingecko.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function shape(c) {
	const md = c.market_data || {};
	const links = c.links || {};
	const explorers = (links.blockchain_site || []).filter((u) => str(u)).slice(0, 3);
	// Contract addresses per chain — the page uses these to cross-link Solana
	// mints into the platform's own intel surfaces.
	const platforms = {};
	for (const [chain, addr] of Object.entries(c.platforms || {})) {
		if (str(chain) && str(addr) && Object.keys(platforms).length < 8) platforms[chain] = addr.trim();
	}
	return {
		id: c.id,
		symbol: str(c.symbol)?.toUpperCase() ?? null,
		name: str(c.name) ?? c.id,
		image: str(c.image?.large) || str(c.image?.small) || null,
		rank: num(c.market_cap_rank),
		categories: (c.categories || []).filter((v) => str(v)).slice(0, 6),
		description: htmlToText(c.description?.en || '').slice(0, 3000),
		links: {
			homepage: str(links.homepage?.[0]),
			twitter: str(links.twitter_screen_name),
			reddit: str(links.subreddit_url),
			telegram: str(links.telegram_channel_identifier),
			github: str(links.repos_url?.github?.[0]),
			explorers,
		},
		platforms,
		market: {
			price: num(md.current_price?.usd),
			market_cap: num(md.market_cap?.usd),
			fdv: num(md.fully_diluted_valuation?.usd),
			volume_24h: num(md.total_volume?.usd),
			high_24h: num(md.high_24h?.usd),
			low_24h: num(md.low_24h?.usd),
			change_24h_abs: num(md.price_change_24h),
			change_pct: {
				h24: num(md.price_change_percentage_24h),
				d7: num(md.price_change_percentage_7d),
				d30: num(md.price_change_percentage_30d),
				y1: num(md.price_change_percentage_1y),
			},
			circulating: num(md.circulating_supply),
			total: num(md.total_supply),
			max: num(md.max_supply),
			ath: num(md.ath?.usd),
			ath_date: str(md.ath_date?.usd),
			ath_change_pct: num(md.ath_change_percentage?.usd),
			atl: num(md.atl?.usd),
			atl_date: str(md.atl_date?.usd),
		},
		last_updated: str(c.last_updated),
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const contract = (params.get('contract') || '').trim();
	const id = (params.get('id') || '').trim().toLowerCase();
	if (contract && !MINT_RE.test(contract)) {
		return error(res, 400, 'bad_contract', 'contract must be a base58 Solana address (32–44 chars)');
	}
	if (!contract && !isPlausibleCoinId(id)) {
		return error(res, 400, 'bad_id', 'id must be a CoinGecko coin id (lowercase slug)');
	}

	try {
		const raw = contract
			? await geckoFetch(`/coins/solana/contract/${contract}`, { ttlMs: 60_000 })
			: await geckoFetch(
					`/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
					{ ttlMs: 60_000 },
				);
		return json(res, 200, { coin: shape(raw) }, {
			'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
		});
	} catch (err) {
		if (err?.status === 404)
			return error(res, 404, 'not_found', `no coin found for "${contract || id}"`);
		return error(res, 502, 'upstream_error', 'coin data is unavailable right now — retry shortly');
	}
});
