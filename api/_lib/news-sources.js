// Crypto-news source registry — ported from the cryptocurrency.cv aggregator
// (same team; its Vercel deployment is retired, so three.ws now runs the
// aggregation natively). Every entry is a real public RSS/Atom feed. Keys and
// category names match the cryptocurrency.cv registry so archive records
// (source_key) and live records line up.
//
// Categories are the canonical filter set exposed by /api/news/feed and the
// /markets/news tabs. Keep them lowercase; the UI owns display labels.

export const NEWS_SOURCES = {
	// ── Tier 1: major outlets ────────────────────────────────────────────────
	coindesk: { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'general' },
	theblock: { name: 'The Block', url: 'https://www.theblock.co/rss.xml', category: 'general' },
	decrypt: { name: 'Decrypt', url: 'https://decrypt.co/feed', category: 'general' },
	cointelegraph: { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', category: 'general' },
	blockworks: { name: 'Blockworks', url: 'https://blockworks.co/feed', category: 'general' },
	cryptoslate: { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', category: 'general' },
	newsbtc: { name: 'NewsBTC', url: 'https://www.newsbtc.com/feed/', category: 'general' },
	dailyhodl: { name: 'The Daily Hodl', url: 'https://dailyhodl.com/feed/', category: 'general' },
	coinjournal: { name: 'CoinJournal', url: 'https://coinjournal.net/feed/', category: 'general' },
	cryptopotato: { name: 'CryptoPotato', url: 'https://cryptopotato.com/feed/', category: 'general' },
	cryptodaily: { name: 'CryptoDaily', url: 'https://cryptodaily.co.uk/feed', category: 'general' },
	cryptopolitan: { name: 'Cryptopolitan', url: 'https://www.cryptopolitan.com/feed/', category: 'general' },
	coinspeaker: { name: 'Coinspeaker', url: 'https://www.coinspeaker.com/feed/', category: 'general' },

	// ── Bitcoin ──────────────────────────────────────────────────────────────
	bitcoinmagazine: { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/', category: 'bitcoin' },
	bitcoinist: { name: 'Bitcoinist', url: 'https://bitcoinist.com/feed/', category: 'bitcoin' },
	bitcoinops: { name: 'Bitcoin Optech', url: 'https://bitcoinops.org/feed.xml', category: 'bitcoin' },
	stackernews: { name: 'Stacker News', url: 'https://stacker.news/rss', category: 'bitcoin' },

	// ── Ethereum ─────────────────────────────────────────────────────────────
	ef_blog: { name: 'Ethereum Foundation', url: 'https://blog.ethereum.org/feed.xml', category: 'ethereum' },

	// ── Solana ───────────────────────────────────────────────────────────────
	solana_news: { name: 'Solana News', url: 'https://solana.com/news/rss.xml', category: 'solana' },

	// ── DeFi / NFT ───────────────────────────────────────────────────────────
	defiant: { name: 'The Defiant', url: 'https://thedefiant.io/feed', category: 'defi' },
	defirate: { name: 'DeFi Rate', url: 'https://defirate.com/feed/', category: 'defi' },
	nftevening: { name: 'NFTevening', url: 'https://nftevening.com/feed/', category: 'nft' },

	// ── Trading / research / on-chain ────────────────────────────────────────
	beincrypto: { name: 'BeInCrypto', url: 'https://beincrypto.com/feed/', category: 'trading' },
	u_today: { name: 'U.Today', url: 'https://u.today/rss', category: 'trading' },
	glassnode: { name: 'Glassnode Insights', url: 'https://insights.glassnode.com/rss/', category: 'research' },
	cryptobriefing: { name: 'Crypto Briefing', url: 'https://cryptobriefing.com/feed/', category: 'research' },
	intotheblock: { name: 'IntoTheBlock', url: 'https://medium.com/feed/intotheblock', category: 'onchain' },
	hashrateindex: { name: 'Hashrate Index', url: 'https://hashrateindex.com/blog/feed/', category: 'onchain' },

	// ── Institutional / mainstream ───────────────────────────────────────────
	kraken_blog: { name: 'Kraken Blog', url: 'https://blog.kraken.com/feed/', category: 'institutional' },
	bitfinex_blog: { name: 'Bitfinex Blog', url: 'https://blog.bitfinex.com/feed/', category: 'institutional' },
	cnbc_crypto: { name: 'CNBC Crypto', url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', category: 'mainstream' },
	techcrunch_crypto: { name: 'TechCrunch Crypto', url: 'https://techcrunch.com/category/cryptocurrency/feed/', category: 'mainstream' },

	// ── Asia ─────────────────────────────────────────────────────────────────
	forkast: { name: 'Forkast News', url: 'https://forkast.news/feed/', category: 'asia' },
	coinpost_en: { name: 'CoinPost', url: 'https://coinpost.jp/?feed=rss2', category: 'asia' },

	// ── Regulation / policy ──────────────────────────────────────────────────
	sec_press: { name: 'SEC Press Releases', url: 'https://www.sec.gov/news/pressreleases.rss', category: 'regulation' },
	coincenter: { name: 'Coin Center', url: 'https://www.coincenter.org/feed/', category: 'regulation' },

	// ── Independent journalism ───────────────────────────────────────────────
	protos: { name: 'Protos', url: 'https://protos.com/feed/', category: 'journalism' },
	unchained_crypto: { name: 'Unchained', url: 'https://unchainedcrypto.com/feed/', category: 'journalism' },
};

// Canonical category order for filter UIs. 'all' is implicit.
export const NEWS_CATEGORIES = [
	'general',
	'bitcoin',
	'ethereum',
	'solana',
	'defi',
	'nft',
	'trading',
	'research',
	'onchain',
	'institutional',
	'mainstream',
	'asia',
	'regulation',
	'journalism',
];

export function sourcesForCategory(category) {
	const keys = Object.keys(NEWS_SOURCES);
	if (!category || category === 'all') return keys;
	return keys.filter((k) => NEWS_SOURCES[k].category === category);
}
