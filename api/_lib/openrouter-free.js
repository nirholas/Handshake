// Live registry of OpenRouter's free-tier models — the single source of truth
// for every surface that serves a free model without a user key.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Model ids on OpenRouter are NOT stable. Providers retire a `:free` endpoint
// with no notice and no redirect: the id simply disappears from /v1/models and
// every request naming it comes back with "This model is unavailable for free."
// On 2026-07-27 that had happened to ALL FIVE ids the /chat app shipped as its
// built-in list (openai/gpt-oss-120b:free, meta-llama/llama-3.3-70b-instruct:free,
// google/gemma-3-27b-it:free, qwen/qwen3-coder:free,
// nousresearch/hermes-3-llama-3.1-405b:free) plus the default in the brand-config
// row, so the first message any visitor sent died on a raw upstream error.
//
// The lesson is not "pick better ids" — it is that a hardcoded id is a time bomb.
// Everything here derives from the LIVE list instead: callers express preference
// as families/capabilities, and whatever is actually alive today wins. A future
// retirement rotates the fleet automatically rather than breaking chat.

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const TTL_MS = 5 * 60 * 1000;
// Serve a stale list rather than nothing when OpenRouter is unreachable: a
// slightly outdated model id still beats an empty picker.
const STALE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// Preference is expressed as id PREFIXES, never whole ids, so a family survives
// its members being retired and renamed. Earlier entries rank higher. Anything
// live but unlisted still ranks (after these), so the picker never runs dry.
const PREFERRED_PREFIXES = [
	'openai/gpt-oss',   // closest continuation of the historical platform default
	'google/gemma',
	'nvidia/nemotron',
	'inclusionai/ling',
	'meta-llama/',
	'qwen/',
	'deepseek/',
	'mistralai/',
];

let cache = { models: [], fetchedAt: 0 };
let inflight = null;

/** A model id usable on the anonymous built-in proxy. */
export function isFreeModelId(id) {
	return typeof id === 'string' && id.endsWith(':free');
}

function supportsTools(model) {
	return Array.isArray(model?.supported_parameters) && model.supported_parameters.includes('tools');
}

function rankOf(model) {
	const idx = PREFERRED_PREFIXES.findIndex((p) => model.id.startsWith(p));
	return idx === -1 ? PREFERRED_PREFIXES.length : idx;
}

/**
 * Rank free models best-first: tool-capable ahead of tool-less (the chat app's
 * whole point is tool use), then by preferred family, then by context window,
 * then by id so the order is deterministic across processes.
 */
export function rankFreeModels(models) {
	return [...models].sort((a, b) => {
		const at = supportsTools(a) ? 0 : 1;
		const bt = supportsTools(b) ? 0 : 1;
		if (at !== bt) return at - bt;
		const ar = rankOf(a);
		const br = rankOf(b);
		if (ar !== br) return ar - br;
		const ac = a.context_length ?? 0;
		const bc = b.context_length ?? 0;
		if (ac !== bc) return bc - ac;
		return a.id.localeCompare(b.id);
	});
}

async function fetchFreeModels(apiKey) {
	const headers = {
		'HTTP-Referer': 'https://three.ws',
		'X-Title': 'three.ws chat',
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
	};
	// The public model list needs no key; an unkeyed deployment still gets a
	// correct picker instead of an empty one.
	const res = await fetch(MODELS_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`openrouter models ${res.status}`);
	const body = await res.json();
	const all = Array.isArray(body?.data) ? body.data : [];
	return rankFreeModels(all.filter((m) => isFreeModelId(m?.id)));
}

/**
 * Live free-model list, best-first. Cached for 5 minutes; on an upstream
 * failure the last good list is served for up to a day before giving up and
 * returning an empty array (callers must treat empty as "no opinion", never as
 * "reject the request").
 */
export async function listFreeModels() {
	const now = Date.now();
	if (cache.models.length && now - cache.fetchedAt < TTL_MS) return cache.models;
	if (inflight) return inflight;

	const key = process.env.OPENROUTER_API_KEY || '';
	inflight = fetchFreeModels(key)
		.then((models) => {
			if (models.length) cache = { models, fetchedAt: Date.now() };
			return cache.models;
		})
		.catch(() => (now - cache.fetchedAt < STALE_MS ? cache.models : []))
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/** True when `id` is a free model OpenRouter is actually serving right now. */
export async function isLiveFreeModel(id) {
	if (!isFreeModelId(id)) return false;
	const models = await listFreeModels();
	// An empty list means we could not reach OpenRouter — do not call a model
	// dead on our own outage.
	if (!models.length) return true;
	return models.some((m) => m.id === id);
}

/**
 * Best free model to use right now, or null when the live list is unavailable.
 * `exclude` skips ids already known to have failed this request.
 */
export async function pickDefaultFreeModel({ exclude = [] } = {}) {
	const models = await listFreeModels();
	const skip = new Set(exclude);
	return models.find((m) => !skip.has(m.id))?.id ?? null;
}

/** Test seam: drop the cached list so the next call refetches. */
export function resetFreeModelCache() {
	cache = { models: [], fetchedAt: 0 };
	inflight = null;
}
