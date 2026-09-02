// Service-catalog descriptor - the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Do not re-add a hand-written mirror for this route in api/wk.js - edit this
// descriptor instead.
//
// Pricing note: a print is priced per object, per size, per destination, so
// there is no single list price to advertise. priceAtomics is the catalog FLOOR
// (data/print-catalog.json pricing.minOrderUsdc), which is exactly what the
// route's probe challenge quotes to a crawler. A real order quotes its own
// signed quote token instead.

export default {
	slug: 'print-order',
	title: 'Materialize: Physical 3D Printing',
	category: '3d',
	useCase: 'Physical Manufacturing - pay in USDC to have a 3D model printed in resin, nylon or full-color sandstone and shipped to a street address.',
	path: '/api/x402/print-order',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '12000000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Materialize',
	tags: ['3d-printing', 'manufacturing', 'physical', 'commerce', 'fulfillment'],
	description:
		'Order a real, physical 3D print of any model and have it manufactured and shipped to a street address, paying in USDC. Quote first at POST /api/print/quote (free, keyless) with a creationId or a glbUrl, a materialId from GET /api/print/catalog, a target height in millimetres and an ISO country code; that returns a printability report, an itemized price and a signed quote token. Post the token plus a shipping address here and the 402 challenge quotes that quote\'s exact total, so the price shown is the price of that object at that size to that country. Settling it opens a real manufacturing job: safety screening, production, tracked shipping, and a certificate of authenticity attested on Solana. Track it at GET /api/print/orders/{id}. The 12 USDC listed here is the catalog floor, not a list price.',
	input: {
		token: 'pq1.<signed quote from POST /api/print/quote>',
		shipping: {
			name: 'Ada Lovelace',
			line1: '12 Analytical Way',
			city: 'London',
			postal_code: 'EC1A 1AA',
			country: 'GB',
		},
	},
	inputSchema: {
		type: 'object',
		required: ['token', 'shipping'],
		properties: {
			token: {
				type: 'string',
				description: 'The signed quote token from POST /api/print/quote. Carries the material, size, quantity, destination and total, so the price cannot be altered in transit. Valid for 24 hours.',
			},
			shipping: {
				type: 'object',
				required: ['name', 'line1', 'city', 'postal_code', 'country'],
				description: 'Delivery address. Minimum fields only; never logged, never in an analytics event.',
				properties: {
					name: { type: 'string', maxLength: 120 },
					line1: { type: 'string', maxLength: 120 },
					line2: { type: 'string', maxLength: 120 },
					city: { type: 'string', maxLength: 120 },
					region: { type: 'string', maxLength: 120 },
					postal_code: { type: 'string', maxLength: 120 },
					country: { type: 'string', maxLength: 2, description: 'ISO 3166-1 alpha-2. Must match the country the quote was priced for.' },
					phone: { type: 'string', maxLength: 120 },
				},
			},
			note: { type: 'string', maxLength: 500, description: 'Optional note for the operator, kept on the order timeline.' },
		},
	},
	storefronts: ['x402scan'],
};
