// Regression tests for the rate limiter's behaviour when Redis cannot answer.
//
// Incident (2026-07-09): the shared Upstash store hit its plan-wide command
// allowance ("max requests limit exceeded. Limit: 500000"). That is not a blip —
// the counter resets only on the plan's billing boundary — so for the rest of the
// period every Redis command was rejected. Two consequences fell out of the old
// design, and each is pinned by a test below:
//
//   1. `critical` money buckets FAILED CLOSED, taking every checkout, withdrawal,
//      mint and trade down for the length of the outage. They must now degrade
//      onto a durable Postgres counter instead.
//   2. Every rate-limited request paid a full failing Redis round-trip, because
//      rate-limit.js — unlike cache.js — had no circuit breaker.
//
// The Postgres path is exercised against a stubbed `sql` tag: these are unit
// tests, and the live-database proof (exact enforcement + durability across a
// second module instance) is covered separately by the deploy-time check.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const QUOTA_ERROR = 'ERR max requests limit exceeded. Limit: 500000, Usage: 500000';

// In-memory stand-in for the rate_limit_counters table. Mirrors the migration's
// (bucket, window_start) primary key and the INSERT … ON CONFLICT DO UPDATE
// semantics: one atomic increment returning the post-increment count.
function makeSqlStub() {
	const rows = new Map();
	const calls = { inserts: 0, deletes: 0 };
	const sql = (strings, ...values) => {
		const text = strings.join('?');
		if (/DELETE FROM rate_limit_counters/i.test(text)) {
			calls.deletes++;
			return Promise.resolve([]);
		}
		if (/INSERT INTO rate_limit_counters/i.test(text)) {
			calls.inserts++;
			const [bucket, windowStart] = values;
			const key = `${bucket}\u0000${windowStart}`;
			const hits = (rows.get(key) || 0) + 1;
			rows.set(key, hits);
			return Promise.resolve([{ hits }]);
		}
		return Promise.resolve([]);
	};
	return { sql, calls, rows };
}

async function loadRateLimit({ redis, sqlStub, production = true }) {
	vi.resetModules();
	vi.doMock('../api/_lib/db.js', () => ({ sql: sqlStub.sql }));
	vi.doMock('../api/_lib/redis.js', () => ({
		getRedis: () => redis,
		isRedisAuthError: () => false,
	}));
	vi.doMock('../api/_lib/env.js', () => ({
		env: {
			NODE_ENV: production ? 'production' : 'test',
			VERCEL_ENV: production ? 'production' : 'development',
			DATABASE_URL: 'postgres://stub/db',
			CACHE_REDIS_CMD_TIMEOUT_MS: 3000,
		},
	}));
	return import('../api/_lib/rate-limit.js');
}

// A fake @upstash/ratelimit-shaped client whose commands always reject the way an
// over-quota Upstash store does.
function overQuotaRedis(counter) {
	return {
		// The Ratelimit constructor only stores this object; our stub throws when
		// @upstash/ratelimit issues its script/eval command through it.
		eval: () => {
			counter.attempts++;
			return Promise.reject(new Error(QUOTA_ERROR));
		},
		evalsha: () => {
			counter.attempts++;
			return Promise.reject(new Error(QUOTA_ERROR));
		},
		scriptLoad: () => Promise.reject(new Error(QUOTA_ERROR)),
	};
}

beforeEach(() => {
	vi.stubEnv('VITEST', '1');
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.doUnmock('../api/_lib/db.js');
	vi.doUnmock('../api/_lib/redis.js');
	vi.doUnmock('../api/_lib/env.js');
});

describe('isRedisQuotaError', () => {
	it('recognises the Upstash over-quota rejection', async () => {
		const { isRedisQuotaError } = await loadRateLimit({ redis: null, sqlStub: makeSqlStub() });
		expect(isRedisQuotaError(new Error(QUOTA_ERROR))).toBe(true);
	});

	it('does not mistake an ordinary timeout for an exhausted allowance', async () => {
		const { isRedisQuotaError } = await loadRateLimit({ redis: null, sqlStub: makeSqlStub() });
		expect(isRedisQuotaError(new Error('operation aborted due to timeout'))).toBe(false);
		expect(isRedisQuotaError(undefined)).toBe(false);
	});
});

