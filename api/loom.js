// Loom — persistence + feed backend for the public shared gallery of
// community-forged 3D creations. A creation is a forged GLB plus its prompt and
// a light bit of attribution; anyone can read the feed (public GET) and anyone
// can contribute one (rate-limited POST). The feed is world-readable, so every
// stored field is sanitized at the boundary and the model URL is allowlisted to
// the handful of hosts we actually forge to — an arbitrary https URL must never
// be injectable into a gallery the whole platform renders.
//
// ── Storage ──────────────────────────────────────────────────────────────────
//   loom:creations         — capped Redis list, newest-first (LPUSH + LTRIM)
//   loom:creation:<id>     — single-record lookup, no expiry
// When Upstash is unconfigured (dev / tests) the same operations run against an
// in-process array so the endpoint is fully functional without Redis. The
// readFeed / writeCreation / readOne abstraction hides which backend is live.

import { randomUUID } from 'node:crypto';
import {
	cors,
	json,
	error,
	readJson,
	wrap,
	method,
	setRateLimitHeaders,
} from './_lib/http.js';
import { getRedis } from './_lib/redis.js';
import { clientIp } from './_lib/rate-limit.js';

const LIST_KEY = 'loom:creations';
const ITEM_KEY = (id) => `loom:creation:${id}`;
const LIST_CAP = 2000;

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 120;
const PROMPT_MAX = 1000;
const AUTHOR_MAX = 40;
const DEFAULT_AUTHOR = 'anon';

// Hosts a forged GLB can legitimately live on: our own domain, Cloudflare R2
// (both the public r2.dev preview domain and the account storage domain),
// Replicate's delivery CDN, and raw.githubusercontent for repo-hosted assets.
// A URL whose host doesn't end with one of these is rejected — this is the only
// thing standing between the public feed and arbitrary-URL injection.
const ALLOWED_GLB_HOST_SUFFIXES = [
	'three.ws',
	'r2.dev',
	'cloudflarestorage.com',
	'replicate.delivery',
	'githubusercontent.com',
];

// POST budget: ~20 contributions per hour per IP. Backed by a Redis counter
// with a 1h TTL when Redis is available; falls back to an in-process sliding
// window otherwise so dev/tests still enforce a (per-instance) ceiling.
const POST_LIMIT = 20;
const POST_WINDOW_MS = 60 * 60 * 1000;

// ── In-memory fallback store (no Redis) ──────────────────────────────────────
// Newest-first, mirroring the Redis list ordering. Bounded to LIST_CAP.
const memCreations = [];
const memById = new Map();

// ── Storage abstraction ──────────────────────────────────────────────────────

function safeParse(s) {
	if (s && typeof s === 'object') return s; // Upstash may auto-deserialize
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// Persist a creation: newest to the front of the list, capped, plus a direct
// id->record key for single lookups. Uses Redis when configured, the in-memory
// arrays otherwise.
export async function writeCreation(rec) {
	const r = getRedis();
	if (!r) {
		memCreations.unshift(rec);
		if (memCreations.length > LIST_CAP) memCreations.length = LIST_CAP;
		memById.set(rec.id, rec);
		return rec;
	}
	const payload = JSON.stringify(rec);
	await r.lpush(LIST_KEY, payload);
	await r.ltrim(LIST_KEY, 0, LIST_CAP - 1);
	await r.set(ITEM_KEY(rec.id), payload);
	return rec;
}

// Read the feed newest-first. `before` (ms epoch) pages backwards: only items
// strictly older than it are returned. Returns up to `limit` records.
//
// The ceiling here is LIST_CAP (what storage actually holds), NOT the smaller
// public MAX_LIMIT: the HTTP handler below already clamps a caller-supplied
// `limit` to MAX_LIMIT before it gets here, so enforcing it a second time only
// hit INTERNAL callers. api/creations.js asks for a SCAN_CAP-deep slice to
// aggregate creator/trending rankings over, and silently got 120 rows instead,
// which under-reported every creator's creation count and made gallery
// pagination dead-end well before the feed did.
export async function readFeed(limit, before) {
	const cap = Math.max(1, Math.min(LIST_CAP, limit | 0 || DEFAULT_LIMIT));
	const hasBefore = Number.isFinite(before);

	const r = getRedis();
	let rows;
	if (!r) {
		rows = memCreations;
	} else {
		// Over-read when paginating so the `before` filter still yields a full page;
		// without a cursor index we walk from the head. The list is capped at
		// LIST_CAP, so a bounded over-read can never be unbounded work.
		const span = hasBefore ? LIST_CAP : cap;
		const raw = await r.lrange(LIST_KEY, 0, span - 1);
		rows = (raw || []).map(safeParse).filter(Boolean);
	}

	const out = [];
	for (const rec of rows) {
		if (!rec || typeof rec !== 'object') continue;
		if (hasBefore && !(Number(rec.createdAt) < before)) continue;
		out.push(rec);
		if (out.length >= cap) break;
	}
	return out;
}

export async function readOne(id) {
	if (!id) return null;
	const r = getRedis();
	if (!r) return memById.get(id) || null;
	const raw = await r.get(ITEM_KEY(id));
	return raw ? safeParse(raw) : null;
}

// Newest few feed entries, for best-effort dedup on POST.
async function readRecent(n) {
	const r = getRedis();
	if (!r) return memCreations.slice(0, n);
	const raw = await r.lrange(LIST_KEY, 0, Math.max(0, n - 1));
	return (raw || []).map(safeParse).filter(Boolean);
}

// ── POST rate limit ──────────────────────────────────────────────────────────

const memPostBuckets = new Map();

function memoryPostLimit(ip) {
	const now = Date.now();
	const cutoff = now - POST_WINDOW_MS;
	const kept = (memPostBuckets.get(ip) || []).filter((t) => t > cutoff);
	if (kept.length >= POST_LIMIT) {
		memPostBuckets.set(ip, kept);
		return { success: false, limit: POST_LIMIT, remaining: 0, reset: kept[0] + POST_WINDOW_MS };
	}
	kept.push(now);
	memPostBuckets.set(ip, kept);
	return {
		success: true,
		limit: POST_LIMIT,
		remaining: POST_LIMIT - kept.length,
		reset: now + POST_WINDOW_MS,
	};
}

async function postRateLimit(ip) {
	const r = getRedis();
	if (!r) return memoryPostLimit(ip);
	const key = `loom:post:${ip}`;
	try {
		const count = await r.incr(key);
		if (count === 1) await r.pexpire(key, POST_WINDOW_MS);
		const ttl = await r.pttl(key);
		const reset = Date.now() + (ttl > 0 ? ttl : POST_WINDOW_MS);
		if (count > POST_LIMIT) {
			return { success: false, limit: POST_LIMIT, remaining: 0, reset };
		}
		return { success: true, limit: POST_LIMIT, remaining: POST_LIMIT - count, reset };
	} catch (err) {
		console.warn('[loom] redis rate-limit degraded, using memory:', err?.message);
		return memoryPostLimit(ip);
	}
}

// ── Validation / sanitization ────────────────────────────────────────────────

// Strip ASCII control chars (incl. the C1 range) that have no place in a
// world-readable label/prompt and could break renderers or hide content.
function stripControl(s) {
	// eslint-disable-next-line no-control-regex
	return String(s).replace(/[\u0000--]/g, '');
}

export function sanitizePrompt(raw) {
	return stripControl(raw).replace(/\s+/g, ' ').trim();
}

export function sanitizeAuthor(raw) {
	if (typeof raw !== 'string') return DEFAULT_AUTHOR;
	const cleaned = stripControl(raw).replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX);
	return cleaned || DEFAULT_AUTHOR;
}

