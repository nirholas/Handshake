// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'model-check',
	title: 'Model Check',
	category: '3d',
	useCase: 'Model Check — an agent handed a 3D asset URL verifies it before using or paying for it: $0.001 USDC per call returns structural stats (vertex/triangle counts, materials, textures, animations, extensions) and prioritized optimization recommendations.',
	path: '/api/x402/model-check',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'cdp-bazaar',
	serviceName: 'three.ws Model Check',
	tags: ['3d', 'gltf', 'glb', 'inspection', 'validation'],
	description: 'Model Check — an agent handed a 3D asset URL verifies it before using or paying for it: $0.001 USDC per call returns structural stats (vertex/triangle counts, materials, textures, animations, extensions) and prioritized optimization recommendations. Single GET with ?url=…; USDC on Solana, Base, or Arbitrum. Free tier: the same inspection is keyless at /api/3d/inspect.',
	input: {
		url: 'https://three.ws/avatars/mannequin.glb',
	},
	inputSchema: {
		type: 'object',
		required: ['url'],
		properties: {
			url: {
				type: 'string',
				format: 'uri',
				description: 'Public HTTPS URL of a glTF/GLB model.',
			},
		},
	},
	storefronts: ['x402scan'],
};
