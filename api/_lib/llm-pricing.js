// LLM cost model. Converts a provider/model/token-usage triple into a cost in
// micro-USD (1 unit = $0.000001) so usage_events.cost_micro_usd can be summed
// without float drift. This is the single source of truth for "what did that
// call cost us" — the admin spend dashboard reads the events this priced.
//
// Anthropic and OpenAI prices are list price per 1M tokens (input / output),
// current as of each vendor's model catalog. Groq, OpenRouter, and NVIDIA NIM
// are platform-funded free tiers (we hold the key, callers pay nothing), so
// their marginal cost to us is $0 — they are intentionally priced at zero, not
// omitted, so the dashboard can show "calls served free" alongside paid spend.

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
// it draws down GCP credits.
const FREE_PROVIDERS = new Set(['groq', 'openrouter', 'nvidia', 'cerebras', 'gemini', 'ovh', 'pollinations']);

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

// Anthropic prompt-cache multipliers against the model's base INPUT price.
// A cache write costs more than a plain input token; a cache read costs a
// tenth. These are ratios, not prices, so they stay correct as list prices
// move. We only ever send the default 5-minute TTL (`{type:'ephemeral'}` with
// no `ttl`), whose write multiplier is 1.25 — the 1h TTL's 2x does not apply.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Compute the cost of one completion in micro-USD. Returns an integer (rounded)
// or 0 when the provider is free or the model is unpriced — never null, so the
// caller can always record a numeric cost.
//
// `cacheWrite`/`cacheRead` are the Anthropic prompt-caching token counts
// (`usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens`).
// They are DISJOINT from `input`: on a cached request the API reports
// `input_tokens` as the uncached remainder only, so the three must be summed
// (at their own rates) to price the full prompt. Omitting them would silently
// under-report spend on every cached call.
export function costMicroUsd({ provider, model, input = 0, output = 0, cacheWrite = 0, cacheRead = 0 } = {}) {
	// A paid/BYOK model draws real spend even when its transport provider is an
	// otherwise-free tier (e.g. OpenRouter Granite), so it is metered by its list
	// price below rather than zeroed. Genuinely-free models still short-circuit.
	// Provider names carry rung suffixes — '#n' for multi-key (openrouter#2),
	// ':variant' for same-key model variants (openrouter:free), '#instant' for
	// the Groq step-down. Strip them so every rung of a free provider prices
	// to zero.
	if (!(model && isPaidModel(model)) && provider && FREE_PROVIDERS.has(String(provider).split(/[#:]/)[0])) return 0;
	const price = priceForModel(model);
	if (!price) return 0;
	const [inPerM, outPerM] = price;
	// tokens / 1e6 * usdPerM * 1e6 micro-usd  ==  tokens * usdPerM
	const usdMicros =
		input * inPerM +
		output * outPerM +
		cacheWrite * inPerM * CACHE_WRITE_MULTIPLIER +
		cacheRead * inPerM * CACHE_READ_MULTIPLIER;
	return Math.round(usdMicros);
}

// Whether we have a real price for this model (vs. defaulting to 0). Lets the
// dashboard distinguish "free provider" from "paid provider we can't price yet".
export function isPriced(model) {
	return priceForModel(model) != null;
}
