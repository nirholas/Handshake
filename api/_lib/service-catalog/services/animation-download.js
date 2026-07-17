// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'animation-download',
	title: 'Animation Bazaar',
	category: '3d',
	useCase: 'three.ws Animation Bazaar — pay once in USDC to unlock a 3D avatar animation (GLB).',
	path: '/api/x402/animation-download',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '10000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Animation Bazaar',
	tags: ['3d', 'animation', 'glb', 'motion', 'avatar'],
	description: 'three.ws Animation Bazaar — pay once in USDC to unlock a 3D avatar animation (GLB). Each animation has its own price; the response carries a short-lived presigned URL the client fetches directly. Wallets that have already paid can re-download for free by signing in with SIWX.',
	input: {
		id: '00000000-0000-0000-0000-000000000000',
	},
	inputSchema: {
		type: 'object',
		required: ['id'],
		properties: {
			id: {
				type: 'string',
				format: 'uuid',
				description: 'Animation clip UUID from the marketplace animations feed (GET /api/marketplace/animations).',
			},
		},
	},
	storefronts: ['x402scan'],
};
