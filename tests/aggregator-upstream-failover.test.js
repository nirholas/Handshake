// The aggregator must not hand a caller a 429 while a healthy alternate
// upstream sits unused.
//
// `upstream_rate_limited` was the second-largest error class on /api/v1/x
// (881 in 30 days): the Solana provider pointed at a single RPC host, so every
// time that host throttled us the free lane passed the 429 straight through,
// even though the platform keeps a priority-ordered pool of six more endpoints
// for exactly this case (api/_lib/solana/connection.js).
//
// The rule under test: a retryable failure (429, unreachable, 5xx) walks the
// provider's alternate hosts; a caller-fault failure (4xx) never does; and a
// provider that declares no alternates behaves exactly as before, with one
// attempt and no extra cost.
//
// On top of that, a short per-host cooldown makes the failover sticky: a host
// that just failed is skipped while an alternate exists, so during an outage
// only the first request pays the discovery cost (worst case a full upstream
// timeout) instead of every request paying it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeUpstream, resetUpstreamHealth } from '../api/_lib/aggregator.js';

const endpoint = {
	id: 'ping',
	method: 'GET',
	path: '/ping',
	query: () => ({}),
};

const providerWithPool = (bases) => ({
	id: 'test',
	name: 'Test provider',
	base: 'https://primary.invalid',
	bases: async () => bases,
	requiresKey: false,
	applyKey: () => {},
});

