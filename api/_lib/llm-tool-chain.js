// api/_lib/llm-tool-chain.js: the OpenAI-wire tool-calling LLM chain.
//
// Extracted verbatim from api/agents/copilot.js (where it was proven in
// production on the trading copilot) so every server-side tool loop: the
// copilot, the general agent loop at /api/agent/run: runs on the same lanes
// with the same failover semantics. Free platform keys lead, the paid OpenAI
// key is a backstop, and the credits-funded Vertex Gemini anchor is ALWAYS the
// final rung when the GCP project is set. Every provider speaks the OpenAI
// chat-completions wire format (tools + streamed tool_calls), so one reader
// handles them all.

import { env } from './env.js';
import {
	vertexGeminiAvailable,
	vertexGeminiModel,
	vertexGeminiChatUrl,
	vertexGeminiHeaders,
} from './vertex-gemini.js';

// ── provider chain (free-first, OpenAI-compatible tool-calling + streaming) ────
// Mirrors the platform policy in api/_lib/llm.js: free platform keys lead, the
// paid OpenAI key is appended last as a backstop. Every provider here speaks the
// OpenAI chat-completions wire format (tools + streamed tool_calls), so one
// reader handles them all. Anthropic is intentionally omitted from the tool loop
//: the free OpenAI-compatible lanes are the primary path and OpenAI is the paid
// tail; nothing here depends on a paid key existing. The credits-funded Vertex
// Gemini anchor is ALWAYS the final rung when the GCP project is set (api/chat.js
// semantics): the prod OPENAI_API_KEY is billing-dead, so without the anchor a
// simultaneous free-lane throttle 5xx'd the copilot. Exported for the anchor
// regression tests.
export function providerChain() {
	const chain = [];
	if (env.GROQ_API_KEY) {
		chain.push({ name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: env.GROQ_API_KEY, model: 'llama-3.3-70b-versatile' });
	}
	const orKeys = [...new Set([env.OPENROUTER_API_KEY, ...(env.OPENROUTER_FALLBACK_KEYS || [])].filter(Boolean))];
	orKeys.forEach((key, i) => {
		chain.push({
			name: i === 0 ? 'openrouter' : `openrouter#${i + 1}`,
			url: 'https://openrouter.ai/api/v1/chat/completions',
			key,
			model: i === 0 ? 'meta-llama/llama-3.3-70b-instruct' : 'meta-llama/llama-3.3-70b-instruct:free',
			extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws' },
		});
	});
	if (env.NVIDIA_API_KEY) {
		chain.push({ name: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: env.NVIDIA_API_KEY, model: 'meta/llama-3.3-70b-instruct' });
	}
	// Three more free lanes, same OpenAI wire format including tools + streamed
	// tool_calls: SambaNova (Llama 3.3 70B, own quota pool), Mistral (Experiment
	// tier, about 1B free tokens/month), and Z.AI's free GLM Flash lane.
	if (env.SAMBANOVA_API_KEY) {
		chain.push({ name: 'sambanova', url: 'https://api.sambanova.ai/v1/chat/completions', key: env.SAMBANOVA_API_KEY, model: 'Meta-Llama-3.3-70B-Instruct' });
	}
	if (env.MISTRAL_API_KEY) {
		chain.push({ name: 'mistral', url: 'https://api.mistral.ai/v1/chat/completions', key: env.MISTRAL_API_KEY, model: 'mistral-small-latest' });
	}
	if (env.ZAI_API_KEY) {
		chain.push({ name: 'zai', url: 'https://api.z.ai/api/paas/v4/chat/completions', key: env.ZAI_API_KEY, model: 'glm-4.7-flash' });
	}
	if (env.OPENAI_API_KEY) {
		chain.push({ name: 'openai', url: 'https://api.openai.com/v1/chat/completions', key: env.OPENAI_API_KEY, model: 'gpt-5.4-nano' });
	}
	// Vertex Gemini credits anchor: keyless (GCP OAuth token minted per request
	// via getHeaders; see api/_lib/vertex-gemini.js), OpenAI-compatible including
	// tools + streamed tool_calls, billed to platform credits. Appended at the
	// tail unconditionally when available so no present provider key can evict it.
	if (vertexGeminiAvailable()) {
		chain.push({
			name: 'vertex-gemini',
			url: vertexGeminiChatUrl(),
			key: null,
			model: vertexGeminiModel(),
			getHeaders: vertexGeminiHeaders,
		});
	}
	return chain;
}

// Stream one chat-completion round. Emits assistant content deltas via
// onContent; accumulates streamed tool_calls. Resolves { content, toolCalls }.
// Throws on transport / non-2xx so the caller can fail over to the next provider.
export async function streamRound(provider, { messages, tools, onContent }) {
	const body = {
		model: provider.model,
		max_tokens: 1024,
		temperature: 0.4,
		stream: true,
		messages,
	};
	if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
	// Keyless lanes (the Vertex Gemini credits anchor) mint their auth per request
	// via getHeaders; a token-exchange failure throws here and fails over to the
	// next provider exactly like a transport error.
	const headers = provider.getHeaders
		? { ...(await provider.getHeaders()), ...(provider.extraHeaders || {}) }
		: { 'content-type': 'application/json', authorization: `Bearer ${provider.key}`, ...(provider.extraHeaders || {}) };
	const resp = await fetch(provider.url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(45_000),
	});
	if (!resp.ok || !resp.body) {
		const detail = await resp.text().catch(() => '');
		throw Object.assign(new Error(`${provider.name} ${resp.status}: ${detail.slice(0, 180)}`), { status: 502 });
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let content = '';
	const toolCalls = []; // index → { id, name, args }
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (payload === '[DONE]') { buf = ''; break; }
			let evt;
			try { evt = JSON.parse(payload); } catch { continue; }
			const delta = evt.choices?.[0]?.delta;
			if (!delta) continue;
			if (delta.content) { content += delta.content; onContent?.(delta.content); }
			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index ?? 0;
					if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' };
					if (tc.id) toolCalls[idx].id = tc.id;
					if (tc.function?.name) toolCalls[idx].name = tc.function.name;
					if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
				}
			}
		}
	}
	return { content, toolCalls: toolCalls.filter(Boolean) };
}

