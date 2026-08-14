// Centralized env + HTTP base for the brain MCP.
//
// This server is a thin wrapper over the three.ws multi-provider LLM router
// (/api/brain/chat). It holds no model keys of its own — the router fronts
// Claude, GPT-5, Grok, Qwen, DeepSeek, NVIDIA NIM, IBM Granite, and more on the
// server's billed keys. The only knobs here are which deployment to talk to,
// how long to wait, and an optional three.ws API key that unlocks the paid
// first-party flagships (free open-weight tiers need no key).

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Base URL of the three.ws API. Override only when self-hosting or pointing at a
// preview deployment.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// Optional bearer credential (three.ws API key `sk_live_…`/`sk_test_…`, or an
// OAuth access token). Sent as `Authorization: Bearer …` on every request. The
// router serves the free open-weight tiers anonymously; the paid first-party
// flagships (Claude, GPT-5, o3, Grok, Qwen Plus, DeepSeek) require this credential.
export const THREE_WS_API_KEY = env('THREE_WS_API_KEY');

// Per-request timeout (ms). A chat completion streams server-side and is
// collapsed into a single MCP reply, so a long flagship answer must not be cut
// short — default generously (the router itself caps at ~120s).
export const HTTP_TIMEOUT_MS = (() => {
	const raw = env('THREE_WS_TIMEOUT_MS');
	if (raw === undefined) return 120000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`THREE_WS_TIMEOUT_MS must be a positive number (got "${raw}")`), {
			code: 'bad_config',
		});
	}
	return n;
})();

// Identifies this client to the API in request logs.
export const USER_AGENT = '@three-ws/brain-mcp';
