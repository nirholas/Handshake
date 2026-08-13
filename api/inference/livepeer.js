// POST /api/inference/livepeer: side-by-side LLM inference comparison.
//
// Body: { prompt: string, model?: string, max_tokens?: number, temperature?: number }
// Response:
//   {
//     ok: true,
//     prompt: string,
//     platform: { ok, reply, latency_ms, provider, model, prompt_tokens, completion_tokens, network: 'three.ws' },
//     livepeer: { ok, reply, latency_ms, model, prompt_tokens, completion_tokens, gateway: 'override'|'studio'|'public', network: 'Livepeer' }
//   }
//
// `platform` is the three.ws inference chain (api/_lib/llm.js), which picks
// whichever provider answers first; `provider` and `model` always name the one
// that actually replied, so the card never claims a vendor that did not run.
//
// Both legs are called in parallel via Promise.allSettled so a slow or failed
// Livepeer orchestrator does not block the platform reply, and each leg
// reports its own ok/error rather than failing the whole request: a
// comparison demo that 500s when one side is down shows nothing.
//
// The Livepeer gateway is resolved by api/_lib/livepeer-gateway.js, shared
// with the text-to-image federation provider, so the network's URLs and the
// LIVEPEER_GATEWAY_URL override live in one file. This leg appends the
// gateway's OpenAI-compatible `/llm` path and posts with plain `fetch` rather
// than the npm SDK: the SDK client is a heavyweight dependency to load per
// cold start for a single JSON POST.
//
// Gateway health note: the no-key public dream gateway has not been Livepeer
// since 2026-08-12 (its hostname resolves to an unrelated host, see
// docs/ops/livepeer-federation.md). An unkeyed deployment therefore reports
// `gateway_unavailable` without dialing, instead of shipping the user's
// prompt at whoever now answers for that name.

import { llmComplete } from '../_lib/llm.js';
import {
	livepeerGatewayConfig,
	livepeerGatewayUsable,
	PUBLIC_GATEWAY_NOTE,
} from '../_lib/livepeer-gateway.js';
import { env } from '../_lib/env.js';
import { cors, method, readJson, error, json, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

export const maxDuration = 60;

const DEFAULT_LIVEPEER_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct';

// Per-leg wall-clock ceiling, well under maxDuration so one hung orchestrator
// cannot eat the whole function budget and strand the other leg's finished
// answer. The platform leg passes the same budget into the provider chain.
const LEG_TIMEOUT_MS = 45_000;

// Shown on any failure of a gateway we did dial. Orchestrators on the network
// come and go per model, so the actionable move is another model, not a retry
// of the same one.
const GATEWAY_RETRY_HINT =
	'An orchestrator serving this model may be offline. Pick another model in settings and run again.';

// Resolve the gateway and the LLM endpoint on it in one place.
function llmGateway() {
	const cfg = livepeerGatewayConfig();
	return { ...cfg, url: `${cfg.base}/llm`, usable: livepeerGatewayUsable(cfg.gateway) };
}

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

// Reply text out of an OpenAI-compatible `message.content`.
//
// Orchestrators on the network run different inference servers, and the
// OpenAI chat schema allows content to be either a plain string or an array
// of typed parts. Treating the array case as a string turned a perfectly
// valid gateway answer into a TypeError inside the leg, which surfaced as a
// bare `leg_failed` with a JS message in the demo card. Normalize both here,
// at the boundary, so everything downstream holds a string.
function replyText(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
			.join('');
	}
	return '';
}

// Platform LLM leg.
//
// The non-Livepeer side of the comparison runs on the platform's funded free
// providers by default and upgrades to Anthropic when the operator supplies a
// key, matching the platform-wide BYOK policy. The chain owns the choice, so
// `provider`/`model` report whichever rung actually answered rather than a
// vendor name fixed at build time.

