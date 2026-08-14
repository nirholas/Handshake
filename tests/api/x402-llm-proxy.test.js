/**
 * Tests for POST /api/x402/llm-proxy: the paid one-shot completion rail.
 *
 * Covers the two things a curl probe against a live server cannot reach
 * deterministically: the metered success path (the provider chain is a real
 * network dependency, so llmComplete is fixtured at the module boundary, the
 * same way tests/api/fact-check-v2.test.js fixtures the search+LLM chain) and
 * the price wiring, which must honor the X402_PRICE_LLM_PROXY ops override like
 * every other endpoint in api/x402/.
 *
 * The handler itself is never mocked. The internal-key bypass
 * (api/_lib/x402/access-control.js) is what lets the success path run without a
 * payment; nothing here signs, verifies, or settles anything.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const llmState = vi.hoisted(() => ({
	result: {
		text: '1, 2, 3.',
		model: 'test-model',
		provider: 'test-provider',
		usage: { input: 5, output: 6 },
	},
}));

vi.mock('../../api/_lib/llm.js', () => ({
	llmComplete: vi.fn(async () => llmState.result),
}));

const INTERNAL_KEY = 'llm-proxy-test-internal-key';
const ENV_KEYS = [
	'INTERNAL_API_KEY',
	'X402_PRICE_LLM_PROXY',
	'X402_PAY_TO_BASE',
	'X402_ASSET_ADDRESS_BASE',
	'X402_ADVERTISE_BASE',
	'X402_PAY_TO_SOLANA',
	'INFERENCE_SIGNING_KEY',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let handler;

async function loadHandler() {
	vi.resetModules();
	({ default: handler } = await import('../../api/x402/llm-proxy.js'));
}

beforeEach(async () => {
	Object.assign(process.env, {
		INTERNAL_API_KEY: INTERNAL_KEY,
		X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
		X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		// Base needs an explicit facilitator opt-in or the 402 quote itself throws
		// no_payto_configured (api/_lib/x402-paid-endpoint.js).
		X402_ADVERTISE_BASE: 'true',
	});
	delete process.env.X402_PAY_TO_SOLANA;
	delete process.env.X402_PRICE_LLM_PROXY;
	// Unsigned metering: the job core still ships, which is what the success-path
	// assertions below read. Signing is covered in tests/inference-settlement.js.
	delete process.env.INFERENCE_SIGNING_KEY;
	await loadHandler();
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
	return { 'x-forwarded-for': `198.51.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}` };
}

function jsonReq(body, headers = {}) {
	const buf = Buffer.from(JSON.stringify(body));
	const req = Readable.from([buf]);
	req.method = 'POST';
	req.url = '/api/x402/llm-proxy';
	req.headers = {
		'content-type': 'application/json',
		'content-length': String(buf.length),
		...freshIp(),
		...headers,
	};
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

async function call(req) {
	const res = makeRes();
	await handler(req, res);
	return res;
}

const internalKey = () => ({ 'x-api-key': INTERNAL_KEY });

describe('POST /api/x402/llm-proxy', () => {
	it('returns a completion with a uuid job id and a re-hashable metering core', async () => {
		const res = await call(jsonReq({ model: 'fast', prompt: 'Count to 3.', max_tokens: 16 }, internalKey()));
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.content).toBe('1, 2, 3.');
		expect(body.provider).toBe('test-provider');
		expect(body.input_tokens).toBe(5);
		expect(body.output_tokens).toBe(6);
		expect(body.tokens_used).toBe(11);
		expect(typeof body.latency_ms).toBe('number');
		// jobId comes from node:crypto's randomUUID; a v4 uuid is the contract the
		// receipt verifier and inference_jobs rows both key on.
		expect(body.job_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(body.metering.type).toBe('three-inference-response/v1');
		expect(body.metering.jobId).toBe(body.job_id);
		expect(body.metering.route).toBe('/api/x402/llm-proxy');
		// No signing key configured, so the core ships unsigned.
		expect(body.response_signature).toBeUndefined();
	});

	it('rejects a missing prompt with 400 and never calls the provider', async () => {
		const { llmComplete } = await import('../../api/_lib/llm.js');
		llmComplete.mockClear();
		const res = await call(jsonReq({ model: 'fast' }, internalKey()));
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('missing_prompt');
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('rejects a prompt over the 4000-character cap with 400', async () => {
		const res = await call(jsonReq({ prompt: 'a'.repeat(4001) }, internalKey()));
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('prompt_too_long');
	});

	it('quotes $0.005 by default and honors the X402_PRICE_LLM_PROXY override', async () => {
		const probe = Readable.from([Buffer.from('{}')]);
		probe.method = 'POST';
		probe.url = '/api/x402/llm-proxy';
		probe.headers = { 'content-type': 'application/json', ...freshIp() };
		const res = await call(probe);
		expect(res.statusCode).toBe(402);
		expect(res.json().accepts[0].amount).toBe('5000');

		process.env.X402_PRICE_LLM_PROXY = '7500';
		await loadHandler();
		const repriced = Readable.from([Buffer.from('{}')]);
		repriced.method = 'POST';
		repriced.url = '/api/x402/llm-proxy';
		repriced.headers = { 'content-type': 'application/json', ...freshIp() };
		const res2 = await call(repriced);
		expect(res2.statusCode).toBe(402);
		expect(res2.json().accepts[0].amount).toBe('7500');
	});
});
