// Aggregator engine — runs a registered third-party API endpoint
// (api/v1/_providers.js) as part of the unified three.ws API.
//
// One function does the real upstream work (executeUpstream); the catch-all
// route picks the billing model and calls it. The x402 pay-per-call path is
// delegated to the platform's existing paidEndpoint rail (api/_lib/
// x402-paid-endpoint.js) so aggregated endpoints settle real USDC and appear
// in the x402 bazaar — no second payment implementation.

import { paidEndpoint } from './x402-paid-endpoint.js';
import { buildBazaarSchema } from './x402-spec.js';
import { installAccessControl } from './x402/access-control.js';
import { withService } from './x402/bazaar-helpers.js';
import { readBody } from './http.js';

const UPSTREAM_TIMEOUT_MS = 20_000;

// The external HTTPS load balancer cuts every response at 30s (three-ws-backend
// timeoutSec: 30), so the whole call, retries included, must answer inside
// that. One shared deadline per executeUpstream call; every attempt's abort
// timer fits in whatever remains, and a retry never starts with less than
// MIN_ATTEMPT_MS on the clock. Without this, a blackholed primary (20s) plus
// one alternate (20s) overruns the LB and the caller sees its 502 instead of
// our answer.
const TOTAL_UPSTREAM_BUDGET_MS = 25_000;
const MIN_ATTEMPT_MS = 1_000;

// A pooled provider treats a host this slow as down: aborting early leaves
// budget to actually use the alternates the pool exists for. Single-host
// providers keep the full UPSTREAM_TIMEOUT_MS, since waiting is all they can do.
const POOLED_ATTEMPT_TIMEOUT_MS = 10_000;

// How many distinct upstream hosts one call may try before giving up. Only
// applies to providers that declare alternates (`provider.bases`); everything
// else makes exactly one attempt, as before.
const MAX_UPSTREAM_ATTEMPTS = 3;

// Failure classes worth re-trying against a different host for the same
// provider. A 4xx other than 429 is the caller's fault and repeats identically
// everywhere, so it is never retried.
const RETRYABLE_CODES = new Set(['upstream_rate_limited', 'upstream_unreachable']);
const isRetryable = (err) => RETRYABLE_CODES.has(err?.code) || err?.status === 502;

// Short per-host memory of retryable failures. Without it, every request
// re-discovers a dead primary the hard way (worst case the full 20s timeout)
// before failing over; with it, only the first request of an outage pays that
// cost and the rest go straight to a healthy alternate. State is per-instance
// (each Cloud Run instance learns on its own), which is fine: the window is
// short and a wrong guess only reorders attempts, never removes them.
const HOST_COOLDOWN_MS = 30_000;
const _hostCooldowns = new Map(); // base URL -> epoch ms until the host is trusted again

const coolingDown = (base) => (_hostCooldowns.get(base) ?? 0) > Date.now();
const markBad = (base) => _hostCooldowns.set(base, Date.now() + HOST_COOLDOWN_MS);
const markGood = (base) => _hostCooldowns.delete(base);

/** Clear per-host failure memory. Exported for tests, which share module state. */
export function resetUpstreamHealth() {
	_hostCooldowns.clear();
}

// Alternate hosts for a provider, primary first, resolved lazily and only when
// the primary has already failed — a provider like `solana` fronts a pool of
// interchangeable RPC endpoints, and resolving that pool can be expensive
// (api/_lib/solana/connection.js pulls in @solana/web3.js), so the happy path
// never pays for it.
async function alternateBases(provider) {
	if (typeof provider.bases !== 'function') return [];
	try {
		const list = await provider.bases();
		return Array.isArray(list) ? list.filter((b) => typeof b === 'string' && b && b !== provider.base) : [];
	} catch {
		return [];
	}
}

/**
 * Resolve the upstream key to use for a call.
 * BYOK (caller-supplied) wins; else the platform env key; else null.
 * @returns {{ key: string|null, source: 'byok'|'platform'|'none' }}
 */
export function resolveUpstreamKey(provider, byokKey) {
	if (byokKey) return { key: byokKey, source: 'byok' };
	const envKey = provider.envVar ? process.env[provider.envVar] : null;
	if (envKey) return { key: envKey, source: 'platform' };
	return { key: null, source: 'none' };
}

