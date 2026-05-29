// Canonical server-side text completion + the platform's LLM provider policy.
//
// Policy (do not re-implement per endpoint — that is how this drifted before):
//
//   • Groq and OpenRouter are PLATFORM-FUNDED. The server holds those keys and
//     callers use them for free. They are the default providers, tried in order.
//
//   • Anthropic is BYOK (bring-your-own-key). It is used ONLY when the caller
//     passes an explicit `anthropicKey` (e.g. an agent owner's own key). The
//     platform never depends on a server-side ANTHROPIC_API_KEY and never
//     hard-fails when it is absent — every flow degrades to the free providers.
//
// Consolidated from the multi-provider fallback that already lived in
// api/persona/extract.js and api/persona/preview.js.

import { env } from './env.js';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// Thrown when no provider is available at all (no free key configured and no
// BYOK key supplied). Carries an HTTP status so handlers can surface it as 503.
export class LlmUnavailableError extends Error {
	constructor(message = 'No LLM provider available. Configure GROQ_API_KEY or OPENROUTER_API_KEY, or supply a BYOK Anthropic key.') {
		super(message);
		this.name = 'LlmUnavailableError';
		this.code = 'llm_unavailable';
		this.status = 503;
	}
}

function anthropicProvider(key, model) {
	const m = model || ANTHROPIC_MODEL;
	return {
		name: 'anthropic',
		model: m,
		url: 'https://api.anthropic.com/v1/messages',
		headers: {
			'content-type': 'application/json',
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
		},
		buildBody: (system, user, maxTokens) => ({
			model: m,
			max_tokens: maxTokens,
			system,
			messages: [{ role: 'user', content: user }],
		}),
		extractText: (r) => r.content?.[0]?.text || '',
		extractUsage: (r) => ({ input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 }),
	};
}

function openaiCompatProvider({ name, key, url, model, extraHeaders = {} }) {
	return {
		name,
		model,
		url,
		headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extraHeaders },
		buildBody: (system, user, maxTokens) => ({
			model,
			max_tokens: maxTokens,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		}),
		extractText: (r) => r.choices?.[0]?.message?.content || '',
		extractUsage: (r) => ({ input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 }),
	};
}

// Build the ordered provider chain for a request. BYOK Anthropic (when the
// caller brings a key) is preferred, then the free platform providers.
function providerChain({ anthropicKey, anthropicModel } = {}) {
	const chain = [];
	if (anthropicKey) chain.push(anthropicProvider(anthropicKey, anthropicModel));
	if (env.GROQ_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'groq',
			key: env.GROQ_API_KEY,
			url: 'https://api.groq.com/openai/v1/chat/completions',
			model: GROQ_MODEL,
		}));
	}
	if (env.OPENROUTER_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'openrouter',
			key: env.OPENROUTER_API_KEY,
			url: 'https://openrouter.ai/api/v1/chat/completions',
			model: OPENROUTER_MODEL,
			extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws' },
		}));
	}
	return chain;
}

// True when at least one provider can serve a completion for the given options.
// Use to gate a feature without making the doomed upstream call.
export function llmConfigured(opts = {}) {
	return providerChain(opts).length > 0;
}

// Run a single-shot system+user completion against the first available
// provider, falling over to the next on transport or non-2xx errors.
//
// Returns { text, provider, model, usage:{input,output}, raw }.
// Throws LlmUnavailableError when no provider is configured, or the last
// upstream error (with .status = 502) when every provider failed.
export async function llmComplete({ system, user, maxTokens = 1024, anthropicKey = null, anthropicModel = null }) {
	const chain = providerChain({ anthropicKey, anthropicModel });
	if (!chain.length) throw new LlmUnavailableError();

	let lastErr;
	for (const p of chain) {
		let upstream;
		try {
			upstream = await fetch(p.url, {
				method: 'POST',
				headers: p.headers,
				body: JSON.stringify(p.buildBody(system, user, maxTokens)),
			});
		} catch (e) {
			lastErr = Object.assign(new Error(`${p.name} unreachable: ${e.message}`), { status: 502, code: 'upstream_unreachable' });
			continue;
		}
		if (!upstream.ok) {
			const body = await upstream.text().catch(() => '');
			lastErr = Object.assign(new Error(`${p.name} ${upstream.status}: ${body.slice(0, 200)}`), { status: 502, code: 'upstream_error' });
			continue;
		}
		const data = await upstream.json();
		return {
			text: (p.extractText(data) || '').trim(),
			provider: p.name,
			model: p.model,
			usage: p.extractUsage(data),
			raw: data,
		};
	}
	throw lastErr || new LlmUnavailableError();
}
