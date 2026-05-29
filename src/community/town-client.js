// Town client — the browser's only door to the CoinCommunities social layer.
//
// Every call goes through the same-origin api/community/* proxy, so the
// CoinCommunities API key never reaches the browser. Realtime is the one
// direct connection: the proxy mints a single-use WS ticket and we open the
// socket straight to CoinCommunities with it (lazy-loaded so nothing lands in
// the main /walk bundle until a coin world is actually entered).

const BASE = '/api/community';

/** Unwrap the { data, error } envelope the proxy speaks, throwing on error. */
async function call(path, init) {
	const res = await fetch(`${BASE}${path}`, init);
	let body = null;
	try {
		body = await res.json();
	} catch {
		/* non-JSON (e.g. 502 HTML) — fall through to status-based error */
	}
	if (!res.ok || body?.error) {
		const err = new Error(body?.error_description || body?.error || `HTTP ${res.status}`);
		err.status = res.status;
		err.code = body?.error;
		throw err;
	}
	return body?.data ?? null;
}

/** Which Town affordances are live for this deployment (reads vs. posting). */
export function fetchCapabilities() {
	return call('/capabilities');
}

/** The lobby of live coin-worlds, most active first. */
export async function fetchWorlds() {
	const data = await call('/worlds');
	return data?.worlds ?? [];
}

/** Recent messages for a coin's community (newest first). */
export async function fetchMessages(token, { limit = 50, before } = {}) {
	const qs = new URLSearchParams({ token, limit: String(limit) });
	if (before) qs.set('before', before);
	const data = await call(`/messages?${qs}`);
	return data?.messages ?? [];
}

/**
 * Post a message. Only succeeds where server-side attribution is configured
 * (capabilities.canPost) and a linked posting identity is supplied. Throws with
 * a `posting_locked` code otherwise so the composer can render its locked state.
 */
export async function postMessage(
	token,
	{ content, walletAddress, twitterId, chainId = 'solana' },
) {
	const data = await call(`/messages?token=${encodeURIComponent(token)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ content, walletAddress, twitterId, chainId }),
	});
	return data?.message ?? null;
}

/**
 * Subscribe to a coin community's realtime stream. Returns a disposer.
 * The realtime module is dynamically imported so it's a separate chunk.
 *
 * @param {string} token  community mint
 * @param {string} baseUrl  CoinCommunities origin (from fetchCapabilities)
 * @param {object} handlers  { onMessage, onLike, onModeration, onConnect, onDisconnect, onGap }
 * @returns {Promise<() => void>}
 */
export async function connectRealtime(token, baseUrl, handlers = {}) {
	const mod = await import('@coin-communities/sdk/react');
	const RT = mod.realtime?.CommunityRealtimeClient ?? mod.CommunityRealtimeClient;
	if (!RT) throw new Error('realtime client unavailable in this SDK build');

	const client = RT.getOrCreate({
		baseUrl,
		tokenAddress: token,
		auth: {
			// Fresh single-use ticket on connect and every reconnect.
			getTicket: async () => {
				const res = await fetch(`${BASE}/ws-ticket?token=${encodeURIComponent(token)}`, {
					method: 'POST',
				});
				const body = await res.json().catch(() => null);
				const ticket = body?.data?.ticket;
				if (!ticket) throw new Error('WebSocket ticket unavailable');
				return ticket;
			},
		},
	});

	return client.subscribe(handlers);
}
