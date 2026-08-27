// aixbt intelligence client: REST v2 (https://api.aixbt.tech/v2).
//
// This is the three.ws ⇄ aixbt bridge: it lets three.ws agents tap aixbt's
// narrative / momentum intelligence the same way external builders use the
// aixbt REST API and MCP. The secret (AIXBT_API_KEY) lives only here on the
// server; the MCP tools and agent skills reach aixbt by calling the
// /api/aixbt/* endpoints that wrap this module, so the key never ships to a
// client or an MCP subprocess.
//
// Auth: `x-api-key: <AIXBT_API_KEY>`. Keys come from a full aixbt.tech
// subscription or a time-boxed x402 key pass (see env.js / .env.example).
//
// Endpoints used (per https://docs.aixbt.tech/builders):
//   GET  /projects        : momentum-ranked projects (filters: names, chain, limit, page)
//   GET  /projects/{id}   : single project detail
//   GET  /intel           : recent narrative intel items
//   GET  /grounding       : hourly structured market context (crypto + tradfi)
//   POST /agents/indigo   : agent chat (Pro/Holder plans)
//   GET  /api-keys/info   : current key metadata (tier, scopes, rate limit)
//
// Responses are wrapped by aixbt as { status, data, pagination }. We unwrap to
// the bare `data` and normalize the fields three.ws renders into stable shapes
// so a downstream change to aixbt's payload doesn't ripple through the UI.

import { env } from './env.js';
import { cacheGet, cacheSet } from './cache.js';

const SOURCE = 'aixbt';
const TIMEOUT_MS = 10_000;

// Cache TTLs (seconds). aixbt grounding updates hourly and intel/projects move
// on the order of minutes; these keep us well under the key's rate limit while
// staying fresh enough for a live feed.
const TTL = {
	projects: 90,
	project: 120,
	intel: 120,
	grounding: 600,
};

/** @returns {boolean} whether an aixbt API key is configured. */
export function aixbtEnabled() {
	return env.AIXBT_ENABLED;
}

class AixbtError extends Error {
	constructor(message, status) {
		super(message);
		this.name = 'AixbtError';
		this.status = status || 502;
		this.code = status === 401 || status === 403
			? 'aixbt_unauthorized'
			: status === 429
				? 'aixbt_rate_limited'
				: 'aixbt_upstream_error';
	}
}

/** Thrown when no key is configured: callers map this to a 503 + setup hint. */
export class AixbtNotConfiguredError extends Error {
	constructor() {
		super('aixbt is not configured on this deployment (set AIXBT_API_KEY)');
		this.name = 'AixbtNotConfiguredError';
		this.status = 503;
		this.code = 'aixbt_not_configured';
	}
}

export const AIXBT_SETUP_HINT =
	'Set AIXBT_API_KEY (full aixbt.tech subscription or an x402 key pass from https://api.aixbt.tech/x402/v2/api-keys).';

/**
 * Classify an aixbt failure into the envelope every door should answer with.
 *
 * One classifier, every door: api/aixbt/* renders it through respondAixbtError,
 * and the /api/v1/market/* handlers rethrow it through the gateway's fail().
 * Keeping it here is what stops the two surfaces from drifting again, the v1
 * doors used to relay aixbt's raw 401 straight to a caller of a public,
 * credential-free endpoint (live on three.ws until this was fixed), telling
 * them to authenticate against a door they hold no key to, while /api/aixbt/*
 * had already mapped that case to a 503.
 *
 * @param {any} err error thrown by this module's request path
 * @returns {{ status: number, code: string, message: string, setup?: string } | null}
 *          null for a genuine internal fault, which the caller must sanitize.
 */
