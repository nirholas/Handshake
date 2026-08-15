// Boundary coverage for the two standalone persona endpoints:
//   POST /api/persona/extract   interview / freeform text -> structured persona
//   POST /api/persona/preview   persona + message -> one in-voice reply
// Both spend a metered LLM completion per call, so the contract under test is as
// much about what must NOT reach a provider (unauthenticated calls, malformed
// bodies, oversized personas) as about the success path.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
	hasScope: (scope, want) => String(scope || '').split(/[\s,]+/).includes(want),
}));

const personaExtractLimit = vi.fn();
const personaPreviewLimit = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		personaExtract: (...a) => personaExtractLimit(...a),
		personaPreviewUser: (...a) => personaPreviewLimit(...a),
	},
}));

const llmCompleteMock = vi.fn();
class FakeLlmUnavailable extends Error {}
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmCompleteMock(...a),
	LlmUnavailableError: FakeLlmUnavailable,
	promptTokens: (usage) => (usage?.input ?? 0) + (usage?.cacheWrite ?? 0) + (usage?.cacheRead ?? 0),
}));

vi.mock('../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'http://localhost:3000' } }));

const { default: extractHandler } = await import('../api/persona/extract.js');
const { default: previewHandler } = await import('../api/persona/preview.js');

function mkReq({ method = 'POST', url = '/api/persona/extract', headers = {}, body = null } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method, url, headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
			} else if (event === 'end') this._endCb = cb;
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

const OK_USAGE = { input: 300, output: 120 };
const GOOD_PERSONA = {
	tone: 'Direct and unadorned, trims every sentence to the load-bearing part',
	vocabulary: ['ship it', 'no fluff'],
	interests: ['3D tooling', 'avatars'],
	communication_style: 'terse',
	dont_say: ['circle back'],
	sample_greeting: 'What is the status?',
};

async function callExtract(body, { url = '/api/persona/extract' } = {}) {
	const res = mkRes();
	await extractHandler(mkReq({ url, body }), res);
	return res;
}
async function callPreview(body) {
	const res = mkRes();
	await previewHandler(mkReq({ url: '/api/persona/preview', body }), res);
	return res;
}

beforeEach(() => {
	getSessionUserMock.mockReset().mockResolvedValue({ id: 'user-1' });
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	personaExtractLimit.mockReset().mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: 0 });
	personaPreviewLimit.mockReset().mockResolvedValue({ success: true, limit: 30, remaining: 29, reset: 0 });
	llmCompleteMock.mockReset();
});

