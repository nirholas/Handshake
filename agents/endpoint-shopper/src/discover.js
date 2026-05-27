// Bazaar discovery for the Endpoint Shopper agent.
//
// Queries our own /api/bazaar/search and /api/bazaar/list proxies which
// aggregate across all configured x402 facilitators. Results are normalized
// into a flat shape the planner and orchestrator can work with.

const BASE = process.env.PUBLIC_APP_ORIGIN || process.env.APP_ORIGIN || 'https://three.ws';

/**
 * Normalize a raw Bazaar resource/item into the shape used throughout the agent.
 *
 * @param {object} raw
 * @returns {{ url: string, serviceName: string, description: string, tags: string[], priceUsdc: string, network: string, priceAtomics: number }}
 */
function normalize(raw) {
	// Resources (from search) and items (from list) have slightly different shapes
	const url = String(raw.resource || raw.url || '');
	const serviceName = String(raw.serviceName || raw.service?.serviceName || '');
	const description = String(raw.description || raw.service?.description || '');
	const tags = Array.isArray(raw.tags) ? raw.tags : Array.isArray(raw.service?.tags) ? raw.service.tags : [];
	// Find the cheapest accept entry across networks
	const accepts = Array.isArray(raw.accepts) ? raw.accepts : [];
	let priceAtomics = 0;
	let network = '';
	if (accepts.length > 0) {
		const cheapest = accepts.reduce((a, b) => {
			const pa = Number(a.amount || 0);
			const pb = Number(b.amount || 0);
			return pb < pa ? b : a;
		}, accepts[0]);
		priceAtomics = Number(cheapest.amount || 0);
		network = String(cheapest.network || '');
	}
	const priceUsdc = (priceAtomics / 1_000_000).toFixed(6).replace(/\.?0+$/, '') || '0';

	return { url, serviceName, description, tags, priceUsdc, network, priceAtomics };
}

/**
 * Search the Bazaar for endpoints relevant to a query.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} [opts.maxResults=10]
 * @returns {Promise<Array<{ url, serviceName, description, tags, priceUsdc, network, priceAtomics }>>}
 */
export async function discoverEndpoints({ query, maxResults = 10 }) {
	const url = `${BASE}/api/bazaar/search?q=${encodeURIComponent(query)}&limit=${maxResults}`;
	const r = await fetch(url, {
		signal: AbortSignal.timeout(12_000),
		headers: { 'accept': 'application/json' },
	}).catch((err) => {
		throw Object.assign(new Error(`Bazaar search failed: ${err.message}`), {
			status: 502,
			code: 'bazaar_search_error',
		});
	});

	if (!r.ok) {
		const text = await r.text().catch(() => '');
		throw Object.assign(
			new Error(`Bazaar search returned ${r.status}: ${text.slice(0, 200)}`),
			{ status: 502, code: 'bazaar_search_error' },
		);
	}

	const data = await r.json();
	const resources = Array.isArray(data.resources) ? data.resources : [];
	return resources.slice(0, maxResults).map(normalize);
}

/**
 * List all Bazaar endpoints (up to limit).
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Array<{ url, serviceName, description, tags, priceUsdc, network, priceAtomics }>>}
 */
export async function listEndpoints({ limit = 20 } = {}) {
	const url = `${BASE}/api/bazaar/list?limit=${limit}`;
	const r = await fetch(url, {
		signal: AbortSignal.timeout(12_000),
		headers: { 'accept': 'application/json' },
	}).catch((err) => {
		throw Object.assign(new Error(`Bazaar list failed: ${err.message}`), {
			status: 502,
			code: 'bazaar_list_error',
		});
	});

	if (!r.ok) {
		const text = await r.text().catch(() => '');
		throw Object.assign(
			new Error(`Bazaar list returned ${r.status}: ${text.slice(0, 200)}`),
			{ status: 502, code: 'bazaar_list_error' },
		);
	}

	const data = await r.json();
	const items = Array.isArray(data.items) ? data.items : [];
	return items.slice(0, limit).map(normalize);
}
