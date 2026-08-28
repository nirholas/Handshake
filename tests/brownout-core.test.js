// Brownout: data provenance and gated fault injection.
//
// These two are the load-bearing halves of the feature, so their edges are
// tested directly: the freshness lattice (a degraded answer must never be able
// to report itself as live), request isolation under concurrency, and every one
// of the gates that stands between a chaos header and a production request.
import { describe, it, expect, afterEach } from 'vitest';
import {
	TIERS,
	worstTier,
	withProvenance,
	recordSource,
	provenanceSummary,
	provenanceHeaders,
} from '../api/_lib/brownout/provenance.js';
import {
	parseChaosDirective,
	chaosDecision,
	withChaos,
	faultFor,
	applyFault,
	CHAOS_HEADER,
	CHAOS_TOKEN_HEADER,
} from '../api/_lib/brownout/chaos.js';

const TOKEN = 'brownout-test-token';
const reqWith = (headers = {}, url = '/api/pump/dashboard', method = 'GET') => ({
	headers: { [CHAOS_TOKEN_HEADER]: TOKEN, ...headers },
	url,
	method,
});

afterEach(() => {
	delete process.env.BROWNOUT_CHAOS_TOKEN;
});

describe('freshness lattice', () => {
	it('orders tiers from freshest to least fresh', () => {
		expect(TIERS).toEqual(['live', 'cache', 'stale', 'fallback']);
	});

	it('takes the WORSE of two tiers, so a mixed response cannot report as live', () => {
		expect(worstTier('live', 'stale')).toBe('stale');
		expect(worstTier('stale', 'live')).toBe('stale');
		expect(worstTier('cache', 'fallback')).toBe('fallback');
		expect(worstTier('live', 'live')).toBe('live');
	});

	it('never trusts an unknown tier into the result', () => {
		expect(worstTier('nonsense', 'stale')).toBe('stale');
		expect(worstTier('stale', 'nonsense')).toBe('stale');
		expect(worstTier(undefined, undefined)).toBe('live');
	});
});

