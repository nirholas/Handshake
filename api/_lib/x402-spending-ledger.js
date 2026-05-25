// Durable spending ledger for x402 buyer clients (USE-22).
//
// Records every payment attempt + outcome so onBeforePaymentCreation hooks
// can enforce sliding-window caps (per-call / per-hour / per-day). The
// strict-cap path uses Redis INCRBY-on-insert with a rollback hook: the
// cap check increments first, the after-payment hook commits, and any
// abort/error path decrements back. This closes the race where two
// concurrent calls would both pass a relaxed read-before-write check.
//
// Cross-network: amounts are stored in micro-USD (6 decimals) regardless
// of source token. The cap module normalizes via x402-spending-price.js
// before recording so $0.001 USDC and $0.001 worth of SOL aggregate cleanly.
//
// Storage shape (Redis):
//   x402:spend:hr:<address>:<UTC_HOUR>    → integer microUSD (TTL 7200s)
//   x402:spend:day:<address>:<UTC_DAY>    → integer microUSD (TTL 172800s)
// Falls back to an in-process Map when UPSTASH_REDIS_REST_* is unset so
// local dev / tests work. In production the fallback only fires when
// X402_ALLOW_MEMORY_FALLBACK=1; otherwise getRedis() refuses to return so
// the cap module fails closed rather than silently per-instance.

import { Redis } from '@upstash/redis';
import { env } from './env.js';

const KEY_PREFIX = 'x402:spend:';
const HOUR_TTL_SECONDS = 7200; // keep one extra hour for slow-cron debugging
const DAY_TTL_SECONDS = 60 * 60 * 48;
const IS_PROD = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
const ALLOW_MEMORY_FALLBACK = process.env.X402_ALLOW_MEMORY_FALLBACK === '1';

let redisClient = null;
let memoryWarned = false;
function getRedis() {
	if (redisClient !== null) return redisClient;
	if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
		if (IS_PROD && !ALLOW_MEMORY_FALLBACK) {
			throw new Error(
				'[x402-spending-ledger] UPSTASH_REDIS_REST_URL/TOKEN required in production. ' +
					'Set them, or set X402_ALLOW_MEMORY_FALLBACK=1 to accept per-instance spend caps.',
			);
		}
		if (IS_PROD && !memoryWarned) {
			memoryWarned = true;
			console.warn(
				'[x402-spending-ledger] Running in production with memory fallback; ' +
					'spend caps are per-instance only.',
			);
		}
		redisClient = false; // sentinel: configured-as-absent
		return null;
	}
	redisClient = new Redis({
		url: env.UPSTASH_REDIS_REST_URL,
		token: env.UPSTASH_REDIS_REST_TOKEN,
	});
	return redisClient;
}

// In-memory fallback. Each slot holds { count, expiresAt }.
const memoryStore = new Map();

function now() {
	return Date.now();
}

function utcHourBucket(timestampMs = now()) {
	return Math.floor(timestampMs / 3_600_000);
}

function utcDayBucket(timestampMs = now()) {
	return Math.floor(timestampMs / 86_400_000);
}

function hourKey(address, bucket) {
	return `${KEY_PREFIX}hr:${address}:${bucket}`;
}

function dayKey(address, bucket) {
	return `${KEY_PREFIX}day:${address}:${bucket}`;
}

function memoryIncr(key, delta, ttlSec) {
	const slot = memoryStore.get(key);
	const current = slot && (!slot.expiresAt || slot.expiresAt > now()) ? slot.value : 0n;
	const next = current + BigInt(delta);
	memoryStore.set(key, {
		value: next < 0n ? 0n : next,
		expiresAt: ttlSec > 0 ? now() + ttlSec * 1000 : 0,
	});
	return next < 0n ? 0n : next;
}

function memoryGet(key) {
	const slot = memoryStore.get(key);
	if (!slot) return 0n;
	if (slot.expiresAt && slot.expiresAt < now()) {
		memoryStore.delete(key);
		return 0n;
	}
	return slot.value;
}

