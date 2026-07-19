// Centralized env + origin for the assistant-widget MCP.
//
// This server is pure and offline: it builds a paste-ready embed for the
// three.ws assistant widget from a config, entirely with local string logic.
// It signs nothing, holds no secret, and makes no network call. The one knob
// is which deployment the generated URLs should point at.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Origin baked into the generated embed (script src, frame URL, builder link).
// Override only when targeting a preview or self-hosted three.ws deployment.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// Identifies this client in any surface that inspects a User-Agent. Kept for
// parity with the rest of the three.ws MCP suite even though this server, being
// offline, sends no HTTP request.
export const USER_AGENT = '@three-ws/assistant-mcp';
