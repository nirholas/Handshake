// x402 subscription API keys — issuance, lookup, revocation, sliding-window
// rate limiting. Backed by Postgres (api/_lib/migrations/2026-05-21-x402-subscriptions.sql)
// with Upstash Redis sorted-set rate limiting where credentials are present
// and an in-memory fallback for local dev.
//
// USE-23 wiring: api/_lib/x402/access-control.js calls this module from
// inside the onProtectedRequest hook to look up the subscription a request
// belongs to before deciding whether to bypass the 402 challenge.
//
// Key format:
//   plaintext = "x402_live_" + base64url(32 bytes of CSPRNG entropy)
//   prefix    = plaintext.slice(0, 16)                        // visible in logs / UI
//   hash      = hex(sha256(plaintext))                        // stored in db
//
// The plaintext is shown ONCE at creation and never persisted in clear.

import { Redis } from '@upstash/redis';
import { sql } from '../db.js';
import { env } from '../env.js';
import { randomToken, sha256 } from '../crypto.js';

const KEY_PREFIX = 'x402_live_';

let _redis = null;
const IS_PROD = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
const ALLOW_MEMORY_FALLBACK = process.env.X402_ALLOW_MEMORY_FALLBACK === '1';

let _redisChecked = false;
let _memoryFallbackWarned = false;
function getRedis() {
	if (_redisChecked) return _redis;
	_redisChecked = true;
	if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
		_redis = new Redis({
			url: env.UPSTASH_REDIS_REST_URL,
			token: env.UPSTASH_REDIS_REST_TOKEN,
		});
		return _redis;
	}
	if (IS_PROD && !ALLOW_MEMORY_FALLBACK) {
		throw new Error(
			'[x402/api-keys] UPSTASH_REDIS_REST_URL/TOKEN required in production. ' +
				'Set them, or set X402_ALLOW_MEMORY_FALLBACK=1 to accept per-instance subscription rate-limits.',
		);
	}
	if (IS_PROD && !_memoryFallbackWarned) {
		_memoryFallbackWarned = true;
		console.warn(
			'[x402/api-keys] Running in production with memory rate-limit; ' +
				'subscription caps are per-instance only.',
		);
	}
	return _redis;
}

// In-memory sliding-window fallback for local dev (no Upstash configured).
// Maps key → array of millisecond timestamps within the current window.
const _memoryWindows = new Map();

/**
 * Look up a subscription by its plaintext API key.
 * Returns the row (without key_hash) or null when no active subscription matches.
 *
 * "Active" = not revoked AND (expires_at IS NULL OR expires_at > now).
 *
 * @param {string} plaintextKey
 * @returns {Promise<null | { id, name, key_prefix, rate_limit_per_minute, expires_at, revoked_at, meta, created_at }>}
 */
export async function lookupSubscription(plaintextKey) {
	if (!plaintextKey || typeof plaintextKey !== 'string') return null;
	if (!plaintextKey.startsWith(KEY_PREFIX)) return null;
	const hash = await sha256(plaintextKey);
	const rows = await sql`
		select id, name, key_prefix, rate_limit_per_minute, expires_at, revoked_at, meta, created_at
		from x402_subscriptions
		where key_hash = ${hash}
		limit 1
	`;
	const row = rows[0];
	if (!row) return null;
	if (row.revoked_at) return { ...row, _status: 'revoked' };
	if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
		return { ...row, _status: 'expired' };
	}
	return { ...row, _status: 'active' };
}

/**
 * Sliding-window rate limit: returns { allowed, remaining, limit, resetAt }.
 * The window is 60 seconds. Each (subscriptionId, route) pair is bucketed
 * independently so partner traffic on one endpoint cannot starve another.
 *
 * @param {object} subscription            — row returned by lookupSubscription()
 * @param {string} route                   — e.g. "/api/x402/model-check"
 * @returns {Promise<{ allowed: boolean, remaining: number, limit: number, resetAt: number }>}
 */
