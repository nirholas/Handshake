// GET/POST /api/motion: the public contract around the motion compiler.
//
// The compiler itself is covered by packages/motion's own suite. What matters
// here is the endpoint's promises: a prompt it knows is answered without
// touching a model, a prompt it does not know reaches one, a model that writes
// nonsense is repaired or falls back rather than returning a broken clip, and a
// score posted directly is compiled without a model at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const llmComplete = vi.fn();
const llmConfigured = vi.fn(() => true);

vi.mock('../../api/_lib/llm.js', () => ({
	llmComplete: (...args) => llmComplete(...args),
	llmConfigured: (...args) => llmConfigured(...args),
	LlmUnavailableError: class LlmUnavailableError extends Error {},
}));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => null,
}));

vi.mock('../../api/_lib/rate-limit.js', () => {
	const ok = async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 });
	return { clientIp: () => '203.0.113.7', limits: { publicIp: ok, motionAuthor: ok, motionCompile: ok } };
});

function makeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: null,
		ended: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		removeHeader(k) { delete this.headers[k.toLowerCase()]; },
		writeHead(status, headers) {
			this.statusCode = status;
			Object.assign(this.headers, headers || {});
			return this;
		},
		end(body) {
			if (body !== undefined) this.body = body;
			this.ended = true;
			return this;
		},
		on() {},
	};
}

async function call(url, { method = 'GET', body = null } = {}) {
	const { default: handler } = await import('../../api/motion.js');
	const req = {
		method,
		url,
		headers: { host: 'three.ws', 'content-type': 'application/json' },
		body: body ?? undefined,
		on(event, cb) {
			if (event === 'data' && body) cb(Buffer.from(JSON.stringify(body)));
			if (event === 'end') cb();
			return this;
		},
	};
	const res = makeRes();
	await handler(req, res);
	return res;
}

const json = (res) => JSON.parse(typeof res.body === 'string' ? res.body : res.body.toString('utf8'));

beforeEach(() => {
	llmComplete.mockReset();
	llmConfigured.mockReset();
	llmConfigured.mockReturnValue(true);
});

describe('capabilities', () => {
	it('publishes the schema, the limits, and the actions it can compose alone', async () => {
		const res = await call('/api/motion?capabilities=1');
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.schema.properties.beats).toBeTruthy();
		expect(body.actions).toContain('wave');
		expect(body.limits.maxBeats).toBeGreaterThan(0);
		expect(llmComplete).not.toHaveBeenCalled();
	});
});

