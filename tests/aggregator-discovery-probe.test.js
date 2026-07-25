// A parameterless sweep of the aggregator must look like a healthy paid
// endpoint, not a broken one.
//
// x402 directory crawlers and uptime/trust monitors (x402scan, the Bazaar
// validator, x402-observer's trust monitor) call every registered endpoint with
// no arguments to check it is alive and priced. Our paid-only endpoints answered
// that sweep correctly with a 402 challenge, but the free-tier ones ran param
// validation first and answered 400: so roughly 14k parameterless probes over
// 30 days scored a working catalog as failing, and drowned the real error rate
// in usage_events at the same time.
//
// The rule under test: no arguments at all + no credentials → hand the probe to
// the paid rail (402 + payment requirements), with the specific param hint on a
// header. Any argument at all means a real caller who deserves the real 400.

import { describe, it, expect } from 'vitest';
import { isParameterlessProbe } from '../api/v1/x/[...slug].js';

const req = (url, query) => ({ method: 'GET', url, query, headers: {} });

describe('aggregator discovery probes', () => {
	it('treats a bare endpoint call as a probe', () => {
		expect(isParameterlessProbe(req('/api/v1/x/solana/balance'))).toBe(true);
		expect(isParameterlessProbe(req('/api/v1/x/solana/balance?'))).toBe(true);
	});

	it('ignores the route slug when deciding', () => {
		// The catch-all route injects its own path segments as `slug`; those are
		// not caller arguments and must not disqualify a probe.
		expect(isParameterlessProbe(req('/api/v1/x/solana/balance', { slug: ['solana', 'balance'] }))).toBe(true);
	});

	it('does not treat a real call with arguments as a probe', () => {
		expect(isParameterlessProbe(req('/api/v1/x/coingecko/price?ids=solana'))).toBe(false);
		expect(
			isParameterlessProbe(req('/api/v1/x/coingecko/price', { slug: ['coingecko', 'price'], ids: 'solana' })),
		).toBe(false);
	});

	it('treats an empty-valued argument as a real call, not a probe', () => {
		// `?ids=` is a caller who built the URL wrong: they get the specific 400
		// telling them the param is empty, not a payment challenge.
		expect(isParameterlessProbe(req('/api/v1/x/coingecko/price?ids='))).toBe(false);
	});
});