/**
 * Perform the real upstream request and return the normalized payload.
 * Throws an Error with `.status` + `.code` on any failure (mapped by wrap()).
 *
 * @param {object} args
 * @param {object} args.provider   provider descriptor
 * @param {object} args.endpoint   endpoint descriptor
 * @param {Record<string,any>} args.query  request query params
 * @param {any} [args.body]        parsed request body (POST)
 * @param {string|null} args.apiKey  resolved upstream key (or null)
 */
export async function executeUpstream({ provider, endpoint, query = {}, body, apiKey }) {
	if (provider.requiresKey && !apiKey) {
		const err = new Error(
			`${provider.name} requires an API key — supply your own via the "${provider.byokHeader}" header, ` +
				`or this deployment must set ${provider.envVar}`,
		);
		err.status = 503;
		err.code = 'not_configured';
		throw err;
	}

	const path = typeof endpoint.path === 'function' ? endpoint.path(query) : endpoint.path;

	// `endpoint.method` is the caller-facing HTTP verb (what the aggregator front
	// door requires the request to use); `endpoint.upstreamMethod` — optional,
	// only set when they differ — is what we actually send upstream. This exists
	// for read-only JSON-RPC upstreams (e.g. Solana) that are POST-only on the
	// wire: the public surface stays a plain GET (agent-friendly, cacheable,
	// no body to construct), while the upstream call is a POST built from the
	// caller's query params. See the `solana` provider in api/v1/_providers.js.
	const upstreamMethod = endpoint.upstreamMethod || endpoint.method;

	const hasPool = typeof provider.bases === 'function';
	const deadline = Date.now() + TOTAL_UPSTREAM_BUDGET_MS;
	const perAttemptCap = hasPool ? POOLED_ATTEMPT_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;

	// One attempt against one upstream host. Everything host-independent (the
	// query builder, the body builder) is re-run per attempt because applyKey may
	// write the key into the URL, which differs per host.
	const attempt = async (base) => {
		const url = new URL(base + path);

		if (endpoint.method === 'GET' && endpoint.query) {
			for (const [k, v] of Object.entries(endpoint.query(query))) {
				if (v != null && v !== '') url.searchParams.set(k, String(v));
			}
		}

		const headers = { accept: 'application/json' };
		let outBody;
		if (upstreamMethod === 'POST') {
			// A GET-caller/POST-upstream endpoint has no caller body to forward — its
			// `body()` builder consumes the caller's query params instead.
			outBody = endpoint.body ? endpoint.body(endpoint.method === 'GET' ? query : body) : body;
			headers['content-type'] = 'application/json';
		}
		provider.applyKey(headers, url, apiKey);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(perAttemptCap, deadline - Date.now()));
		let res;
		try {
			res = await fetch(url, {
				method: upstreamMethod,
				headers,
				body: outBody != null ? JSON.stringify(outBody) : undefined,
				signal: controller.signal,
			});
		} catch (err) {
			clearTimeout(timer);
			const e = new Error(`${provider.name} is unreachable`);
			e.status = 504;
			e.code = 'upstream_unreachable';
			e.cause = err;
			throw e;
		}
		clearTimeout(timer);

		const text = await res.text();
		let data;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = text;
		}

		if (!res.ok) {
			const e = new Error(
				`${provider.name} returned ${res.status} for ${endpoint.id}`,
			);
			// Map upstream 5xx to 502 (we're the proxy); pass client-fault 4xx through.
			e.status = res.status >= 500 ? 502 : res.status;
			e.code = res.status === 429 ? 'upstream_rate_limited' : 'upstream_error';
			e.detail = typeof data === 'object' ? data : { message: String(data).slice(0, 300) };
			throw e;
		}

		return endpoint.transform ? endpoint.transform(data) : data;
	};

	// A provider whose upstream is a pool of interchangeable hosts (Solana RPC)
	// should not hand the caller a 429 while a healthy alternate sits unused:
	// the free lane's rate-limit passthrough was the second-largest error class
	// on the aggregator. Providers with no alternates make exactly one attempt,
	// as before, so this costs a single-host provider nothing.
	//
	// The cooldown map feeds in here: a primary that failed a retryable way in
	// the last HOST_COOLDOWN_MS is skipped up front (only when alternates exist
	// to take its place), and alternates are tried freshest-first.
	const primaryCooling = coolingDown(provider.base) && typeof provider.bases === 'function';

	let firstErr;
	if (!primaryCooling) {
		try {
			const out = await attempt(provider.base);
			markGood(provider.base);
			return out;
		} catch (err) {
			if (!isRetryable(err)) throw err;
			markBad(provider.base);
			firstErr = err;
		}
	}

	const alternates = await alternateBases(provider);
	if (!alternates.length) {
		if (firstErr) throw firstErr;
		// The primary was skipped for cooldown but the pool came back empty:
		// try it anyway rather than failing without a single attempt.
		const out = await attempt(provider.base);
		markGood(provider.base);
		return out;
	}

	// Healthy-looking alternates first, recently-failed ones after, and a
	// skipped primary last so pool exhaustion still gives it one chance.
	const ordered = [
		...alternates.filter((b) => !coolingDown(b)),
		...alternates.filter((b) => coolingDown(b)),
		...(primaryCooling ? [provider.base] : []),
	];

	let lastErr = firstErr ?? null;
	const budget = MAX_UPSTREAM_ATTEMPTS - (firstErr ? 1 : 0);
	for (const base of ordered.slice(0, budget)) {
		// A retry that cannot get a meaningful slice of the deadline is not worth
		// starting; surface the best error we have while the LB is still listening.
		if (lastErr && deadline - Date.now() < MIN_ATTEMPT_MS) break;
		try {
			const out = await attempt(base);
			markGood(base);
			return out;
		} catch (next) {
			if (!isRetryable(next)) throw next;
			markBad(base);
			lastErr = next;
		}
	}
	throw lastErr;
}

