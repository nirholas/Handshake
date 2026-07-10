// Crypto-news source registry — 192 live publisher feeds across 27 categories,
// 33 of them international across 17 languages.
//
// Ported from the cryptocurrency.cv aggregator (same team; its Vercel deployment
// is retired, so three.ws runs the aggregation natively). Keys and category
// names match the cryptocurrency.cv registry so archive records (source_key)
// and live records line up.
//
// EVERY feed here was fetched and parsed before being listed. The upstream
// registry carried ~450 feeds and roughly half are no longer real. What was
// dropped, and why:
//
//   * ~150 dead outright — 404/410, dead domains, or a feed URL that now serves
//     an HTML page. Size is no signal: several returned 700 KB of markup.
//   * substack.com and mirror.xyz (28 feeds) — behind a Cloudflare bot
//     challenge, so every one answers 403 to a server-side fetch.
//   * medium.com (43 feeds) — answers 429 to datacenter egress regardless of
//     pacing. They look live in a browser, which is the trap.
//
// A feed that only rate-limited us is not the same as a dead one, so those were
// re-probed slowly before any verdict. Regenerate and re-validate with
// scripts/news-sources-probe.mjs, which exits non-zero when a source has died.
//
// Fields: name, url, category. Optional: kind ('json' — shaped by an adapter in
// news.js rather than parsed as a feed), tier + credibility (upstream editorial
// tiering, drives refresh priority), language + region (international feeds).