describe('provenance ledger', () => {
	it('is a no-op outside a request context, so a helper never needs to know', () => {
		expect(() => recordSource({ name: 'x', outcome: 'ok' })).not.toThrow();
		expect(provenanceSummary()).toBeNull();
		expect(provenanceHeaders()).toBeNull();
	});

	it('summarises a clean live answer without a trace', () => {
		withProvenance(() => {
			recordSource({ name: 'birdeye', outcome: 'ok', ms: 42, tier: 'live' });
			const s = provenanceSummary();
			expect(s).toMatchObject({ tier: 'live', ok: 1, failed: 0, degraded: false });
			const h = provenanceHeaders();
			expect(h.summary).toContain('tier=live');
			expect(h.summary).not.toContain('degraded=1');
			// A healthy response should not pay for a per-source breakdown.
			expect(h.trace).toBeNull();
		});
	});

	it('reports the worst contributing tier and emits a trace when degraded', () => {
		withProvenance(() => {
			recordSource({ name: 'birdeye', outcome: 'fail', ms: 412, tier: 'live', detail: 429 });
			recordSource({ name: 'dexscreener', outcome: 'ok', ms: 88, tier: 'stale' });
			const s = provenanceSummary();
			expect(s.tier).toBe('stale');
			expect(s).toMatchObject({ ok: 1, failed: 1, degraded: true });
			const h = provenanceHeaders();
			expect(h.summary).toContain('degraded=1');
			expect(h.trace).toContain('birdeye;o=429;t=412');
			expect(h.trace).toContain('dexscreener;o=ok;t=88');
		});
	});

	it('does NOT call an ordinary cache hit degraded', () => {
		// Almost every response on a healthy site is a cache hit. Counting those as
		// degraded would mark the whole platform degraded and train every reader to
		// ignore the flag, which is worse than not having one.
		withProvenance(() => {
			recordSource({ name: 'coingecko', outcome: 'ok', ms: 0, tier: 'cache' });
			const s = provenanceSummary();
			expect(s.tier).toBe('cache');
			expect(s.degraded).toBe(false);
		});
	});

	it('calls a stale or fallback answer degraded, because it is worse than intended', () => {
		for (const tier of ['stale', 'fallback']) {
			withProvenance(() => {
				recordSource({ name: 'src', outcome: 'ok', ms: 1, tier });
				expect(provenanceSummary().degraded, tier).toBe(true);
			});
		}
	});

	it('counts a failure as degraded even when the answer that came back was live', () => {
		// A ladder that failed over still tells the reader the chain was exercised.
		withProvenance(() => {
			recordSource({ name: 'a', outcome: 'fail', ms: 10, tier: 'live' });
			recordSource({ name: 'b', outcome: 'ok', ms: 10, tier: 'live' });
			const s = provenanceSummary();
			expect(s.tier).toBe('live');
			expect(s.degraded).toBe(true);
		});
	});

	it('keeps two concurrent requests' + " strictly apart", async () => {
		const [a, b] = await Promise.all([
			withProvenance(async () => {
				recordSource({ name: 'req-a', outcome: 'ok', ms: 1, tier: 'live' });
				await new Promise((r) => setTimeout(r, 5));
				recordSource({ name: 'req-a2', outcome: 'ok', ms: 1, tier: 'stale' });
				return provenanceSummary();
			}),
			withProvenance(async () => {
				await new Promise((r) => setTimeout(r, 1));
				recordSource({ name: 'req-b', outcome: 'fail', ms: 1, tier: 'live' });
				return provenanceSummary();
			}),
		]);
		expect(a.records.map((r) => r.name)).toEqual(['req-a', 'req-a2']);
		expect(a.tier).toBe('stale');
		expect(b.records.map((r) => r.name)).toEqual(['req-b']);
		expect(b.failed).toBe(1);
	});

	it('caps what it records but keeps the true count, so a fan-out cannot become a payload', () => {
		withProvenance(() => {
			for (let i = 0; i < 200; i++) recordSource({ name: `p${i}`, outcome: 'ok', ms: 1, tier: 'live' });
			const s = provenanceSummary();
			expect(s.records.length).toBeLessThanOrEqual(24);
			expect(s.sources).toBe(200);
			expect(s.truncated).toBe(200 - s.records.length);
		});
	});

	it('never lets a source name break the header grammar', () => {
		withProvenance(() => {
			recordSource({ name: 'evil\nname;with,separators', outcome: 'fail', ms: 1, tier: 'live' });
			const h = provenanceHeaders();
			expect(h.trace).not.toMatch(/[\n\r]/);
			expect(h.trace.split(',').length).toBe(1);
		});
	});
});

describe('chaos directive parsing', () => {
	it('reads every supported fault kind', () => {
		const f = parseChaosDirective('birdeye=http:429, tokens-xyz=timeout, dex=network, cg=empty, slowly=slow:250');
		expect(f.get('birdeye')).toEqual({ kind: 'http', status: 429 });
		expect(f.get('tokens-xyz')).toEqual({ kind: 'timeout' });
		expect(f.get('dex')).toEqual({ kind: 'network' });
		expect(f.get('cg')).toEqual({ kind: 'empty' });
		expect(f.get('slowly')).toEqual({ kind: 'slow', ms: 250 });
	});

	it('drops a malformed entry instead of guessing at it', () => {
		// A typo must disable that one fault, never inject a different one.
		const f = parseChaosDirective('a=http:99, b=http:notanumber, c=teleport, =timeout, d=slow:999999');
		expect(f.size).toBe(0);
	});

	it('defaults a bare name to a network failure', () => {
		expect(parseChaosDirective('birdeye').get('birdeye')).toEqual({ kind: 'network' });
	});
});

