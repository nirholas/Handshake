// api/avatar/video-generate.js + api/avatar/video-status.js - the LongCat worker
// config gate.
//
// Regression: both handlers resolved LONGCAT_WORKER_URL / LONGCAT_WORKER_KEY by
// calling helpers that threw, from INSIDE the `try { await fetch(...) }` block.
// The catch there assumes a network failure, so a deployment that had simply
// never been given the worker credentials answered:
//
//   502 {"error":"worker_unreachable","error_description":"LONGCAT_WORKER_URL not configured"}
//
// Two defects in one response. The status was wrong (nothing was unreachable;
// the endpoint was never configured, which is the 503 the author already wrote
// into the thrown error and which no caller could ever observe), and the body
// named an internal env var, the exact operator detail api/_lib/http.js goes out
// of its way to withhold from clients ("which secrets are unset is operator
// information").
//
// Verified live before the fix against a local server with the vars absent:
//   POST /api/avatar/video-generate {audio_url,image_url on three.ws}
//     -> 502 worker_unreachable "LONGCAT_WORKER_URL not configured"
//
// The gate also moved ahead of the free-trial reservation in video-generate:
// an unconfigured deployment must not insert and then delete a usage_events row
// on every attempt.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...args) => sqlMock(...args),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => ({ id: 'user-1', plan: 'free' }),
}));
vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: (key) => `https://cdn.example.test/${key}`,
}));
vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'https://three.ws', S3_PUBLIC_DOMAIN: 'https://cdn.example.test' },
}));
vi.mock('../../api/_lib/rate-limit.js', () => {
	const ok = async () => ({ success: true, limit: 10, remaining: 9, reset: 0 });
	return {
		limits: { videoGenerateUser: ok, videoGenerateGlobal: ok, upload: ok, publicIp: ok },
		clientIp: () => '127.0.0.1',
	};
});
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));

const { default: generateHandler } = await import('../../api/avatar/video-generate.js');
const { default: statusHandler } = await import('../../api/avatar/video-status.js');

function makeRes() {
	return {
		statusCode: 0,
		body: null,
		headers: {},
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b ?? ''; },
		get headersSent() { return this.body !== null; },
		get writableEnded() { return this.body !== null; },
	};
}

function parseBody(res) {
	return typeof res.body === 'string' && res.body ? JSON.parse(res.body) : null;
}

const savedUrl = process.env.LONGCAT_WORKER_URL;
const savedKey = process.env.LONGCAT_WORKER_KEY;

beforeEach(() => {
	sqlMock.mockReset();
	sqlMock.mockResolvedValue([]);
	delete process.env.LONGCAT_WORKER_URL;
	delete process.env.LONGCAT_WORKER_KEY;
});

afterEach(() => {
	if (savedUrl === undefined) delete process.env.LONGCAT_WORKER_URL;
	else process.env.LONGCAT_WORKER_URL = savedUrl;
	if (savedKey === undefined) delete process.env.LONGCAT_WORKER_KEY;
	else process.env.LONGCAT_WORKER_KEY = savedKey;
});

describe('POST /api/avatar/video-generate with no worker configured', () => {
	function req() {
		return {
			method: 'POST',
			url: '/api/avatar/video-generate',
			headers: { host: 'three.ws' },
			socket: { remoteAddress: '127.0.0.1' },
			body: {
				audio_url: 'https://three.ws/clip.mp3',
				image_url: 'https://three.ws/face.png',
			},
		};
	}

	it('answers 503 worker_unconfigured, not 502 worker_unreachable', async () => {
		const res = makeRes();
		await generateHandler(req(), res);
		expect(res.statusCode).toBe(503);
		expect(parseBody(res).error).toBe('worker_unconfigured');
	});

	it('never names the missing env var in the client-visible body', async () => {
		const res = makeRes();
		await generateHandler(req(), res);
		expect(res.body).not.toMatch(/LONGCAT_WORKER_URL|LONGCAT_WORKER_KEY/);
	});

	it('writes no free-trial reservation when the worker can never be reached', async () => {
		const res = makeRes();
		await generateHandler(req(), res);
		const statements = sqlMock.mock.calls.map(([strings]) =>
			(Array.isArray(strings) ? strings.join(' ') : String(strings)).toLowerCase());
		expect(statements.some((q) => q.includes('insert into usage_events'))).toBe(false);
		expect(statements.some((q) => q.includes('delete from usage_events'))).toBe(false);
	});

	it('still refuses an untrusted audio_url before looking at worker config', async () => {
		const bad = req();
		bad.body.audio_url = 'http://169.254.169.254/latest/meta-data/';
		const res = makeRes();
		await generateHandler(bad, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('invalid_request');
	});
});

describe('GET /api/avatar/video-status with no worker configured', () => {
	it('answers 503 worker_unconfigured without naming the env var', async () => {
		// The ownership row must exist, otherwise the handler correctly stops at 404
		// before it ever needs the worker.
		sqlMock.mockResolvedValue([{ user_id: 'user-1' }]);
		const res = makeRes();
		await statusHandler(
			{ method: 'GET', url: '/api/avatar/video-status?job_id=job-1', headers: { host: 'three.ws' }, socket: {} },
			res,
		);
		expect(res.statusCode).toBe(503);
		expect(parseBody(res).error).toBe('worker_unconfigured');
		expect(res.body).not.toMatch(/LONGCAT_WORKER_URL|LONGCAT_WORKER_KEY/);
	});

	it('a job that does not exist is still 404, not a config error', async () => {
		sqlMock.mockResolvedValue([]);
		const res = makeRes();
		await statusHandler(
			{ method: 'GET', url: '/api/avatar/video-status?job_id=missing', headers: { host: 'three.ws' }, socket: {} },
			res,
		);
		expect(res.statusCode).toBe(404);
		expect(parseBody(res).error).toBe('not_found');
	});

	it("another user's job is 403 before the worker is consulted", async () => {
		sqlMock.mockResolvedValue([{ user_id: 'someone-else' }]);
		const res = makeRes();
		await statusHandler(
			{ method: 'GET', url: '/api/avatar/video-status?job_id=job-2', headers: { host: 'three.ws' }, socket: {} },
			res,
		);
		expect(res.statusCode).toBe(403);
		expect(parseBody(res).error).toBe('forbidden');
	});
});
