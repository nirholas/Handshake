// The source a scaffolded paid endpoint is generated from. Kept apart from the
// `vscode` UI flow in scaffold.js so it can be rendered and asserted on outside
// the editor host (test/scaffold.test.mjs does exactly that).
//
// The output follows the repo's canonical paidEndpoint() pattern
// (api/_lib/x402-paid-endpoint.js): Solana-first networks, a bazaar entry so the
// endpoint is discoverable the moment it deploys, and a handler that only runs
// after the buyer's payment settles.

/**
 * Render a ready-to-deploy `api/x402/<slug>.js` handler.
 *
 * @param {{ slug: string, priceUsd: number|string, description: string }} spec
 * @returns {string} JavaScript source for the endpoint file
 */
export function renderEndpoint({ slug, priceUsd, description }) {
	const priceAtomics = Math.round(Number(priceUsd) * 1e6);
	return `// ${slug} — paid x402 endpoint. Buyers pay USDC (Solana or Base); the call runs
// only after settlement. Wired to the shared paidEndpoint() x402 dance.
//
//   POST /api/x402/${slug}

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';

const RESOURCE_URL = 'https://three.ws/api/x402/${slug}';

const paid = paidEndpoint({
	route: '/api/x402/${slug}',
	method: 'POST',
	// $${Number(priceUsd).toFixed(6)} in USDC atomics (6 decimals).
	priceAtomics: ${priceAtomics},
	// Solana leads the challenge and Base follows, so a first-accept buyer
	// settles on Solana, the platform's home chain.
	networks: ['solana', 'base'],
	description: ${JSON.stringify(description)},
	service: withService({
		serviceName: ${JSON.stringify(slug)},
		tags: ['x402', 'paid'],
	}),
	bazaar: {
		description: ${JSON.stringify(description)},
		useCases: ['x402 paid api'],
		input: { type: 'json', example: {}, schema: { type: 'object', additionalProperties: true } },
		output: { type: 'json', example: {} },
		schema: buildBazaarSchema({ method: 'POST', bodySchema: { type: 'object', additionalProperties: true } }),
		resource: RESOURCE_URL,
	},
	resourceUrlBuilder: () => RESOURCE_URL,

	// Runs ONLY after the buyer's payment settles. Return JSON; throw an Error
	// with a .status for handled failures.
	async handler({ req }) {
		const body = await readJson(req);
		// Replace this echo with the real work. It returns the validated request
		// so the endpoint is wired end-to-end from the first deploy.
		return {
			ok: true,
			service: ${JSON.stringify(slug)},
			received: body,
		};
	},
});

async function readJson(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
}

export default paid;
export const config = { api: { bodyParser: false } };
`;
}
