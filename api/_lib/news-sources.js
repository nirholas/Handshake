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

	// ── Bitcoin ──────────────────────────────────────────────────────────────
	bitcoinmagazine: { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/', category: 'bitcoin' },
	bitcoinist: { name: 'Bitcoinist', url: 'https://bitcoinist.com/feed/', category: 'bitcoin' },

	// ── Ethereum + L2 ────────────────────────────────────────────────────────
	daily_gwei: { name: 'The Daily Gwei', url: 'https://thedailygwei.substack.com/feed', category: 'ethereum' },
	optimism_blog: { name: 'Optimism', url: 'https://optimism.mirror.xyz/feed/atom', category: 'layer2' },
	arbitrum_blog: { name: 'Arbitrum', url: 'https://arbitrum.io/blog/rss.xml', category: 'layer2' },
	base_blog: { name: 'Base', url: 'https://base.mirror.xyz/feed/atom', category: 'layer2' },

	// ── Solana ───────────────────────────────────────────────────────────────
	solana_news: { name: 'Solana News', url: 'https://solana.com/news/rss.xml', category: 'solana' },

	// ── DeFi / NFT ───────────────────────────────────────────────────────────
	defiant: { name: 'The Defiant', url: 'https://thedefiant.io/feed', category: 'defi' },
	nftnow: { name: 'NFT Now', url: 'https://nftnow.com/feed/', category: 'nft' },

	// ── Trading / research / on-chain ────────────────────────────────────────
	beincrypto: { name: 'BeInCrypto', url: 'https://beincrypto.com/feed/', category: 'trading' },
	u_today: { name: 'U.Today', url: 'https://u.today/rss', category: 'trading' },
	messari: { name: 'Messari', url: 'https://messari.io/rss', category: 'research' },
	glassnode: { name: 'Glassnode Insights', url: 'https://insights.glassnode.com/rss/', category: 'research' },
	cryptobriefing: { name: 'Crypto Briefing', url: 'https://cryptobriefing.com/feed/', category: 'research' },
	intotheblock: { name: 'IntoTheBlock', url: 'https://medium.com/feed/intotheblock', category: 'onchain' },
	coin_metrics: { name: 'Coin Metrics', url: 'https://coinmetrics.substack.com/feed', category: 'onchain' },

	// ── Institutional / mainstream ───────────────────────────────────────────
	coinbase_blog: { name: 'Coinbase Blog', url: 'https://www.coinbase.com/blog/rss.xml', category: 'institutional' },
	binance_blog: { name: 'Binance Blog', url: 'https://www.binance.com/en/blog/rss.xml', category: 'institutional' },
	kraken_blog: { name: 'Kraken Blog', url: 'https://blog.kraken.com/feed/', category: 'institutional' },
	cnbc_crypto: { name: 'CNBC Crypto', url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', category: 'mainstream' },
	techcrunch_crypto: { name: 'TechCrunch Crypto', url: 'https://techcrunch.com/category/cryptocurrency/feed/', category: 'mainstream' },

	// ── Asia ─────────────────────────────────────────────────────────────────
	wu_blockchain: { name: 'Wu Blockchain', url: 'https://wublock.substack.com/feed', category: 'asia' },
	forkast: { name: 'Forkast News', url: 'https://forkast.news/feed/', category: 'asia' },

	// ── Regulation / policy ──────────────────────────────────────────────────
	sec_press: { name: 'SEC Press Releases', url: 'https://www.sec.gov/news/pressreleases.rss', category: 'regulation' },
	coincenter: { name: 'Coin Center', url: 'https://www.coincenter.org/feed/', category: 'regulation' },

	// ── Independent journalism ───────────────────────────────────────────────
	protos: { name: 'Protos', url: 'https://protos.com/feed/', category: 'journalism' },
	milkroad: { name: 'Milk Road', url: 'https://www.milkroad.com/feed/', category: 'journalism' },
	unchained_crypto: { name: 'Unchained', url: 'https://unchainedcrypto.com/feed/', category: 'journalism' },
};

// Canonical category order for filter UIs. 'all' is implicit.
export const NEWS_CATEGORIES = [
	'general',
	'bitcoin',
	'ethereum',
	'layer2',
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
