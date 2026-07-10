/**
 * redis.js quota-exhaustion fast-fail breaker — unit test.
 *
 * Live production failure, 2026-07-10: the Upstash plan's monthly request
 * allowance was spent ("ERR max requests limit exceeded. Limit: 500000, Usage:
 * 500000"). Unlike a network blip, the counter does not reset until the billing
 * boundary — so EVERY command for the rest of the period is doomed. Untreated,
 * each request still paid a full Upstash REST round-trip (latency on the hot
 * path) and re-logged, and healthz reported `cache` degraded with the circuit
 * flapping open every few minutes.
 *
 * The breaker treats quota exhaustion like the auth breaker treats WRONGPASS: the
 * first quota rejection opens it, subsequent commands short-circuit to the
 * caller's fallback with `circuitOpen` set (no fetch, no quota spend, no stall),
 * and a half-open trial re-probes on an escalating cooldown so a plan upgrade
 * self-heals without a redeploy.
 *
 * The @upstash/redis client issues each command as a fetch() to the REST URL, so
 * we stub global fetch to simulate the quota rejection, then a recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	getRedis,
	redisQuotaBreakerState,
	redisAuthBreakerState,
	isRedisQuotaError,
	__resetRedisAuthBreaker,
} from '../api/_lib/redis.js';

const URL = 'https://quota-test.upstash.io';
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
let saved;

const HEADERS = { get: () => null };

// Mirrors the request shape the way the auth-breaker test does: the client's
// auto-pipelining sends an array of command arrays and expects an array back.
function makeResponse(body, init) {
	let parsed;
	try {
		parsed = JSON.parse(init?.body || 'null');
	} catch {
		parsed = null;
	}
	const isPipeline = Array.isArray(parsed) && Array.isArray(parsed[0]);
	const payload = isPipeline ? parsed.map(() => body) : body;
	return {
		ok: true,
		status: 200,
		headers: HEADERS,
		async json() {
			return payload;
		},
		async text() {
			return JSON.stringify(payload);
		},
	};
}

// The verbatim body Upstash returned in production on 2026-07-10.
const QUOTA = {
	error:
		'ERR max requests limit exceeded. Limit: 500000, Usage: 500000. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details',
};
const quotaResponse = (init) => makeResponse(QUOTA, init);
const okResponse = (result, init) => makeResponse({ result }, init);

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.UPSTASH_REDIS_REST_URL = URL;
	process.env.UPSTASH_REDIS_REST_TOKEN = 'valid-token';
	__resetRedisAuthBreaker();
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.restoreAllMocks();
	__resetRedisAuthBreaker();
});

describe('isRedisQuotaError', () => {
	it('recognizes the production quota rejection', () => {
		expect(isRedisQuotaError(new Error(QUOTA.error))).toBe(true);
		expect(isRedisQuotaError(new Error('ERR max daily request limit reached'))).toBe(true);
	});

	it('does not mistake a transient or auth failure for quota exhaustion', () => {
		expect(isRedisQuotaError(new Error('fetch failed'))).toBe(false);
		expect(isRedisQuotaError(new Error('WRONGPASS invalid or missing auth token.'))).toBe(false);
		expect(isRedisQuotaError(new Error('redis command timed out after 5000ms'))).toBe(false);
	});
});

describe('redis quota breaker', () => {
	it('opens on the first quota rejection and then fast-fails without calling fetch', async () => {
		const fetchMock = vi.fn(async (_url, init) => quotaResponse(init));
		globalThis.fetch = fetchMock;
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const r = getRedis();
		expect(r).toBeTruthy();

		// First command pays one real round-trip and surfaces the quota error.
		await expect(r.get('k')).rejects.toThrow(/max requests limit exceeded/i);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(redisQuotaBreakerState().open).toBe(true);
		// Quota exhaustion must NOT be mistaken for a bad credential.
		expect(redisAuthBreakerState().open).toBe(false);

		// Every later command short-circuits: no fetch, rejection tagged circuitOpen
		// so consumers (cache.js, rate-limit.js) route to their fallback silently.
		for (let i = 0; i < 50; i++) {
			const err = await r.get('k').then(() => null, (e) => e);
			expect(err).toBeTruthy();
			expect(err.circuitOpen).toBe(true);
			expect(err.quotaBreakerOpen).toBe(true);
		}
		expect(fetchMock).toHaveBeenCalledTimes(1); // still just the one real call
	});

	it('self-heals via a half-open trial once the plan has capacity again', async () => {
		let mode = 'quota';
		const fetchMock = vi.fn(async (_url, init) =>
			mode === 'quota' ? quotaResponse(init) : okResponse('PONG', init),
		);
		globalThis.fetch = fetchMock;
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const r = getRedis();
		await expect(r.get('k')).rejects.toThrow(/max requests limit exceeded/i);
		expect(redisQuotaBreakerState().open).toBe(true);

		// While the cooldown is unexpired the breaker holds — no network call.
		await expect(r.get('k')).rejects.toMatchObject({ circuitOpen: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Fast-forward past the cooldown; the plan now answers. (The client
		// base64-decodes results, so assert the command SETTLES rather than
		// pinning a decoded value — what matters is that the trial was admitted.)
		mode = 'ok';
		const before = fetchMock.mock.calls.length;
		vi.spyOn(Date, 'now').mockReturnValue(redisQuotaBreakerState().openUntil + 1);

		await expect(r.get('k')).resolves.toBeDefined(); // the half-open trial
		expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
		expect(redisQuotaBreakerState().open).toBe(false);
		expect(redisQuotaBreakerState().rearms).toBe(0);
	});

	it('a transient error neither opens nor is masked by the quota breaker', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('fetch failed');
		});
		globalThis.fetch = fetchMock;
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const r = getRedis();
		await expect(r.get('k')).rejects.toThrow(/fetch failed/i);
		// Transient failures keep the existing per-consumer degrade behavior.
		expect(redisQuotaBreakerState().open).toBe(false);
		expect(redisAuthBreakerState().open).toBe(false);

		// …and they still reach the network on the next command rather than being
		// short-circuited. (The upstash client retries internally, so assert the
		// call count grows rather than pinning its retry policy.)
		const before = fetchMock.mock.calls.length;
		await expect(r.get('k')).rejects.toThrow(/fetch failed/i);
		expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
	});
});
