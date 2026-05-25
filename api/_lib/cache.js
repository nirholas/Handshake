// Shared cache adapter — Upstash Redis (REST) primary, in-memory fallback.
//
// Why: Vercel serverless functions are stateless per-instance. Our previous
// in-memory Map cache was wiped on every cold start, which is *most* requests
// under low traffic. Upstash REST works on edge + node, no socket pooling,
// and the free tier (10k cmd/day) easily covers our portfolio/balances volume.
//
// Falls back to in-memory transparently when UPSTASH_REDIS_REST_URL is unset,
// so dev + tests need no extra config.
//
// Env:
//   UPSTASH_REDIS_REST_URL    — https://<region>.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  — REST API token (read+write)

const memCache = new Map();
const MEM_DEFAULT_TTL_MS = 60_000;

function memSet(key, value, ttlSeconds) {
	const ttlMs = (ttlSeconds && ttlSeconds * 1000) || MEM_DEFAULT_TTL_MS;
	memCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
function memGet(key) {
	const hit = memCache.get(key);
	if (!hit) return null;
	if (Date.now() > hit.expiresAt) {
		memCache.delete(key);
		return null;
	}
	return hit.value;
}
function memDel(key) {
	memCache.delete(key);
}

function redisConfigured() {
	return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCmd(args) {
	const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(args),
	});
	if (!r.ok) throw new Error(`upstash ${r.status}: ${await r.text().catch(() => '')}`);
	const json = await r.json();
	if (json.error) throw new Error(`upstash error: ${json.error}`);
	return json.result;
}

export async function cacheGet(key) {
	if (!redisConfigured()) return memGet(key);
	try {
		const raw = await redisCmd(['GET', key]);
		if (raw == null) return null;
		return JSON.parse(raw);
	} catch (err) {
		console.warn('[cache] redis GET failed, using memory fallback:', err?.message);
		return memGet(key);
	}
}

export async function cacheSet(key, value, ttlSeconds = 60) {
	if (!redisConfigured()) return memSet(key, value, ttlSeconds);
	try {
		const payload = JSON.stringify(value);
		await redisCmd(['SET', key, payload, 'EX', String(ttlSeconds)]);
	} catch (err) {
		console.warn('[cache] redis SET failed, using memory fallback:', err?.message);
		memSet(key, value, ttlSeconds);
	}
}

export async function cacheDel(key) {
	if (!redisConfigured()) return memDel(key);
	try {
		await redisCmd(['DEL', key]);
	} catch {
		memDel(key);
	}
}

export function cacheBackend() {
	return redisConfigured() ? 'upstash' : 'memory';
}
