// /api/v1/x/<provider>/<endpoint> — the aggregator front door.
//
// One catch-all route exposes every third-party API registered in
// api/v1/_providers.js. Per request, it selects a billing model and runs the
// call through the aggregator engine:
//
//   • BYOK   — caller supplies their own upstream key (e.g. "x-provider-key").
//              Pure pass-through: no markup, no key custody. Rate-limited + metered.
//   • plan   — caller authenticates with a three.ws API key / OAuth token / session.
//              Uses the platform's upstream key; counts against their plan.
//   • x402   — no credentials → pay-per-call in USDC via the real paidEndpoint
//              rail (also makes the endpoint discoverable in the x402 bazaar).
//
// GET /api/v1/x (no provider) returns the machine-readable provider catalog.

import { cors, json, error, rateLimited, wrap, readJson, setRateLimitHeaders } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { authenticateBearer, extractBearer, getSessionUser, hasScope } from '../../_lib/auth.js';
import { recordEvent } from '../../_lib/usage.js';
import { ENDPOINT_INDEX, providerCatalog } from '../_providers.js';
import { executeUpstream, getPaidHandler, resolveUpstreamKey } from '../../_lib/aggregator.js';

function parseSlug(req) {
	// Prefer the platform-provided param; fall back to parsing the path so the
	// route also works under runtimes that don't populate req.query.slug.
	const fromQuery = req.query?.slug;
	if (Array.isArray(fromQuery)) return fromQuery.filter(Boolean);
	if (typeof fromQuery === 'string' && fromQuery) return fromQuery.split('/').filter(Boolean);
	const path = new URL(req.url, 'http://internal').pathname;
	const m = path.match(/\/api\/v1\/x\/?(.*)$/);
	return m && m[1] ? m[1].split('/').filter(Boolean) : [];
}

function parseQuery(req) {
	const q = { ...(req.query || {}) };
	delete q.slug;
	// Ensure path-only deployments still get query params.
	for (const [k, v] of new URL(req.url, 'http://internal').searchParams) {
		if (!(k in q)) q[k] = v;
	}
	return q;
}

