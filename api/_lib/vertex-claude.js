// Vertex AI Claude transport — routes first-party-shaped Anthropic Messages
// requests to Google Vertex AI so platform LLM traffic bills the ~$100k GCP
// credit pool instead of a paid Anthropic key.
//
// The Anthropic Messages wire format on Vertex differs from api.anthropic.com in
// exactly four ways (everything else — request body, SSE event shapes — is
// identical, so existing parsers work unchanged):
//   1. The model id goes in the URL path, not the request body.
//   2. The body gains `"anthropic_version": "vertex-2023-10-16"` and drops `model`.
//   3. Auth is `Authorization: Bearer <oauth>` — no `x-api-key`, no
//      `anthropic-version` header.
//   4. Dated first-party model ids convert to Vertex's `@` form
//      (claude-haiku-4-5-20251001 → claude-haiku-4-5@20251001); bare ids pass
//      through (claude-sonnet-4-6).
//
// Config (env):
//   GOOGLE_CLOUD_PROJECT          — GCP project id (required)
//   GOOGLE_CLOUD_LOCATION_CLAUDE  — region or "global" (default: "global")
//   VERTEX_CLAUDE_ENABLED=1       — Vertex becomes an available Anthropic transport
//   VERTEX_CLAUDE_PRIMARY=1       — Vertex Claude leads the provider chain (before
//                                   the free lanes); requires VERTEX_CLAUDE_ENABLED
//
// Both flags off → callers never construct a Vertex request, so behavior is
// byte-identical to the pre-Vertex chain. Any Vertex error (429/5xx/quota/token
// exchange) is a normal provider failure the caller's chain falls through.

import { getGcpAccessToken } from './gcp-auth.js';

// Bounds the wait for response headers only. The Response may be a stream the
// caller pipes through for minutes, so a whole-request deadline would cut
// live completions; a hung connection is the only thing this needs to catch.
const VERTEX_HEADERS_TIMEOUT_MS = 45_000;

const DEFAULT_LOCATION = 'global';
const ANTHROPIC_VERTEX_VERSION = 'vertex-2023-10-16';

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
	return null;
}

function flag(name) {
	const v = readEnv(name);
	return v === '1' || v === 'true';
}

// Map a first-party Anthropic model id to its Vertex publisher-model id. A
// trailing 8-digit date suffix (`-20251001`) becomes the Vertex `@` form
// (`@20251001`); every other id — bare aliases like `claude-sonnet-4-6`, or ids
// already in `@` form — passes through untouched. One shared helper so the
// string surgery lives in exactly one place.
export function toVertexModelId(modelId) {
	if (!modelId) return modelId;
	const m = /^(.*)-(\d{8})$/.exec(modelId);
	return m ? `${m[1]}@${m[2]}` : modelId;
}

// True when the GCP project is configured — the minimum to attempt Vertex.
export function vertexClaudeConfigured() {
	return Boolean(readEnv('GOOGLE_CLOUD_PROJECT'));
}

// True when Vertex is an available Anthropic transport (flag on AND configured).
export function vertexClaudeEnabled() {
	return flag('VERTEX_CLAUDE_ENABLED') && vertexClaudeConfigured();
}

// True when Vertex Claude should LEAD the provider chain (inversion flag on, and
// Vertex is otherwise enabled).
export function vertexClaudePrimary() {
	return vertexClaudeEnabled() && flag('VERTEX_CLAUDE_PRIMARY');
}

function vertexTarget() {
	const project = readEnv('GOOGLE_CLOUD_PROJECT');
	const location = readEnv('GOOGLE_CLOUD_LOCATION_CLAUDE') || DEFAULT_LOCATION;
	// The global endpoint uses the bare host; a regional endpoint prefixes it.
	const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
	return { project, location, host };
}

// Build the Vertex Messages endpoint URL for a model. `:streamRawPredict` for
// streaming SSE, `:rawPredict` for a single JSON response.
export function vertexMessagesUrl(modelId, { stream = false } = {}) {
	const { project, location, host } = vertexTarget();
	const vid = toVertexModelId(modelId);
	const verb = stream ? 'streamRawPredict' : 'rawPredict';
	return `https://${host}/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${vid}:${verb}`;
}

// Convert a first-party Anthropic Messages body to the Vertex body: drop `model`
// (it lives in the URL), drop the caller's `stream` hint (streaming is chosen by
// the URL verb, not the body), and add the required `anthropic_version`.
export function toVertexBody(anthropicBody) {
	const { model, stream, ...rest } = anthropicBody;
	return { ...rest, anthropic_version: ANTHROPIC_VERTEX_VERSION };
}

// Resolve the request headers for a Vertex Messages call — a fresh (cached) GCP
// OAuth bearer token. May throw when no GCP credentials are configured; callers
// treat that like any other provider failure and fall through their chain.
export async function vertexRequestHeaders() {
	const token = await getGcpAccessToken();
	return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

// Issue an Anthropic Messages request against Vertex and return the raw Response
// (streaming or not), so callers can pass the SSE body through unchanged or read
// the JSON. `body` is a first-party-shaped Anthropic body including `model`.
export async function vertexAnthropicMessages(body, { stream = false } = {}) {
	const url = vertexMessagesUrl(body.model, { stream });
	const headers = await vertexRequestHeaders();
	const headersCtrl = new AbortController();
	const headersTimer = setTimeout(() => headersCtrl.abort(), VERTEX_HEADERS_TIMEOUT_MS);
	try {
		return await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(toVertexBody(body)),
			signal: headersCtrl.signal,
		});
	} finally {
		clearTimeout(headersTimer);
	}
}