describe('compiling from a prompt', () => {
	it('answers a movement it knows without calling a model', async () => {
		const res = await call('/api/motion?prompt=wave%20hello%20twice');
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.source.lane).toBe('composer');
		expect(body.source.matched).toBe('wave');
		expect(body.clip.duration).toBeGreaterThan(0.5);
		expect(body.clip.tracks.length).toBeGreaterThan(10);
		expect(body.warnings).toEqual([]);
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('returns the score alongside the clip, so an editor can change one beat', async () => {
		const body = json(await call('/api/motion?prompt=nod'));
		expect(Array.isArray(body.score.beats)).toBe(true);
		expect(body.score.beats[0]).toHaveProperty('at');
		expect(body.summary).toMatch(/beats/);
	});

	it('is deterministic, so the edge is allowed to cache it', async () => {
		const first = json(await call('/api/motion?prompt=shrug'));
		const second = json(await call('/api/motion?prompt=shrug'));
		expect(first.clip).toEqual(second.clip);
		const res = await call('/api/motion?prompt=shrug');
		expect(res.getHeader('cache-control')).toMatch(/max-age/);
	});

	it('reaches a model for a movement the built-in lane does not know', async () => {
		llmComplete.mockResolvedValue({
			text: JSON.stringify({
				name: 'considering',
				beats: [
					{ label: 'still', posture: 'easy', hold: 0.3 },
					{ label: 'look away', posture: 'lean_back', gaze: 'aside', face: 'doubt', in: 0.5, hold: 0.6 },
					{ label: 'return', posture: 'easy', gaze: 'forward', in: 0.5, hold: 0.3 },
				],
			}),
			provider: 'test-provider',
			model: 'test-model',
		});
		const res = await call('/api/motion?prompt=she%20weighs%20it%20up%20and%20lets%20it%20go');
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.source.lane).toBe('model');
		expect(body.source.provider).toBe('test-provider');
		expect(body.clip.tracks.length).toBeGreaterThan(10);
		expect(llmComplete).toHaveBeenCalledTimes(1);
	});

	it('repairs a model answer that does not validate, carrying the failing path', async () => {
		llmComplete
			.mockResolvedValueOnce({ text: JSON.stringify({ beats: [{ posture: 'levitating' }, { posture: 'easy' }] }), provider: 'p', model: 'm' })
			.mockResolvedValueOnce({ text: JSON.stringify({ beats: [{ posture: 'tiptoe', hold: 0.3 }, { posture: 'easy', in: 0.4 }] }), provider: 'p', model: 'm' });
		const body = json(await call('/api/motion?prompt=float%20above%20the%20ground'));
		expect(body.source.lane).toBe('model');
		expect(body.source.note).toMatch(/repaired/i);
		expect(llmComplete).toHaveBeenCalledTimes(2);
		const repairPrompt = llmComplete.mock.calls[1][0].user;
		expect(repairPrompt).toMatch(/posture/);
		expect(repairPrompt).toMatch(/levitating/);
	});

	it('falls back to the nearest known movement when the model lane fails', async () => {
		llmComplete.mockRejectedValue(new Error('upstream on fire'));
		const body = json(await call('/api/motion?prompt=wave%20like%20a%20lighthouse%20keeper&lane=model'));
		expect(body.source.lane).toBe('composer');
		expect(body.source.note).toMatch(/upstream on fire/);
		expect(body.clip.duration).toBeGreaterThan(0);
	});

	it('says what it does know when there is no model and no match', async () => {
		llmConfigured.mockReturnValue(false);
		const res = await call('/api/motion?prompt=perform%20a%20quarterly%20earnings%20interpretive%20dance');
		expect(res.statusCode).toBe(503);
		const body = json(res);
		expect(body.error).toBe('model_unavailable');
		expect(body.actions).toContain('wave');
	});

	it('never calls a model on the fast lane, and says so honestly', async () => {
		const res = await call('/api/motion?prompt=an%20unknown%20interpretive%20movement&lane=fast');
		expect(res.statusCode).toBe(422);
		expect(json(res).error).toBe('unrecognized_motion');
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('rejects an empty prompt rather than compiling nothing', async () => {
		const res = await call('/api/motion?prompt=%20%20');
		expect(res.statusCode).toBe(400);
		expect(json(res).error).toBe('missing_prompt');
	});

	it('honours the loop and in-place switches', async () => {
		const open = json(await call('/api/motion?prompt=idle'));
		const looped = json(await call('/api/motion?prompt=idle&loop=1'));
		expect(looped.clip.duration).toBeGreaterThan(open.clip.duration);

		const travelling = json(await call('/api/motion?prompt=walk%20forward'));
		const inPlace = json(await call('/api/motion?prompt=walk%20forward&rootmotion=0'));
		expect(travelling.clip.tracks.some((t) => t.name === 'Hips.position')).toBe(true);
		expect(inPlace.clip.tracks.some((t) => t.name === 'Hips.position')).toBe(false);
	});
});

describe('compiling a score directly', () => {
	it('compiles a posted score with no model involved', async () => {
		const res = await call('/api/motion', {
			method: 'POST',
			body: {
				name: 'hand raised',
				score: {
					beats: [
						{ label: 'down', posture: 'easy', hold: 0.2 },
						{ label: 'up', arms: { right: { at: 'overhead', hand: 'open' } }, in: 0.4, hold: 0.4 },
					],
				},
			},
		});
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.source.lane).toBe('direct');
		expect(body.clip.name).toBe('hand raised');
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('rejects an invalid score with the path that was wrong', async () => {
		const res = await call('/api/motion', {
			method: 'POST',
			body: { score: { beats: [{ arms: { right: { at: 'elbow' } } }] } },
		});
		expect(res.statusCode).toBe(400);
		const body = json(res);
		expect(body.error).toBe('invalid_score');
		expect(body.path).toBe('score.beats[0].arms.right.at');
	});

	it('rejects a body with no score at all', async () => {
		const res = await call('/api/motion', { method: 'POST', body: { name: 'nothing' } });
		expect(res.statusCode).toBe(400);
		expect(json(res).error).toBe('invalid_score');
	});
});
