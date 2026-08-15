// Integration tests for how /api/tts/catalog and /api/tts/synthesize behave when
// a voice lane is configured but refusing to serve.
//
// The failure they pin is real: on 2026-08-15 every Gemini synthesis came back
// 403 ("Lightning dunning decision is deny for project ...") while the lane
// reported itself configured, so the Voice Lab listed 30 Gemini voices, sorted
// them first, and the first Preview a visitor clicked dumped that raw JSON into
// the page. These assert the three things that has to produce instead: a
// sentence a human can act on, the lane withheld from the catalog afterwards,
// and the next caller answered without a second doomed round trip.
//
// Only the network is stubbed (upstream Gemini and the Microsoft voice list);
// the handlers, the router, and the breaker are the real modules.

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

import catalogHandler from '../api/tts/catalog.js';
import synthesizeHandler from '../api/tts/synthesize.js';
import { noteLaneHealthy } from '../api/_lib/tts-lane-health.js';

const realFetch = global.fetch;
const savedEnv = { ...process.env };

afterAll(() => {
	global.fetch = realFetch;
	process.env = savedEnv;
});

// The exact body Google returns for a dunning-denied project.
const DUNNING_403 = JSON.stringify(
	{
		error: {
			code: 403,
			message: 'Lightning dunning decision is deny for project: projects/93741856042',
			status: 'PERMISSION_DENIED',
		},
	},
	null,
	2,
);

const EDGE_VOICES = [
	{
		ShortName: 'en-US-AriaNeural',
		Locale: 'en-US',
		Gender: 'Female',
		FriendlyName: 'Microsoft Aria Online (Natural) - English (United States)',
		VoiceTag: { ContentCategories: ['General'], VoicePersonalities: ['Positive'] },
	},
];

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) {
			this._headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._headers[k.toLowerCase()];
		},
		end(b) {
			this._body = b || '';
		},
		get headersSent() {
			return false;
		},
		get writableEnded() {
			return false;
		},
		get json() {
			try {
				return JSON.parse(this._body);
			} catch {
				return null;
			}
		},
	};
}

function getReq(url) {
	return {
		method: 'GET',
		url,
		headers: { accept: 'application/json', origin: 'http://localhost:3000' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}

/** A POST whose body the handler reads off the stream, as a real request does. */
function postReq(url, body) {
	const payload = Buffer.from(JSON.stringify(body));
	return {
		method: 'POST',
		url,
		headers: {
			accept: 'application/json',
			origin: 'http://localhost:3000',
			'content-type': 'application/json',
			'content-length': String(payload.length),
		},
		socket: { remoteAddress: '127.0.0.1' },
		on(event, cb) {
			if (event === 'data') cb(payload);
			if (event === 'end') cb();
			return this;
		},
	};
}

beforeEach(async () => {
	await noteLaneHealthy('gemini');
	process.env.GOOGLE_CLOUD_PROJECT = '';
	process.env.GEMINI_API_KEY = 'test-key';
	delete process.env.OPENAI_API_KEY;
	delete process.env.ELEVENLABS_API_KEY;
	delete process.env.NVIDIA_API_KEY;
	global.fetch = vi.fn(async (url) => {
		const href = String(url);
		if (href.includes('speech.platform.bing.com')) {
			return { ok: true, status: 200, json: async () => EDGE_VOICES };
		}
		if (href.includes('generativelanguage.googleapis.com')) {
			return { ok: false, status: 403, text: async () => DUNNING_403 };
		}
		throw new Error(`unexpected fetch: ${href}`);
	});
});

async function catalog() {
	const res = mockRes();
	await catalogHandler(getReq('/api/tts/catalog?limit=2000'), res);
	return res;
}

async function speak(provider = 'gemini') {
	const res = mockRes();
	await synthesizeHandler(
		postReq('/api/tts/synthesize', { provider, voiceId: 'Kore', text: 'Hello.' }),
		res,
	);
	return res;
}

describe('a lane that is configured but refusing', () => {
	it('is offered until it fails, then withheld with the reason attached', async () => {
		const before = (await catalog()).json;
		expect(before.providers.find((p) => p.id === 'gemini').available).toBe(true);
		expect(before.counts.gemini).toBeGreaterThan(0);

		const failed = await speak();
		expect(failed.statusCode).toBe(502);

		const after = (await catalog()).json;
		const gemini = after.providers.find((p) => p.id === 'gemini');
		expect(gemini.available).toBe(false);
		expect(gemini.reason).toMatch(/Temporarily unavailable/);
		expect(after.counts.gemini ?? 0).toBe(0);
		expect(after.voices.some((v) => v.provider === 'gemini')).toBe(false);
	});

	it('never leaks the raw upstream body into the message a picker renders', async () => {
		const res = await speak();
		const { error_description: message, detail } = res.json;
		expect(message).not.toMatch(/dunning|PERMISSION_DENIED|projects\//);
		expect(message).not.toContain('\n');
		expect(message).toMatch(/Microsoft Edge and NVIDIA Magpie are free/);
		// The diagnostic text survives, it just stops being the headline.
		expect(detail).toMatch(/403/);
	});

	it('answers the next caller from the breaker instead of a second doomed call', async () => {
		await speak();
		const calls = global.fetch.mock.calls.length;

		const second = await speak();
		expect(second.statusCode).toBe(503);
		expect(second.json.error).toBe('lane_unavailable');
		expect(second.json.retry_with).toEqual(['edge', 'nvidia']);
		expect(global.fetch.mock.calls.length).toBe(calls);
	});

	it('leaves every other lane alone', async () => {
		await speak();
		const after = (await catalog()).json;
		expect(after.providers.find((p) => p.id === 'edge').available).toBe(true);
		expect(after.counts.edge).toBeGreaterThan(0);
	});
});