describe('durable Postgres fallback (no Redis configured)', () => {
	it('a critical money bucket enforces its ceiling instead of failing closed', async () => {
		const stub = makeSqlStub();
		const { limits } = await loadRateLimit({ redis: null, sqlStub: stub });

		// withdrawalPerUser: 5 per day, critical, not degradeToMemory — the exact
		// shape that used to answer "denied, rate_limiter_unavailable" on request #1.
		const seen = [];
		for (let i = 0; i < 7; i++) seen.push(await limits.withdrawalPerUser('user-1'));

		expect(seen[0].success).toBe(true);
		expect(seen[0].reason).toBe('rate_limiter_degraded_postgres');
		expect(seen.filter((r) => r.success)).toHaveLength(5);
		expect(seen[5].success).toBe(false);
		expect(seen[6].success).toBe(false);
		expect(stub.calls.inserts).toBe(7);
	});

	it('counts each identity in its own bucket', async () => {
		const stub = makeSqlStub();
		const { limits } = await loadRateLimit({ redis: null, sqlStub: stub });
		for (let i = 0; i < 5; i++) await limits.withdrawalPerUser('user-a');
		const other = await limits.withdrawalPerUser('user-b');
		expect(other.success).toBe(true);
		expect(other.remaining).toBe(4);
	});

	it('namespaces buckets so a spent limiter cannot starve an unrelated one', async () => {
		const stub = makeSqlStub();
		const { limits } = await loadRateLimit({ redis: null, sqlStub: stub });
		for (let i = 0; i < 6; i++) await limits.withdrawalPerUser('same-id');
		// voiceClone: 3/day, also critical — same id, different bucket.
		const voice = await limits.voiceClone('same-id');
		expect(voice.success).toBe(true);
	});

	it('cheap non-critical buckets never touch Postgres', async () => {
		const stub = makeSqlStub();
		const { limits } = await loadRateLimit({ redis: null, sqlStub: stub });
		for (let i = 0; i < 20; i++) await limits.imgProxyIp('203.0.113.1');
		expect(stub.calls.inserts).toBe(0);
	});

	it('the hottest read guards are local — zero Postgres, zero Redis', async () => {
		const stub = makeSqlStub();
		const { limits } = await loadRateLimit({ redis: null, sqlStub: stub });
		for (let i = 0; i < 30; i++) {
			await limits.authedReadIp('203.0.113.2');
			await limits.mcpIp('203.0.113.2');
			await limits.walletRead('user-x');
		}
		expect(stub.calls.inserts).toBe(0);
	});

	it('a Postgres outage on top of a Redis outage still denies a money bucket', async () => {
		const stub = makeSqlStub();
		stub.sql = () => Promise.reject(new Error('neon unreachable'));
		const { limits } = await loadRateLimit({ redis: null, sqlStub: stub });
		const r = await limits.withdrawalPerUser('user-1');
		expect(r.success).toBe(false);
		expect(r.reason).toBe('rate_limiter_unavailable');
	});

	it('an auth bucket stays usable when both Redis and Postgres are down', async () => {
		// degradeToMemory: locking every user out of login is worse than a weaker,
		// per-instance brute-force cap.
		const stub = makeSqlStub();
		stub.sql = () => Promise.reject(new Error('neon unreachable'));
		const { limits } = await loadRateLimit({ redis: null, sqlStub: stub });
		const r = await limits.authIp('203.0.113.9');
		expect(r.success).toBe(true);
	});
});

describe('circuit breaker in front of Redis', () => {
	it('stops hammering an over-quota store and serves from the durable fallback', async () => {
		const counter = { attempts: 0 };
		const stub = makeSqlStub();
		const { limits } = await loadRateLimit({ redis: overQuotaRedis(counter), sqlStub: stub });

		// Enough calls that, without a breaker, every one would hit Redis.
		const results = [];
		for (let i = 0; i < 25; i++) results.push(await limits.withdrawalPerUser(`user-${i}`));

		// The breaker opens after 5 consecutive failures, so Redis is attempted a
		// bounded number of times — not once per request.
		expect(counter.attempts).toBeLessThanOrEqual(6);
		expect(counter.attempts).toBeGreaterThan(0);

		// And the requests were still decided — durably, in Postgres.
		expect(results.every((r) => r.reason === 'rate_limiter_degraded_postgres')).toBe(true);
		expect(results.every((r) => r.success)).toBe(true);
		expect(stub.calls.inserts).toBe(25);
	});

	it('reports the exhausted allowance through rateLimiterHealth', async () => {
		const counter = { attempts: 0 };
		const stub = makeSqlStub();
		const { limits, rateLimiterHealth } = await loadRateLimit({
			redis: overQuotaRedis(counter),
			sqlStub: stub,
		});
		for (let i = 0; i < 6; i++) await limits.withdrawalPerUser('u');
		const h = rateLimiterHealth();
		expect(h.configured).toBe(true);
		expect(h.quotaExhausted).toBe(true);
		expect(h.durableFallback).toBe(true);
		expect(h.circuitOpen).toBe(true);
	});

	it('a non-critical bucket fails OPEN when Redis is blind', async () => {
		// A limiter outage must never take down a read endpoint.
		const counter = { attempts: 0 };
		const stub = makeSqlStub();
		const { limits } = await loadRateLimit({ redis: overQuotaRedis(counter), sqlStub: stub });
		const r = await limits.cohortsIp('203.0.113.4');
		expect(r.success).toBe(true);
		expect(r.reason).toBe('rate_limiter_degraded');
		expect(stub.calls.inserts).toBe(0);
	});
});

describe('bucket declaration invariants', () => {
	// `local` means per-instance memory and nothing else — never a Redis or
	// Postgres command. That is right for a flood guard and catastrophic for a
	// spend control: across a Cloud Run fan-out it bounds one container, not the
	// money. Reducing Redis burn is a standing pressure on this file, so pin the
	// rule mechanically rather than trusting review.
	it('no `critical` bucket is declared `local`', async () => {
		const fs = await import('node:fs');
		const url = await import('node:url');
		const src = fs.readFileSync(
			url.fileURLToPath(new URL('../api/_lib/rate-limit.js', import.meta.url)),
			'utf8',
		);
		const offenders = [];
		for (const m of src.matchAll(/getLimiter\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g)) {
			const [, name, opts] = m;
			if (/local:\s*true/.test(opts) && /critical:\s*true/.test(opts)) offenders.push(name);
		}
		expect(offenders).toEqual([]);
	});
});