describe('chaos gating', () => {
	it('is off entirely when no token is configured', () => {
		const d = chaosDecision(reqWith({ [CHAOS_HEADER]: 'birdeye=timeout' }));
		expect(d).toMatchObject({ allowed: false, reason: 'not_configured' });
	});

	it('refuses a wrong token', () => {
		process.env.BROWNOUT_CHAOS_TOKEN = TOKEN;
		const d = chaosDecision({ headers: { [CHAOS_HEADER]: 'birdeye=timeout', [CHAOS_TOKEN_HEADER]: 'nope' }, url: '/api/x', method: 'GET' });
		expect(d).toMatchObject({ allowed: false, reason: 'bad_token' });
	});

	it('allows a valid directive on a read path', () => {
		process.env.BROWNOUT_CHAOS_TOKEN = TOKEN;
		const d = chaosDecision(reqWith({ [CHAOS_HEADER]: 'birdeye=http:429' }));
		expect(d.allowed).toBe(true);
		expect(d.faults.get('birdeye')).toEqual({ kind: 'http', status: 429 });
	});

	it('refuses anything carrying a payment header, whatever the route', () => {
		process.env.BROWNOUT_CHAOS_TOKEN = TOKEN;
		for (const h of ['x-payment', 'payment-signature', 'x-payment-response']) {
			const d = chaosDecision(reqWith({ [CHAOS_HEADER]: 'birdeye=timeout', [h]: 'anything' }, '/api/intel/heatmap'));
			expect(d, h).toMatchObject({ allowed: false, reason: 'money_path' });
		}
	});

	it('refuses a money route even with a valid token', () => {
		process.env.BROWNOUT_CHAOS_TOKEN = TOKEN;
		for (const url of ['/api/x402-pay', '/api/pay/execute', '/api/agents/1/withdraw', '/api/purchase/skill', '/api/token/swap']) {
			const d = chaosDecision(reqWith({ [CHAOS_HEADER]: 'birdeye=timeout' }, url));
			expect(d, url).toMatchObject({ allowed: false, reason: 'money_path' });
		}
	});

	it('refuses a write method', () => {
		process.env.BROWNOUT_CHAOS_TOKEN = TOKEN;
		const d = chaosDecision(reqWith({ [CHAOS_HEADER]: 'birdeye=timeout' }, '/api/agents', 'DELETE'));
		expect(d).toMatchObject({ allowed: false, reason: 'write_method' });
	});

	it('says no rather than silently doing nothing when every fault is malformed', () => {
		process.env.BROWNOUT_CHAOS_TOKEN = TOKEN;
		const d = chaosDecision(reqWith({ [CHAOS_HEADER]: 'birdeye=teleport' }));
		expect(d).toMatchObject({ allowed: false, reason: 'no_valid_faults' });
	});
});

describe('fault scoping and shape', () => {
	it('matches a sub-scoped upstream from its parent name', async () => {
		await withChaos(parseChaosDirective('birdeye=timeout'), async () => {
			expect(faultFor('birdeye')).toEqual({ kind: 'timeout' });
			// A directive for the provider covers every call shape it serves.
			expect(faultFor('birdeye:txs')).toEqual({ kind: 'timeout' });
			expect(faultFor('dexscreener')).toBeNull();
		});
	});

	it('is inert outside a chaos context', () => {
		expect(faultFor('birdeye')).toBeNull();
	});

	it('raises a timeout indistinguishable from a real one', async () => {
		await expect(applyFault({ kind: 'timeout' }, 'https://x')).rejects.toMatchObject({ name: 'TimeoutError' });
	});

	it('raises a network failure with the errno undici would attach', async () => {
		// api/_lib/solana/connection.js reads exactly this cause to name the fault.
		await expect(applyFault({ kind: 'network' }, 'https://x')).rejects.toMatchObject({
			message: 'fetch failed',
			cause: { code: 'ECONNREFUSED' },
		});
	});

	it('returns a real Response for an http fault, with Retry-After on a 429', async () => {
		const res = await applyFault({ kind: 'http', status: 429 }, 'https://x');
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('1');
		const res500 = await applyFault({ kind: 'http', status: 500 }, 'https://x');
		expect(res500.headers.get('retry-after')).toBeNull();
	});

	it('lets a slow fault fall through to the real call, just later', async () => {
		const t0 = Date.now();
		const out = await applyFault({ kind: 'slow', ms: 30 }, 'https://x');
		expect(out).toBeNull();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
	});
});
