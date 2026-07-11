// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'market-mood',
	title: 'Market Mood Index',
	category: 'market-data',
	useCase: 'three.ws Market Mood Index — $0.002 USDC per call blends the Fear & Greed index with live sentiment scored across 192 crypto news feeds into one 0–100 mood reading with the headlines driving it.',
	path: '/api/x402/market-mood',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '2000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Market Mood',
	tags: ['sentiment', 'fear-greed', 'news', 'market-data'],
	description: 'three.ws Market Mood Index — pay $0.002 USDC per call for a composite market-mood reading no single index gives you. Blends the Crypto Fear & Greed index (with its 24 h delta) with live lexicon sentiment scored across the newest headlines from 192 crypto publisher feeds into one 0–100 mood score and label, and returns both components so you can see when positioning (Fear & Greed) and narrative (news tone) disagree — the divergence signal. Includes the bullish and bearish headlines currently driving the news component, with links. Both components must be live or the call refuses before settlement.',
	input: {},
	inputSchema: {
		type: 'object',
		properties: {},
	},
	outputExample: {
		mood: 62,
		label: 'Greed',
		divergence: 'aligned',
		components: {
			fear_greed: { value: 66, label: 'Greed', change_24h: 3 },
			news: { score: 0.18, label: 'positive', articles_scored: 120, positive: 41, negative: 22, neutral: 57 },
		},
		drivers: {
			bullish: [{ title: 'Example bullish headline', source: 'Example Source', link: 'https://example.com/a' }],
			bearish: [{ title: 'Example bearish headline', source: 'Example Source', link: 'https://example.com/b' }],
		},
		ts: '2026-07-11T10:00:00Z',
	},
	storefronts: ['x402scan'],
};
