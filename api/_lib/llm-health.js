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
//   • OpenRouter (primary, env.OPENROUTER_API_KEY) — leads the paid path
//   • Anthropic  (env.ANTHROPIC_API_KEY)           — paid backstop
//   • OpenAI     (env.OPENAI_API_KEY)              — paid backstop
// A provider with no key is simply not probed (omitted from the report) — it is
// not "down", it is "not part of this deployment".
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

const PROBE_TIMEOUT_MS = 5_000;

// Cheapest live model per provider — a max_tokens:1 completion costs a fraction
// of a cent and the probe only reads the HTTP status, not the body.
const OPENROUTER_MODEL = 'openai/gpt-5.6-luna';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = 'gpt-5.6-luna';

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