async function redisIncrby(redis, key, delta, ttlSec) {
	// INCRBY returns the new value. EXPIRE refreshes the TTL — fine to call
	// on every increment, the key just gets a sliding TTL window.
	const next = await redis.incrby(key, Number(delta));
	if (ttlSec > 0) {
		// EXPIRE w/ NX would be slightly cheaper but Upstash supports plain
		// EXPIRE returning 1/0; this works for both first-create and refresh.
		await redis.expire(key, ttlSec);
	}
	return BigInt(next);
}

// Increment hour + day buckets for `address` by `microUsd` (BigInt-safe number
// or BigInt). Returns the post-increment running totals { hour, day }.
//
// Use this for pessimistic admission: increment first, check the cap returns
// false, then call rollback() if the payment is rejected upstream. The cost
// is exactly one round-trip in the success path.
export async function reserve({ address, microUsd, timestamp = now() }) {
	if (!address || typeof address !== 'string') {
		throw new Error('spending-ledger.reserve: address required');
	}
	const delta = BigInt(microUsd);
	if (delta <= 0n) {
		// No-op increments would corrupt the bucket; treat <=0 as a peek.
		return current({ address, timestamp });
	}
	const hBucket = utcHourBucket(timestamp);
	const dBucket = utcDayBucket(timestamp);
	const hKey = hourKey(address, hBucket);
	const dKey = dayKey(address, dBucket);
	const redis = getRedis();
	if (!redis) {
		return {
			hour: memoryIncr(hKey, delta, HOUR_TTL_SECONDS),
			day: memoryIncr(dKey, delta, DAY_TTL_SECONDS),
		};
	}
	const [hour, day] = await Promise.all([
		redisIncrby(redis, hKey, delta, HOUR_TTL_SECONDS),
		redisIncrby(redis, dKey, delta, DAY_TTL_SECONDS),
	]);
	return { hour, day };
}

// Inverse of reserve(). Decrements the same buckets by the same amount.
// Used by the cap hook when admission passed but the payment subsequently
// failed (signing rejected, facilitator returned 402, network error, etc.)
// so the budget doesn't drain on aborted attempts.
//
// Idempotency: callers should track a `reserved` flag and only roll back
// once. We don't dedupe here — that's a property of the caller, not the
// store, because the same physical reservation can be rolled back by
// different code paths (catch block vs. retry policy).
export async function rollback({ address, microUsd, timestamp = now() }) {
	if (!address || !microUsd) return;
	const delta = BigInt(microUsd);
	const hKey = hourKey(address, utcHourBucket(timestamp));
	const dKey = dayKey(address, utcDayBucket(timestamp));
	const redis = getRedis();
	if (!redis) {
		memoryIncr(hKey, -delta, HOUR_TTL_SECONDS);
		memoryIncr(dKey, -delta, DAY_TTL_SECONDS);
		return;
	}
	await Promise.all([redis.incrby(hKey, -Number(delta)), redis.incrby(dKey, -Number(delta))]);
}

// Snapshot of the current hour + day spend without modifying. Used by
// dashboards and the relaxed (non-strict) cap path that's willing to
// race for a higher-throughput win.
export async function current({ address, timestamp = now() }) {
	if (!address) return { hour: 0n, day: 0n };
	const hKey = hourKey(address, utcHourBucket(timestamp));
	const dKey = dayKey(address, utcDayBucket(timestamp));
	const redis = getRedis();
	if (!redis) {
		return { hour: memoryGet(hKey), day: memoryGet(dKey) };
	}
	const [h, d] = await Promise.all([redis.get(hKey), redis.get(dKey)]);
	const toBig = (v) => (v == null ? 0n : BigInt(String(v)));
	return { hour: toBig(h), day: toBig(d) };
}

// Called by the onAfterPaymentCreation hook once the buyer has signed and
// the wire is on its way. The reservation already accounted for the spend
// — record() is a no-op on the totals and is primarily here so callers can
// also persist a richer audit log if they want one. We keep the public
// surface simple: pass through to ensure idempotent semantics; callers
// that store a separate per-payment audit table do that themselves.
export async function record(_event) {
	// Intentionally empty: reserve() did the accounting. This is the
	// API surface the cap module's lifecycle docs reference, so callers
	// have a single mental model (reserve → commit-or-rollback).
}

export const _internal = {
	utcHourBucket,
	utcDayBucket,
	hourKey,
	dayKey,
	resetMemoryStore() {
		memoryStore.clear();
		redisClient = null;
	},
};
