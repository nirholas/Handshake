// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'embody',
	title: 'Embodiment',
	category: '3d',
	useCase:
		'Give your agent a 3D body — one x402 call returns a rigged, animated, talking avatar plus a one-tag embed for any website. The only embodiment endpoint in the x402 ecosystem.',
	path: '/api/x402/embody',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Embodiment',
	tags: ['3d', 'avatar', 'embed', 'agent', 'embodiment'],
	description:
		'Give your agent a 3D body — one x402 call returns a rigged, animated, talking ' +
		'avatar plus a one-tag embed for any website. The only embodiment endpoint in the ' +
		'x402 ecosystem. POST { name, prompt | image_url, personality?, voice? } and get back ' +
		'{ agent_id, glb_url, viewer_url, profile_url, embed_html, voice }. The body is a ' +
		'durable persona that reloads by id in any future session. $1 USDC, no account. ' +
		'Generation failures never settle — you are only charged when a finished body is returned.',
	input: {
		name: 'Nova Scout',
		prompt: 'a friendly explorer in a teal jumpsuit',
		voice: 'nova',
	},
	inputSchema: {
		type: 'object',
		required: ['name'],
		oneOf: [{ required: ['prompt'] }, { required: ['image_url'] }],
		properties: {
			name: { type: 'string', minLength: 1, maxLength: 64 },
			prompt: { type: 'string', minLength: 1, maxLength: 600 },
			image_url: { type: 'string', format: 'uri' },
			personality: { type: 'string', maxLength: 600 },
			voice: { type: 'string' },
		},
	},
	// Mirrors buildBundle()'s settled 200 in api/x402/embody.js — the durable
	// persona id, its GLB + viewer/profile URLs, and the paste-anywhere embed tag.
	outputExample: {
		agent_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
		glb_url: 'https://cdn.three.ws/personas/nova-scout/rigged.glb',
		viewer_url: 'https://three.ws/viewer?src=https%3A%2F%2Fcdn.three.ws%2Fpersonas%2Fnova-scout%2Frigged.glb',
		profile_url: 'https://three.ws/embed/persona?persona=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee&state=idle',
		embed_html: '<iframe src="https://three.ws/embed/persona?persona=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee&state=idle" width="360" height="480" loading="lazy" style="border:0;border-radius:12px;max-width:100%" allow="autoplay; fullscreen; xr-spatial-tracking" allowfullscreen sandbox="allow-scripts allow-same-origin allow-popups"></iframe>',
		reload_url: 'https://three.ws/api/mcp3d/persona?id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
		voice: 'nova',
		rigged: true,
		name: 'Nova Scout',
	},
	storefronts: ['x402scan'],
};
