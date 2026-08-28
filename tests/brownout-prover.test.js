// The prover's judgement, tested directly. Its whole value rests on refusing to
// call a fallback proven when the fault never reached the code, so that refusal
// is the first thing covered here.
import { describe, it, expect } from 'vitest';
import { parseProvenance, wasExercised, judge, contractUrl, chaosDirective } from '../scripts/prove-brownout.mjs';

const headers = (summary, trace) =>
	new Headers({ ...(summary ? { 'x-brownout': summary } : {}), ...(trace ? { 'x-brownout-trace': trace } : {}) });

describe('parseProvenance', () => {
	it('reads the summary and the per-source trace', () => {
		const p = parseProvenance(
			headers('v=1;tier=stale;sources=3;ok=1;failed=2;ms=512;degraded=1', 'birdeye;o=429;t=412, dex;o=ok;t=88'),
		);
		expect(p).toMatchObject({ tier: 'stale', degraded: true, ok: 1, failed: 2, ms: 512 });
		expect(p.sources).toEqual([
			{ name: 'birdeye', outcome: '429', ms: 412 },
			{ name: 'dex', outcome: 'ok', ms: 88 },
		]);
	});

	it('treats a missing header as "recorded nothing", not as an error', () => {
		const p = parseProvenance(headers(null, null));
		expect(p.tier).toBeNull();
		expect(p.sources).toEqual([]);
		expect(p.degraded).toBe(false);
	});
});

describe('wasExercised', () => {
	const prov = parseProvenance(headers('v=1;tier=live', 'birdeye:txs;o=429;t=1, dex;o=ok;t=2'));

	it('counts a source that failed', () => {
		expect(wasExercised(prov, 'birdeye:txs')).toBe(true);
	});

	it('matches a sub-scoped source from the provider name the contract broke', () => {
		// A contract says "break birdeye"; the code calls it as birdeye:txs.
		expect(wasExercised(prov, 'birdeye')).toBe(true);
	});

	it('does not count a source that succeeded, or one that never appeared', () => {
		expect(wasExercised(prov, 'dex')).toBe(false);
		expect(wasExercised(prov, 'coingecko')).toBe(false);
	});
});

describe('judge', () => {
	const contract = {
		expect: { status: 200, tier: ['stale', 'fallback'], degraded: true, exercised: ['birdeye'], jsonHas: ['tokens'] },
	};
	const good = {
		status: 200,
		prov: parseProvenance(headers('v=1;tier=stale;ok=1;failed=1;degraded=1', 'birdeye;o=429;t=1, cache;o=ok;t=1')),
		body: { tokens: [] },
		chaosStatus: 'applied;faults=1',
	};

	it('passes a contract whose fault landed and whose expectations held', () => {
		expect(judge(contract, good)).toMatchObject({ verdict: 'pass', problems: [] });
	});

	it('refuses to pass a fallback whose fault never reached the code', () => {
		// The single most important behaviour here: a warm cache answered, no
		// upstream was called, and calling that a pass would certify a fallback
		// that never ran.
		const unexercised = { ...good, prov: parseProvenance(headers('v=1;tier=cache;ok=1;failed=0', null)) };
		const out = judge(contract, unexercised);
		expect(out.verdict).toBe('not_exercised');
		expect(out.problems[0]).toMatch(/never appears as a failed source/);
	});

	it('refuses when the server declined the directive, rather than reading the result', () => {
		const refused = { ...good, chaosStatus: 'refused;reason=bad_token' };
		expect(judge(contract, refused)).toMatchObject({ verdict: 'not_exercised' });
	});

	it('reports each broken expectation separately', () => {
		const bad = {
			status: 502,
			prov: parseProvenance(headers('v=1;tier=live;ok=0;failed=1', 'birdeye;o=429;t=1')),
			body: {},
			chaosStatus: 'applied;faults=1',
		};
		const out = judge(contract, bad);
		expect(out.verdict).toBe('fail');
		expect(out.problems.join(' ')).toMatch(/status 502/);
		expect(out.problems.join(' ')).toMatch(/tier live/);
		expect(out.problems.join(' ')).toMatch(/missing `tokens`/);
	});

	it('accepts any of several allowed statuses', () => {
		const c = { expect: { status: [200, 503], exercised: [] } };
		for (const status of [200, 503]) {
			expect(judge(c, { ...good, status }).verdict).toBe('pass');
		}
		expect(judge(c, { ...good, status: 500 }).verdict).toBe('fail');
	});
});

describe('contractUrl', () => {
	const contract = {
		endpoint: '/api/intel/heatmap',
		query: { limit: 6 },
		bust: { param: 'limit', warm: 6, attempt: 40 },
	};

	it('sends warm and attempt to different cache keys, in the direction the contract states', () => {
		// Caches are not symmetric: the heatmap answers any smaller limit out of a
		// larger cached field, so only warm-small then attempt-large actually misses.
		expect(contractUrl('http://x', contract, 'warm')).toContain('limit=6');
		expect(contractUrl('http://x', contract, 'attempt')).toContain('limit=40');
	});

	it('applies the plain query when a contract declares no bust', () => {
		const url = contractUrl('http://x', { endpoint: '/api/coin/detail', query: { id: 'solana' } });
		expect(url).toBe('http://x/api/coin/detail?id=solana');
	});
});

describe('chaosDirective', () => {
	it('renders the header a contract asks for', () => {
		expect(chaosDirective({ break: { birdeye: 'http:429', dex: 'timeout' } })).toBe('birdeye=http:429, dex=timeout');
	});
});
