// Redis-backed idempotency cache for x402 payment-identifier (USE-15).
//
// Keyed by `${route}|${paymentId}`. Each entry stores the response body, a
// few essential response headers (content-type, x-payment-response, status),
// and a SHA-256 hash of the request payload that was paid for. The hash is
// what the spec calls for: same id + different payload → 409 Conflict.
//
// The store falls back to an in-process Map when Upstash isn't configured, so
// `npm test` and local dev work without Redis. In production the fallback
// only fires when X402_ALLOW_MEMORY_FALLBACK=1 is set — otherwise the module
// boot-checks and refuses to load without Upstash, preventing accidental
// silent degradation across Vercel function replicas.

import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { env } from '../env.js';

const IS_PROD = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
const ALLOW_MEMORY_FALLBACK = process.env.X402_ALLOW_MEMORY_FALLBACK === '1';

let redis = null;
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
	redis = new Redis({
		url: env.UPSTASH_REDIS_REST_URL,
		token: env.UPSTASH_REDIS_REST_TOKEN,
	});
} else if (IS_PROD) {
	// No Redis configured. Per-instance memory fallback prevents replays
	// within a single function container but not across Vercel replicas.
	// Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to enable
	// cross-replica deduplication.
	console.warn(
		'[x402-idempotency] UPSTASH_REDIS_REST_URL/TOKEN not set; ' +
			'using per-instance memory fallback. Cross-replica replay protection requires Redis.',
	);
}

const KEY_PREFIX = 'x402:idem:';

// In-memory fallback. Map<key, { entry, expiresAt }>.
const memoryStore = new Map();

function now() {
	return Date.now();
}

function memoryGet(key) {
	const slot = memoryStore.get(key);
	if (!slot) return null;
	if (slot.expiresAt && slot.expiresAt < now()) {
		memoryStore.delete(key);
		return null;
	}
	return slot.entry;
}

function memorySet(key, entry, ttlSec) {
	memoryStore.set(key, {
		entry,
		expiresAt: ttlSec > 0 ? now() + ttlSec * 1000 : 0,
	});
}

function fullKey(route, paymentId) {
	return `${KEY_PREFIX}${route}|${paymentId}`;
}

// Stable hash of the bytes the caller paid for. The route + query string +
// JSON-stringified body is enough for our endpoints — none of them depend on
// header state. Returns null when there's nothing distinguishing to hash
// (POSTs without a body fall back to route alone).
export function hashRequestPayload({ method, url, body }) {
	const h = createHash('sha256');
	h.update(String(method || 'GET').toUpperCase());
	h.update('\n');
	h.update(String(url || ''));
	h.update('\n');
	if (body !== undefined && body !== null) {
		if (typeof body === 'string') h.update(body);
		else if (Buffer.isBuffer(body)) h.update(body);
		else h.update(JSON.stringify(body));
	}
	return h.digest('hex');
}

// Read a cached response by route + paymentId. Returns null if the key is
// missing or expired. The returned shape is whatever `set()` was given.
export async function get(route, paymentId) {
	const key = fullKey(route, paymentId);
	if (!redis) return memoryGet(key);
	try {
		const raw = await redis.get(key);
		if (!raw) return null;
		// Upstash auto-decodes JSON when storing objects, but old keys or
		// string-encoded values still come back as strings — handle both.
		return typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch (err) {
		console.error('[idempotency-cache] get failed:', err?.message || err);
		return null;
	}
}

// Write a response into the cache. ttlSec=0 means "store with no expiration"
// — never use that in production; the env-driven default is finite. Failures
// to write are logged but never thrown — the caller has already settled the
// payment and shouldn't see a 5xx because Redis blinked.
export async function set(route, paymentId, entry, ttlSec) {
	const key = fullKey(route, paymentId);
	if (!redis) {
		memorySet(key, entry, ttlSec);
		return;
	}
	try {
		const opts = ttlSec > 0 ? { ex: ttlSec } : undefined;
		await redis.set(key, JSON.stringify(entry), opts);
	} catch (err) {
		console.error('[idempotency-cache] set failed:', err?.message || err);
	}
}

// Test-only hook to drop the in-memory store between tests.
export function _resetMemoryStore() {
	memoryStore.clear();
}
