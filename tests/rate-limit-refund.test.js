// Tests for refunding a consumed single-use rate-limit window.
//
// The case this exists for: a caller is charged a 6-hour window, then the run
// produces nothing at all because a dependency the platform owns was down (every
// LLM provider busy at once, in the GitHub memory-seeding lane). Charging that
// to the caller means our outage costs them six hours on a run that read nothing
// and wrote nothing, so the handler hands the window back.
//
// A refund is only meaningful on a single-use window: Upstash cannot return one
// token, so the Redis path resets the identifier, which is equivalent only when
// the ceiling is 1. refundLimit refuses anything else rather than silently
// clearing a bucket it was never allowed to clear.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory stand-in for rate_limit_counters, with the UPDATE the refund issues.
function makeSqlStub() {
	const rows = new Map();
	const sql = (strings, ...values) => {
		const text = strings.join('?');
		if (/DELETE FROM rate_limit_counters/i.test(text)) return Promise.resolve([]);
		if (/INSERT INTO rate_limit_counters/i.test(text)) {
			const [bucket, windowStart] = values;
			const key = `${bucket}\u0000${windowStart}`;
			const hits = (rows.get(key) || 0) + 1;
			rows.set(key, hits);
			return Promise.resolve([{ hits }]);
		}
		if (/UPDATE rate_limit_counters/i.test(text)) {
			const [bucket, windowStart] = values;
			const key = `${bucket}\u0000${windowStart}`;
			if (!rows.has(key)) return Promise.resolve([]);
			const hits = Math.max(0, rows.get(key) - 1);
			rows.set(key, hits);
			return Promise.resolve([{ hits }]);
		}
		return Promise.resolve([]);
	};
	return { sql, rows };
}

async function loadRateLimit({ redis = null, sqlStub, production = false } = {}) {
	vi.resetModules();
	vi.doMock('../api/_lib/db.js', () => ({ sql: sqlStub.sql }));
	vi.doMock('../api/_lib/redis.js', () => ({ getRedis: () => redis, isRedisAuthError: () => false }));
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

beforeEach(() => {
	vi.stubEnv('VITEST', '1');
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.doUnmock('../api/_lib/db.js');
	vi.doUnmock('../api/_lib/redis.js');
	vi.doUnmock('../api/_lib/env.js');
});

describe('the GitHub seeding window', () => {
	it('blocks a second run, and lets it through once the window is refunded', async () => {
		const { limits } = await loadRateLimit({ sqlStub: makeSqlStub() });

		expect((await limits.githubSeed('agent-1')).success).toBe(true);
		expect((await limits.githubSeed('agent-1')).success).toBe(false);

		expect(await limits.githubSeedRefund('agent-1')).toBe(true);
		expect((await limits.githubSeed('agent-1')).success).toBe(true);
		// The refund returned one hit, not the whole bucket.
		expect((await limits.githubSeed('agent-1')).success).toBe(false);
	});

	it('refunds only the agent that failed', async () => {
		const { limits } = await loadRateLimit({ sqlStub: makeSqlStub() });

		await limits.githubSeed('agent-1');
		await limits.githubSeed('agent-2');
		await limits.githubSeedRefund('agent-1');

		expect((await limits.githubSeed('agent-1')).success).toBe(true);
		expect((await limits.githubSeed('agent-2')).success).toBe(false);
	});

	it('reports nothing to refund when the window was never spent', async () => {
		const { limits } = await loadRateLimit({ sqlStub: makeSqlStub() });
		expect(await limits.githubSeedRefund('never-seeded')).toBe(false);
	});
});

describe('refundLimit', () => {
	it('refuses a bucket whose ceiling is not one', async () => {
		const { refundLimit } = await loadRateLimit({ sqlStub: makeSqlStub() });
		await expect(
			refundLimit('withdrawal:user', { limit: 5, window: '1 d', critical: true }, 'user-1'),
		).rejects.toThrow(/not a single-use window/);
	});

	it('decrements the durable Postgres counter for a critical bucket', async () => {
		const stub = makeSqlStub();
		const { refundLimit } = await loadRateLimit({ sqlStub: stub, production: true });

		// A critical bucket with no Redis counts in Postgres, so its refund has to
		// find the row the counter wrote: same bucket key, same window start.
		const ms = 3600_000;
		const windowStart = Math.floor(Date.now() / ms) * ms;
		const key = `test:single\u0000user-1\u0000${windowStart}`;
		stub.rows.set(key, 1);

		expect(
			await refundLimit('test:single', { limit: 1, window: '1 h', critical: true }, 'user-1'),
		).toBe(true);
		expect(stub.rows.get(key)).toBe(0);
	});

	it('reports no refund when the durable counter holds no row for the caller', async () => {
		const stub = makeSqlStub();
		const { refundLimit } = await loadRateLimit({ sqlStub: stub, production: true });
		expect(
			await refundLimit('test:single', { limit: 1, window: '1 h', critical: true }, 'nobody'),
		).toBe(false);
	});
});