// ── free tier lane ──────────────────────────────────────────────────────────
// An unauthenticated caller (no BYOK key, no three.ws credentials) on an
// endpoint marked `free: { perMin, perDay }` (api/v1/_providers.js) gets a real
// per-IP, per-endpoint quota BEFORE the x402 402 challenge — this is what makes
// "the free crypto API" true instead of marketing copy: `curl
// https://three.ws/api/v1/x/coingecko/price?ids=solana` returns data with zero
// wallet setup. Both windows (burst perMin + funnel-budget perDay) must pass;
// whichever check blocks the request drives the RateLimit-* headers so a client
// backing off learns the window that actually stopped it. Returns true when the
// request was served (caller must return); false means the quota is exhausted
// and the caller should fall through to the existing x402 lane.
async function serveFreeLane({ req, res, provider, endpoint }) {
	const ip = clientIp(req);
	const bucketKey = `${provider.id}:${endpoint.id}:${ip}`;
	const [minResult, dayResult] = await Promise.all([
		limits.apiV1FreeMin(bucketKey, endpoint.free.perMin),
		limits.apiV1FreeDay(bucketKey, endpoint.free.perDay),
	]);

	res.setHeader('x-free-tier', '1');
	const blocked = !minResult.success || !dayResult.success;
	const headerResult = !minResult.success ? minResult : dayResult;
	setRateLimitHeaders(res, headerResult);

	if (blocked) {
		// Hint header (the 402 challenge body shape is spec-locked by the x402
		// bazaar format, so the "quota resets at T" signal rides a header instead):
		// the caller learns exactly when the free lane reopens, on top of the 402's
		// own "or pay per call / send a three.ws API key" accepts array.
		res.setHeader('x-free-tier-reset', new Date(headerResult.reset).toISOString());
		return false;
	}

	const query = parseQuery(req);
	const body = endpoint.method === 'POST' ? await readJson(req) : undefined;
	// Free lane always runs on the platform's own upstream key (there is no
	// caller credential to resolve one from) — same key source the plan lane
	// uses, just billed differently.
	const { key, source } = resolveUpstreamKey(provider, null);

	const started = Date.now();
	let out;
	try {
		out = await executeUpstream({ provider, endpoint, query, body, apiKey: key });
	} catch (err) {
		recordEvent({
			kind: 'api',
			tool: `v1.x.${provider.id}.${endpoint.id}`,
			status: 'error',
			latencyMs: Date.now() - started,
			meta: { billing: 'free', key_source: source, code: err?.code, ip },
		});
		throw err;
	}

	// Metering: free-lane calls still record a usage event (billing: 'free') so
	// funnel adoption is measurable even though no payment settles.
	recordEvent({
		kind: 'api',
		tool: `v1.x.${provider.id}.${endpoint.id}`,
		status: 'ok',
		latencyMs: Date.now() - started,
		meta: { billing: 'free', key_source: source, ip },
	});

	json(res, 200, {
		data: out,
		_meta: {
			provider: provider.id,
			endpoint: endpoint.id,
			billing: 'free',
			free_remaining: { per_min: minResult.remaining, per_day: dayResult.remaining },
		},
	});
	return true;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	const slug = parseSlug(req);

	// Discovery: GET /api/v1/x → list every aggregated provider + endpoint.
	if (slug.length === 0) {
		return json(res, 200, {
			data: {
				base_url: '/api/v1/x',
				billing: {
					byok: 'send your own upstream key via the provider\'s BYOK header — pass-through, no markup',
					plan: 'authenticate with a three.ws API key / OAuth token — uses the platform key',
					free: 'send no credentials on an endpoint marked "free" — a per-IP quota (see each endpoint\'s free.perMin/free.perDay) serves real data with zero setup; X-Free-Tier: 1 + RateLimit-* headers on every response',
					x402: 'send no credentials — pay per call in USDC (HTTP 402), or quota-exhausted free-tier calls fall through here',
				},
				providers: providerCatalog(),
			},
		});
	}

	if (slug.length !== 2) {
		return error(
			res,
			404,
			'not_found',
			'use /api/v1/x/<provider>/<endpoint> — GET /api/v1/x lists every available pair',
		);
	}

	const ref = ENDPOINT_INDEX.get(`${slug[0]}/${slug[1]}`);
	if (!ref) {
		return error(
			res,
			404,
			'unknown_endpoint',
			`no aggregated endpoint "${slug[0]}/${slug[1]}" — GET /api/v1/x lists what's available`,
		);
	}
	const { provider, endpoint } = ref;

	const isHead = req.method === 'HEAD' && endpoint.method === 'GET';
	if (req.method !== endpoint.method && !isHead) {
		// Same probe-friendliness rule as api/_lib/x402-paid-endpoint.js: a
		// wrong-method request carrying no payment or auth credentials is a
		// discovery probe (x402scan, Bazaar validators) that wants the 402
		// challenge, so hand it to the paid rail — its own method gate serves
		// the challenge for exactly this case. Credentialed callers still get
		// the strict 405.
		const hasCredentials =
			!!req.headers['x-payment'] ||
			!!req.headers['payment-signature'] ||
			!!req.headers['sign-in-with-x'] ||
			!!req.headers.authorization ||
			!!req.headers['x-api-key'] ||
			(provider.byokHeader && !!req.headers[provider.byokHeader]);
		if (!hasCredentials) return getPaidHandler(provider, endpoint)(req, res);
		res.setHeader('allow', `${endpoint.method}, OPTIONS`);
		return error(res, 405, 'method_not_allowed', `use ${endpoint.method}`);
	}

	// ── billing model selection ──────────────────────────────────────────────
	const byokKey = provider.byokHeader ? req.headers[provider.byokHeader] : null;
	let principal = null;
	if (!byokKey) {
		const session = await getSessionUser(req);
		if (session) principal = { userId: session.id, source: 'session', scope: 'all' };
		else {
			const bearer = await authenticateBearer(extractBearer(req));
			if (bearer)
				principal = {
					userId: bearer.userId,
					source: bearer.source,
					scope: bearer.scope || '',
					apiKeyId: bearer.apiKeyId,
					clientId: bearer.clientId,
				};
		}
	}

	// Free tier: no BYOK key, no three.ws credentials, endpoint marked `free` →
	// serve a real per-IP quota before the 402 challenge. Quota exhausted falls
	// through to the x402 lane below (still !byokKey && !principal).
	if (!byokKey && !principal && endpoint.free) {
		const served = await serveFreeLane({ req, res, provider, endpoint });
		if (served) return;
	}

	// No BYOK key and no three.ws credentials → pay-per-call via the x402 rail.
	if (!byokKey && !principal) return getPaidHandler(provider, endpoint)(req, res);

	const billing = byokKey ? 'byok' : 'plan';

	// Plan callers must hold the endpoint's scope (session owners hold all).
	if (
		billing === 'plan' &&
		principal.source !== 'session' &&
		endpoint.scope &&
		!hasScope(principal.scope, endpoint.scope)
	) {
		return error(res, 403, 'insufficient_scope', `this endpoint requires the "${endpoint.scope}" scope`);
	}

	// ── rate limit (per principal › IP) ──────────────────────────────────────
	const ip = clientIp(req);
	const rlKey = principal?.apiKeyId
		? `key:${principal.apiKeyId}`
		: principal?.userId
			? `user:${principal.userId}`
			: `ip:${ip}`;
	const rl = await limits.apiV1(rlKey);
	setRateLimitHeaders(res, rl);
	if (!rl.success) return rateLimited(res, rl);

	// ── execute ──────────────────────────────────────────────────────────────
	const query = parseQuery(req);
	const body = endpoint.method === 'POST' ? await readJson(req) : undefined;
	const { key, source } = resolveUpstreamKey(provider, billing === 'byok' ? byokKey : null);

	const started = Date.now();
	let out;
	try {
		out = await executeUpstream({ provider, endpoint, query, body, apiKey: key });
	} catch (err) {
		recordEvent({
			kind: 'api',
			tool: `v1.x.${provider.id}.${endpoint.id}`,
			userId: principal?.userId,
			apiKeyId: principal?.apiKeyId,
			clientId: principal?.clientId,
			status: 'error',
			latencyMs: Date.now() - started,
			meta: { billing, key_source: source, code: err?.code },
		});
		throw err;
	}

	recordEvent({
		kind: 'api',
		tool: `v1.x.${provider.id}.${endpoint.id}`,
		userId: principal?.userId,
		apiKeyId: principal?.apiKeyId,
		clientId: principal?.clientId,
		status: 'ok',
		latencyMs: Date.now() - started,
		meta: { billing, key_source: source },
	});

	return json(res, 200, {
		data: out,
		_meta: { provider: provider.id, endpoint: endpoint.id, billing },
	});
});
