// Canonical story-page links — the single source of truth for how a news
// article maps to its own indexable page on three.ws, shared by the browser
// modules (news feed, archive, coin page, reader) AND the server (the SSR
// story-page handler and the news sitemap import this file too, like
// api/sentiment.js → src/social/sentiment.js).
//
// URL scheme:  /markets/news/<YYYY-MM>/<id16>[-<slug>]
//   <YYYY-MM>  the article's publication month — maps 1:1 to an archive month
//              file (articles/YYYY-MM.jsonl), so ANY of the 660k+ historical
//              articles resolves with a single fetch.
//   <id16>     the 16-hex content-addressed article id (sha256 of the
//              publisher link) that the live feed and the archive already
//              share. This is the lookup key.
//   <slug>     human/SEO-readable, derived from the title. Cosmetic only —
//              the route ignores it, so a retitled story never 404s.

/** Lowercase-ascii slug from an article title. Returns '' for titles with no
 * latin content (e.g. Chinese headlines) — the path stays valid without it. */
export function slugifyTitle(title) {
	return String(title || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '') // strip diacritics
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.split('-')
		.slice(0, 10)
		.join('-')
		.slice(0, 80)
		.replace(/-+$/, '');
}

/** YYYY-MM month bucket for an article, or null when it carries no parseable
 * publication date (undated corpus rows stay on the query-param reader). */
export function storyMonth(a) {
	const t = Date.parse(a?.pub_date || a?.published_at || '');
	if (Number.isNaN(t)) return null;
	return new Date(t).toISOString().slice(0, 7);
}

/**
 * Canonical story-page path for an article record, or null when the record
 * can't carry one (no id or no date). Accepts both the live-feed shape
 * (pub_date) and the coin-rail shape (published_at).
 */
export function storyPath(a) {
	const month = storyMonth(a);
	if (!a?.id || !/^[a-f0-9]{16}$/.test(a.id) || !month) return null;
	const slug = slugifyTitle(a.title);
	return `/markets/news/${month}/${a.id}${slug ? `-${slug}` : ''}`;
}

// Tickers the aggregator detects (api/_lib/news.js TICKER_WORDS) mapped to
// their CoinGecko ids, so article pages can deep-link straight into the
// /coin/:id profiles. Symbols outside this map fall back to a news search.
export const TICKER_COIN_IDS = {
	BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', BNB: 'binancecoin',
	DOGE: 'dogecoin', ADA: 'cardano', USDT: 'tether', USDC: 'usd-coin',
	AVAX: 'avalanche-2', DOT: 'polkadot', LINK: 'chainlink', LTC: 'litecoin',
	MATIC: 'matic-network', TRX: 'tron', SHIB: 'shiba-inu', SUI: 'sui',
	APT: 'aptos', NEAR: 'near', ARB: 'arbitrum', OP: 'optimism', PEPE: 'pepe',
	BONK: 'bonk', AAVE: 'aave', UNI: 'uniswap', MKR: 'maker', XLM: 'stellar',
	XMR: 'monero', ATOM: 'cosmos', FIL: 'filecoin', HBAR: 'hedera-hashgraph',
	INJ: 'injective-protocol', TIA: 'celestia', JTO: 'jito-governance-token',
	JUP: 'jupiter-exchange-solana', WLD: 'worldcoin-wld', TON: 'the-open-network',
	HYPE: 'hyperliquid',
};

/** In-platform destination for a ticker chip: the coin profile when the
 * symbol is a known major, otherwise a scoped news search. */
export function tickerHref(sym) {
	const id = TICKER_COIN_IDS[String(sym || '').toUpperCase()];
	return id ? `/coin/${id}` : `/markets/news?q=${encodeURIComponent(sym)}`;
}
