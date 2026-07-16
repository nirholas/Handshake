// @ts-check
// Live LLM provider health — the truth behind "AI features are up".
//
// `llm.js` fails over silently across a free-first chain (Groq → OpenRouter →
// NVIDIA → paid Anthropic/OpenAI), which is exactly what keeps user-facing AI
// alive when a provider dies — and exactly what hides a dead provider from ops.
// The June 2026 outage took out all three paid providers at once while chat
// stayed (barely) up on a free-tier OpenRouter key; nobody saw it until users
// hit `:free`-only quality. This module probes the paid providers the platform
// depends on with a near-zero-cost ping (max_tokens: 1) so an outage is visible
// before it degrades the product.
//
// Probed providers mirror the paid tier of the routing chain:
//   • OpenRouter      (primary, env.OPENROUTER_API_KEY) — leads the paid path
//   • Anthropic       (env.ANTHROPIC_API_KEY)           — paid backstop
//   • OpenAI          (env.OPENAI_API_KEY)              — paid backstop
//   • Vertex Gemini   (GOOGLE_CLOUD_PROJECT)            — GCP-credit-billed anchor
//   • Vertex Anthropic (VERTEX_CLAUDE_ENABLED=1)        — GCP-credit-billed Claude
// A provider with no key/config is simply not probed (omitted from the report) —
// it is not "down", it is "not part of this deployment".
//
// The two Vertex rungs matter here specifically because llm.js's real chain
// (providerChain()) already reaches them whenever GOOGLE_CLOUD_PROJECT is set —
// they are the reliability anchor that survives a same-day outage of all three
// third-party paid keys above. Before these were added, this probe (and the
// /api/llm/health dashboard it backs) would report `down`/`degraded` during
// exactly the outage Vertex was already absorbing for real users — a false
// alarm hiding the fact that the platform was fine.
//
// Statuses per provider: 'ok' (2xx) | 'error' (timeout, unreachable, or non-2xx,
// e.g. a 402 out-of-credits or a 401 bad key). `overall` is 'ok' when every
// configured provider passes, 'down' when none do, 'degraded' in between, and
// 'unconfigured' when no paid key is set at all (the free-first chain still
// serves, so that is not an outage — see the overall calc below).
//
// Reused directly (not over HTTP) by api/_lib/forge-health.js and exposed,
// gated, at GET /api/llm/health.

import { env } from './env.js';
import { vertexClaudeEnabled, vertexMessagesUrl, vertexRequestHeaders, toVertexBody } from './vertex-claude.js';

const PROBE_TIMEOUT_MS = 5_000;

// Cheapest live model per provider — a max_tokens:1 completion costs a fraction
// of a cent and the probe only reads the HTTP status, not the body.
const OPENROUTER_MODEL = 'openai/gpt-5.4-nano';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = 'gpt-5.4-nano';
// Same model ids llm.js's real chain uses for these two rungs — see
// vertexGeminiProvider()/vertexAnthropicProvider() there.
const VERTEX_GEMINI_MODEL = process.env.VERTEX_GEMINI_MODEL || 'google/gemini-2.5-flash';

// fetch with a hard 5s timeout; returns the Response (or null on transport
// error) plus the measured round-trip so the report can surface latency.
async function timedFetch(url, options) {
	const started = Date.now();
	try {
		const res = await fetch(url, { ...options, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		return { res, latencyMs: Date.now() - started };
	} catch (err) {
		return { res: null, latencyMs: Date.now() - started, err };
	}
}

// Turn a probe response into a provider verdict. A 2xx means the key authed and
// the account has quota; anything else (timeout, network, 401/402/429/5xx) is an
// error carrying a short, account-detail-free reason.
function judge({ res, latencyMs, err }, model) {
	if (!res) {
		const reason = err?.name === 'TimeoutError' ? `timed out after ${PROBE_TIMEOUT_MS}ms` : 'unreachable';
		return { status: 'error', error: reason, latencyMs };
	}
	if (res.status >= 200 && res.status < 300) {
		return { status: 'ok', model, latencyMs };
	}
	return { status: 'error', error: `${res.status} ${res.statusText || ''}`.trim(), latencyMs };
}

async function probeOpenAiCompat({ key, url, model, extraHeaders = {} }) {
	const r = await timedFetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extraHeaders },
		body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
	});
	return judge(r, model);
}

