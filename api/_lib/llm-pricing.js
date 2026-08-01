// LLM cost model. Converts a provider/model/token-usage triple into a cost in
// micro-USD (1 unit = $0.000001) so usage_events.cost_micro_usd can be summed
// without float drift. This is the single source of truth for "what did that
// call cost us" — the admin spend dashboard reads the events this priced.
//
// Anthropic and OpenAI prices are list price per 1M tokens (input / output),
// current as of each vendor's model catalog. Groq and NVIDIA NIM are
// platform-funded free tiers (we hold the key, callers pay nothing), so their
// marginal cost to us is $0: they are intentionally priced at zero, not
// omitted, so the dashboard can show "calls served free" alongside paid spend.
//
// OpenRouter is NOT blanket-free, and treating it as such is what made a real
// $30 credit burn invisible: the platform key routes `:free` models (genuinely
// $0) AND vendor mirrors like `anthropic/claude-opus-5` (real spend at close to
// list price), and both used to price to exactly 0, the mirror because its
// namespaced id matched no table key and the provider was on the free list. A
// lane reporting $0 while it drains a balance is worse than one reporting
// nothing, so:
//
//   • `:free` suffix          → 0, and only that suffix earns a free price.
//   • vendor-namespaced id    → priced by the underlying model (openRouterBaseId).
//   • a provider-reported cost (OpenRouter's `usage.cost`, requested with
//     `usage: { include: true }`) always wins over the table, it is the
//     authoritative number the account was actually charged.
//   • anything else on a spending lane → UNKNOWN (null), never 0. Callers
//     record null (usage_events.cost_micro_usd is nullable) and raise, so the
//     gap is visible instead of masquerading as free traffic.

import { isPaidModel } from './chat-models.js';

// USD per 1,000,000 tokens, [input, output]. Keys are matched by prefix so a
// dated alias (claude-haiku-4-5-20251001) resolves to its family price.
const PRICE_PER_MTOK = {
	'claude-fable-5': [10, 50],
	'claude-mythos-5': [10, 50],
	'claude-opus-5': [5, 25],
	// Sonnet 5 list price (intro $2/$10 runs through 2026-08-31; we meter at sticker).
	'claude-sonnet-5': [3, 15],
	'claude-opus-4-8': [5, 25],
	'claude-opus-4-7': [5, 25],
	'claude-opus-4-6': [5, 25],
	'claude-opus-4-5': [5, 25],
	'claude-sonnet-4-6': [3, 15],
	'claude-sonnet-4-5': [3, 15],
	'claude-haiku-4-5': [1, 5],
	'gpt-5.6-sol': [5, 30],
	'gpt-5.6-terra': [2.5, 15],
	'gpt-5.6-luna': [1, 6],
	'gpt-5.5-pro': [30, 180],
	'gpt-5.5': [5, 30],
	'gpt-5.4-pro': [30, 180],
	'gpt-5.4-mini': [0.75, 4.5],
	'gpt-5.4-nano': [0.2, 1.25],
	'gpt-5.4': [2.5, 15],
	'gpt-5.3-codex': [1.75, 14],
	'o3-pro': [20, 80],
	'o3': [2, 8],
	// xAI Grok list prices (docs.x.ai, July 2026). 4.1-fast is the budget tier.
	'grok-4.5': [2, 6],
	'grok-4.3': [1.25, 2.5],
	'grok-4.1-fast': [0.2, 0.5],
	// Deprecated OpenAI family — kept so historical usage_events still price.
	'gpt-4o-mini': [0.15, 0.6],
	'gpt-4o': [2.5, 10],
	'o3-mini': [1.1, 4.4],
	// Vertex Gemini (model id carries the publisher prefix) — billed to the GCP
	// credit grant, so it's metered like a paid model rather than priced to 0.
	'google/gemini-2.5-flash-lite': [0.1, 0.4],
	'gemini-2.5-flash-lite': [0.1, 0.4],
	'google/gemini-2.5-flash': [0.3, 2.5],
	'gemini-2.5-flash': [0.3, 2.5],
	'google/gemini-2.5-pro': [1.25, 10],
	'gemini-2.5-pro': [1.25, 10],
	// OpenRouter IBM Granite (BYOK) — the funded key draws real spend, so it is
	// metered here despite openrouter being a free provider (see isPaidModel).
	'ibm-granite/granite-4.1-8b': [0.05, 0.1],
};

// Providers whose marginal cost to the platform is zero (platform-funded free
// tiers, or keyless anonymous tiers). vertex-gemini is deliberately NOT here —
// it draws down GCP credits. openrouter is deliberately NOT here either: the
// platform key serves both `:free` models and paid vendor mirrors, so freeness
// is a property of the MODEL on that lane, not of the lane (see isFreeLane).
const FREE_PROVIDERS = new Set(['groq', 'nvidia', 'cerebras', 'gemini', 'ovh', 'pollinations']);

