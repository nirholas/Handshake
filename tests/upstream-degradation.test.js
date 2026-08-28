// Degradation contracts, proven by breaking the upstream.
//
// Every endpoint below declares what it is ALLOWED to say when the services it
// depends on are entirely unreachable. The test then makes that true: it swaps
// global fetch for one that fails the way a dead host fails, calls the real
// handler, and judges the real response.
//
// This exists because "does it have a fallback" is the wrong review question. In
// one week this repo shipped four fallbacks that were individually reasonable
// and collectively dangerous: a payment retry that re-signed the blockhash the
// facilitator had just refused, a token security verdict assembled from
// remembered on-chain state while the chain was unreadable, an access gate
// answering from a cached verdict, and an alert feed that went silent in a way
// that looked like a calm market. Each passed review. None had a stated answer
// to "when this is down, what may this endpoint claim?".
//
// Adding an endpoint here is one line. See scripts/resilience/contracts.mjs for
// the vocabulary and docs/resilience.md for the generated upstream map.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CONTRACT, judge, failingFetch } from '../scripts/resilience/contracts.mjs';

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: new Proxy({}, { get: () => async () => ({ success: true, remaining: 100 }) }),
	clientIp: () => '203.0.113.9',
}));

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[String(k).toLowerCase()] = v; },
		getHeader(k) { return this._h[String(k).toLowerCase()]; },
		status(code) { this.statusCode = code; return this; },
		json(payload) { this._body = JSON.stringify(payload); return this; },
		end(body) { if (body !== undefined) this._body = body; },
	};
}

/**
 * Load a handler with a genuinely cold module registry, so a value remembered
 * by a previous case cannot answer this one and make it pass for the wrong
 * reason. Every module in this area keeps per-instance state on purpose.
 */
async function loadHandler(path) {
	vi.resetModules();
	const mod = await import(path);
	return mod.default ?? mod.handler;
}

async function invoke(handler, url, { method = 'GET' } = {}) {
	const res = makeRes();
	let threw;
	try {
		await handler({ url, method, headers: { host: 'three.ws' }, query: {}, socket: { remoteAddress: '203.0.113.9' } }, res);
	} catch (err) {
		threw = err;
	}
	let body = null;
	if (res._body) {
		try {
			body = JSON.parse(res._body);
		} catch {
			body = res._body;
		}
	}
	return { status: res.statusCode, body, headers: res._h, threw };
}

// The declared contracts. `warm` marks endpoints whose contract only makes sense
// once something has been remembered; those are exercised twice, first with a
// working upstream so there is a remembered value to serve.
const ENDPOINTS = [
	{
		name: 'GET /api/v1/token/security',
		module: '../api/v1/token/security.js',
		url: '/api/v1/token/security?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		contract: CONTRACT.MUST_NOT_SERVE_STALE,
		why: 'mint and freeze authority and holder concentration are the whole verdict, so a remembered copy served as live is a clean bill of health for a chain nobody can see',
	},
	{
		name: 'GET /api/coin/fear-greed',
		module: '../api/coin/fear-greed.js',
		url: '/api/coin/fear-greed',
		contract: CONTRACT.MAY_SERVE_STALE,
		why: 'a sentiment reading minutes old is a better answer than a blank panel',
	},
	{
		name: 'GET /api/defi/chains',
		module: '../api/defi/chains.js',
		url: '/api/defi/chains',
		contract: CONTRACT.MAY_SERVE_STALE,
		why: 'TVL by chain moves slowly and the page is decorative if it is empty',
	},
	{
		name: 'GET /api/defi/protocols',
		module: '../api/defi/protocols.js',
		url: '/api/defi/protocols',
		contract: CONTRACT.MAY_SERVE_STALE,
		why: 'same board, same reasoning as chains',
	},
	{
		name: 'GET /api/ca2x402/resolve',
		module: '../api/ca2x402/resolve.js',
		url: '/api/ca2x402/resolve?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		contract: CONTRACT.MAY_SERVE_STALE,
		why: 'a throttled indexer used to make a live token read as "not found", which denied a real token downstream',
	},
];

