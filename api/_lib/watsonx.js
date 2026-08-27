// Shared server-side IBM watsonx.ai client for the LLM proxies.
//
// Mirrors the verified REST contract used by packages/ibm-watsonx-mcp:
// an IBM Cloud API key is exchanged for a short-lived IAM bearer token (cached
// across warm invocations), every inference call is scoped to a project (or
// deployment space), and the endpoint is version-stamped. The streaming chat
// endpoint returns an OpenAI-shaped SSE stream (choices[].delta.content), so
// callers can reuse an OpenAI delta reader verbatim.
//
// There is no mock path. When credentials are absent watsonxConfig() reports
// `configured: false` so a proxy can mark the provider unavailable; any IAM or
// upstream failure throws so the proxy reports the real cause to the caller.

import { fetchUpstream } from './upstream-fetch.js';

const IAM_TOKEN_URL = 'https://iam.cloud.ibm.com/identity/token';

// The IAM exchange is idempotent (same key, same short-lived token) so it is
// retried; an inference is not, and gets one attempt with a longer deadline.
const IAM_TIMEOUT_MS = 10_000;
const INFERENCE_TIMEOUT_MS = 45_000;

// Refresh the IAM token this many ms before its stated expiry so an in-flight
// request never races the hard expiry boundary.
const TOKEN_SKEW_MS = 5 * 60 * 1000;

// Module-scoped token cache. Vercel keeps a function instance warm across
// invocations, so caching the ~1h IAM token here saves a token round-trip on
// every chat request. Keyed by API key so multiple keys never cross-pollute.
const tokenCache = new Map(); // apiKey → { token, expiresAt }
const inflight = new Map(); // apiKey → Promise<string>

// Read and normalise watsonx configuration from the environment. `configured`
// is true only when an API key AND a project (or space) are both present —
// watsonx requires scoping on every inference request, so a key alone is not
// enough to serve a model.
export function watsonxConfig(env = process.env) {
	const apiKey = env.WATSONX_API_KEY?.trim();
	const projectId = env.WATSONX_PROJECT_ID?.trim();
	const spaceId = env.WATSONX_SPACE_ID?.trim();
	return {
		configured: Boolean(apiKey && (projectId || spaceId)),
		apiKey,
		projectId,
		spaceId,
		// us-south is the default deployment region; override per region host.
		url: (env.WATSONX_URL?.trim() || 'https://us-south.ml.cloud.ibm.com').replace(/\/$/, ''),
		iamUrl: env.WATSONX_IAM_URL?.trim() || IAM_TOKEN_URL,
		apiVersion: env.WATSONX_API_VERSION?.trim() || '2024-05-31',
		// The Time Series Forecasting API GA'd Feb 2025, so it needs a newer API
		// version contract than the chat endpoints. Overridable per account/region.
		tsApiVersion: env.WATSONX_TS_API_VERSION?.trim() || '2025-02-11',
		chatModel: env.WATSONX_MODEL_ID?.trim() || 'ibm/granite-3-8b-instruct',
		// Granite embedding model used by the semantic features (Agent Galaxy).
		// 278m-multilingual is the broad default; override per account/region.
		embedModel: env.WATSONX_EMBED_MODEL_ID?.trim() || 'ibm/granite-embedding-278m-multilingual',
	};
}

// Mint (or reuse) an IAM bearer token for the given config. Concurrent callers
// coalesce onto a single in-flight IAM round-trip per API key.
export async function watsonxToken(cfg) {
	if (!cfg.apiKey) throw new Error('WATSONX_API_KEY is not set');
	const now = Date.now();
	const cached = tokenCache.get(cfg.apiKey);
	if (cached && cached.expiresAt - TOKEN_SKEW_MS > now) return cached.token;
	if (inflight.has(cfg.apiKey)) return inflight.get(cfg.apiKey);

	const p = (async () => {
		const res = await fetchUpstream(cfg.iamUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body: new URLSearchParams({
				grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
				apikey: cfg.apiKey,
			}),
		}, { name: 'watsonx:iam', timeoutMs: IAM_TIMEOUT_MS, attempts: 3, okWhen: () => true });
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data.access_token) {
			throw new Error(
				`watsonx IAM auth failed (${res.status}): ${data.errorMessage || data.errorCode || 'no access_token'}`,
			);
		}
		tokenCache.set(cfg.apiKey, {
			token: data.access_token,
			expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
		});
		return data.access_token;
	})();

	inflight.set(cfg.apiKey, p);
	try {
		return await p;
	} finally {
		inflight.delete(cfg.apiKey);
	}
}