export const NEWS_SOURCES = {
	// ── General newsrooms (66) ───────────────────────────────────────────────
	altcoinbuzz: { name: 'AltcoinBuzz', url: 'https://www.altcoinbuzz.io/feed/', category: 'general' },
	ambcrypto: { name: 'AMBCrypto', url: 'https://ambcrypto.com/feed/', category: 'general' },
	beincryptoes: { name: 'BeInCrypto Español', url: 'https://es.beincrypto.com/feed/', category: 'general', language: 'es', region: 'latam' },
	beincryptopr: { name: 'BeInCrypto Brasil', url: 'https://br.beincrypto.com/feed/', category: 'general', language: 'pt', region: 'latam' },
	bitcoinaddictth: { name: 'Bitcoin Addict Thailand', url: 'https://bitcoinaddict.org/feed/', category: 'general', language: 'th', region: 'asia' },
	bits_media: { name: 'Bits.Media', url: 'https://bits.media/rss2/', category: 'general', language: 'ru', region: 'europe' },
	blockchainmedia: { name: 'Blockchain Media', url: 'https://blockchainmedia.id/feed/', category: 'general', language: 'id', region: 'asia' },
	blockmedia: { name: 'Block Media', url: 'https://www.blockmedia.co.kr/feed/', category: 'general', language: 'ko', region: 'asia' },
	blocktempo: { name: 'BlockTempo', url: 'https://www.blocktempo.com/feed/', category: 'general', tier: 'tier3', credibility: 0.75 },
	blockworks: { name: 'Blockworks', url: 'https://blockworks.co/feed', category: 'general', tier: 'tier2', credibility: 0.9 },
	blokt: { name: 'Blokt', url: 'https://blokt.com/feed', category: 'general' },
	btcecho: { name: 'BTC-ECHO', url: 'https://www.btc-echo.de/feed/', category: 'general', language: 'de', region: 'europe' },
	btcnewsjp: { name: 'btcnews.jp', url: 'https://bitbank.cc/knowledge/feed', category: 'general', language: 'ja', region: 'asia' },
	coin68: { name: 'Coin68', url: 'https://coin68.com/rss/trang-chu.rss', category: 'general', language: 'vi', region: 'asia' },
	coincentral_news: { name: 'CoinCentral', url: 'https://coincentral.com/news/feed/', category: 'general' },
	coincu: { name: 'Coincu', url: 'https://coincu.com/feed/', category: 'general' },
	coindesk: { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'general', tier: 'tier2', credibility: 0.95 },
	coindeskjapan: { name: 'CoinDesk Japan', url: 'https://www.coindeskjapan.com/feed/', category: 'general', language: 'ja', region: 'asia' },
	coindeskkorea: { name: 'CoinDesk Korea', url: 'https://www.coindeskkorea.com/feed/', category: 'general', language: 'ko', region: 'asia' },
	coindoo: { name: 'Coindoo', url: 'https://coindoo.com/feed/', category: 'general' },
	coinedition: { name: 'Coin Edition', url: 'https://coinedition.com/feed/', category: 'general' },
	coingape: { name: 'CoinGape', url: 'https://coingape.com/feed/', category: 'general' },
	coinidol: { name: 'CoinIdol', url: 'https://coinidol.com/rss2/', category: 'general' },
	coinjournal: { name: 'CoinJournal', url: 'https://coinjournal.net/feed/', category: 'general' },
	coinpaper: { name: 'CoinPaper', url: 'https://coinpaper.com/feed', category: 'general' },
	coinpedia: { name: 'CoinPedia', url: 'https://coinpedia.org/feed/', category: 'general' },
	coinpost: { name: 'CoinPost', url: 'https://coinpost.jp/?feed=rss2', category: 'general', tier: 'tier3', credibility: 0.75, language: 'ja', region: 'asia' },
	coinspeaker: { name: 'Coinspeaker', url: 'https://www.coinspeaker.com/feed/', category: 'general' },
	cointelegraph: { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', category: 'general', tier: 'tier3', credibility: 0.78 },
	criptovaluteit: { name: 'Criptovalute.it', url: 'https://www.criptovalute.it/feed/', category: 'general', language: 'it', region: 'europe' },
	crypto_insiders: { name: 'Crypto Insiders', url: 'https://www.crypto-insiders.nl/feed/', category: 'general', language: 'nl', region: 'europe' },
	crypto_times_jp: { name: 'Crypto Times Japan', url: 'https://crypto-times.jp/feed/', category: 'general', language: 'ja', region: 'asia' },
	cryptoast: { name: 'Cryptoast', url: 'https://cryptoast.fr/feed/', category: 'general', language: 'fr', region: 'europe' },
	cryptodaily: { name: 'CryptoDaily', url: 'https://cryptodaily.co.uk/feed', category: 'general' },
	cryptomonday: { name: 'CryptoMonday', url: 'https://cryptomonday.de/feed/', category: 'general', language: 'de', region: 'europe' },
	cryptonewsflash: { name: 'Crypto-News Flash', url: 'https://www.crypto-news-flash.com/feed/', category: 'general' },
	cryptonewsindia: { name: 'Crypto News India', url: 'https://cryptonewsindia.com/feed/', category: 'general', language: 'hi', region: 'asia' },
	cryptonewsz: { name: 'CryptoNewsZ', url: 'https://www.cryptonewsz.com/feed/', category: 'general' },
	cryptoninjas: { name: 'CryptoNinjas', url: 'https://www.cryptoninjas.net/feed/', category: 'general' },
	cryptonomist: { name: 'The Cryptonomist', url: 'https://it.cryptonomist.ch/feed/', category: 'general', language: 'it', region: 'europe' },
	cryptopolitan: { name: 'Cryptopolitan', url: 'https://www.cryptopolitan.com/feed/', category: 'general', tier: 'tier3', credibility: 0.68 },
	cryptoslate: { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', category: 'general', tier: 'tier3', credibility: 0.75 },
	cryptotvplus: { name: 'CryptoTvPlus', url: 'https://cryptotvplus.com/feed/', category: 'general' },
	dailyhodl: { name: 'The Daily Hodl', url: 'https://dailyhodl.com/feed/', category: 'general', tier: 'tier3', credibility: 0.72 },
	decrypt: { name: 'Decrypt', url: 'https://decrypt.co/feed', category: 'general', tier: 'tier2', credibility: 0.88 },
	diariobitcoin: { name: 'Diario Bitcoin', url: 'https://www.diariobitcoin.com/feed/', category: 'general', language: 'es', region: 'latam' },
	finance_magnates_crypto: { name: 'Finance Magnates Crypto', url: 'https://www.financemagnates.com/cryptocurrency/feed/', category: 'general' },
	forklog: { name: 'ForkLog', url: 'https://forklog.com/feed/', category: 'general', language: 'ru', region: 'europe' },
	journalducoin: { name: 'Journal du Coin', url: 'https://journalducoin.com/feed/', category: 'general', language: 'fr', region: 'europe' },
	koinmedya: { name: 'Koin Medya', url: 'https://koinmedya.com/feed/', category: 'general', language: 'tr', region: 'europe' },
	livecoins: { name: 'Livecoins', url: 'https://livecoins.com.br/feed/', category: 'general', language: 'pt', region: 'latam' },
	mihanblockchain: { name: 'Mihan Blockchain (میهن بلاکچین)', url: 'https://mihanblockchain.com/feed/', category: 'general', language: 'fa', region: 'mena' },
	newsbtc: { name: 'NewsBTC', url: 'https://www.newsbtc.com/feed/', category: 'general', tier: 'tier3', credibility: 0.7 },
	nulltx: { name: 'NullTX', url: 'https://nulltx.com/feed/', category: 'general' },
	panewslab: { name: 'PANews (PA财经)', url: 'https://www.panewslab.com/rss.xml?lang=zh&type=NEWS', category: 'general', language: 'zh', region: 'asia' },
	portaldobitcoin: { name: 'Portal do Bitcoin', url: 'https://portaldobitcoin.uol.com.br/feed/', category: 'general', language: 'pt', region: 'latam' },
	ramzarz: { name: 'Ramz Arz (رمزارز)', url: 'https://ramzarz.news/feed/', category: 'general', language: 'fa', region: 'mena' },
	siamblockchain: { name: 'Siam Blockchain', url: 'https://siamblockchain.com/feed/', category: 'general', language: 'th', region: 'asia' },
	theblock: { name: 'The Block', url: 'https://www.theblock.co/rss.xml', category: 'general', tier: 'tier2', credibility: 0.93 },
	thecryptobasic: { name: 'TheCryptoBasic', url: 'https://thecryptobasic.com/feed/', category: 'general' },
	thenewscrypto: { name: 'TheNewsCrypto', url: 'https://thenewscrypto.com/feed/', category: 'general' },
	tokenpost: { name: 'TokenPost', url: 'https://www.tokenpost.kr/rss', category: 'general', language: 'ko', region: 'asia' },
	usethebitcoin: { name: 'UseTheBitcoin', url: 'https://usethebitcoin.com/feed/', category: 'general' },
	watcherguru: { name: 'Watcher.Guru', url: 'https://watcher.guru/news/feed', category: 'general', tier: 'tier3', credibility: 0.68 },
	zebpay: { name: 'ZebPay Blog', url: 'https://zebpay.com/blog/feed/', category: 'general', language: 'hi', region: 'asia' },
	zycrypto: { name: 'ZyCrypto', url: 'https://zycrypto.com/feed/', category: 'general' },

	// ── Bitcoin (11) ─────────────────────────────────────────────────────────
	bitcoinblock: { name: 'Bitcoin Block', url: 'https://bitcoinblock.com.br/feed/', category: 'bitcoin', language: 'pt', region: 'latam' },
	bitcoincom: { name: 'Bitcoin.com News', url: 'https://news.bitcoin.com/feed/', category: 'bitcoin' },
	bitcoinist: { name: 'Bitcoinist', url: 'https://bitcoinist.com/feed/', category: 'bitcoin', tier: 'tier3', credibility: 0.72 },
	bitcoinmagazine: { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/', category: 'bitcoin', tier: 'tier3', credibility: 0.82 },
	bitcoinops: { name: 'Bitcoin Optech', url: 'https://bitcoinops.org/feed.xml', category: 'bitcoin' },
	blockstream_blog: { name: 'Blockstream Blog', url: 'https://blog.blockstream.com/feed/', category: 'bitcoin' },
	btctimes: { name: 'BTC Times', url: 'https://www.btctimes.com/feed.xml', category: 'bitcoin' },
	casa_blog: { name: 'Casa Blog', url: 'https://blog.keys.casa/rss/', category: 'bitcoin' },
	livebitcoinnews: { name: 'Live Bitcoin News', url: 'https://www.livebitcoinnews.com/feed/', category: 'bitcoin' },
	stackernews: { name: 'Stacker News', url: 'https://stacker.news/rss', category: 'bitcoin' },

	// ── Ethereum (5) ─────────────────────────────────────────────────────────
	ef_blog: { name: 'Ethereum Foundation', url: 'https://blog.ethereum.org/feed.xml', category: 'ethereum' },
	ens_blog: { name: 'ENS Blog', url: 'https://ens.domains/blog/rss.xml', category: 'ethereum' },
	lido_dao_blog: { name: 'Lido DAO Governance', url: 'https://research.lido.fi/latest.rss', category: 'ethereum' },

	// ── Layer 2 (3) ──────────────────────────────────────────────────────────
	altlayer_blog: { name: 'AltLayer Blog', url: 'https://blog.altlayer.io/feed', category: 'layer2' },

	// ── Solana (7) ───────────────────────────────────────────────────────────
	solana_news: { name: 'Solana News', url: 'https://solana.com/news/rss.xml', category: 'solana' },
	solanafloor: { name: 'SolanaFloor', url: 'https://solanafloor.com/feed.xml', category: 'solana' },

	// ── Alt L1 (13) ──────────────────────────────────────────────────────────
	avail_blog: { name: 'Avail Blog', url: 'https://blog.availproject.org/rss/', category: 'altl1' },
	celestia_blog: { name: 'Celestia Blog', url: 'https://blog.celestia.org/rss/', category: 'altl1' },
	hedera: { name: 'Hedera', url: 'https://hedera.com/feed/', category: 'altl1' },
	neonewstoday: { name: 'NEO News Today', url: 'https://neonewstoday.com/feed/', category: 'altl1' },
	sei_blog: { name: 'Sei Blog', url: 'https://blog.sei.io/rss/', category: 'altl1' },
	sui_blog: { name: 'Sui Blog', url: 'https://blog.sui.io/feed/', category: 'altl1' },

	// ── DeFi (18) ────────────────────────────────────────────────────────────
	bankless: { name: 'Bankless', url: 'https://www.bankless.com/rss/feed', category: 'defi', tier: 'tier3', credibility: 0.78 },
	curve_blog: { name: 'Curve Blog', url: 'https://news.curve.fi/rss/', category: 'defi' },
	defiant: { name: 'The Defiant', url: 'https://thedefiant.io/feed', category: 'defi', tier: 'tier2', credibility: 0.87 },
	defirate: { name: 'DeFi Rate', url: 'https://defirate.com/feed/', category: 'defi' },
	eigenlayer_blog: { name: 'EigenLayer Blog', url: 'https://www.blog.eigenlayer.xyz/rss/', category: 'defi' },
	lido_blog: { name: 'Lido Blog', url: 'https://blog.lido.fi/rss/', category: 'defi' },
	synthetix_blog: { name: 'Synthetix Blog', url: 'https://blog.synthetix.io/rss/', category: 'defi' },
	tally_blog: { name: 'Tally Blog', url: 'https://blog.tally.xyz/feed', category: 'defi' },
	yearn_blog: { name: 'Yearn Finance Blog', url: 'https://blog.yearn.fi/feed', category: 'defi' },

	// ── NFT (3) ──────────────────────────────────────────────────────────────
	nftevening: { name: 'NFTevening', url: 'https://nftevening.com/feed/', category: 'nft' },

	// ── Gaming (3) ───────────────────────────────────────────────────────────
	chiliz: { name: 'Chiliz', url: 'https://www.chiliz.com/feed/', category: 'gaming' },
	gala_blog: { name: 'Gala Games Blog', url: 'https://blog.gala.games/feed', category: 'gaming' },

	// ── Trading (7) ──────────────────────────────────────────────────────────
	beincrypto: { name: 'BeInCrypto', url: 'https://beincrypto.com/feed/', category: 'trading', tier: 'tier3', credibility: 0.7 },
	coinalyze_blog: { name: 'Coinalyze Blog', url: 'https://coinalyze.net/blog/feed/', category: 'trading' },
	comparic: { name: 'Comparic', url: 'https://comparic.pl/feed/', category: 'trading', language: 'pl', region: 'europe' },
	finbold: { name: 'Finbold', url: 'https://finbold.com/feed/', category: 'trading' },
	fxstreet_crypto: { name: 'FXStreet Crypto', url: 'https://www.fxstreet.com/rss', category: 'trading' },
	tradingview_crypto: { name: 'TradingView Crypto Ideas', url: 'https://www.tradingview.com/feed/?sort=recent&stream=crypto', category: 'trading' },
	u_today: { name: 'U.Today', url: 'https://u.today/rss', category: 'trading', tier: 'tier3', credibility: 0.7 },

	// ── Derivatives (5) ──────────────────────────────────────────────────────
	amberdata_blog: { name: 'Amberdata Blog', url: 'https://blog.amberdata.io/rss.xml', category: 'derivatives' },
	deribit_insights: { name: 'Deribit Insights', url: 'https://insights.deribit.com/feed/', category: 'derivatives' },
	paradigm_trading: { name: 'Paradigm (Trading)', url: 'https://www.paradigm.co/blog/rss.xml', category: 'derivatives' },

	// ── Research (2) ─────────────────────────────────────────────────────────
	cryptobriefing: { name: 'Crypto Briefing', url: 'https://cryptobriefing.com/feed/', category: 'research' },
	glassnode: { name: 'Glassnode Insights', url: 'https://insights.glassnode.com/rss/', category: 'research' },

	// ── On-chain analytics (3) ───────────────────────────────────────────────
	dune_blog: { name: 'Dune Analytics Blog', url: 'https://dune.com/blog/feed', category: 'onchain' },
	woobull: { name: 'Willy Woo (Woobull)', url: 'https://woobull.com/feed/', category: 'onchain' },

	// ── Quant (1) ────────────────────────────────────────────────────────────
	alpha_architect: { name: 'Alpha Architect', url: 'https://alphaarchitect.com/feed/', category: 'quant' },

	// ── Institutional (7) ────────────────────────────────────────────────────
	binance_announcements: { name: 'Binance Announcements', url: 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20&catalogId=48', category: 'institutional', kind: 'json' },
	bitfinex_blog: { name: 'Bitfinex Blog', url: 'https://blog.bitfinex.com/feed/', category: 'institutional' },
	fireblocks_blog: { name: 'Fireblocks Blog', url: 'https://www.fireblocks.com/blog/feed/', category: 'institutional' },
	kraken_blog: { name: 'Kraken Blog', url: 'https://blog.kraken.com/feed/', category: 'institutional' },
	placeholder_vc: { name: 'Placeholder VC', url: 'https://www.placeholder.vc/blog?format=rss', category: 'institutional' },

	// ── TradFi (1) ───────────────────────────────────────────────────────────

	// ── ETF / asset managers (2) ─────────────────────────────────────────────
	ark_invest: { name: 'ARK Invest', url: 'https://www.ark-invest.com/feed', category: 'etf' },
	coinshares_research: { name: 'CoinShares Research', url: 'https://blog.coinshares.com/feed', category: 'etf' },

	// ── Stablecoins (1) ──────────────────────────────────────────────────────
	makerdao_gov: { name: 'MakerDAO Governance', url: 'https://forum.makerdao.com/latest.rss', category: 'stablecoin' },

	// ── Fintech (2) ──────────────────────────────────────────────────────────
	paypal_newsroom: { name: 'PayPal Newsroom', url: 'https://newsroom.paypal-corp.com/news?pagetemplate=rss', category: 'fintech' },
	stripe_crypto: { name: 'Stripe Blog (Crypto)', url: 'https://stripe.com/blog/feed.rss', category: 'fintech' },

	// ── Mainstream media (18) ────────────────────────────────────────────────
	axios_crypto: { name: 'Axios Crypto', url: 'https://api.axios.com/feed/', category: 'mainstream', tier: 'tier1', credibility: 0.91 },
	bbc_business: { name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'mainstream', tier: 'tier1', credibility: 0.96 },
	benzinga_crypto: { name: 'Benzinga Crypto', url: 'https://www.benzinga.com/feed', category: 'mainstream', tier: 'tier3', credibility: 0.78 },
	business_insider_markets: { name: 'Business Insider Markets', url: 'https://feeds.businessinsider.com/custom/all', category: 'mainstream' },
	cnbc_crypto: { name: 'CNBC Crypto', url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', category: 'mainstream' },
	economic_times_india: { name: 'Economic Times India Markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', category: 'mainstream' },
	fortune_crypto: { name: 'Fortune Crypto', url: 'https://fortune.com/feed/fortune-feeds/?id=3230629', category: 'mainstream', tier: 'tier1', credibility: 0.92 },
	ft_crypto: { name: 'Financial Times Crypto', url: 'https://www.ft.com/cryptocurrencies?format=rss', category: 'mainstream' },
	guardian_tech: { name: 'The Guardian Tech', url: 'https://www.theguardian.com/technology/rss', category: 'mainstream', tier: 'tier1', credibility: 0.95 },
	marketwatch: { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/', category: 'mainstream' },
	nikkei_asia: { name: 'Nikkei Asia', url: 'https://asia.nikkei.com/rss/feed/nar', category: 'mainstream' },
	nyt_business: { name: 'New York Times Business', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', category: 'mainstream' },
	seekingalpha: { name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml', category: 'mainstream' },
	techcrunch_crypto: { name: 'TechCrunch Crypto', url: 'https://techcrunch.com/category/cryptocurrency/feed/', category: 'mainstream' },
	tokenist: { name: 'The Tokenist', url: 'https://tokenist.com/feed/', category: 'mainstream' },
	wsj_business: { name: 'Wall Street Journal', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', category: 'mainstream' },
	wsj_crypto: { name: 'Wall Street Journal Crypto', url: 'https://feeds.a.dj.com/rss/RSSWSJD.xml', category: 'mainstream' },
	yahoo_crypto: { name: 'Yahoo Finance Crypto', url: 'https://finance.yahoo.com/rss/cryptocurrency', category: 'mainstream' },

	// ── Geopolitics (12) ─────────────────────────────────────────────────────
	al_jazeera: { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'geopolitical' },
	atlantic_council_crypto: { name: 'Atlantic Council Crypto', url: 'https://www.atlanticcouncil.org/category/programs/geoeconomics-center/digital-currencies/feed/', category: 'geopolitical' },
	bbc_world: { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'geopolitical' },
	cftc_press: { name: 'CFTC Press Releases', url: 'https://www.cftc.gov/rss.xml', category: 'geopolitical' },
	coincenter: { name: 'Coin Center', url: 'https://www.coincenter.org/feed/', category: 'geopolitical' },
	dw_news: { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all', category: 'geopolitical' },
	eba_news: { name: 'EBA News (EU Banking)', url: 'https://www.eba.europa.eu/rss.xml', category: 'geopolitical' },
	federal_reserve: { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'geopolitical' },
	rba_speeches: { name: 'RBA Speeches (Australia)', url: 'https://www.rba.gov.au/rss/rss-cb-speeches.xml', category: 'geopolitical' },
	sec_press: { name: 'SEC Press Releases', url: 'https://www.sec.gov/news/pressreleases.rss', category: 'geopolitical' },
	treasury_press: { name: 'US Treasury Press', url: 'https://home.treasury.gov/rss.xml', category: 'geopolitical' },
	uk_fca_crypto: { name: 'UK FCA Crypto', url: 'https://www.fca.org.uk/news/rss.xml', category: 'geopolitical' },

	// ── Security (9) ─────────────────────────────────────────────────────────
	chainalysis_blog: { name: 'Chainalysis Blog', url: 'https://www.chainalysis.com/blog/feed/', category: 'security' },
	elliptic_blog: { name: 'Elliptic Blog', url: 'https://www.elliptic.co/blog/rss.xml', category: 'security' },
	openzeppelin_blog: { name: 'OpenZeppelin Blog', url: 'https://www.openzeppelin.com/news/rss.xml', category: 'security' },
	samczsun: { name: 'samczsun Blog', url: 'https://samczsun.com/rss/', category: 'security' },
	trailofbits: { name: 'Trail of Bits Blog', url: 'https://blog.trailofbits.com/feed/', category: 'security' },
	trezor_blog: { name: 'Trezor Blog', url: 'https://blog.trezor.io/feed', category: 'security' },
	zcash_blog: { name: 'Zcash Blog', url: 'https://electriccoin.co/blog/feed/', category: 'security' },

	// ── Developer (5) ────────────────────────────────────────────────────────
	particle_network_blog: { name: 'Particle Network Blog', url: 'https://blog.particle.network/rss/', category: 'developer' },

	// ── DePIN (2) ────────────────────────────────────────────────────────────
	hivemapper_blog: { name: 'Hivemapper Blog', url: 'https://blog.hivemapper.com/feed', category: 'depin' },
	iotex_blog: { name: 'IoTeX Blog', url: 'https://iotex.io/blog/feed', category: 'depin' },

	// ── AI x crypto (2) ──────────────────────────────────────────────────────

	// ── Mining (2) ───────────────────────────────────────────────────────────
	bitcoinmining: { name: 'Bitcoin Mining News', url: 'https://bitcoinmagazine.com/tags/mining/.rss/full/', category: 'mining' },
	hashrateindex: { name: 'Hashrate Index', url: 'https://hashrateindex.com/blog/feed/', category: 'mining' },

	// ── Macro (9) ────────────────────────────────────────────────────────────
	alhambra_partners: { name: 'Alhambra Partners', url: 'https://www.alhambrapartners.com/feed/', category: 'macro' },
	bis_speeches: { name: 'BIS Speeches', url: 'https://www.bis.org/doclist/cbspeeches.rss', category: 'macro' },
	boe_speeches: { name: 'Bank of England Speeches', url: 'https://www.bankofengland.co.uk/rss/speeches', category: 'macro' },
	ecb_press: { name: 'ECB Press Releases', url: 'https://www.ecb.europa.eu/rss/press.html', category: 'macro' },
	federal_reserve_notes: { name: 'Federal Reserve FEDS Notes', url: 'https://www.federalreserve.gov/feeds/feds_notes.xml', category: 'macro' },
	fred_blog: { name: 'FRED Blog (St. Louis Fed)', url: 'https://fredblog.stlouisfed.org/feed/', category: 'macro' },
	lyn_alden: { name: 'Lyn Alden', url: 'https://www.lynalden.com/feed/', category: 'macro' },
	wolf_street: { name: 'Wolf Street', url: 'https://wolfstreet.com/feed/', category: 'macro' },
	zerohedge: { name: 'ZeroHedge', url: 'https://cms.zerohedge.com/fullrss2.xml', category: 'macro' },

	// ── Independent journalism (13) ──────────────────────────────────────────
	benjamin_cowen_yt: { name: 'Benjamin Cowen', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCRvqjQPSeaWn-uEx-w0XOIg', category: 'journalism' },
	coffeezilla_pod: { name: 'Coffeezilla', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCFQMnBA3CS502aghlcr0_aw', category: 'journalism' },
	coin_bureau_yt: { name: 'Coin Bureau', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCqK_GSMbpiV8spgD3ZGloSw', category: 'journalism' },
	cryptoweekly: { name: 'Crypto Weekly', url: 'https://cryptoweekly.co/feed/', category: 'journalism' },
	defiprime: { name: 'DeFi Prime', url: 'https://defiprime.com/feed.xml', category: 'journalism' },
	metaversal: { name: 'Metaversal', url: 'https://metaversal.banklesshq.com/feed', category: 'journalism' },
	molly_white: { name: 'Molly White Blog', url: 'https://www.citationneeded.news/rss/', category: 'journalism', tier: 'tier2', credibility: 0.86 },
	protos: { name: 'Protos', url: 'https://protos.com/feed/', category: 'journalism', tier: 'tier3', credibility: 0.75 },
	raoul_pal_yt: { name: 'Raoul Pal (Real Vision)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCBH5VZE_Y4F3CMcPIzPEB5A', category: 'journalism' },
	trustnodes: { name: 'Trustnodes', url: 'https://www.trustnodes.com/feed/', category: 'journalism' },
	unchained_crypto: { name: 'Unchained Crypto', url: 'https://unchainedcrypto.com/feed/', category: 'journalism' },
	unchained_podcast: { name: 'Unchained Podcast', url: 'https://feeds.simplecast.com/JGE3yC0V', category: 'journalism' },
	web3isgoinggreat: { name: 'Web3 Is Going Just Great', url: 'https://www.web3isgoinggreat.com/feed.xml', category: 'journalism' },

	// ── Asia (3) ─────────────────────────────────────────────────────────────
	bitpinas: { name: 'BitPinas', url: 'https://bitpinas.com/feed/', category: 'asia' },
	blockhead_tech: { name: 'Blockhead', url: 'https://www.blockhead.co/latest/rss/', category: 'asia' },
	forkast: { name: 'Forkast News', url: 'https://forkast.news/feed/', category: 'asia' },
};

// Canonical category order for filter UIs. 'all' is implicit.
export const NEWS_CATEGORIES = [
	'general',
	'bitcoin',
	'ethereum',
	'layer2',
	'solana',
	'altl1',
	'defi',
	'nft',
	'gaming',
	'trading',
	'derivatives',
	'research',
	'onchain',
	'quant',
	'institutional',
	'etf',
	'stablecoin',
	'fintech',
	'mainstream',
	'geopolitical',
	'security',
	'developer',
	'depin',
	'mining',
	'macro',
	'journalism',
	'asia',
];

// Languages present in the registry (ISO 639-1). English feeds carry no
// `language` field; everything else is explicitly tagged.
export const NEWS_LANGUAGES = [
	'de',
	'es',
	'fa',
	'fr',
	'hi',
	'id',
	'it',
	'ja',
	'ko',
	'nl',
	'pl',
	'pt',
	'ru',
	'th',
	'tr',
	'vi',
	'zh',
];

export function sourcesForCategory(category) {
	const keys = Object.keys(NEWS_SOURCES);
	if (!category || category === 'all') return keys;
	return keys.filter((k) => NEWS_SOURCES[k].category === category);
}

/** Every source publishing in `lang`; 'en' means the untagged English feeds. */
export function sourcesForLanguage(lang) {
	const keys = Object.keys(NEWS_SOURCES);
	if (!lang || lang === 'all') return keys;
	if (lang === 'en') return keys.filter((k) => !NEWS_SOURCES[k].language);
	return keys.filter((k) => NEWS_SOURCES[k].language === lang);
}

// Refresh ordering for the aggregator's bounded worker pool (api/_lib/news.js):
// lower = refreshed first, so a deadline-truncated cold start still returns the
// highest-credibility outlets. Derived from the upstream editorial tier, which
// is why tier metadata lives on the source entries above.
const TIER_RANK = { tier1: 0, research: 1, tier2: 1, tier3: 2, fintech: 2, tier4: 3 };

export function sourcePriority(key) {
	const tier = NEWS_SOURCES[key]?.tier;
	if (tier && TIER_RANK[tier] !== undefined) return TIER_RANK[tier];
	// Untiered: English long-tail before international, which is niche by design.
	return NEWS_SOURCES[key]?.language ? 4 : 3;
}