// Strip a rung suffix from a provider name: '#n' for multi-key rungs
// (openrouter#2), ':variant' for same-key model variants, '#instant' for the
// Groq step-down. Every rung of a provider meters like its base.
function baseProvider(provider) {
	return String(provider || '').split(/[#:]/)[0];
}

/**
 * The underlying model id behind an OpenRouter route.
 *
 * OpenRouter namespaces every id by vendor (`anthropic/claude-opus-5`,
 * `openai/gpt-5.6-sol`, `x-ai/grok-4.5`), which matches nothing in the price
 * table above, so a mirror of a $5/$25 model used to price to exactly $0.
 * Strip the vendor segment so the mirror prices as the model it actually is.
 * Ids already carrying a table-native prefix (`google/gemini-2.5-flash`,
 * `ibm-granite/granite-4.1-8b`) are left alone by the caller because the table
 * lookup tries the raw id first.
 */
export function openRouterBaseId(model) {
	if (!model) return model;
	const i = model.indexOf('/');
	return i === -1 ? model : model.slice(i + 1);
}

/** Whether an OpenRouter route is the genuinely-free `:free` tier. */
export function isOpenRouterFreeModel(model) {
	return typeof model === 'string' && model.endsWith(':free');
}

/**
 * Whether this provider/model pair costs the platform nothing. Used by the
 * metering audit to tell "served free" apart from "we failed to price it".
 */
export function isFreeLane(provider, model) {
	if (model && isPaidModel(model)) return false;
	if (baseProvider(provider) === 'openrouter') return isOpenRouterFreeModel(model);
	return FREE_PROVIDERS.has(baseProvider(provider));
}

function priceForModel(model) {
	if (!model) return null;
	// Longest-prefix match so 'claude-haiku-4-5-20251001' hits 'claude-haiku-4-5'
	// and never a shorter, wrong family.
	let best = null;
	for (const key of Object.keys(PRICE_PER_MTOK)) {
		if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
	}
	return best ? PRICE_PER_MTOK[best] : null;
}

// Resolve a price for a model, falling back through the two shapes an
// OpenRouter mirror id can take: vendor-namespaced (`anthropic/claude-opus-5`)
// and dotted version segments (`anthropic/claude-haiku-4.5`, where the
// first-party id is `claude-haiku-4-5`). Both resolve to the underlying model's
// price instead of dropping to unknown.
function priceForRoute(model) {
	if (!model) return null;
	const base = openRouterBaseId(model);
	return (
		priceForModel(model) ||
		priceForModel(base) ||
		priceForModel(base.replace(/(\d)\.(\d)/g, '$1-$2'))
	);
}

// Anthropic prompt-cache multipliers against the model's base INPUT price.
// A cache write costs more than a plain input token; a cache read costs a
// tenth. These are ratios, not prices, so they stay correct as list prices
// move. We only ever send the default 5-minute TTL (`{type:'ephemeral'}` with
// no `ttl`), whose write multiplier is 1.25 — the 1h TTL's 2x does not apply.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Cost of one completion in micro-USD.
 *
 * Returns an integer, or **null when the cost is UNKNOWN**, a spending lane
 * whose model has no price and whose provider reported none. Null is not an
 * error path to swallow: `usage_events.cost_micro_usd` is nullable precisely so
 * unknown reads as unknown, and callers log it (see recordLlmSpend). Zero is
 * reserved for lanes that genuinely cost nothing.
 *
 * `reportedCostUsd` is the provider's own charge for the call, in USD, when it
 * tells us (OpenRouter returns `usage.cost` when the request carries
 * `usage: { include: true }`). It is authoritative and overrides the table.
 *
 * `cacheWrite`/`cacheRead` are the Anthropic prompt-caching token counts
 * (`usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens`).
 * They are DISJOINT from `input`: on a cached request the API reports
 * `input_tokens` as the uncached remainder only, so the three must be summed
 * (at their own rates) to price the full prompt. Omitting them would silently
 * under-report spend on every cached call.
 */
export function costMicroUsd({ provider, model, input = 0, output = 0, cacheWrite = 0, cacheRead = 0, reportedCostUsd = null } = {}) {
	// The provider told us what it charged, nothing beats that, including for a
	// lane we have no table price for.
	if (Number.isFinite(reportedCostUsd)) return Math.round(reportedCostUsd * 1_000_000);
	// Genuinely-free lanes: platform-funded free tiers, keyless anonymous tiers,
	// and OpenRouter's `:free` routes. A paid/BYOK model on an otherwise-free
	// transport (OpenRouter Granite, the Claude mirrors) is NOT free and falls
	// through to the table below.
	if (isFreeLane(provider, model)) return 0;
	const price = priceForRoute(model);
	// Unknown on a spending lane. Never 0: a fabricated zero is how a $30
	// OpenRouter burn stayed invisible until the balance was gone.
	if (!price) return null;
	const [inPerM, outPerM] = price;
	// tokens / 1e6 * usdPerM * 1e6 micro-usd  ==  tokens * usdPerM
	const usdMicros =
		input * inPerM +
		output * outPerM +
		cacheWrite * inPerM * CACHE_WRITE_MULTIPLIER +
		cacheRead * inPerM * CACHE_READ_MULTIPLIER;
	return Math.round(usdMicros);
}

// Whether we have a real price for this model (vs. reporting unknown). Lets the
// dashboard distinguish "free provider" from "paid provider we can't price yet".
export function isPriced(model) {
	return priceForRoute(model) != null;
}
