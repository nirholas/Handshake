/**
 * A dead endpoint is not a free endpoint.
 *
 * Both x402 probes (the dry-run simulator's `probePrice` and the executor's
 * `probe402`) used to treat every non-402 response as "served without a
 * challenge, so it costs nothing". That is only true of a SUCCESS. A 404, a 400,
 * or a 500 is an endpoint that failed, and calling it free produced the exact
 * wrong answer in the two places it matters most:
 *
 *   - the simulator reported `feasible: true` at a cost of $0 for a workload
 *     whose every call was erroring, because a free call never enters the policy
 *     replay and so can never be refused. That is the one question /api/pay/simulate
 *     exists to answer, answered backwards.
 *   - the executor answered `200 {ok: true, paid: false, note: "Endpoint served
 *     response without a 402. No payment needed."}` for an upstream 500, so an
 *     agent read a failure as a successful free call.
 *
 * The network is stubbed at the fetch boundary; the SSRF guard chain is pinned by
 * its own suite (tests/x402-rate-limit-probe-target.test.js and friends), and the
 * address resolution below is inert because no socket is ever opened.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/ssrf.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		resolvePublicHost: async () => ['203.0.113.10'],
		pinnedAgent: () => ({ close: async () => {} }),
	};
});

const { probePrice, USDC_SOLANA_MINT } = await import('../api/_lib/pay/probe.js');
const { probe402 } = await import('../api/pay/execute.js');

const URL_UNDER_TEST = 'https://api.example.com/data';

function reply(status, body, headers = {}) {
	globalThis.fetch = vi.fn(async () => new Response(body, { status, headers }));
}

function challengeBody(accepts) {
	return JSON.stringify({ x402Version: 2, resource: URL_UNDER_TEST, accepts });
}

const SOLANA_ACCEPT = {
	scheme: 'exact',
	network: 'solana',
	amount: '1000',
	asset: USDC_SOLANA_MINT,
	payTo: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
	extra: { feePayer: 'FEEPAYer1111111111111111111111111111111111' },
};

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('probePrice: only a success is free', () => {
	it('reports a 2xx with no challenge as free', async () => {
		reply(200, JSON.stringify({ ok: true }));
		const probe = await probePrice(URL_UNDER_TEST);
		expect(probe).toMatchObject({ kind: 'free', status: 200 });
	});

	it('reports a 404 as an endpoint error, never as free', async () => {
		reply(404, 'no such route');
		const probe = await probePrice(URL_UNDER_TEST);
		expect(probe.kind).toBe('error');
		expect(probe.code).toBe('endpoint_error');
		expect(probe.status).toBe(404);
	});

	it('reports a 500 as an endpoint error, never as free', async () => {
		reply(500, 'boom');
		const probe = await probePrice(URL_UNDER_TEST);
		expect(probe.kind).toBe('error');
		expect(probe.code).toBe('endpoint_error');
		expect(probe.message).toMatch(/HTTP 500/);
	});

	it('still parses a real 402 challenge into rails', async () => {
		reply(402, challengeBody([SOLANA_ACCEPT]));
		const probe = await probePrice(URL_UNDER_TEST);
		expect(probe.kind).toBe('priced');
		expect(probe.rails[0]).toMatchObject({ network: 'solana', amount_atomics: '1000' });
	});
});

describe('probe402: an upstream failure is not a free call', () => {
	it('passes a 2xx straight back as free', async () => {
		reply(200, JSON.stringify({ answer: 42 }));
		const result = await probe402(URL_UNDER_TEST, { method: 'GET', body: null });
		expect(result).toMatchObject({ free: true, status: 200 });
		expect(result.result).toEqual({ answer: 42 });
	});

	it('raises a 502 endpoint_error for an upstream 500, carrying the real status', async () => {
		reply(500, JSON.stringify({ error: 'upstream exploded' }));
		const err = await probe402(URL_UNDER_TEST, { method: 'GET', body: null }).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.status).toBe(502);
		expect(err.code).toBe('endpoint_error');
		expect(err.detail).toEqual({
			upstream_status: 500,
			upstream_body: { error: 'upstream exploded' },
		});
	});

	it('raises the same error for a 4xx, so a bad request is never billed as free', async () => {
		reply(400, 'claim is required');
		const err = await probe402(URL_UNDER_TEST, { method: 'POST', body: {} }).catch((e) => e);
		expect(err.code).toBe('endpoint_error');
		expect(err.detail.upstream_status).toBe(400);
		expect(err.detail.upstream_body).toBe('claim is required');
	});

	it('selects the Solana USDC accept from a real challenge', async () => {
		reply(402, challengeBody([{ ...SOLANA_ACCEPT, network: 'base', asset: '0xdead' }, SOLANA_ACCEPT]));
		const result = await probe402(URL_UNDER_TEST, { method: 'GET', body: null });
		expect(result.accept.asset).toBe(USDC_SOLANA_MINT);
		expect(result.amountAtomics).toBe(1000n);
	});

	it('refuses a challenge that quotes an unreadable price rather than throwing raw', async () => {
		reply(402, challengeBody([{ ...SOLANA_ACCEPT, amount: 'free!' }]));
		const err = await probe402(URL_UNDER_TEST, { method: 'GET', body: null }).catch((e) => e);
		expect(err.status).toBe(422);
		expect(err.code).toBe('invalid_amount');
	});

	it('refuses a non-positive price, which cannot be paid', async () => {
		reply(402, challengeBody([{ ...SOLANA_ACCEPT, amount: '0' }]));
		const err = await probe402(URL_UNDER_TEST, { method: 'GET', body: null }).catch((e) => e);
		expect(err.status).toBe(422);
		expect(err.code).toBe('invalid_amount');
	});
});
