// The Living Stages host brain speaks whatever this endpoint returns
// (api/stage/host.js), so what it does to the model's words IS the product.
//
// Two properties are pinned here because both failed silently in production:
//
//   1. sanitizeLine strips CONTROL characters, not punctuation. The class was
//      once written with literal characters, which collapsed to the printable
//      range [space-hyphen] and ate every hyphen in the spoken line: the host
//      said "on chain" for "on-chain", every show, with nothing in the logs.
//   2. the "returning regulars" recall reads VERIFIED tips only. A tip row is
//      created from a caller-asserted settlement and stays quarantined until the
//      chain confirms it, so counting unverified rows would let anyone put a
//      name of their choosing into the host's system prompt and hear it spoken
//      to the room.
import { test, expect, vi, beforeEach } from 'vitest';

let sqlHandler = () => [];
const seenQueries = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const text = strings.join('?');
		seenQueries.push(text);
		return Promise.resolve(sqlHandler(text, values));
	},
}));

class FakeUnavailable extends Error {}
let llmResult = async () => ({ text: 'ok' });
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...args) => llmResult(...args),
	LlmUnavailableError: FakeUnavailable,
}));

let authorized = true;
vi.mock('../api/_lib/stage-bridge.js', () => ({
	verifyStageRequest: async () => authorized,
}));

const mod = await import('../api/stage/host.js');
const handler = mod.default;
const { sanitizeLine } = mod;

const STAGE_ID = '2e90fbb9-347c-42d5-9162-c8dc7cb7ad04';

function makeReq(body) {
	return {
		method: 'POST',
		url: '/api/stage/host',
		headers: { 'content-type': 'application/json' },
		query: {},
		body,
		// readJson() takes the pre-parsed body when the server already has one.
		on() {},
	};
}

function makeRes() {
	const res = {
		statusCode: 0,
		body: null,
		headers: {},
		headersSent: false,
		setHeader(k, v) {
			this.headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[String(k).toLowerCase()];
		},
		end(payload) {
			this.headersSent = true;
			if (typeof payload === 'string') {
				try {
					this.body = JSON.parse(payload);
				} catch {
					this.body = payload;
				}
			}
			return this;
		},
	};
	return res;
}

function stageRow() {
	return [{ agent_id: 'a1', title: 'Test Set', format: 'open mic', agent_name: 'Nova', persona_prompt: null, description: null }];
}

beforeEach(() => {
	seenQueries.length = 0;
	authorized = true;
	llmResult = async () => ({ text: 'ok' });
	sqlHandler = (text) => (text.includes('FROM stages s') ? stageRow() : []);
});

test('a hyphenated spoken line survives sanitizing intact', () => {
	expect(sanitizeLine('Make your on-chain mark, state-of-the-art style.')).toBe(
		'Make your on-chain mark, state-of-the-art style.',
	);
});

test('control characters are stripped and runs of whitespace collapse', () => {
	const dirty = `one\u0000two\u001fthree\u007ffour   five`;
	expect(sanitizeLine(dirty)).toBe('one two three four five');
});

test('an em dash from the model never reaches the captions', () => {
	expect(sanitizeLine('you are the future\u2014this is on-chain')).toBe('you are the future, this is on-chain');
});

test('surrounding quotes and a leaked speaker label are removed, length is bounded', () => {
	expect(sanitizeLine('"Host: welcome in, friends"')).toBe('welcome in, friends');
	expect(sanitizeLine('x'.repeat(600))).toHaveLength(400);
	expect(sanitizeLine(null)).toBe('');
});

test('a signed request returns the host line plus the beat cue', async () => {
	llmResult = async () => ({ text: '"Host: welcome to the on-chain show"' });
	const res = makeRes();
	await handler(makeReq({ stageId: STAGE_ID, beat: 'opener', context: { audience: 7 } }), res);
	expect(res.statusCode).toBe(200);
	expect(res.body).toEqual({ text: 'welcome to the on-chain show', cue: 'cheer' });
});

test('the regulars recall counts verified tips only', async () => {
	const res = makeRes();
	await handler(makeReq({ stageId: STAGE_ID, beat: 'banter' }), res);
	const tipQuery = seenQueries.find((q) => q.includes('FROM show_tips'));
	expect(tipQuery).toBeTruthy();
	expect(tipQuery).toContain('verified_at IS NOT NULL');
});

test('an unsigned request never reaches the model', async () => {
	authorized = false;
	let called = false;
	llmResult = async () => {
		called = true;
		return { text: 'should not happen' };
	};
	const res = makeRes();
	await handler(makeReq({ stageId: STAGE_ID, beat: 'banter' }), res);
	expect(res.statusCode).toBe(401);
	expect(res.body).toEqual({ error: 'unauthorized' });
	expect(called).toBe(false);
});

test('a stage that does not exist is a 404, not a model call', async () => {
	sqlHandler = () => [];
	const res = makeRes();
	await handler(makeReq({ stageId: STAGE_ID, beat: 'banter' }), res);
	expect(res.statusCode).toBe(404);
});

test('an exhausted LLM chain surfaces as 503 so the room uses its failsafe line', async () => {
	llmResult = async () => {
		throw new FakeUnavailable('no providers');
	};
	const res = makeRes();
	await handler(makeReq({ stageId: STAGE_ID, beat: 'banter' }), res);
	expect(res.statusCode).toBe(503);
	expect(res.body).toEqual({ error: 'host_brain_unavailable' });
});
