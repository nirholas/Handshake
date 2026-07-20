// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'pipeline-stylize',
	title: 'Pipeline - Stylize',
	category: '3d',
	useCase: '3D Asset Pipeline — Stylize: pay $0.03 USDC to geometrically restyle a GLB.',
	path: '/api/x402/pipeline-stylize',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '30000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Pipeline - Stylize',
	tags: ['3d', 'stylize', 'voxel', 'glb', 'pipeline'],
	description: '3D Asset Pipeline — Stylize: pay $0.03 USDC to geometrically restyle a GLB. Voxel, brick, Voronoi-shatter, or faceted low-poly filters that rebuild the mesh itself (not a shader), so the look survives export to any engine. POST a public glb_url + style; get back a durable first-party GLB URL.',
	input: {
		glb_url: 'https://three.ws/avatars/mannequin.glb',
		style: 'voxel',
		resolution: 48,
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
			style: {
				type: 'string',
				enum: ['voxel', 'brick', 'voronoi', 'lowpoly'],
				default: 'voxel',
			},
			resolution: {
				type: 'integer',
				description: 'Style density, clamped per filter.',
			},
		},
	},
	storefronts: ['x402scan'],
};
