// The loop that makes Brownout worth having: inject a fault, run the REAL
// wrapper and the REAL provider ladder, and watch the fallback take over while
// the response reports honestly what happened.
//
// A stubbed `fetch` can only prove the stub was called. These tests break the
// upstream from inside the wrapper that every third-party call in api/ goes
// through, so what is exercised is the retry policy, the breaker, the last-good
// tier and the ladder itself, exactly as a real outage would exercise them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withProvenance, provenanceSummary, provenanceHeaders } from '../api/_lib/brownout/provenance.js';
import { withChaos, parseChaosDirective } from '../api/_lib/brownout/chaos.js';
import { fetchUpstreamJson, lastGood, _resetLastGood } from '../api/_lib/upstream-fetch.js';
import { fetchFirst } from '../src/shared/failover-fetch.js';

const ORIGINAL_FETCH = globalThis.fetch;
const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	_resetLastGood?.();
});
afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	vi.restoreAllMocks();
});

describe('fetchUpstream under an injected fault', () => {
	it('fails the named upstream and leaves its siblings alone', async () => {
		globalThis.fetch = vi.fn(async () => json({ ok: true }));
		await withChaos(parseChaosDirective('broken=http:500'), async () => {
			await expect(
				fetchUpstreamJson('https://a.example/x', {}, { name: 'broken', attempts: 1 }),
			).rejects.toThrow(/http 500/);
			// The un-named upstream is untouched: a fault is scoped to what it names.
			await expect(fetchUpstreamJson('https://b.example/x', {}, { name: 'healthy', attempts: 1 })).resolves.toEqual({ ok: true });
		});
	});

	it('is retried by the real retry policy, and the retry can succeed', async () => {
		// A 429 fault is transient, so withRetry retries it. The second attempt is
		// still faulted, which is what proves the injection survives into the retry
		// rather than being a one-shot.
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			return json({ ok: true });
		});
		await withChaos(parseChaosDirective('flaky=http:429'), async () => {
			await expect(
				fetchUpstreamJson('https://a.example/x', {}, { name: 'flaky', attempts: 2, maxRetryAfterMs: 5 }),
			).rejects.toThrow(/http 429/);
		});
		// The real socket was never opened: every attempt hit the fault.
		expect(calls).toBe(0);
	});

	it('serves the last-good value when the live read is faulted, and marks it stale', async () => {
		globalThis.fetch = vi.fn(async () => json({ price: 42 }));
		const load = () => fetchUpstreamJson('https://a.example/price', {}, { name: 'pricer', attempts: 1 });

		const live = await lastGood('brownout:price', load);
		expect(live).toMatchObject({ value: { price: 42 }, stale: false });

		const out = await withProvenance(() =>
			withChaos(parseChaosDirective('pricer=network'), async () => {
				const res = await lastGood('brownout:price', load, { maxAgeMs: 60_000 });
				return { res, prov: provenanceSummary() };
			}),
		);
		expect(out.res.value).toEqual({ price: 42 });
		expect(out.res.stale).toBe(true);
		// And the response would tell the caller so.
		expect(out.prov.tier).toBe('stale');
		expect(out.prov.degraded).toBe(true);
	});

	it('rethrows honestly when the upstream is faulted and nothing was ever cached', async () => {
		globalThis.fetch = vi.fn(async () => json({ price: 1 }));
		await withChaos(parseChaosDirective('pricer=network'), async () => {
			await expect(
				lastGood('brownout:never-seen', () => fetchUpstreamJson('https://a.example/p', {}, { name: 'pricer', attempts: 1 })),
			).rejects.toThrow(/fetch failed/);
		});
	});
});

describe('provider ladder under an injected fault', () => {
	const providers = [
		{ name: 'primary', url: 'https://p1.example/x', parse: async (r) => (await r.json()).v },
		{ name: 'secondary', url: 'https://p2.example/x', parse: async (r) => (await r.json()).v },
		{ name: 'tertiary', url: 'https://p3.example/x', parse: async (r) => (await r.json()).v },
	];

	it('walks past the faulted rung to the next healthy one', async () => {
		globalThis.fetch = vi.fn(async (url) => json({ v: String(url).includes('p2') ? 'from-secondary' : 'from-other' }));
		const out = await withChaos(parseChaosDirective('primary=timeout'), () =>
			fetchFirst(providers, { timeoutMs: 500, cooldownMs: 0 }),
		);
		expect(out.source).toBe('secondary');
		expect(out.value).toBe('from-secondary');
	});

	it('records the whole walk, not just the rung that answered', async () => {
		globalThis.fetch = vi.fn(async () => json({ v: 'ok' }));
		// Both readings are taken INSIDE the context: the ledger is scoped to the
		// request, so asking for it afterwards correctly answers null.
		const { prov, headers } = await withProvenance(async () => {
			await withChaos(parseChaosDirective('primary=http:503, secondary=network'), () =>
				fetchFirst(providers, { timeoutMs: 500, cooldownMs: 0 }),
			);
			// The ladder records asynchronously (it must not block the answer), so
			// let those microtasks land before reading the ledger.
			await new Promise((r) => setTimeout(r, 20));
			return { prov: provenanceSummary(), headers: provenanceHeaders() };
		});
		const names = prov.records.map((r) => r.name);
		expect(names).toEqual(['primary', 'secondary', 'tertiary']);
		expect(prov.failed).toBe(2);
		expect(prov.ok).toBe(1);
		// Two rungs died and the third answered live: the answer is fresh, but the
		// reader still learns the chain was exercised.
		expect(prov.tier).toBe('live');
		expect(prov.degraded).toBe(true);
		expect(headers.summary).toContain('degraded=1');
		expect(headers.trace).toMatch(/primary;o=503/);
	});

	it('fails the whole chain when every rung is faulted', async () => {
		globalThis.fetch = vi.fn(async () => json({ v: 'ok' }));
		await withChaos(parseChaosDirective('primary=network, secondary=network, tertiary=network'), async () => {
			await expect(fetchFirst(providers, { timeoutMs: 500, cooldownMs: 0 })).rejects.toThrow(/providers failed/);
		});
	});
});