describe('upstream degradation contracts', () => {
	let realFetch;

	beforeEach(() => {
		realFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		vi.unstubAllGlobals();
	});

	for (const ep of ENDPOINTS) {
		for (const mode of ['network', 'status']) {
			it(`${ep.name} honours "${ep.contract}" when every upstream fails (${mode})`, async () => {
				const handler = await loadHandler(ep.module);
				globalThis.fetch = failingFetch(mode);

				const observed = await invoke(handler, ep.url);
				const verdict = judge(ep.contract, observed);

				expect(
					verdict.ok,
					`${ep.name} declares ${ep.contract} because ${ep.why}.\n` +
						`Observed: status=${observed.status} ` +
						`body=${JSON.stringify(observed.body)?.slice(0, 200)} ` +
						`threw=${observed.threw ? observed.threw.message : 'no'}\n` +
						`Verdict: ${verdict.reason}`,
				).toBe(true);
			});
		}
	}

	it('never answers a total outage with an untyped 500', async () => {
		// The one rule every endpoint shares regardless of its contract: a caller
		// must be able to tell "try again shortly" from "your request was wrong".
		// An untyped 500 says neither, and is what an unhandled rejection looks
		// like from the outside.
		for (const ep of ENDPOINTS) {
			const handler = await loadHandler(ep.module);
			globalThis.fetch = failingFetch('network');
			const observed = await invoke(handler, ep.url);
			expect(observed.status, `${ep.name} answered an untyped 500`).not.toBe(500);
			if (observed.threw) {
				const typed = observed.threw.status ?? observed.threw.statusCode ?? observed.threw.code;
				expect(typed, `${ep.name} threw an untyped error out of the handler`).toBeTruthy();
			}
		}
	});
});

describe('contract judgement', () => {
	// The judge decides whether a real endpoint passes, so its own reasoning is
	// worth pinning: a bug here would quietly pass every endpoint above.
	it('rejects an unmarked 200 under may-serve-stale', () => {
		expect(judge(CONTRACT.MAY_SERVE_STALE, { status: 200, body: { total: 1 } }).ok).toBe(false);
	});

	it('accepts a marked 200 under may-serve-stale', () => {
		expect(judge(CONTRACT.MAY_SERVE_STALE, { status: 200, body: { total: 1, stale: true } }).ok).toBe(true);
		expect(
			judge(CONTRACT.MAY_SERVE_STALE, { status: 200, body: { total: 1 }, headers: { 'x-three-stale': '1' } }).ok,
		).toBe(true);
	});

	it('rejects any 2xx under must-refuse and must-not-serve-stale', () => {
		expect(judge(CONTRACT.MUST_REFUSE, { status: 200, body: {} }).ok).toBe(false);
		expect(judge(CONTRACT.MUST_NOT_SERVE_STALE, { status: 200, body: { stale: true } }).ok).toBe(false);
	});

	it('accepts a typed refusal and rejects an untyped one', () => {
		expect(judge(CONTRACT.MUST_REFUSE, { status: 503, body: { error: 'sources_unavailable' } }).ok).toBe(true);
		expect(judge(CONTRACT.MUST_REFUSE, { status: 500, body: {} }).ok).toBe(false);
		expect(judge(CONTRACT.MUST_REFUSE, { status: 404, body: {} }).ok).toBe(false);
	});

	it('treats a thrown typed error as a refusal but an untyped throw as a failure', () => {
		expect(judge(CONTRACT.MUST_REFUSE, { threw: Object.assign(new Error('x'), { status: 503 }) }).ok).toBe(true);
		expect(judge(CONTRACT.MUST_REFUSE, { threw: new Error('boom') }).ok).toBe(false);
	});
});
