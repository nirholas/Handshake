// POST /api/inference/livepeer — side-by-side LLM inference comparison.
//
// Body: { prompt: string, model?: string, max_tokens?: number, temperature?: number }
// Response:
//   {
//     ok: true,
//     prompt: string,
//     claude:   { ok, reply, latency_ms, model, prompt_tokens, completion_tokens, network: 'Anthropic' },
//     livepeer: { ok, reply, latency_ms, model, prompt_tokens, completion_tokens, gateway: 'studio'|'public', network: 'Livepeer' }
//   }
//
// Both providers are called in parallel via Promise.allSettled so a slow
// or failed Livepeer orchestrator does not block the Claude reply. The
// Livepeer leg routes to:
//   - https://livepeer.studio/api/generate/llm   when LIVEPEER_API_KEY is set
//   - https://dream-gateway.livepeer.cloud/llm   otherwise (public, rate-limited)
//
// We `import 'livepeer'` so the package version is tied to the call shape —
// the npm SDK is built for the same Studio API path we hit by raw fetch. The
// actual request is plain HTTP because the Vercel edge-friendlier path is
// `fetch`, not a heavyweight SDK client.

// eslint-disable-next-line no-unused-vars -- pinned for version parity with the SDK call shape
import { Livepeer } from 'livepeer';
import { env } from '../_lib/env.js';
import { cors, method, readJson, error, json, wrap } from '../_lib/http.js';

export const maxDuration = 60;

const DEFAULT_LIVEPEER_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

// Models known to be available on the Livepeer public/studio gateway as of
// late 2025. Surfaced to the client via the GET handler so the demo's
// settings drawer renders the live list without hard-coding it in HTML.
const LIVEPEER_MODELS = [
	'meta-llama/Meta-Llama-3.1-8B-Instruct',
	'mistralai/Mistral-Nemo-Instruct-2407',
	'Qwen/Qwen2.5-7B-Instruct',
];

function clampPrompt(p) {
	if (typeof p !== 'string') return '';
	return p.trim().slice(0, 8000);
}

function clampInt(n, lo, hi, fallback) {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.min(Math.max(Math.round(v), lo), hi);
}

function clampTemp(n, fallback = 0.7) {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.min(Math.max(v, 0), 2);
}

// ── Claude leg ────────────────────────────────────────────────────────────────

async function callClaude({ prompt, max_tokens, temperature }) {
	// ANTHROPIC_API_KEY is optional (env.opt) — skip the doomed request and
	// report the missing-key state so the comparison still shows the Livepeer leg.
	const key = env.ANTHROPIC_API_KEY;
	if (!key) {
		return {
			ok: false,
			network: 'Anthropic',
			model: CLAUDE_MODEL,
			latency_ms: 0,
			error: 'missing_api_key',
			upstream_body: 'ANTHROPIC_API_KEY is not configured',
		};
	}
	const t0 = Date.now();
	const upstream = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: CLAUDE_MODEL,
			max_tokens,
			temperature,
			messages: [{ role: 'user', content: prompt }],
		}),
	});
	const latency_ms = Date.now() - t0;

	if (!upstream.ok) {
		const body = await upstream.text().catch(() => '');
		return {
			ok: false,
			network: 'Anthropic',
			model: CLAUDE_MODEL,
			latency_ms,
			error: 'upstream_error',
			upstream_status: upstream.status,
			upstream_body: body.slice(0, 1000),
		};
	}

	const data = await upstream.json();
	const reply = (data.content || []).map((c) => c?.text || '').join('').trim();
	return {
		ok: true,
		network: 'Anthropic',
		model: CLAUDE_MODEL,
		latency_ms,
		reply,
		prompt_tokens: data?.usage?.input_tokens ?? null,
		completion_tokens: data?.usage?.output_tokens ?? null,
		stop_reason: data?.stop_reason ?? null,
	};
}

// ── Livepeer leg ──────────────────────────────────────────────────────────────

