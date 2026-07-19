// Centralized env + HTTP base for the concierge MCP.
//
// This server is a thin wrapper over the PUBLIC three.ws Concierge API
// (POST /api/concierge) plus two pure, offline generators (embed snippets and
// the avatar catalog). It signs nothing and holds no secret, the only knobs
// are which deployment to talk to and how long to wait. Nothing about how an
// answer is produced is baked in here; it all comes from the live endpoint.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Base URL of the three.ws API that serves POST /api/concierge, and the origin
// the generated embed snippets point at. Override only when self-hosting or
// pointing at a preview deployment.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// Per-request timeout (ms) for the concierge answer call. A grounded answer
// streams over a free-first LLM chain that can fail over across providers, so
// the default leaves room for one slow rung before giving up.
export const HTTP_TIMEOUT_MS = (() => {
	const raw = env('THREE_WS_TIMEOUT_MS');
	if (raw === undefined) return 45000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`THREE_WS_TIMEOUT_MS must be a positive number (got "${raw}")`), {
			code: 'bad_config',
		});
	}
	return n;
})();

// Timeout (ms) for fetching a page that concierge_ask should ground its answer
// in. Separate from the answer timeout so a slow site can't eat the whole call.
export const PAGE_FETCH_TIMEOUT_MS = (() => {
	const raw = env('CONCIERGE_PAGE_TIMEOUT_MS');
	if (raw === undefined) return 12000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 12000;
	return n;
})();

// Identifies this client to the API in request logs.
export const USER_AGENT = '@three-ws/concierge-mcp';
