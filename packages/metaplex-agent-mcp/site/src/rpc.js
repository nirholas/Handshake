// RPC endpoint resolution for a fully static site.
//
// The browser reality, measured rather than assumed:
//   devnet   api.devnet.solana.com answers browser origins with CORS. Works
//            everywhere, costs nothing, so it is the default rehearsal lane.
//   mainnet  api.mainnet-beta.solana.com returns 403 to browser origins, so a
//            static page has no free mainnet endpoint. Two real options: the
//            three.ws public proxy (method-allowlisted and rate-limited), or an
//            endpoint the visitor brings (Helius / QuickNode / Triton).
//
// Which of those is available is capability-DETECTED at runtime with a real
// getHealth call, never assumed: if the proxy answers with CORS we offer it as
// the zero-config option, otherwise the visitor supplies one. A saved custom
// endpoint always wins, and is validated before it can be selected.

const STORAGE_KEY = 'map.rpc.custom';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const THREEWS_PROXY = 'https://three.ws/api/solana-rpc';

/** The visitor's saved endpoint for a cluster, if any. */
export function customRpc(network) {
	try {
		const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		return all[network] || '';
	} catch {
		return '';
	}
}

export function saveCustomRpc(network, url) {
	let all = {};
	try {
		all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
	} catch {
		all = {};
	}
	if (url) all[network] = url;
	else delete all[network];
	localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** A single JSON-RPC round trip. Throws on transport or RPC-level failure. */
export async function rpcCall(endpoint, method, params = []) {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!res.ok) throw new Error(`${method} returned HTTP ${res.status}`);
	const body = await res.json();
	if (body.error) throw new Error(body.error.message || `${method} failed`);
	return body.result;
}

/** True when the endpoint answers a real request from this origin. */
export async function probe(endpoint) {
	try {
		const health = await rpcCall(endpoint, 'getHealth');
		return health === 'ok' || health === undefined;
	} catch {
		return false;
	}
}

/**
 * Validate an endpoint the visitor typed, and confirm it is on the cluster they
 * think it is. A devnet URL pasted into the mainnet slot is a mistake worth
 * catching before it eats a real mint, so we compare genesis hashes.
 */
const GENESIS = {
	mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

export async function validateRpc(endpoint, network) {
	let url;
	try {
		url = new URL(endpoint);
	} catch {
		return { ok: false, message: 'That is not a valid URL.' };
	}
	if (url.protocol !== 'https:') {
		return { ok: false, message: 'The endpoint must be https.' };
	}
	let genesis;
	try {
		genesis = await rpcCall(endpoint, 'getGenesisHash');
	} catch (err) {
		return { ok: false, message: `The endpoint did not answer: ${err.message}` };
	}
	if (genesis !== GENESIS[network]) {
		const actual = Object.entries(GENESIS).find(([, hash]) => hash === genesis)?.[0];
		return {
			ok: false,
			message: actual
				? `That endpoint is on ${actual}, not ${network}.`
				: 'That endpoint is on an unrecognised cluster.',
		};
	}
	return { ok: true, message: 'Endpoint verified.' };
}

/**
 * Resolve the endpoint to use, and say WHY, so the UI can be honest about it.
 * @returns {Promise<{endpoint: string|null, source: 'custom'|'threews'|'public'|'none'}>}
 */
export async function resolveEndpoint(network) {
	const custom = customRpc(network);
	if (custom) return { endpoint: custom, source: 'custom' };

	if (network === 'devnet') {
		if (await probe(DEVNET_RPC)) return { endpoint: DEVNET_RPC, source: 'public' };
		if (await probe(THREEWS_PROXY + '?net=devnet')) {
			return { endpoint: THREEWS_PROXY + '?net=devnet', source: 'threews' };
		}
		return { endpoint: null, source: 'none' };
	}

	if (await probe(THREEWS_PROXY)) return { endpoint: THREEWS_PROXY, source: 'threews' };
	return { endpoint: null, source: 'none' };
}
