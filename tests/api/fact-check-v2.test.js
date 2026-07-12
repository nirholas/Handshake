/**
 * Tests for the fact-check "v2" free-daily-lane work (prompt 20 of
 * prompts/x402-catalog):
 *   • a free daily lane (per-IP quota) that runs the REAL chain and falls
 *     through to the existing x402 402 challenge once exhausted
 *   • the `lane` field on every response ("free" | "paid")
 *
 * The benchmark fixture + runner scoring math (the other half of prompt 20)
 * are covered separately in tests/api/fact-check-benchmark.test.js — kept
 * apart so the two layers don't collide.
 *
 * The upstream chain (LLM query generation, web search, image evidence) is
 * fixtured at the module boundary — none of api/x402/fact-check.js's own logic
 * is mocked, matching the pattern in tests/api/v1-ai-speech.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const llmState = vi.hoisted(() => ({
	queries: ['q1', 'q2', 'q3'],
	analyses: [{ excerpt: 'it says so', stance: 'supports' }],
}));

vi.mock('../../agents/fact-checker/src/llm-verdict.js', () => ({
	generateSearchQueries: vi.fn(async () => ({ queries: llmState.queries, tokens: 120 })),
	analyzeResults: vi.fn(async (_claim, results) => ({
		analyses: results.map((_r, i) => llmState.analyses[i] || llmState.analyses[0]),
		tokens: 200,
	})),
}));

vi.mock('../../agents/fact-checker/src/search-sources.js', () => ({
	searchAll: vi.fn(async () => [
		{ url: 'https://en.wikipedia.org/wiki/Test', title: 'Test — Wikipedia', snippet: 'A well-sourced snippet.' },
		{ url: 'https://example.com/blog', title: 'Some blog', snippet: 'A less authoritative snippet.' },
	]),
}));

vi.mock('../../agents/fact-checker/src/source-authority.js', () => ({
	authorityScore: vi.fn((url) => (url.includes('wikipedia.org') ? 0.9 : 0.4)),
}));

vi.mock('../../agents/fact-checker/src/image-evidence.js', () => ({
	imageEvidence: vi.fn(async () => null),
}));

const ENV_KEYS = ['X402_PAY_TO_BASE', 'X402_ASSET_ADDRESS_BASE', 'X402_ADVERTISE_BASE', 'X402_PAY_TO_SOLANA', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let handler;

beforeEach(async () => {
	vi.resetModules();
	Object.assign(process.env, {
		X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
		X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		// Base also needs a working facilitator opt-in (CDP creds or this explicit
		// flag) or buildRequirements() drops the network and 402-quoting itself
		// throws no_payto_configured — see api/_lib/x402-paid-endpoint.js.
		X402_ADVERTISE_BASE: 'true',
	});
	delete process.env.X402_PAY_TO_SOLANA;
	// No Redis configured → the idempotency cache and the rate limiter both run
	// on their honest in-process fallbacks (deterministic within one test file).
	delete process.env.UPSTASH_REDIS_REST_URL;
	delete process.env.UPSTASH_REDIS_REST_TOKEN;
	({ default: handler } = await import('../../api/x402/fact-check.js'));
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
});

let ipCounter = 0;
function freshIp() {
	ipCounter += 1;
	return { 'x-forwarded-for': `203.0.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}` };
}

function jsonReq(body, headers = {}) {
	const buf = Buffer.from(JSON.stringify(body));
	const req = Readable.from([buf]);
	req.method = 'POST';
	req.url = '/api/x402/fact-check';
	req.headers = { 'content-type': 'application/json', 'content-length': String(buf.length), ...headers };
	return req;
}

function makeRes() {
	const chunks = [];
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		write(c) {
			chunks.push(Buffer.from(c));
		},
		end(c) {
			if (c) chunks.push(Buffer.from(c));
			this.writableEnded = true;
			this.headersSent = true;
		},
		json() {
			return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
		},
	};
}

async function callFactCheck(req) {
	const res = makeRes();
	await handler(req, res);
	return res;
}

describe('POST /api/x402/fact-check — free daily lane', () => {
	it('serves a free check with lane:"free" and a real verdict', async () => {
		const res = await callFactCheck(jsonReq({ claim: 'The sky is blue during the day.' }, freshIp()));
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.lane).toBe('free');
		expect(typeof body.free_remaining_today).toBe('number');
		expect(['supported', 'contradicted', 'mixed', 'insufficient']).toContain(body.verdict);
		expect(body.attestation).toMatch(/^sha256:/);
	});

	it('rejects a too-short claim with 400 before burning a free slot', async () => {
		const ip = freshIp();
		const bad = await callFactCheck(jsonReq({ claim: 'hi' }, ip));
		expect(bad.statusCode).toBe(400);
		expect(bad.json().error).toBe('invalid_claim');
		// The slot wasn't spent — a real check on the same IP still succeeds.
		const ok = await callFactCheck(jsonReq({ claim: 'A valid claim right here.' }, ip));
		expect(ok.statusCode).toBe(200);
		expect(ok.json().lane).toBe('free');
	});

	it('rejects invalid JSON with 400', async () => {
		const req = Readable.from([Buffer.from('{not json')]);
		req.method = 'POST';
		req.url = '/api/x402/fact-check';
		req.headers = { 'content-type': 'application/json', ...freshIp() };
		const res = await callFactCheck(req);
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_json');
	});

	it('falls through to the 402 challenge once the daily free quota is exhausted', async () => {
		const { FREE_DAILY_LIMIT } = await import('../../api/x402/fact-check.js');
		const ip = freshIp();
		for (let i = 0; i < FREE_DAILY_LIMIT; i++) {
			const res = await callFactCheck(jsonReq({ claim: `Claim number ${i} right here.` }, ip));
			expect(res.statusCode).toBe(200);
			expect(res.json().lane).toBe('free');
		}
		const over = await callFactCheck(jsonReq({ claim: 'One claim too many today.' }, ip));
		expect(over.statusCode).toBe(402);
	});

	it('a request carrying an X-PAYMENT header always goes straight to the paid rail (402 without a real proof)', async () => {
		const res = await callFactCheck(
			jsonReq({ claim: 'A claim paid for up front.' }, { ...freshIp(), 'x-payment': 'not-a-real-proof' }),
		);
		// No free lane, straight into x402 verification — an invalid/undecodable
		// proof is rejected by the rail (never silently treated as free).
		expect(res.statusCode).toBeGreaterThanOrEqual(400);
		expect(res.json().lane).not.toBe('free');
	});

	it('GET (or any non-POST) is left entirely to the paid rail', async () => {
		// Credential-less wrong-method requests are discovery probes and receive
		// the 402 challenge (x402-paid-endpoint.js method gate); a request
		// carrying payment/auth credentials still gets the strict 405.
		const probe = Readable.from([]);
		probe.method = 'GET';
		probe.url = '/api/x402/fact-check';
		probe.headers = { ...freshIp() };
		const probeRes = await callFactCheck(probe);
		expect(probeRes.statusCode).toBe(402);
		expect(Array.isArray(probeRes.json().accepts)).toBe(true);

		const paying = Readable.from([]);
		paying.method = 'GET';
		paying.url = '/api/x402/fact-check';
		paying.headers = { 'x-payment': 'abc', ...freshIp() };
		const payingRes = await callFactCheck(paying);
		expect(payingRes.statusCode).toBe(405);
	});
});
