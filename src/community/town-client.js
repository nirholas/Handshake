// Town client — the browser's only door to the CoinCommunities social layer.
//
// Every call goes through the same-origin api/community/* proxy, so the
// CoinCommunities API key never reaches the browser. Realtime is the one
// direct connection: the proxy mints a single-use WS ticket and we open the
// socket straight to CoinCommunities with it (lazy-loaded so nothing lands in
// the main /walk bundle until a coin world is actually entered).

const BASE = '/api/community';

// Once the proxy answers cc_unconfigured (503: no CoinCommunities key on this
// deployment), every further call this page load would 503 identically; the
// state only changes with a redeploy. Remember the first such error and fail
// every later call fast, so one page view never spams the endpoint.
let _unconfiguredErr = null;

/** Unwrap the { data, error } envelope the proxy speaks, throwing on error. */
async function call(path, init) {
	if (_unconfiguredErr) throw _unconfiguredErr;
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
		if (err.code === 'cc_unconfigured') _unconfiguredErr = err;
		throw err;
	}
	return body?.data ?? null;
}

/** Which Town affordances are live for this deployment (reads vs. posting). */
export function fetchCapabilities() {
	return call('/capabilities');
}

// One in-flight /worlds request serves every concurrent caller (the lobby and
// coin-world-boot's enrich() can both want it during a single boot).
let _worldsInflight = null;

/** The lobby of live coin-worlds, most active first. */
export function fetchWorlds() {
	if (!_worldsInflight) {
		_worldsInflight = call('/worlds')
			.then((data) => data?.worlds ?? [])
			.finally(() => {
				_worldsInflight = null;
			});
	}
	return _worldsInflight;
}

/** Recent messages for a coin's community (newest first). */
export async function fetchMessages(token, { limit = 50, before } = {}) {
	const qs = new URLSearchParams({ token, limit: String(limit) });
	if (before) qs.set('before', before);
	const data = await call(`/messages?${qs}`);
	return data?.messages ?? [];
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