describe('POST /api/persona/extract', () => {
	it('synthesizes a persona from an interview and reports real token usage', async () => {
		llmCompleteMock.mockResolvedValue({
			text: JSON.stringify(GOOD_PERSONA), model: 'test-model', usage: OK_USAGE,
		});
		const res = await callExtract({
			answers: [{ question: 'What do you build?', answer: 'Avatar tooling. Ship fast, no fluff.' }],
		});
		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.persona).toEqual(GOOD_PERSONA);
		expect(out.model).toBe('test-model');
		expect(out.tokens_in).toBe(300);
		expect(out.tokens_out).toBe(120);
		expect(out.tokens_used).toBe(420);
		expect(typeof out.latency_ms).toBe('number');
	});

	it('accepts freeform text as an alternative to the interview', async () => {
		llmCompleteMock.mockResolvedValue({ text: JSON.stringify(GOOD_PERSONA), model: 'm', usage: OK_USAGE });
		const res = await callExtract({ freeform: 'I write terse release notes and hate corporate filler.' });
		expect(res.statusCode).toBe(200);
		expect(llmCompleteMock.mock.calls[0][0].user).toContain('corporate filler');
	});

	it('clamps oversized model output and falls back on an unknown communication_style', async () => {
		llmCompleteMock.mockResolvedValue({
			text: JSON.stringify({
				tone: 'x'.repeat(500),
				vocabulary: Array.from({ length: 40 }, (_, i) => `word${i}`),
				interests: Array.from({ length: 40 }, (_, i) => `topic${i}`),
				communication_style: 'sardonic',
				dont_say: ['a', 'b', 'c', 'd', 'e'],
				sample_greeting: 'y'.repeat(900),
			}),
			model: 'm', usage: OK_USAGE,
		});
		const { persona } = parse(await callExtract({ freeform: 'anything' }));
		expect(persona.tone).toHaveLength(240);
		expect(persona.vocabulary).toHaveLength(10);
		expect(persona.interests).toHaveLength(5);
		expect(persona.dont_say).toHaveLength(3);
		expect(persona.sample_greeting).toHaveLength(400);
		expect(persona.communication_style).toBe('detailed');
	});

	it('strips a markdown fence the model wrapped the JSON in', async () => {
		llmCompleteMock.mockResolvedValue({
			text: '```json\n' + JSON.stringify(GOOD_PERSONA) + '\n```', model: 'm', usage: OK_USAGE,
		});
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(200);
		expect(parse(res).persona.communication_style).toBe('terse');
	});

	it('rejects an unauthenticated caller before touching the limiter or a provider', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
		expect(personaExtractLimit).not.toHaveBeenCalled();
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('rejects a bearer token that carries neither avatars scope', async () => {
		getSessionUserMock.mockResolvedValue(null);
		extractBearerMock.mockReturnValue('tok');
		authenticateBearerMock.mockResolvedValue({ userId: 'user-9', scope: 'wallet:read' });
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(401);
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('accepts a bearer token scoped for avatars', async () => {
		getSessionUserMock.mockResolvedValue(null);
		extractBearerMock.mockReturnValue('tok');
		authenticateBearerMock.mockResolvedValue({ userId: 'user-9', scope: 'avatars:read' });
		llmCompleteMock.mockResolvedValue({ text: JSON.stringify(GOOD_PERSONA), model: 'm', usage: OK_USAGE });
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(200);
		expect(personaExtractLimit).toHaveBeenCalledWith('user-9');
	});

	it('does not spend a daily quota token on a malformed body', async () => {
		for (const body of [{}, { answers: [] }, { answers: ['nope'] }, { answers: [{ question: 'q' }] }]) {
			const res = await callExtract(body);
			expect(res.statusCode).toBe(400);
		}
		const tooMany = await callExtract({
			answers: Array.from({ length: 13 }, () => ({ question: 'q', answer: 'a' })),
		});
		expect(tooMany.statusCode).toBe(400);
		expect(parse(tooMany).error_description).toBe('max 12 answers');
		expect(personaExtractLimit).not.toHaveBeenCalled();
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('returns 429 with the limiter reason once the daily budget is spent', async () => {
		personaExtractLimit.mockResolvedValue({ success: false, limit: 5, remaining: 0, reset: Date.now() + 60_000 });
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(429);
		expect(parse(res).error).toBe('rate_limited');
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('reports a provider-free deployment as 503 without naming server env vars', async () => {
		llmCompleteMock.mockRejectedValue(new FakeLlmUnavailable());
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('config_missing');
		expect(res.body).not.toMatch(/API_KEY/);
	});

	it('returns 502 when the model answers with prose instead of JSON', async () => {
		llmCompleteMock.mockResolvedValue({ text: 'Sure! Here is a persona.', model: 'm', usage: OK_USAGE });
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('parse_error');
	});

	it('returns 502 rather than a blank persona when every provider answered empty', async () => {
		llmCompleteMock.mockResolvedValue({ text: '', model: 'm', usage: { input: 0, output: 0 } });
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('upstream_error');
	});

	it('returns 502 when the model returns valid JSON with no usable persona in it', async () => {
		llmCompleteMock.mockResolvedValue({ text: '{}', model: 'm', usage: OK_USAGE });
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('parse_error');
	});

	// Attribution is not cosmetic: llmComplete only enforces its per-user daily
	// USD cap when a userId is known, and the spend ledger drops any completion
	// that arrives without one. The 5/day limiter bounds the call COUNT; this is
	// what bounds the bill.
	it('attributes the completion to the caller so the spend is capped and ledgered', async () => {
		llmCompleteMock.mockResolvedValue({ text: JSON.stringify(GOOD_PERSONA), model: 'm', usage: OK_USAGE });
		await callExtract({ freeform: 'anything' });
		expect(llmCompleteMock.mock.calls[0][0].track).toEqual({
			userId: 'user-1',
			tool: 'persona-extract',
		});
	});

	it('reports a spent LLM spend cap as a budget rather than a retryable outage', async () => {
		llmCompleteMock.mockRejectedValue(Object.assign(
			new Error('Daily LLM spend cap of $2.00 reached. Resets in under 24 hours.'),
			{ status: 429, code: 'daily_spend_cap_exceeded' },
		));
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(429);
		expect(parse(res).error).toBe('daily_spend_cap_exceeded');
		expect(parse(res).error_description).toMatch(/Resets in under 24 hours/);
	});

	it('never lets a provider status become the caller status', async () => {
		// An expired server-side key answers 401. Echoing that reads to a browser
		// as an expired session on a request whose sign-in was never in doubt.
		llmCompleteMock.mockRejectedValue(Object.assign(new Error('provider 401'), { status: 401 }));
		const res = await callExtract({ freeform: 'anything' });
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('upstream_error');
	});

	it('answers a preflight without running the handler body', async () => {
		const res = mkRes();
		await extractHandler(mkReq({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } }), res);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-methods']).toBe('POST,OPTIONS');
		expect(getSessionUserMock).not.toHaveBeenCalled();
	});

	it('rejects a non-POST method', async () => {
		const res = mkRes();
		await extractHandler(mkReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/persona/preview', () => {
	it('replies in the persona voice and pins the persona into the system prompt', async () => {
		llmCompleteMock.mockResolvedValue({ text: 'Send the mesh.', model: 'test-model', usage: OK_USAGE });
		const res = await callPreview({ persona: GOOD_PERSONA, user_message: 'Can you rig this avatar?' });
		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.reply).toBe('Send the mesh.');
		expect(out.tokens_used).toBe(420);
		const { system, user } = llmCompleteMock.mock.calls[0][0];
		expect(system).toContain('"communication_style": "terse"');
		expect(system).toContain('circle back');
		expect(user).toBe('Can you rig this avatar?');
	});

	it('truncates an overlong user message to the documented cap', async () => {
		llmCompleteMock.mockResolvedValue({ text: 'ok', model: 'm', usage: OK_USAGE });
		await callPreview({ persona: GOOD_PERSONA, user_message: 'z'.repeat(5000) });
		expect(llmCompleteMock.mock.calls[0][0].user).toHaveLength(1500);
	});

	it('rejects an unauthenticated caller before touching the limiter or a provider', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = await callPreview({ persona: GOOD_PERSONA, user_message: 'hi' });
		expect(res.statusCode).toBe(401);
		expect(personaPreviewLimit).not.toHaveBeenCalled();
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('does not spend a quota token on a malformed body', async () => {
		for (const body of [
			{ user_message: 'hi' },
			{ persona: 'terse', user_message: 'hi' },
			{ persona: [GOOD_PERSONA], user_message: 'hi' },
			{ persona: GOOD_PERSONA },
			{ persona: GOOD_PERSONA, user_message: '   ' },
		]) {
			const res = await callPreview(body);
			expect(res.statusCode).toBe(400);
		}
		expect(personaPreviewLimit).not.toHaveBeenCalled();
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('refuses a persona large enough to inflate the prompt into an expensive call', async () => {
		const res = await callPreview({
			persona: { ...GOOD_PERSONA, notes: 'x'.repeat(9000) },
			user_message: 'hi',
		});
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toContain('persona is too large');
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('returns 429 once the per-user budget is spent', async () => {
		personaPreviewLimit.mockResolvedValue({ success: false, limit: 30, remaining: 0, reset: Date.now() + 60_000 });
		const res = await callPreview({ persona: GOOD_PERSONA, user_message: 'hi' });
		expect(res.statusCode).toBe(429);
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('reports a provider-free deployment as 503 without naming server env vars', async () => {
		llmCompleteMock.mockRejectedValue(new FakeLlmUnavailable());
		const res = await callPreview({ persona: GOOD_PERSONA, user_message: 'hi' });
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('config_missing');
		expect(res.body).not.toMatch(/API_KEY/);
	});

	it('returns 502 rather than an empty bubble when every provider answered empty', async () => {
		llmCompleteMock.mockResolvedValue({ text: '', model: 'm', usage: { input: 0, output: 0 } });
		const res = await callPreview({ persona: GOOD_PERSONA, user_message: 'hi' });
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('upstream_error');
	});

	it('attributes the completion to the caller so the spend is capped and ledgered', async () => {
		llmCompleteMock.mockResolvedValue({ text: 'ok', model: 'm', usage: OK_USAGE });
		await callPreview({ persona: GOOD_PERSONA, user_message: 'hi' });
		expect(llmCompleteMock.mock.calls[0][0].track).toEqual({
			userId: 'user-1',
			tool: 'persona-preview',
		});
	});

	it('reports a spent LLM spend cap as a budget rather than a retryable outage', async () => {
		llmCompleteMock.mockRejectedValue(Object.assign(
			new Error('Daily LLM spend cap of $2.00 reached. Resets in under 24 hours.'),
			{ status: 429, code: 'daily_spend_cap_exceeded' },
		));
		const res = await callPreview({ persona: GOOD_PERSONA, user_message: 'hi' });
		expect(res.statusCode).toBe(429);
		expect(parse(res).error).toBe('daily_spend_cap_exceeded');
	});

	it('never lets a provider status become the caller status', async () => {
		llmCompleteMock.mockRejectedValue(Object.assign(new Error('provider 401'), { status: 401 }));
		const res = await callPreview({ persona: GOOD_PERSONA, user_message: 'hi' });
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('upstream_error');
	});

	it('rejects a non-POST method', async () => {
		const res = mkRes();
		await previewHandler(mkReq({ method: 'GET', url: '/api/persona/preview' }), res);
		expect(res.statusCode).toBe(405);
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});
});
