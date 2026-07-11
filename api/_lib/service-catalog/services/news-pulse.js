// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'news-pulse',
	title: 'Ticker News Pulse',
	category: 'market-data',
	useCase: 'three.ws Ticker News Pulse — $0.002 USDC per call measures live news coverage for one ticker across 192 crypto publisher feeds: mention count, velocity vs the prior window, sentiment split, and top headlines.',
	path: '/api/x402/news-pulse',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '2000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws News Pulse',
	tags: ['news', 'sentiment', 'ticker', 'narrative'],
	description: 'three.ws Ticker News Pulse — pay $0.002 USDC per call to measure how loudly the news cycle is talking about one ticker right now. Scans the live output of 192 crypto publisher feeds (the same engine behind the free three.ws news API) for mentions of your ticker inside a 1–72 h window and returns the mention count, unique outlets covering it, the sentiment split with an aggregate score, coverage velocity versus the immediately preceding window (accelerating / steady / cooling), and the top headlines with links. Zero mentions is a truthful, billable answer — silence is a signal. Feed outages refuse before settlement.',
	input: { ticker: 'THREE', hours: 24 },
	inputSchema: {
		type: 'object',
		required: ['ticker'],
		properties: {
			ticker: { type: 'string', minLength: 2, maxLength: 10, description: 'Ticker symbol to scan for, e.g. BTC. $-prefix optional.' },
			hours: { type: 'integer', minimum: 1, maximum: 72, default: 24, description: 'Look-back window in hours.' },
		},
	},
	outputExample: {
		ticker: 'BTC',
		window_hours: 24,
		mentions: 87,
		unique_sources: 34,
		velocity: { previous_window_mentions: 61, change_pct: 42.6, trend: 'accelerating' },
		sentiment: { score: 0.12, positive: 31, negative: 19, neutral: 37 },
		headlines: [{ title: 'Example headline', source: 'Example Source', link: 'https://example.com/a', pub_date: '2026-07-11T08:12:00Z', sentiment: 'positive' }],
		ts: '2026-07-11T10:00:00Z',
	},
	storefronts: ['x402scan'],
};