export async function checkRateLimit(subscription, route) {
	const limit = Math.max(1, Number(subscription?.rate_limit_per_minute) || 60);
	const windowMs = 60_000;
	const now = Date.now();
	const bucketKey = `x402:rl:${subscription.id}:${route}`;

	const redis = getRedis();
	if (redis) {
		// Redis sorted-set sliding window: ZREMRANGEBYSCORE drops expired
		// timestamps, ZCARD counts the rest, ZADD writes the new one. EXPIRE
		// keeps the key from leaking when the partner stops calling.
		const cutoff = now - windowMs;
		const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
		const pipeline = redis.pipeline();
		pipeline.zremrangebyscore(bucketKey, 0, cutoff);
		pipeline.zadd(bucketKey, { score: now, member });
		pipeline.zcard(bucketKey);
		pipeline.expire(bucketKey, Math.ceil(windowMs / 1000) + 5);
		const results = await pipeline.exec();
		const count = Number(results?.[2] ?? 0);
		if (count > limit) {
			// Remove the candidate we just added so it doesn't count against
			// the next legitimate request after the window slides.
			await redis.zrem(bucketKey, member);
			const oldest = await redis.zrange(bucketKey, 0, 0, { withScores: true });
			const resetAt = oldest?.length >= 2 ? Number(oldest[1]) + windowMs : now + windowMs;
			return { allowed: false, remaining: 0, limit, resetAt };
		}
		return {
			allowed: true,
			remaining: Math.max(0, limit - count),
			limit,
			resetAt: now + windowMs,
		};
	}

	// In-memory fallback. Single-process correctness only — fine for local
	// dev, would over-allow across Vercel lambda instances. Production must
	// have Upstash configured.
	const cutoff = now - windowMs;
	const stamps = (_memoryWindows.get(bucketKey) || []).filter((t) => t > cutoff);
	if (stamps.length >= limit) {
		_memoryWindows.set(bucketKey, stamps);
		return {
			allowed: false,
			remaining: 0,
			limit,
			resetAt: stamps[0] + windowMs,
		};
	}
	stamps.push(now);
	_memoryWindows.set(bucketKey, stamps);
	return {
		allowed: true,
		remaining: Math.max(0, limit - stamps.length),
		limit,
		resetAt: now + windowMs,
	};
}

/**
 * Issue a new subscription. Returns the row plus the plaintext token.
 * The plaintext is shown ONCE — callers MUST surface it to the operator and
 * we never store it.
 *
 * @param {object} opts
 * @param {string} opts.name                                  — required, human-readable label
 * @param {string} [opts.id]                                  — optional explicit id (default: random 12-char slug)
 * @param {number} [opts.rateLimitPerMinute=60]
 * @param {Date|string|null} [opts.expiresAt]
 * @param {object|null} [opts.meta]
 * @param {string|null} [opts.createdBy]                      — user.id of issuing admin
 * @returns {Promise<{ id, name, key_prefix, rate_limit_per_minute, expires_at, meta, created_at, token: string }>}
 */
export async function createSubscription({
	name,
	id,
	rateLimitPerMinute = 60,
	expiresAt = null,
	meta = null,
	createdBy = null,
}) {
	if (!name || typeof name !== 'string') {
		const err = new Error('subscription name is required');
		err.status = 400;
		err.code = 'validation_error';
		throw err;
	}
	const subId = id || `sub_${randomToken(8).slice(0, 12)}`;
	const tokenSecret = randomToken(32);
	const plaintext = `${KEY_PREFIX}${tokenSecret}`;
	const prefix = plaintext.slice(0, 16);
	const hash = await sha256(plaintext);

	const [row] = await sql`
		insert into x402_subscriptions
			(id, name, key_hash, key_prefix, rate_limit_per_minute, expires_at, meta, created_by)
		values
			(${subId}, ${name}, ${hash}, ${prefix}, ${rateLimitPerMinute},
			 ${expiresAt}, ${meta}, ${createdBy})
		returning id, name, key_prefix, rate_limit_per_minute, expires_at, meta, created_at
	`;
	return { ...row, token: plaintext };
}