export function mapAixbtFailure(err) {
	if (err?.code === 'aixbt_not_configured') {
		return { status: 503, code: err.code, message: err.message, setup: AIXBT_SETUP_HINT };
	}
	const status = Number(err?.status) || 502;
	// aixbt rejecting OUR server-side key is a deployment fault, never the
	// caller's. It is the same class of failure as a missing key, so it gets the
	// same 503 + actionable setup hint. The `aixbt_unauthorized` code is
	// preserved so existing clients keep their typed branch.
	if (status === 401 || status === 403) {
		return {
			status: 503,
			code: 'aixbt_unauthorized',
			message: 'aixbt rejected this deployment key (expired, revoked, or below the plan this read needs)',
			setup: AIXBT_SETUP_HINT,
		};
	}
	// 4xx and "upstream is the fault" (502/503/504/429) carry their descriptive
	// code + message; only genuine internal faults get sanitized.
	if (err?.code && (status < 500 || status === 502 || status === 503 || status === 504)) {
		return { status, code: err.code, message: err.message || 'aixbt request failed' };
	}
	return null;
}

function buildUrl(path, query) {
	const url = new URL(`${env.AIXBT_API_BASE}${path}`);
	for (const [k, v] of Object.entries(query || {})) {
		if (v === undefined || v === null || v === '') continue;
		url.searchParams.set(k, String(v));
	}
	return url.toString();
}

