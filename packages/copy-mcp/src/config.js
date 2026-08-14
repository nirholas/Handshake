// Centralized env + HTTP base for the copy-trading MCP.
//
// This server is the account-scoped control surface for a copier's own
// copy-trade relationships (/api/copy/subscriptions, /api/copy/executions,
// /api/copy/earnings). Every account-scoped call carries the copier's bearer
// credential — a three.ws API key (sk_live_… / sk_test_…) or an OAuth access
// token — so the API resolves "me" the same way the website does. The server
// holds no Solana key and never signs: copy trading here is non-custodial, so
// the only secret is the bearer that authenticates the copier.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Base URL of the three.ws API. Override only when self-hosting or pointing at a
// preview deployment.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// The copier's bearer credential. Read lazily (empty default) so importing the
// module — and therefore buildServer() in the offline tests — never requires a
// key; account-scoped tools throw a clear `missing_credential` at call time if
// it is absent. Mint one at https://three.ws/dashboard/developers.
export const THREE_WS_API_KEY = env('THREE_WS_API_KEY', '');

// Per-request timeout (ms). These are live reads/writes against the copy engine
// — generous enough to ride out a cold edge, fast in practice.
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
export const USER_AGENT = '@three-ws/copy-mcp';
