// Tests for POST /api/agents/suggest-spec — the "describe it, we build it"
// generator behind the create-agent wizard.
//
// The load-bearing behaviour under test is the try-first opening: a signed-out
// visitor can generate a spec BEFORE making an account (the wizard only gates
// the final ship step), but anonymous calls are metered on a tighter per-IP
// budget than signed-in ones and carry no user attribution.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
}));

const agentSuggestMock = vi.fn();
const agentSuggestAnonMock = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		agentSuggest: (...a) => agentSuggestMock(...a),
		agentSuggestAnon: (...a) => agentSuggestAnonMock(...a),
	},
	clientIp: () => '203.0.113.7',
}));

const llmCompleteMock = vi.fn();
const llmConfiguredMock = vi.fn();
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmCompleteMock(...a),
	llmConfigured: (...a) => llmConfiguredMock(...a),
	LlmUnavailableError: class LlmUnavailableError extends Error {},
}));

const { default: handler } = await import('../api/agents/suggest-spec.js');

function mkReq({ method = 'POST', url = '/api/agents/suggest-spec', headers = {}, body = null } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method,
		url,
		headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') this._endCb = cb;
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

const OK_LIMIT = { success: true, limit: 10, remaining: 9, reset: Date.now() + 3_600_000 };
const HIT_LIMIT = { success: false, limit: 10, remaining: 0, reset: Date.now() + 3_600_000 };

const GOOD_SPEC = JSON.stringify({
	name: 'Market Oracle',
	description: 'Reads Solana markets and explains what is moving and why.',
	tags: ['markets', 'solana', 'analysis'],
	skills: ['pump-fun'],
	category: 'general',
	greeting: 'I watch the market so you do not have to. What do you want to know?',
	persona: 'You are Market Oracle, a sharp, plain-spoken markets analyst. You cite data and refuse to shill.',
	avatar_starter: 'cz',
	voice: 'browser',
});

beforeEach(() => {
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	agentSuggestMock.mockReset().mockResolvedValue(OK_LIMIT);
	agentSuggestAnonMock.mockReset().mockResolvedValue(OK_LIMIT);
	llmConfiguredMock.mockReset().mockReturnValue(true);
	llmCompleteMock.mockReset().mockResolvedValue({ text: GOOD_SPEC, provider: 'groq' });
});

describe('POST /api/agents/suggest-spec — try-first generation', () => {
	it('lets a signed-out visitor generate (no 401) and meters on the anon per-IP budget', async () => {
		const req = mkReq({ body: { prompt: 'a markets analyst' } });
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.spec.name).toBe('Market Oracle');
		// Anonymous → tight anon limiter, NOT the generous signed-in one.
		expect(agentSuggestAnonMock).toHaveBeenCalledWith('203.0.113.7');
		expect(agentSuggestMock).not.toHaveBeenCalled();
		// No user identity behind the spend for an anonymous call.
		const track = llmCompleteMock.mock.calls[0][0].track;
		expect(track.userId).toBeNull();
		expect(track.tool).toBe('agent_suggest_spec');
	});

	it('meters a signed-in user on the generous budget and attributes the spend', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user-42' });
		const req = mkReq({ body: { prompt: 'a zen coach' } });
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(agentSuggestMock).toHaveBeenCalledWith('203.0.113.7');
		expect(agentSuggestAnonMock).not.toHaveBeenCalled();
		expect(llmCompleteMock.mock.calls[0][0].track.userId).toBe('user-42');
	});

	it('returns 429 when a guest exhausts the anon per-IP budget', async () => {
		agentSuggestAnonMock.mockResolvedValue(HIT_LIMIT);
		const req = mkReq({ body: { prompt: 'spam' } });
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(429);
		expect(parse(res).error).toBe('rate_limited');
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('generates with no brief at all (surprise me)', async () => {
		const req = mkReq({ body: {} });
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		// The model gets a "no brief" instruction rather than an empty user turn.
		expect(llmCompleteMock.mock.calls[0][0].user).toMatch(/no brief/i);
	});

	it('normalizes and clamps a messy model result into a safe spec', async () => {
		llmCompleteMock.mockResolvedValue({
			text: '```json\n' + JSON.stringify({
				name: '   Wild#$%Name!!!   ',
				description: 'x'.repeat(400),
				tags: ['#Alpha', 'ALPHA', 'b'],
				skills: ['pump-fun', 'not-a-real-skill'],
				category: 'not-a-category',
				avatar_starter: 'not-a-body',
				voice: 'weird',
			}) + '\n```',
			provider: 'groq',
		});
		const req = mkReq({ body: { prompt: 'x' } });
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		const spec = parse(res).spec;
		expect(spec.name).not.toMatch(/[#$%!]/); // stripped to letters/numbers/spaces
		expect(spec.description.length).toBeLessThanOrEqual(240);
		expect(spec.tags).toEqual(['alpha', 'b']); // de-duped, lowercased, '#' stripped
		expect(spec.skills).toEqual(['pump-fun']); // unknown skill dropped
		expect(spec.category).toBe('general'); // bad category → safe default
		expect(spec.avatar_starter).toBe('default'); // bad body → safe default
		expect(spec.voice).toBe('browser'); // bad voice → safe default
	});

	it('surfaces a clear 503 when the LLM chain is unconfigured', async () => {
		llmConfiguredMock.mockReturnValue(false);
		const req = mkReq({ body: { prompt: 'x' } });
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('llm_unavailable');
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});
});
