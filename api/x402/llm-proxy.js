// POST /api/x402/llm-proxy   { model, prompt, max_tokens }
//
// Paid LLM inference proxy — x402 micropayment endpoint for agents that want
// to run one-shot text completions without an API key of their own. Payment
// unlocks one completion through the platform's free-first provider chain:
// Groq leads for "fast" requests (sub-second latency), the full chain
// (Groq → OpenRouter → NVIDIA NIM → Anthropic) covers fallback. The
// response always includes measured wall-clock latency, token counts, and
// the actual provider/model used so callers can benchmark the route.
//
// The autonomous loop calls this every 10 minutes with a minimal "Count to 3."
// prompt to benchmark p95 latency and alert when it exceeds 3 seconds
// (api/_lib/x402/autonomous-registry.js → 'llm-proxy-latency').
//
// Body:  { model: "fast"|"smart"|string, prompt: string, max_tokens?: number }
// Price: $0.005 USDC (5 000 atomics) — covers one cheap completion
//
// Response 200:
//   { content, model, provider, latency_ms, tokens_used, input_tokens, output_tokens }

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { llmComplete } from '../_lib/llm.js';
import llmProxyListing from '../_lib/service-catalog/services/llm-proxy.js';

const ROUTE = '/api/x402/llm-proxy';

// Map the caller-facing model alias to llmComplete options.
// "fast"  → Groq leads the free chain (sub-second latency, sufficient for short prompts)
// "smart" → same chain, Anthropic backstop moves to the preferred position via anthropicModel
// any other string → treated as a direct anthropicModel hint (falls through to paid backstop)
function resolveModelOpts(modelAlias) {
	if (!modelAlias || modelAlias === 'fast') {
		return { preferNvidia: false }; // default free chain, Groq leads
	}
	if (modelAlias === 'smart') {
		return { anthropicModel: 'claude-haiku-4-5-20251001', preferNvidia: false };
	}
	// Treat the string as an explicit anthropicModel (last-resort paid lane only).
	return { anthropicModel: String(modelAlias), preferNvidia: false };
}

// Single source of truth: api/_lib/service-catalog/services/llm-proxy.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = llmProxyListing.description;

const INPUT_EXAMPLE = {
	model: 'fast',
	prompt: 'Count to 3.',
	max_tokens: 10,
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['prompt'],
	properties: {
		model: {
			type: 'string',
			default: 'fast',
			description: '"fast" (default, Groq), "smart" (Anthropic Haiku), or a specific model string.',
		},
		prompt: {
			type: 'string',
			minLength: 1,
			maxLength: 4000,
			description: 'The user prompt to complete.',
		},
		max_tokens: {
			type: 'integer',
			minimum: 1,
			maximum: 2048,
			default: 256,
			description: 'Maximum tokens to generate.',
		},
	},
};

const OUTPUT_EXAMPLE = {
	content: '1, 2, 3.',
	model: 'llama-3.3-70b-versatile',
	provider: 'groq',
	latency_ms: 312,
	tokens_used: 11,
	input_tokens: 5,
	output_tokens: 6,
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['content', 'model', 'provider', 'latency_ms', 'tokens_used'],
	properties: {
		content: { type: 'string' },
		model: { type: 'string' },
		provider: { type: 'string' },
		latency_ms: { type: 'integer' },
		tokens_used: { type: 'integer' },
		input_tokens: { type: 'integer' },
		output_tokens: { type: 'integer' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyType: 'json',
			body: INPUT_EXAMPLE,
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: 5_000, // $0.005 USDC
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws LLM Inference Proxy',
		tags: ['llm', 'inference', 'completion', 'proxy', 'benchmark'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const chunks = [await readBody(req, 1_000_000)];
		const rawBody = Buffer.concat(chunks).toString();

		let body;
		try {
			body = JSON.parse(rawBody);
		} catch {
			const err = new Error('Request body must be valid JSON');
			err.status = 400;
			err.code = 'invalid_json';
			throw err;
		}

		const prompt = String(body?.prompt || '').trim();
		if (!prompt) {
			const err = new Error('"prompt" is required');
			err.status = 400;
			err.code = 'missing_prompt';
			throw err;
		}
		if (prompt.length > 4000) {
			const err = new Error('"prompt" must be at most 4000 characters');
			err.status = 400;
			err.code = 'prompt_too_long';
			throw err;
		}

		const maxTokens = Math.min(Math.max(parseInt(body?.max_tokens ?? 256, 10) || 256, 1), 2048);
		const modelAlias = body?.model || 'fast';
		const opts = resolveModelOpts(modelAlias);

		const t0 = Date.now();
		const result = await llmComplete({
			system: 'You are a helpful assistant. Be concise.',
			user: prompt,
			maxTokens,
			...opts,
			timeoutMs: 15_000,
		});
		const latencyMs = Date.now() - t0;

		const inputTokens = result.usage?.input ?? 0;
		const outputTokens = result.usage?.output ?? 0;

		return {
			content: result.text,
			model: result.model,
			provider: result.provider,
			latency_ms: latencyMs,
			tokens_used: inputTokens + outputTokens,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
		};
	},
});