export function sanitizeOptionalString(raw, max) {
	if (typeof raw !== 'string') return null;
	const cleaned = stripControl(raw).trim().slice(0, max);
	return cleaned || null;
}

// Validate the model URL is an https URL on an allowlisted host. Returns the
// normalized href on success, or null if it fails any check.
export function validateGlbUrl(raw) {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	let url;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	const host = url.hostname.toLowerCase();
	const ok = ALLOWED_GLB_HOST_SUFFIXES.some(
		(suffix) => host === suffix || host.endsWith(`.${suffix}`),
	);
	return ok ? url.href : null;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res)) return;

	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://localhost');
		const singleId = url.searchParams.get('c');

		if (singleId) {
			const creation = await readOne(singleId);
			if (!creation) return error(res, 404, 'not_found', 'creation not found');
			return json(res, 200, { creation });
		}

		const limit = Math.min(
			MAX_LIMIT,
			Math.max(1, parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
		);
		const beforeRaw = url.searchParams.get('before');
		const before = beforeRaw != null && beforeRaw !== '' ? Number(beforeRaw) : NaN;

		const creations = await readFeed(limit, before);
		// A full page implies more may exist behind the oldest item we returned;
		// hand back its createdAt as the cursor. A short page means we hit the end.
		const nextBefore =
			creations.length === limit ? Number(creations[creations.length - 1].createdAt) : null;
		return json(res, 200, { creations, nextBefore });
	}

	if (req.method === 'POST') {
		const ip = clientIp(req);
		const rl = await postRateLimit(ip);
		if (!rl.success) {
			setRateLimitHeaders(res, rl);
			return error(res, 429, 'rate_limited', 'too many creations, slow down', {
				retry_after: Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000)),
			});
		}

		const body = await readJson(req, 8_000);

		const prompt = sanitizePrompt(body?.prompt ?? '');
		if (!prompt) return error(res, 400, 'bad_request', 'prompt is required');
		if (prompt.length > PROMPT_MAX) {
			return error(res, 400, 'bad_request', `prompt too long (max ${PROMPT_MAX})`);
		}

		const glbUrl = validateGlbUrl(body?.glbUrl);
		if (!glbUrl) {
			return error(
				res,
				400,
				'invalid_glb_url',
				'glbUrl must be an https URL hosted on an allowed domain',
			);
		}

		// Dedup: if this exact GLB was just contributed, return the existing record
		// instead of stacking a duplicate at the top of a public feed. Best-effort —
		// only scans the newest few entries, which is where an accidental re-POST lands.
		const recent = await readRecent(5);
		const dupe = recent.find((rec) => rec && rec.glbUrl === glbUrl);
		if (dupe) return json(res, 200, { creation: dupe });

		const previewImageUrl = sanitizeOptionalString(body?.previewImageUrl, 600);
		const tier = sanitizeOptionalString(body?.tier, 40);
		const backend = sanitizeOptionalString(body?.backend, 40);
		const author = sanitizeAuthor(body?.author);

		const creation = {
			id: randomUUID(),
			prompt,
			glbUrl,
			previewImageUrl,
			author,
			tier,
			backend,
			createdAt: Date.now(),
		};

		await writeCreation(creation);
		setRateLimitHeaders(res, rl);
		return json(res, 201, { creation });
	}

	if (!method(req, res, ['GET', 'POST'])) return;
});
