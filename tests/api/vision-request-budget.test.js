// /api/vision request-budget tests.
//
// The endpoint's contract is that it always produces its OWN diagnosable error
// before the gateway produces an opaque 504 above it. That only holds if the
// budget covers the whole request: it used to bound the model chain alone, so a
// slow 12 MB upload (up to READ_BODY_TIMEOUT_MS) was added to the 24s chain
// budget rather than charged against it, and the real wall clock reached ~39s.
// On 2026-08-07 production logged 504s on agent uploads with no matching
// app-level error, which is what a request dying above the handler looks like.
//
// These cover the budget arithmetic specifically: the chain gets what is left
// after the body read, and a read that consumed the budget is refused outright.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const state = {
	configured: true,
	// Milliseconds the mocked body read burns before resolving, simulating a slow
	// upload without actually sleeping for that long in the test.
	readDelayMs: 0,
	describeCalls: [],
};

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		visionUser: vi.fn(async () => ({ success: true })),
		visionIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/vision.js', () => ({
	visionConfigured: vi.fn(() => state.configured),
	describeImage: vi.fn(async (opts) => {
		state.describeCalls.push(opts);
		return { text: 'a blue robot', provider: 'test-lane', model: 'test-model' };
	}),
	VisionUnavailableError: class VisionUnavailableError extends Error {},
}));

// The body read is where the elapsed time comes from. Advancing the fake clock
// inside readBody reproduces a slow upload deterministically.
vi.mock('../../api/_lib/http.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		readJson: vi.fn(async () => {
			vi.advanceTimersByTime(state.readDelayMs);
			return { image: 'aGVsbG8=', imageType: 'image/png' };
		}),
	};
});

const handler = (await import('../../api/vision.js')).default;

function makeReq() {
	const req = Readable.from([Buffer.from('{}')]);
	req.method = 'POST';
	req.url = '/api/vision';
	req.headers = { host: 'localhost', 'content-type': 'application/json' };
	return req;
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}
async function invoke() {
	const res = makeRes();
	await handler(makeReq(), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	state.configured = true;
	state.readDelayMs = 0;
	state.describeCalls = [];
	vi.useFakeTimers();
});

describe('/api/vision request budget', () => {
	it('gives the model chain the full budget when the upload was instant', async () => {
		const r = await invoke();
		expect(r.status).toBe(200);
		expect(state.describeCalls).toHaveLength(1);
		// The whole 24s budget survives an upload that cost nothing.
		expect(state.describeCalls[0].deadlineMs).toBe(24_000);
	});

	it('charges a slow upload against the chain budget instead of adding to it', async () => {
		state.readDelayMs = 15_000;
		const r = await invoke();
		expect(r.status).toBe(200);
		// 24s total minus the 15s the upload took, NOT a fresh 24s on top of it,
		// which is what let the total wall clock reach ~39s and overrun the gateway.
		expect(state.describeCalls[0].deadlineMs).toBe(9_000);
		// Each attempt is capped by the remaining budget too, never the raw 20s.
		expect(state.describeCalls[0].timeoutMs).toBe(9_000);
	});

	it('refuses with its own 504 when the upload consumed the budget', async () => {
		state.readDelayMs = 23_000;
		const r = await invoke();
		expect(r.status).toBe(504);
		expect(r.body.error).toBe('deadline_exceeded');
		// No point starting a lane that cannot finish: the chain is never called.
		expect(state.describeCalls).toHaveLength(0);
	});
});
