// Centralized env + HTTP base for the herald MCP.
//
// This server has exactly one job: hand a line to the three.ws delivery rail so
// the human who owns the key hears it from their own 3D companion. It is
// authenticated (a Bearer credential on every request), it signs nothing
// locally, and it holds no other secret.
//
// The addressing model is worth understanding before wiring an agent to it: an
// announcement always goes to the *key owner's own* sessions. There is no
// recipient parameter, so an agent cannot use this to interrupt anyone else.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Base URL of the three.ws API. Override only when self-hosting or pointing at
// a preview deployment.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// The agent owner's three.ws credential: an API key (sk_live_… / sk_test_…)
// carrying the `herald:announce` scope, or an OAuth access token for the same
// account. REQUIRED: the rail is account-scoped and returns 401 without it.
// THREE_WS_TOKEN / THREE_WS_BEARER are accepted aliases.
export const THREE_WS_API_KEY =
	env('THREE_WS_API_KEY') || env('THREE_WS_TOKEN') || env('THREE_WS_BEARER') || '';

// Per-request timeout (ms). One small POST; generous enough to ride out a cold
// edge without leaving an agent hanging.
export const HTTP_TIMEOUT_MS = (() => {
	const raw = env('THREE_WS_TIMEOUT_MS');
	if (raw === undefined) return 20000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`THREE_WS_TIMEOUT_MS must be a positive number (got "${raw}")`), {
			code: 'bad_config',
		});
	}
	return n;
})();

// Identifies this client to the API in request logs.
export const USER_AGENT = '@three-ws/herald-mcp';
