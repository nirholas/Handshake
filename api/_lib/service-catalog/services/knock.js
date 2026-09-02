// Service-catalog descriptor - the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Do not re-add a hand-written mirror for this route in api/wk.js - edit this
// descriptor instead.
//
// Two things about this listing are unusual and both are deliberate.
// Price: every door sets its own, so priceAtomics is the representative figure
// the route's own probe challenge quotes when no ?to= handle is named. A real
// knock's 402 carries that recipient's price.
// Payout: the USDC settles to the recipient's own wallet, never to three.ws,
// so the payTo in a live challenge is the person you are knocking on, not the
// platform receiver a static catalog entry can name.

export default {
	slug: 'knock',
	title: 'Knock: Reach a Real Person',
	category: 'agent-infra',
	useCase: 'Agent-to-human contact - pay a person\'s own asking price to get exactly one message through to them, delivered out loud by their 3D companion.',
	path: '/api/x402/knock',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '50000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Knock',
	tags: ['knock', 'attention', 'messaging', 'agent-to-human', 'x402'],
	description:
		'Pay a real person\'s price and get one message through to them, in person. Every three.ws account can publish a priced door at /knock/<username>; paying it buys exactly one message, delivered out loud and in person by that person\'s 3D companion, which walks on screen wherever they are on the site and says who you are and what you paid. Call it as POST /api/x402/knock?to=<username>: the challenge quotes that door\'s own price, and the USDC settles directly to the recipient, not to three.ws. Read GET /api/knock/door?handle=<username> for a door\'s exact price and limits before you pay, or GET /api/knock/directory for every open door. The response carries a receipt URL you can poll for a reply without needing an account. The price listed here is the representative one a probe with no handle receives.',
	input: {
		from: 'Ada (research agent)',
		subject: 'Your x402 settle path',
		message: 'I index x402 endpoints and yours is the only one settling on Solana. Two questions about the facilitator, happy to pay for the time.',
		sender_kind: 'agent',
	},
	inputSchema: {
		type: 'object',
		required: ['from', 'message'],
		properties: {
			from: { type: 'string', maxLength: 64, description: 'Who is knocking. Shown and spoken to the recipient.' },
			message: { type: 'string', maxLength: 2000, description: 'The message. The length ceiling is per-door; read it from /api/knock/door.' },
			subject: { type: 'string', maxLength: 120, description: 'One line the companion says out loud. The body is shown, never read aloud.' },
			url: { type: 'string', maxLength: 400, description: 'An http(s) link the recipient can follow to check you out.' },
			sender_kind: { type: 'string', enum: ['agent', 'human', 'unknown'], description: 'Self-declared. Shown in the inbox, never trusted for access.' },
			request_id: { type: 'string', maxLength: 80, description: 'Idempotency key. A retry after a settled payment returns the first knock instead of knocking twice.' },
		},
	},
	// What a settled knock returns. The receipt URL is the whole point for a
	// caller with no account: it is how they read the reply.
	outputExample: {
		ok: true,
		knock_id: 'c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a',
		delivered_to: 'nirholas',
		announced: true,
		importance: 78,
		paid: '0.05',
		receipt_url: 'https://three.ws/knock/receipt/c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a',
		duplicate: false,
	},
	storefronts: ['x402scan'],
};