// Authorization headers for a streaming chat request. Separated from the body
// so callers that build their own payload (api/chat.js) can resolve headers
// lazily inside their own fetch/failover loop.
export async function watsonxAuthHeaders(cfg) {
	return {
		Authorization: `Bearer ${await watsonxToken(cfg)}`,
		'Content-Type': 'application/json',
		Accept: 'text/event-stream',
	};
}

// A bearer-token Authorization header for a non-streaming JSON request
// (embeddings, one-shot chat). Accept is application/json, not event-stream.
async function jsonAuthHeaders(cfg) {
	return {
		Authorization: `Bearer ${await watsonxToken(cfg)}`,
		'Content-Type': 'application/json',
		Accept: 'application/json',
	};
}

// POST a body to a watsonx ml endpoint and return the parsed JSON. Adds the
// version query param and surfaces the real upstream status + message on
// failure so callers report the true cause (auth, quota, unsupported model).
async function watsonxPost(cfg, path, body, version) {
	const headers = await jsonAuthHeaders(cfg);
	const res = await fetchUpstream(`${cfg.url}${path}?version=${version || cfg.apiVersion}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ ...body, ...scope(cfg) }),
	}, { name: 'watsonx', timeoutMs: INFERENCE_TIMEOUT_MS, attempts: 1, okWhen: () => true });
	const text = await res.text();
	if (!res.ok) {
		let detail = text.slice(0, 300);
		try {
			const j = JSON.parse(text);
			detail = j.errors?.[0]?.message || j.message || detail;
		} catch {
			// non-JSON error body — keep the raw slice
		}
		throw new Error(`watsonx ${res.status}: ${detail}`);
	}
	return text ? JSON.parse(text) : {};
}

// The project/space scoping object every inference body requires.
function scope(cfg) {
	return cfg.projectId ? { project_id: cfg.projectId } : { space_id: cfg.spaceId };
}

// Embed one or more texts with a Granite embedding model. Returns one vector
// per input (order preserved) plus the model and dimensionality. watsonx caps
// inputs per call, so large sets must be chunked by the caller.
export async function watsonxEmbed(cfg, { inputs, model } = {}) {
	if (!Array.isArray(inputs) || inputs.length === 0) {
		throw new Error('watsonxEmbed: inputs must be a non-empty array');
	}
	const data = await watsonxPost(cfg, '/ml/v1/text/embeddings', {
		model_id: model || cfg.embedModel,
		inputs,
	});
	const vectors = (data.results || []).map((r) => r.embedding);
	return {
		model: model || cfg.embedModel,
		vectors,
		dimensions: vectors[0]?.length ?? 0,
		inputCount: inputs.length,
	};
}

// One-shot (non-streaming) chat completion. Used where we need a short, whole
// answer rather than a token stream — e.g. asking Granite to name a cluster of
// semantically-similar agents. Returns the assistant text and token usage.
//
// Granite lane policy:
//   • watsonx creds present → watsonx leads; on any failure (IAM auth, quota,
//     region outage, unsupported model) it falls over to OpenRouter-hosted
//     Granite — the SAME model family (ibm-granite/*), just different hosting.
//   • watsonx creds ABSENT → Granite runs on OpenRouter directly as the primary
//     (no point attempting, and failing, the watsonx call first). This is what
//     lets the Granite features run on a deployment with no IBM account at all.
//   • neither configured → the real watsonx "not set" error propagates, exactly
//     as before.
// Invisible to callers: the return shape is identical and `provider` marks which
// lane served ('watsonx' | 'openrouter-granite').
export async function watsonxChatComplete(cfg, { messages, model, maxTokens, temperature } = {}) {
	// No watsonx credentials on this deployment → serve Granite from OpenRouter
	// directly rather than attempting a doomed watsonx round-trip on every call.
	const watsonxUsable = Boolean(cfg?.apiKey && (cfg?.projectId || cfg?.spaceId));
	if (!watsonxUsable) {
		const direct = await graniteOpenRouterFallback({ messages, maxTokens, temperature });
		if (direct) return direct;
		// No OpenRouter either — fall through so the genuine watsonx error surfaces.
	}
	// Decoding params are TOP-LEVEL on the chat endpoint (it is OpenAI-shaped) —
	// not nested under a `parameters` wrapper (that's the older text/generation
	// API). Nesting them here silently dropped max_tokens/temperature; keep this
	// consistent with watsonxChatRequest() above, which already sends them flat.
	try {
		const data = await watsonxPost(cfg, '/ml/v1/text/chat', {
			model_id: model || cfg.chatModel,
			messages,
			...(maxTokens != null ? { max_tokens: maxTokens } : {}),
			...(temperature != null ? { temperature } : {}),
		});
		const choice = data.choices?.[0];
		return {
			text: choice?.message?.content ?? '',
			finishReason: choice?.finish_reason,
			usage: data.usage,
			model: data.model_id || model || cfg.chatModel,
			provider: 'watsonx',
		};
	} catch (err) {
		const fallback = await graniteOpenRouterFallback({ messages, maxTokens, temperature });
		if (fallback) {
			console.warn(`[watsonx] chat failed, served via OpenRouter (${fallback.model}): ${err.message}`);
			return fallback;
		}
		throw err;
	}
}

// Same-model backstop for watsonxChatComplete: OpenRouter-hosted Granite, tried
// only when the watsonx call failed. Keeps the platform's Granite features alive
// through a watsonx-side outage without swapping the model family. Returns null
// when no OpenRouter key is configured (so the original watsonx error stands) or
// when OpenRouter itself fails. The key list mirrors llm.js / brain-chat:
// OPENROUTER_API_KEY first, then the comma-separated OPENROUTER_FALLBACK_KEYS.
async function graniteOpenRouterFallback({ messages, maxTokens, temperature }) {
	const keys = [
		process.env.OPENROUTER_API_KEY?.trim(),
		...(process.env.OPENROUTER_FALLBACK_KEYS || '').split(',').map((k) => k.trim()),
	].filter(Boolean);
	if (!keys.length) return null;
	// Vision reads (ibm/vision.js) send multimodal messages — an array content
	// block with an image_url. OpenRouter has no Granite-vision model, and the
	// text Granite model can't see the image, so route those to a vision-capable
	// model instead. Plain text completions keep using Granite (same family).
	const isMultimodal = (messages || []).some(
		(m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url'),
	);
	const model = isMultimodal
		? process.env.OPENROUTER_VISION_MODEL?.trim() || 'google/gemini-2.5-flash'
		: process.env.OPENROUTER_GRANITE_MODEL?.trim() || 'ibm-granite/granite-4.1-8b';
	for (const key of [...new Set(keys)]) {
		try {
			const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${key}`,
					'HTTP-Referer': 'https://three.ws',
					'X-Title': 'three.ws',
				},
				body: JSON.stringify({
					model,
					messages,
					...(maxTokens != null ? { max_tokens: maxTokens } : {}),
					...(temperature != null ? { temperature } : {}),
				}),
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) continue;
			const data = await res.json();
			const choice = data.choices?.[0];
			const text = choice?.message?.content ?? '';
			if (!text) continue;
			return {
				text,
				finishReason: choice?.finish_reason,
				usage: data.usage,
				model: data.model || model,
				provider: 'openrouter-granite',
			};
		} catch {
			// Try the next key; if all fail we return null and the watsonx error stands.
		}
	}
	return null;
}

// Granite TimeSeries forecasting lives in ./watsonx-forecast.js (the canonical
// helper the Granite Oracle + Granite Proof and their tests import). It reuses
// watsonxToken() from this module, so there is no forecast code here.

// Build a ready-to-fetch streaming chat request. `messages` is the standard
// [{ role, content }] array (system messages allowed). The response body is an
// SSE stream of OpenAI-shaped chat completion chunks.
export async function watsonxChatRequest(cfg, { model, messages, maxTokens } = {}) {
	const headers = await watsonxAuthHeaders(cfg);
	return {
		url: `${cfg.url}/ml/v1/text/chat_stream?version=${cfg.apiVersion}`,
		headers,
		body: {
			model_id: model || cfg.chatModel,
			...(cfg.projectId ? { project_id: cfg.projectId } : { space_id: cfg.spaceId }),
			messages,
			...(maxTokens ? { max_tokens: maxTokens } : {}),
		},
	};
}