async function callPlatformLlm({ prompt, max_tokens }) {
	const t0 = Date.now();
	let result;
	try {
		result = await llmComplete({
			user: prompt,
			maxTokens: max_tokens,
			anthropicKey: env.ANTHROPIC_API_KEY,
			timeoutMs: LEG_TIMEOUT_MS,
		});
	} catch (e) {
		return {
			ok: false,
			network: 'three.ws',
			provider: null,
			model: null,
			latency_ms: Date.now() - t0,
			error: e.code === 'llm_unavailable' ? 'no_provider_configured' : 'upstream_error',
			upstream_body: String(e?.message || e).slice(0, 1000),
		};
	}
	return {
		ok: true,
		network: 'three.ws',
		provider: result.provider,
		model: result.model,
		latency_ms: Date.now() - t0,
		reply: (result.text || '').trim(),
		prompt_tokens: result.usage?.input ?? null,
		completion_tokens: result.usage?.output ?? null,
	};
}

// Livepeer leg.

async function callLivepeer({ prompt, model, max_tokens, temperature }) {
	const { url, gateway, key, usable } = llmGateway();

	// Refused, not attempted: the only gateway left on the no-key path is a
	// hostname that no longer answers for Livepeer, and a retry loop against it
	// would be an outbound copy of the user's prompt to an unidentified host.
	if (!usable) {
		return {
			ok: false,
			network: 'Livepeer',
			model,
			gateway,
			gateway_url: url,
			latency_ms: 0,
			error: 'gateway_unavailable',
			hint: PUBLIC_GATEWAY_NOTE,
		};
	}

	const headers = { 'content-type': 'application/json' };
	if (key) headers.authorization = `Bearer ${key}`;

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
			// A federated orchestrator can accept the connection and then sit on
			// it. Without this ceiling that stall becomes the request's, and the
			// platform leg's finished answer never reaches the caller.
			signal: AbortSignal.timeout(LEG_TIMEOUT_MS),
		});
	} catch (e) {
		// A socket/DNS/TLS failure here is the gateway being down, and an abort
		// is it being too slow to be part of a side-by-side comparison. Code the
		// two distinctly so the demo can say which one happened.
		const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
		return {
			ok: false,
			network: 'Livepeer',
			model,
			gateway,
			gateway_url: url,
			latency_ms: Date.now() - t0,
			error: timedOut ? 'gateway_timeout' : 'gateway_unreachable',
			error_message: timedOut
				? `no response within ${Math.round(LEG_TIMEOUT_MS / 1000)}s`
				: String(e?.message || e),
			hint: GATEWAY_RETRY_HINT,
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
			hint: GATEWAY_RETRY_HINT,
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
		reply = replyText(first?.message?.content) || replyText(first?.text);
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

// Handler.

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	if (req.method === 'GET') {
		// Surface the live model list + gateway state so the demo's settings
		// drawer can render without hard-coding it in HTML. `keyed` and `usable`
		// let the client say, before a run, that the Livepeer leg cannot answer
		// on this deployment and which env var fixes it.
		const { url, gateway, key, usable } = llmGateway();
		return json(res, 200, {
			ok: true,
			default_model: DEFAULT_LIVEPEER_MODEL,
			models: LIVEPEER_MODELS,
			gateway,
			gateway_url: url,
			keyed: Boolean(key),
			usable,
			...(usable ? {} : { hint: PUBLIC_GATEWAY_NOTE }),
		});
	}

	if (!method(req, res, ['POST'])) return;

	const rl = await limits.livepeerIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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

	const [platformRes, livepeerRes] = await Promise.allSettled([
		callPlatformLlm({ prompt, max_tokens }),
		callLivepeer({ prompt, model, max_tokens, temperature }),
	]);

	const platform = platformRes.status === 'fulfilled'
		? platformRes.value
		: {
				ok: false,
				network: 'three.ws',
				provider: null,
				model: null,
				error: 'leg_failed',
				error_message: String(platformRes.reason?.message || platformRes.reason || 'unknown'),
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
		platform,
		livepeer,
	});
});