async function probeAnthropic({ key, model }) {
	const r = await timedFetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
		body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
	});
	return judge(r, model);
}

// Vertex probes authenticate with a GCP OAuth bearer token (vertexRequestHeaders)
// instead of a static API key, so a token-exchange failure (no service-account
// credentials, no aiplatform IAM) is itself a real, reportable 'error' verdict —
// caught here rather than left to throw uncaught.
async function probeVertexGemini() {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	const location = process.env.GOOGLE_CLOUD_LOCATION_GEMINI || 'global';
	const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
	const url = `https://${host}/v1beta1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`;
	try {
		const headers = { 'content-type': 'application/json', ...(await vertexRequestHeaders()) };
		const r = await timedFetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({ model: VERTEX_GEMINI_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
		});
		return judge(r, VERTEX_GEMINI_MODEL);
	} catch (err) {
		return { status: 'error', error: `token exchange failed: ${err?.message || 'unknown'}`, latencyMs: 0 };
	}
}

async function probeVertexAnthropic({ model }) {
	try {
		const headers = await vertexRequestHeaders();
		const r = await timedFetch(vertexMessagesUrl(model, { stream: false }), {
			method: 'POST',
			headers,
			body: JSON.stringify(toVertexBody({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })),
		});
		return judge(r, model);
	} catch (err) {
		return { status: 'error', error: `token exchange failed: ${err?.message || 'unknown'}`, latencyMs: 0 };
	}
}

// Probe every configured paid provider in parallel and fold the per-provider
// verdicts into one `overall`. Returns { [provider]: verdict, ..., overall }.
export async function probeLlmHealth() {
	const probes = [];
	if (env.OPENROUTER_API_KEY) {
		probes.push([
			'openrouter',
			probeOpenAiCompat({
				key: env.OPENROUTER_API_KEY,
				url: 'https://openrouter.ai/api/v1/chat/completions',
				model: OPENROUTER_MODEL,
				extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws' },
			}),
		]);
	}
	if (env.ANTHROPIC_API_KEY) {
		probes.push(['anthropic', probeAnthropic({ key: env.ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL })]);
	}
	if (env.OPENAI_API_KEY) {
		probes.push([
			'openai',
			probeOpenAiCompat({
				key: env.OPENAI_API_KEY,
				url: 'https://api.openai.com/v1/chat/completions',
				model: OPENAI_MODEL,
			}),
		]);
	}
	// Same gate llm.js's real chain uses (providerChain(): `if
	// (process.env.GOOGLE_CLOUD_PROJECT) chain.push(vertexGeminiProvider())`) —
	// probed whenever the chain would actually reach for it, not behind a
	// separate flag.
	if (process.env.GOOGLE_CLOUD_PROJECT) {
		probes.push(['vertex-gemini', probeVertexGemini()]);
	}
	if (vertexClaudeEnabled()) {
		probes.push(['vertex-anthropic', probeVertexAnthropic({ model: ANTHROPIC_MODEL })]);
	}

	const verdicts = await Promise.all(probes.map(async ([name, p]) => [name, await p]));
	const report = Object.fromEntries(verdicts);

	const total = verdicts.length;
	const passed = verdicts.filter(([, v]) => v.status === 'ok').length;
	let overall;
	// No paid key on this deployment is not an outage: the free-first chain
	// (Groq / OpenRouter-free / NVIDIA) still serves, so report 'unconfigured'
	// rather than 'down' — otherwise a free-only install would page ops forever
	// and permanently degrade forge?health against the platform's own policy.
	if (total === 0) overall = 'unconfigured';
	else if (passed === 0) overall = 'down';
	else if (passed === total) overall = 'ok';
	else overall = 'degraded';

	report.overall = overall;
	return report;
}