/**
 * Revoke a subscription. Idempotent: re-revoking is a no-op. Returns the
 * updated row, or null when no subscription with this id exists.
 */
export async function revokeSubscription(id) {
	const [row] = await sql`
		update x402_subscriptions
		set revoked_at = coalesce(revoked_at, now())
		where id = ${id}
		returning id, name, key_prefix, rate_limit_per_minute, expires_at, revoked_at, meta, created_at
	`;
	return row || null;
}

/**
 * Aggregate usage for a subscription. Reads from x402_access_log: total
 * grants, total denials, per-route counts, and the most recent N entries
 * for quick eyeballing.
 */
export async function getUsage(id, { recentLimit = 50 } = {}) {
	const [sub] = await sql`
		select id, name, key_prefix, rate_limit_per_minute, expires_at, revoked_at, created_at
		from x402_subscriptions where id = ${id}
	`;
	if (!sub) return null;
	const callerId = `subscription:${id}`;
	const [counts] = await sql`
		select
			count(*) filter (where granted)         as granted,
			count(*) filter (where not granted)     as denied,
			max(created_at)                         as last_seen
		from x402_access_log
		where caller_id = ${callerId}
	`;
	const perRoute = await sql`
		select route,
		       count(*) filter (where granted)     as granted,
		       count(*) filter (where not granted) as denied
		from x402_access_log
		where caller_id = ${callerId}
		group by route
		order by granted desc, denied desc
	`;
	const recent = await sql`
		select route, granted, reason, meta, created_at
		from x402_access_log
		where caller_id = ${callerId}
		order by created_at desc
		limit ${recentLimit}
	`;
	return {
		subscription: sub,
		totals: {
			granted: Number(counts?.granted || 0),
			denied: Number(counts?.denied || 0),
			lastSeenAt: counts?.last_seen || null,
		},
		perRoute: perRoute.map((r) => ({
			route: r.route,
			granted: Number(r.granted || 0),
			denied: Number(r.denied || 0),
		})),
		recent,
	};
}

/**
 * List active subscriptions (or all when includeInactive is true). Never
 * returns the key hash — only the prefix.
 */
export async function listSubscriptions({ includeInactive = false } = {}) {
	if (includeInactive) {
		return sql`
			select id, name, key_prefix, rate_limit_per_minute, expires_at, revoked_at,
			       meta, created_at, created_by
			from x402_subscriptions
			order by created_at desc
		`;
	}
	return sql`
		select id, name, key_prefix, rate_limit_per_minute, expires_at, revoked_at,
		       meta, created_at, created_by
		from x402_subscriptions
		where revoked_at is null
		  and (expires_at is null or expires_at > now())
		order by created_at desc
	`;
}

/**
 * Write one row to x402_access_log. Fire-and-forget (errors logged, never
 * thrown) so the audit trail can never break a paid endpoint response.
 *
 * @param {object} entry
 * @param {string} entry.callerId           — 'internal' | 'subscription:<id>' | 'oauth:<sub>' | 'abort:<short>'
 * @param {string} entry.route
 * @param {string} entry.reason
 * @param {boolean} entry.granted
 * @param {object|null} [entry.meta]
 */
export function logAccess({ callerId, route, reason, granted, meta = null }) {
	queueMicrotask(async () => {
		try {
			await sql`
				insert into x402_access_log (caller_id, route, reason, granted, meta)
				values (${callerId}, ${route}, ${reason}, ${granted}, ${meta})
			`;
		} catch (err) {
			console.error('[x402-access-log] insert failed', {
				route,
				callerId,
				error: err?.message,
			});
		}
	});
}

export const __test = { KEY_PREFIX };
