// Tests for POST /api/forge-enhance, the art-director rewrite that turns a
// terse idea into the prompt the reference-image + reconstruction pipeline can
// actually render.
//
// The load-bearing detail here is the cleanup pass. The system prompt forbids
// quotation marks, but every LLM in the chain wraps its answer in them anyway,
// and whatever survives cleanup is fed verbatim to the diffusion model that
// paints the reference image, where a stray quote is just more text to draw.
// A regression had left only the CURLY-quote branch working, so the far more
// common straight-quoted reply ("a knight in armor") kept its quotes all the way
// into the image prompt. These pin both quote styles, plus the label strip and
// the fall-back-to-the-user's-own-words behavior.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const llmComplete = vi.fn(async () => ({ text: 'a plain reply', provider: 'test', model: 'test-model' }));

vi.mock('../../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmComplete(...a),
	LlmUnavailableError: class LlmUnavailableError extends Error {},
}));

// The Vertex director lane is optional and fail-soft; keep it out of the way so
// these assert the cleanup pass rather than a GCP token exchange.
vi.mock('../../api/_lib/gcp-auth.js', () => ({ getGcpAccessToken: vi.fn(async () => 'token') }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { forgeEnhance: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '203.0.113.7'),
}));

const handler = (await import('../../api/forge-enhance.js')).default;

function mkReq(body) {
	const payload = JSON.stringify(body);
	const stream = Readable.from([Buffer.from(payload, 'utf8')]);
	stream.method = 'POST';
	stream.url = '/api/forge-enhance';
	stream.headers = { 'content-type': 'application/json' };
	return stream;
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[String(k).toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.writableEnded = true;
		},
	};
}

const parsed = (res) => JSON.parse(res.body || '{}');

async function enhance(replyText, prompt = 'a knight') {
	llmComplete.mockResolvedValueOnce({ text: replyText, provider: 'test', model: 'test-model' });
	const res = mkRes();
	await handler(mkReq({ prompt }), res);
	return parsed(res);
}

beforeEach(() => {
	vi.clearAllMocks();
	// GOOGLE_CLOUD_PROJECT would divert the rewrite to the Vertex lane; the free
	// chain is the one under test here.
	delete process.env.GOOGLE_CLOUD_PROJECT;
});

describe('POST /api/forge-enhance, prompt cleanup', () => {
	it('strips straight double quotes the model wrapped around its answer', async () => {
		const body = await enhance('"a knight in weathered steel plate armor"');
		expect(body.prompt).toBe('a knight in weathered steel plate armor');
	});

	it('strips curly quotes too', async () => {
		const body = await enhance('“a knight in weathered steel plate armor”');
		expect(body.prompt).toBe('a knight in weathered steel plate armor');
	});

	it('keeps a quote that is part of the prompt rather than wrapping it', async () => {
		const body = await enhance('a sign reading "open" in painted enamel');
		expect(body.prompt).toBe('a sign reading "open" in painted enamel');
	});

	it('strips a Prompt: label, collapses whitespace, and drops the trailing period', async () => {
		const body = await enhance('Enhanced prompt: a matte\n  ceramic teapot.');
		expect(body.prompt).toBe('a matte ceramic teapot');
	});

	it("falls back to the user's own words when the rewrite comes back degenerate", async () => {
		const body = await enhance('.', 'a small brass compass');
		expect(body.prompt).toBe('a small brass compass');
	});

	it('returns the subject class and its negative prompt alongside the rewrite', async () => {
		const body = await enhance('"a golden retriever"', 'a golden retriever');
		expect(body.subject).toBe('animal');
		expect(body.negative_prompt).toContain('extra legs');
		// Realistic by default, so the photoreal failure modes are layered on too.
		expect(body.negative_prompt).toContain('plastic doll skin');
	});

	it('rejects a prompt too short to rewrite before calling any provider', async () => {
		const res = mkRes();
		await handler(mkReq({ prompt: 'ab' }), res);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('prompt_too_short');
		expect(llmComplete).not.toHaveBeenCalled();
	});
});