async function callLivepeer({ prompt, model, max_tokens, temperature }) {
	const useStudio = Boolean(env.LIVEPEER_API_KEY);
	const url = useStudio
		? 'https://livepeer.studio/api/generate/llm'
		: 'https://dream-gateway.livepeer.cloud/llm';
	const gateway = useStudio ? 'studio' : 'public';

	const headers = { 'content-type': 'application/json' };
	if (useStudio) headers.authorization = `Bearer ${env.LIVEPEER_API_KEY}`;

	// Livepeer AI Gateway LLM pipeline accepts an OpenAI-compatible chat
	// completions shape: { model, messages, max_tokens, temperature, stream }.
	// The `messages` array carries the prompt as a single user turn.
	const body = {
		model,
		messages: [{ role: 'user', content: prompt }],
		max_tokens,
		temperature,
		stream: false,
	};

	const t0 = Date.now();
	let upstream;
	try {
		upstream = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
	} catch (e) {
		return {
			ok: false,
			network: 'Livepeer',
			model,
			gateway,
			gateway_url: url,
			latency_ms: Date.now() - t0,
			error: 'network_error',
			error_message: String(e?.message || e),
		};
	}
	const latency_ms = Date.now() - t0;

	if (!upstream.ok) {
		const text = await upstream.text().catch(() => '');
		return {
			ok: false,
			network: 'Livepeer',
			model,
			gateway,
			gateway_url: url,
			latency_ms,
			error: 'upstream_error',
			upstream_status: upstream.status,
			upstream_body: text.slice(0, 1000),
		};
	}

	const data = await upstream.json().catch(() => null);
	if (!data) {
		return {
			ok: false,
			network: 'Livepeer',
			model,
			gateway,
			gateway_url: url,
			latency_ms,
			error: 'parse_error',
		};
	}

	// The Livepeer AI Gateway returns OpenAI-style choices when present, and
	// the older Studio LLM pipeline returns `{ response, tokens_used }`. Handle
	// both so the demo works regardless of which orchestrator answered.
	let reply = '';
	let prompt_tokens = null;
	let completion_tokens = null;

	if (Array.isArray(data.choices) && data.choices.length) {
		const first = data.choices[0];
		reply = first?.message?.content || first?.text || '';
		prompt_tokens = data?.usage?.prompt_tokens ?? null;
		completion_tokens = data?.usage?.completion_tokens ?? null;
	} else if (typeof data.response === 'string') {
		reply = data.response;
		// The legacy shape only reports a single `tokens_used` total; split it
		// best-effort by estimating prompt tokens from the input (≈4 chars/tok).
		const total = Number(data.tokens_used) || 0;
		const estPrompt = Math.min(total, Math.ceil(prompt.length / 4));
		prompt_tokens = estPrompt;
		completion_tokens = Math.max(total - estPrompt, 0);
	} else if (typeof data === 'string') {
		reply = data;
	}

	return {
		ok: Boolean(reply),
		network: 'Livepeer',
		model,
		gateway,
		gateway_url: url,
		latency_ms,
		reply: reply.trim(),
		prompt_tokens,
		completion_tokens,
		...(reply ? {} : { error: 'empty_response', raw: JSON.stringify(data).slice(0, 1000) }),
	};
}

// ── handler ──────────────────────────────────────────────────────────────────

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	if (req.method === 'GET') {
		// Surface the live model list + gateway state so the demo's settings
		// drawer can render without hard-coding it in HTML.
		return json(res, 200, {
			ok: true,
			default_model: DEFAULT_LIVEPEER_MODEL,
			models: LIVEPEER_MODELS,
			gateway: env.LIVEPEER_API_KEY ? 'studio' : 'public',
			gateway_url: env.LIVEPEER_API_KEY
				? 'https://livepeer.studio/api/generate/llm'
				: 'https://dream-gateway.livepeer.cloud/llm',
		});
	}

	if (!method(req, res, ['POST'])) return;

	let body;
	try {
		body = await readJson(req, 200_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const prompt = clampPrompt(body.prompt);
	if (!prompt) return error(res, 400, 'bad_request', 'prompt is required');

	const model = typeof body.model === 'string' && body.model.trim()
		? body.model.trim().slice(0, 200)
		: DEFAULT_LIVEPEER_MODEL;
	const max_tokens = clampInt(body.max_tokens, 32, 2048, 512);
	const temperature = clampTemp(body.temperature, 0.7);

	const [claudeRes, livepeerRes] = await Promise.allSettled([
		callClaude({ prompt, max_tokens, temperature }),
		callLivepeer({ prompt, model, max_tokens, temperature }),
	]);

	const claude = claudeRes.status === 'fulfilled'
		? claudeRes.value
		: {
				ok: false,
				network: 'Anthropic',
				model: CLAUDE_MODEL,
				error: 'leg_failed',
				error_message: String(claudeRes.reason?.message || claudeRes.reason || 'unknown'),
			};

	const livepeer = livepeerRes.status === 'fulfilled'
		? livepeerRes.value
		: {
				ok: false,
				network: 'Livepeer',
				model,
				error: 'leg_failed',
				error_message: String(livepeerRes.reason?.message || livepeerRes.reason || 'unknown'),
			};

	return json(res, 200, {
		ok: true,
		prompt,
		max_tokens,
		temperature,
		claude,
		livepeer,
	});
});