// ── x402 pay-per-call path ────────────────────────────────────────────────────
// Lazily build (and cache) one paidEndpoint handler per descriptor. The handler
// runs the SAME executeUpstream with the platform key, so a paying caller and a
// plan/BYOK caller hit identical upstream logic.
const _paidHandlers = new Map();

export function getPaidHandler(provider, endpoint) {
	const key = `${provider.id}/${endpoint.id}`;
	if (_paidHandlers.has(key)) return _paidHandlers.get(key);

	const route = `/api/v1/x/${provider.id}/${endpoint.id}`;
	const description =
		`three.ws API — ${provider.name}: ${endpoint.summary} ` +
		`Pay per call in USDC, or use a three.ws API key / your own ${provider.name} key.`;

	const bazaar = {
		discoverable: true,
		info: {
			input: { type: 'http', method: endpoint.method, queryParams: endpoint.params || {} },
			output: { type: 'json', example: {} },
		},
		schema: buildBazaarSchema({
			method: endpoint.method,
			queryParamsSchema: { type: 'object' },
			outputSchema: { type: 'object' },
		}),
	};

	const handler = paidEndpoint({
		route,
		method: endpoint.method,
		priceAtomics: endpoint.priceAtomics,
		networks: ['base', 'solana'],
		description,
		bazaar,
		service: withService({
			serviceName: `three.ws · ${provider.name}`,
			tags: ['aggregator', provider.category, provider.id],
		}),
		requiredScope: endpoint.scope || 'agents:read',
		accessControl: installAccessControl({ requiredScope: endpoint.scope || 'agents:read' }),
		async handler({ req, bypass }) {
			const query = req.query || {};
			let body;
			if (endpoint.method === 'POST') body = await readJsonStream(req);
			const { key } = resolveUpstreamKey(provider, null); // pay path uses platform key
			const out = await executeUpstream({ provider, endpoint, query, body, apiKey: key });
			return {
				data: out,
				_meta: {
					provider: provider.id,
					endpoint: endpoint.id,
					billing: bypass ? 'plan' : 'x402',
				},
			};
		},
	});

	_paidHandlers.set(key, handler);
	return handler;
}

// Minimal JSON body reader for the paid POST path. Mirrors http.js readJson
// but without its content-type hard-fail, since the x402 dance has already
// consumed headers. Delegates to the shared readBody, which prefers the
// pre-parsed req.rawBody/req.body the Cloud Run server already captured —
// re-reading the raw stream (as this function used to) hangs forever once
// Express has drained it.
async function readJsonStream(req, limit = 1_000_000) {
	const buf = await readBody(req, limit);
	if (!buf.length) return undefined;
	try {
		return JSON.parse(buf.toString('utf8'));
	} catch {
		throw Object.assign(new Error('invalid JSON body'), { status: 400, code: 'validation_error' });
	}
}
