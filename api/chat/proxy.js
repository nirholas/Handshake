import { env } from '../_lib/env.js';
import { cors, error, json, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isFreeModelId, isLiveFreeModel, pickDefaultFreeModel } from '../_lib/openrouter-free.js';
import { AGENT_MODEL_ID, runAgentCompletion } from '../agent/run.js';

const UPGRADE_URL = `${env.APP_ORIGIN}/pricing`;

// How many live models to try before giving up. OpenRouter retires `:free`
// endpoints without notice, and a saved conversation can name one for months
// afterwards; rolling over to a live model keeps that chat working instead of
// surfacing the upstream's raw "This model is unavailable for free" text.
const MAX_MODEL_ATTEMPTS = 3;

/**
 * Seconds to wait after an upstream 429, when OpenRouter sent no Retry-After.
 * It answers the free-tier quota cap with the reset time buried in the error
 * body (`error.metadata.headers['X-RateLimit-Reset']`, epoch milliseconds)
 * instead of a header, so without this a quota-exhausted response reached the
 * browser carrying no backoff hint at all and clients could only guess or spin.
 * Reading the body is safe here: nothing has been streamed to the client yet.
 */
async function retryAfterFromBody(upstream) {
	let reset;
	try {
		const parsed = JSON.parse(await upstream.text());
		reset = Number(parsed?.error?.metadata?.headers?.['X-RateLimit-Reset']);
	} catch {
		return null;
	}
	if (!Number.isFinite(reset) || reset <= 0) return null;
	const seconds = Math.ceil((reset - Date.now()) / 1000);
	// A reset already in the past means the window just rolled: tell the caller to
	// retry now rather than emitting a negative (and so ignored) Retry-After.
	return String(Math.max(1, seconds));
}

/** Upstream said the named model is gone / not free — not that the request was bad. */
function isModelUnavailable(status, body) {
	if (status !== 400 && status !== 404) return false;
	return /unavailable for free|no endpoints found|not a valid model|no allowed providers|is not available/i.test(
		body,
	);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// Anonymous proxy — only :free models pass the gate below, but the upstream
	// free-tier quota is shared across our OpenRouter key. Cap per-IP to prevent
	// a single client from draining the free quota and rate-limiting everyone.
	const ip = clientIp(req);
	const rl = await limits.chatIp(ip);
	if (!rl.success) {
		// rateLimited() sets a standards-correct Retry-After from the limiter result.
		return rateLimited(res, rl);
	}

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status ?? 400, 'bad_request', err.message);
	}

	// The virtual agent-loop model: same wire format in and out, but answered by
	// the server-side tool loop instead of OpenRouter. The chatIp limit above
	// already counted this request, so the loop skips its own limiter. Branches
	// before the OpenRouter key check on purpose: the loop runs on its own
	// provider chain (Groq / Vertex / …) and does not need an OpenRouter key.
	if (body?.model === AGENT_MODEL_ID) {
		return runAgentCompletion(req, res, body, { rateLimited: true });
	}

	if (!env.OPENROUTER_API_KEY && !env.OPENROUTER_FALLBACK_KEYS.length)
		return error(res, 503, 'not_configured', 'Built-in model not available');

	const model = body?.model;
	// Only allow free-tier OpenRouter models to prevent abuse.
	if (!isFreeModelId(model))
		return error(res, 400, 'invalid_model', 'Only free-tier models (ending in :free) are allowed via the built-in proxy');

	// A model that OpenRouter no longer serves is swapped for a live one BEFORE
	// the call, so a stale saved conversation costs no round-trip. When the live
	// list is unreachable the model is taken at face value and the post-call
	// rollover below is the safety net.
	let activeModel = model;
	if (!(await isLiveFreeModel(model))) {
		activeModel = (await pickDefaultFreeModel({ exclude: [model] })) ?? model;
	}

	// The message goes upstream as written. This proxy adds no content filter of
	// its own: the serving model's own judgment is the only safety layer, and a
	// refusal, if any, is the model's to make and to word. Abuse control here is
	// the per-IP quota above plus the free-model-only gate, not pre-screening.
	// Owner directive 2026-08-07.

	// Only :free models pass the gate above, so any configured key can serve the
	// request. Rotate to the next key on account-level failures (bad key, out of
	// credits, rate limit) — rotation happens before any byte is streamed, so a
	// retry is always safe. Other statuses (4xx from a bad request, 5xx) are
	// final: every key would fail the same way.
	const keys = [...new Set([env.OPENROUTER_API_KEY, ...env.OPENROUTER_FALLBACK_KEYS].filter(Boolean))];
	let upstream;
	const tried = [];
	for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt += 1) {
		tried.push(activeModel);
		for (const [i, key] of keys.entries()) {
			upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${key}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://three.ws',
					'X-Title': 'three.ws chat',
				},
				body: JSON.stringify({ ...body, model: activeModel }),
			});
			if (![401, 402, 403, 429].includes(upstream.status) || i === keys.length - 1) break;
			// Release the abandoned response so its connection returns to the pool.
			await upstream.body?.cancel()?.catch?.(() => {});
		}

		// A retired model answers identically on every key, so rolling the model
		// is the only recovery. Reading the body here is safe: nothing has been
		// streamed to the client yet.
		if (upstream.status !== 400 && upstream.status !== 404) break;
		const failedBody = await upstream.text();
		if (!isModelUnavailable(upstream.status, failedBody)) {
			// A genuine bad request — hand the upstream's own explanation back.
			res.statusCode = upstream.status;
			res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
			res.setHeader('cache-control', 'no-store');
			res.end(failedBody);
			return;
		}
		// Either way the current response is spent: roll to the next live model,
		// or fall through to the friendly 503 below. Never re-read this body.
		const next = await pickDefaultFreeModel({ exclude: tried });
		upstream = null;
		if (!next) break;
		activeModel = next;
	}

	if (!upstream) {
		return error(
			res,
			503,
			'no_free_model',
			'Every free model is unavailable right now. Please try again in a moment.',
		);
	}

	if (upstream.status === 402) {
		const upstreamBody = await upstream.text();
		const reason = /no_credits|insufficient/i.test(upstreamBody) ? 'no_credits' : 'plan_required';
		return json(res, 402, {
			error: 'payment_required',
			error_description: 'Built-in model requires a funded plan',
			reason,
			upgradeUrl: UPGRADE_URL,
		});
	}

	if (upstream.status === 429) {
		const retryAfter =
			upstream.headers.get('retry-after') ||
			upstream.headers.get('x-ratelimit-reset-requests') ||
			(await retryAfterFromBody(upstream));
		if (retryAfter) res.setHeader('retry-after', String(retryAfter));
		return json(res, 429, {
			error: 'rate_limited',
			error_description: 'The built-in model is rate-limited. Please wait a moment and try again.',
			...(retryAfter ? { retry_after: retryAfter } : {}),
		});
	}

	res.statusCode = upstream.status;
	const ct = upstream.headers.get('content-type') ?? 'application/json';
	res.setHeader('content-type', ct);
	res.setHeader('cache-control', 'no-store');

	if (!upstream.body) {
		res.end(await upstream.text());
		return;
	}

	// Stream SSE response directly back to the browser
	const reader = upstream.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(value);
		}
	} finally {
		res.end();
	}
});
