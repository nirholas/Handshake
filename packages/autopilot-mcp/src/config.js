// Centralized env + HTTP base for the autopilot MCP.
//
// This server is the agent's OWN execution control plane: it reads and writes
// the real three.ws autopilot surface (scopes, daily SOL spend caps, the
// propose → execute → undo loop) over live HTTP. Every autopilot route is
// owner-only, so this server is authenticated — it carries a three.ws API key
// (or OAuth access token) as a Bearer credential on every request. It signs
// nothing locally; all scope and spend enforcement happens server-side.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Base URL of the three.ws API. Override only when self-hosting or pointing at a
// preview deployment.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// The agent's three.ws credential. Either a three.ws API key (sk_live_… /
// sk_test_…) or an OAuth access token — both authenticate as the owning user via
// `Authorization: Bearer`. REQUIRED: every autopilot endpoint is owner-scoped and
// returns 401 without it. Treat it like a password; it can move real SOL.
export const THREE_WS_API_KEY =
	env('THREE_WS_API_KEY') || env('THREE_WS_TOKEN') || env('THREE_WS_BEARER') || '';

// Per-request timeout (ms). Proposal generation runs a real LLM synthesis pass
// server-side (maxDuration 60s upstream), so the default is generous enough to
// ride out a cold edge + model call without tripping a false timeout.
export const HTTP_TIMEOUT_MS = (() => {
	const raw = env('THREE_WS_TIMEOUT_MS');
	if (raw === undefined) return 60000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`THREE_WS_TIMEOUT_MS must be a positive number (got "${raw}")`), {
			code: 'bad_config',
		});
	}
	return n;
})();

// Identifies this client to the API in request logs.
export const USER_AGENT = '@three-ws/autopilot-mcp';
