// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'pipeline-rembg',
	title: 'Pipeline - RemBG',
	category: '3d',
	useCase: '3D Asset Pipeline — Background Removal: pay $0.01 USDC to strip the background from an image, returning a transparent PNG — the clean reference view image→3D reconstruction needs so it never bakes a room into the mesh.',
	path: '/api/x402/pipeline-rembg',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '10000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Pipeline - RemBG',
	tags: ['image', 'rembg', 'cutout', 'segmentation', 'pipeline'],
	description: '3D Asset Pipeline — Background Removal: pay $0.01 USDC to strip the background from an image, returning a transparent PNG — the clean reference view image→3D reconstruction needs so it never bakes a room into the mesh. POST a public image_url; get back a durable first-party PNG URL.',
	input: {
		image_url: 'https://three.ws/avatars/thumbs/default.png',
		model: 'rmbg2',
	},
	inputSchema: {
		type: 'object',
		required: ['image_url'],
		properties: {
			image_url: {
				type: 'string',
				format: 'uri',
				description: 'Public HTTPS URL of the source image (PNG, JPEG, WEBP, or GIF).',
			},
			model: {
				type: 'string',
				enum: ['rmbg2', 'u2net', 'isnet', 'u2net_human_seg', 'silueta'],
				default: 'rmbg2',
			},
		},
	},
	storefronts: ['x402scan'],
};