const reply = (status, body = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// executeUpstream calls fetch with a URL instance; tests may also see a string.
const hostOf = (input) => (input instanceof URL ? input : new URL(String(input.url || input))).host;

// Host health is module state shared by every test in this file.
beforeEach(() => resetUpstreamHealth());
afterEach(() => vi.unstubAllGlobals());

describe('aggregator upstream failover', () => {
	it('falls over to an alternate host on a 429', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				seen.push(hostOf(input));
				return seen.length === 1 ? reply(429, { error: 'slow down' }) : reply(200, { ok: true });
			}),
		);

		const out = await executeUpstream({
			provider: providerWithPool(['https://backup-a.invalid', 'https://backup-b.invalid']),
			endpoint,
			query: {},
			apiKey: null,
		});

		expect(out).toEqual({ ok: true });
		expect(seen).toEqual(['primary.invalid', 'backup-a.invalid']);
	});

	it('falls over when the primary is unreachable', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				seen.push(hostOf(input));
				if (seen.length === 1) throw new Error('ECONNREFUSED');
				return reply(200, { ok: true });
			}),
		);

		const out = await executeUpstream({
			provider: providerWithPool(['https://backup-a.invalid']),
			endpoint,
			query: {},
			apiKey: null,
		});

		expect(out).toEqual({ ok: true });
		expect(seen).toEqual(['primary.invalid', 'backup-a.invalid']);
	});

	it('never retries a caller-fault 4xx', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				seen.push(hostOf(input));
				return reply(400, { error: 'bad address' });
			}),
		);

		await expect(
			executeUpstream({
				provider: providerWithPool(['https://backup-a.invalid']),
				endpoint,
				query: {},
				apiKey: null,
			}),
		).rejects.toMatchObject({ status: 400, code: 'upstream_error' });
		expect(seen).toEqual(['primary.invalid']);
	});

	it('surfaces the failure once the whole pool is exhausted', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => reply(429, { error: 'slow down' })));

		await expect(
			executeUpstream({
				provider: providerWithPool(['https://backup-a.invalid', 'https://backup-b.invalid']),
				endpoint,
				query: {},
				apiKey: null,
			}),
		).rejects.toMatchObject({ code: 'upstream_rate_limited' });
	});

	it('caps attempts so one call cannot walk an unbounded pool', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				seen.push(hostOf(input));
				return reply(429, {});
			}),
		);

		const pool = Array.from({ length: 10 }, (_, i) => `https://backup-${i}.invalid`);
		await expect(
			executeUpstream({ provider: providerWithPool(pool), endpoint, query: {}, apiKey: null }),
		).rejects.toMatchObject({ code: 'upstream_rate_limited' });
		expect(seen).toHaveLength(3);
	});

	it('makes exactly one attempt for a provider with no alternates', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				seen.push(hostOf(input));
				return reply(429, {});
			}),
		);

		const provider = {
			id: 'single',
			name: 'Single host',
			base: 'https://primary.invalid',
			requiresKey: false,
			applyKey: () => {},
		};

		await expect(executeUpstream({ provider, endpoint, query: {}, apiKey: null })).rejects.toMatchObject({
			code: 'upstream_rate_limited',
		});
		expect(seen).toEqual(['primary.invalid']);
	});

	it('skips a primary that just failed, so only the first request pays for the outage', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				const host = hostOf(input);
				seen.push(host);
				return host === 'primary.invalid' ? reply(429, {}) : reply(200, { ok: true });
			}),
		);

		const provider = providerWithPool(['https://backup-a.invalid']);
		await executeUpstream({ provider, endpoint, query: {}, apiKey: null });
		expect(seen).toEqual(['primary.invalid', 'backup-a.invalid']);

		// Second call within the cooldown window goes straight to the alternate.
		const out = await executeUpstream({ provider, endpoint, query: {}, apiKey: null });
		expect(out).toEqual({ ok: true });
		expect(seen).toEqual(['primary.invalid', 'backup-a.invalid', 'backup-a.invalid']);
	});

	it('still tries a cooled-down primary when the pool resolves empty', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				seen.push(hostOf(input));
				return seen.length === 1 ? reply(429, {}) : reply(200, { ok: true });
			}),
		);

		// First call marks the primary bad; the second resolves an empty pool, so
		// the primary must be tried anyway rather than failing with no attempt.
		await executeUpstream({
			provider: providerWithPool(['https://backup-a.invalid']),
			endpoint,
			query: {},
			apiKey: null,
		});
		const out = await executeUpstream({ provider: providerWithPool([]), endpoint, query: {}, apiKey: null });
		expect(out).toEqual({ ok: true });
		expect(seen[seen.length - 1]).toBe('primary.invalid');
	});

	it('answers inside the 25s total budget even when every host blackholes', async () => {
		vi.useFakeTimers();
		try {
			const seen = [];
			// Every host hangs until its abort timer fires; only the deadline can
			// end this call.
			vi.stubGlobal(
				'fetch',
				vi.fn(
					(input, init) =>
						new Promise((_, reject) => {
							seen.push(hostOf(input));
							init.signal.addEventListener('abort', () => reject(new Error('aborted')));
						}),
				),
			);

			const started = Date.now();
			const pending = executeUpstream({
				provider: providerWithPool(['https://backup-a.invalid', 'https://backup-b.invalid']),
				endpoint,
				query: {},
				apiKey: null,
			}).catch((err) => ({ err, settledAt: Date.now() }));

			await vi.advanceTimersByTimeAsync(30_000);
			const { err, settledAt } = await pending;

			// Pooled attempts abort at 10s each; the third gets only the 5s left in
			// the budget, so the caller has an answer at 25s, inside the LB's 30s.
			expect(err).toMatchObject({ code: 'upstream_unreachable' });
			expect(seen).toEqual(['primary.invalid', 'backup-a.invalid', 'backup-b.invalid']);
			expect(settledAt - started).toBeLessThanOrEqual(25_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives a skipped primary a last chance when every alternate fails', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				seen.push(hostOf(input));
				// Primary recovers; the backup stays rate-limited throughout.
				return hostOf(input) === 'backup-a.invalid' || seen.length === 1
					? reply(429, {})
					: reply(200, { ok: true });
			}),
		);

		const provider = providerWithPool(['https://backup-a.invalid']);
		await expect(executeUpstream({ provider, endpoint, query: {}, apiKey: null })).rejects.toMatchObject({
			code: 'upstream_rate_limited',
		});

		// Second call: primary is cooling, backup is tried first and fails, and
		// the primary (now recovered) is reached as the final candidate.
		const out = await executeUpstream({ provider, endpoint, query: {}, apiKey: null });
		expect(out).toEqual({ ok: true });
		expect(seen).toEqual(['primary.invalid', 'backup-a.invalid', 'backup-a.invalid', 'primary.invalid']);
	});
});
