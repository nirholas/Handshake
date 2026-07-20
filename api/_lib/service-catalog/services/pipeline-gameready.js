// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'pipeline-gameready',
	title: 'Pipeline - Game-Ready',
	category: '3d',
	useCase: '3D Asset Pipeline — Game-Ready: pay $0.03 USDC to make a GLB engine-ready.',
	path: '/api/x402/pipeline-gameready',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '30000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Pipeline - Game-Ready',
	tags: ['3d', 'gameready', 'retopology', 'glb', 'pipeline'],
	description: '3D Asset Pipeline — Game-Ready: pay $0.03 USDC to make a GLB engine-ready. The mesh is retopologized to a fixed polygon budget (quad QuadriFlow or silhouette-preserving low-poly) with PBR re-baked onto the new topology. POST a public glb_url + poly_budget; get back a durable first-party GLB URL.',
	input: {
		glb_url: 'https://three.ws/avatars/mannequin.glb',
		topology: 'quad',
		poly_budget: 12000,
	},
	inputSchema: {
		type: 'object',
		required: ['glb_url'],
		properties: {
			glb_url: {
				type: 'string',
				format: 'uri',
				description: 'Public HTTPS URL of the source .glb mesh.',
			},
			topology: {
				type: 'string',
				enum: ['quad', 'tri'],
				default: 'quad',
			},
			poly_budget: {
				type: 'integer',
				minimum: 1000,
				maximum: 500000,
				default: 15000,
			},
			texture_size: {
				type: 'integer',
				enum: [1024, 2048],
				default: 1024,
			},
		},
	},
	storefronts: ['x402scan'],
};