async function request(path, { query, method = 'GET', body } = {}) {
	if (!aixbtEnabled()) throw new AixbtNotConfiguredError();

	const url = buildUrl(path, query);
	let res;
	try {
		res = await fetch(url, {
			method,
			headers: {
				'x-api-key': env.AIXBT_API_KEY,
				accept: 'application/json',
				...(body ? { 'content-type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new AixbtError(`aixbt unreachable: ${err?.message || 'fetch failed'}`, 504);
	}

	const payload = await res.json().catch(() => null);
	if (!res.ok) {
		const detail = payload?.error || payload?.message || `HTTP ${res.status}`;
		throw new AixbtError(`aixbt ${path} failed: ${detail}`, res.status);
	}
	// aixbt wraps successful reads as { status, data, pagination }.
	return {
		data: payload?.data ?? payload ?? null,
		pagination: payload?.pagination ?? null,
	};
}

// Read-through cache around a GET. Cache keys are content-addressed by path +
// query so distinct filters never collide. Errors are never cached.
//
// A separate last-known-good copy outlives the fresh TTL by design. Without it
// an aixbt 5xx propagated straight through to /api/v1/market/intel and
// /projects as a hard failure even when a perfectly serviceable answer from two
// minutes ago was sitting right there. The LKG copy is returned marked stale,
// so the caller can caption it rather than pass it off as live, and a failure
// with nothing cached still throws honestly.
const LKG_TTL_SECONDS = 6 * 60 * 60;

async function cachedGet(cacheKey, ttl, path, query) {
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached) return cached;
	const lkgKey = `${cacheKey}:lkg`;
	try {
		const fresh = await request(path, { query });
		await cacheSet(cacheKey, fresh, ttl).catch(() => {});
		await cacheSet(lkgKey, { ...fresh, at: Date.now() }, LKG_TTL_SECONDS).catch(() => {});
		return fresh;
	} catch (err) {
		const lkg = await cacheGet(lkgKey).catch(() => null);
		if (!lkg) throw err;
		console.warn(`[aixbt] ${path} failed (${err?.message || err}); serving last-known-good`);
		return { ...lkg, stale: true, as_of: new Date(Number(lkg.at) || Date.now()).toISOString() };
	}
}

function num(v) {
	const n = typeof v === 'string' ? Number(v) : v;
	return Number.isFinite(n) ? n : null;
}

// ── Normalizers ───────────────────────────────────────────────────────────
// Map aixbt's verbose objects into the lean shapes three.ws renders + speaks.

function normalizeProject(p) {
	if (!p || typeof p !== 'object') return null;
	const primaryToken = Array.isArray(p.tokens) ? p.tokens[0] : null;
	return {
		id: p._id || p.id || p.name || null,
		name: p.name || null,
		ticker: p.ticker || p.symbol || null,
		x_handle: p.xHandle || null,
		address: primaryToken?.address || p.address || null,
		chain: primaryToken?.chain || p.chain || null,
		scores: {
			spiking: num(p.spikingScore),
			climbing: num(p.climbingScore),
			active: num(p.activeScore),
		},
		trajectory:
			p.momentumContext?.spikingTrajectory ||
			p.momentumContext?.climbingTrajectory ||
			null,
		market: {
			price_usd: num(p.price),
			market_cap: num(p.marketCap),
			volume_24h: num(p.volume24h),
			change_24h: num(p.priceChange24h ?? p.change24h),
		},
		intel: Array.isArray(p.intel) ? p.intel.slice(0, 10).map(normalizeIntel).filter(Boolean) : [],
		categories: p.coingeckoData?.categories || [],
		source: SOURCE,
	};
}

function normalizeIntel(i) {
	if (!i || typeof i !== 'object') return null;
	return {
		category: i.category || null,
		description: i.description || i.summary || null,
		detected_at: i.detectedAt || i.createdAt || null,
		reinforced_at: i.reinforcedAt || null,
		observations: num(i.observationCount),
		official_source: Boolean(i.hasOfficialSource),
		project: i.project?.name || i.projectName || null,
		ticker: i.project?.ticker || i.ticker || null,
		source: SOURCE,
	};
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Momentum-ranked projects. Optional filters mirror aixbt's query params.
 * @param {{ limit?: number, page?: number, names?: string, chain?: string }} [opts]
 */
export async function getProjects({ limit = 20, page = 1, names, chain } = {}) {
	const lim = Math.min(Math.max(1, Number(limit) || 20), 50);
	const key = `aixbt:projects:${page}:${lim}:${names || '*'}:${chain || '*'}`;
	const { data, pagination } = await cachedGet(key, TTL.projects, '/projects', {
		limit: lim,
		page,
		names,
		chain,
	});
	const list = Array.isArray(data) ? data : data?.projects || [];
	return { projects: list.map(normalizeProject).filter(Boolean), pagination };
}

/** Single project detail by aixbt id, ticker, or name. */
export async function getProject(id) {
	const key = `aixbt:project:${id}`;
	const { data } = await cachedGet(key, TTL.project, `/projects/${encodeURIComponent(id)}`);
	return normalizeProject(data);
}

/**
 * Recent narrative intel items.
 * @param {{ limit?: number, category?: string, chain?: string }} [opts]
 */
export async function getIntel({ limit = 20, category, chain } = {}) {
	const lim = Math.min(Math.max(1, Number(limit) || 20), 50);
	const key = `aixbt:intel:${lim}:${category || '*'}:${chain || '*'}`;
	const { data, pagination } = await cachedGet(key, TTL.intel, '/intel', {
		limit: lim,
		category,
		chain,
	});
	const list = Array.isArray(data) ? data : data?.intel || [];
	return { intel: list.map(normalizeIntel).filter(Boolean), pagination };
}

/** Hourly structured market context (crypto + tradfi). Returned as-is. */
export async function getGrounding() {
	const key = 'aixbt:grounding';
	const { data } = await cachedGet(key, TTL.grounding, '/grounding');
	return { grounding: data, source: SOURCE };
}

/**
 * Agent chat against aixbt's `indigo` agent (Pro/Holder plans only).
 * Not cached: each turn is a distinct conversation.
 * @param {Array<{ role: string, content: string }>} messages
 */
export async function chatIndigo(messages) {
	const { data } = await request('/agents/indigo', { method: 'POST', body: { messages } });
	const reply =
		typeof data === 'string'
			? data
			: data?.content || data?.message || data?.reply || data?.text || null;
	return { reply, raw: data, source: SOURCE };
}

/** Current API key metadata: tier, scopes, rate limit. */
export async function getKeyInfo() {
	const { data } = await request('/api-keys/info');
	return data;
}
