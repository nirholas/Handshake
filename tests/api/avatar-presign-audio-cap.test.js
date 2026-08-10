// api/avatar/presign-audio.js - upload-grant limits.
//
// Gap found auditing the api/avatar surface: presign-audio was the only presign
// handler in the batch with neither a rate limit nor a size cap. Its sibling
// api/avatar/presign-glb.js documents exactly why both are needed: a presigned
// PUT cannot carry a content-length policy (R2 rejects the CORS preflight when
// content-length is a signed header, see api/_lib/r2.js), so the caller-declared
// size is the only binding pre-check, and without a bucket one session can mint
// unlimited write grants and use the bucket as free hosting.
//
// Verified live before the fix against a local server with a real session:
//   POST /api/avatar/presign-audio {"filename":"clip.mp3"}  -> 200 + signed PUT URL
// repeatable without limit and with no declared size at all.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const uploadLimit = vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 }));
const presignMock = vi.fn(async ({ key }) => `https://bucket.example.test/${key}?sig=stub`);

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => ({ id: 'user-1' }),
}));
vi.mock('../../api/_lib/r2.js', () => ({
	presignUpload: (...args) => presignMock(...args),
	publicUrl: (key) => `https://cdn.example.test/${key}`,
}));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { upload: (...args) => uploadLimit(...args) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../../api/_lib/db.js', () => ({
	sql: async () => [],
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));

const { default: handler } = await import('../../api/avatar/presign-audio.js');

const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

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

function makeReq(body) {
	return {
		method: 'POST',
		url: '/api/avatar/presign-audio',
		headers: { host: 'three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
		body,
	};
}

function parseBody(res) {
	return typeof res.body === 'string' && res.body ? JSON.parse(res.body) : null;
}

beforeEach(() => {
	presignMock.mockClear();
	uploadLimit.mockClear();
	uploadLimit.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: 0 });
});

describe('POST /api/avatar/presign-audio', () => {
	it('signs a PUT URL for a declared, in-budget clip', async () => {
		const res = makeRes();
		await handler(makeReq({ filename: 'clip.mp3', content_type: 'audio/mpeg', bytes: 1_200_000 }), res);
		expect(res.statusCode).toBe(200);
		const out = parseBody(res);
		expect(out.upload_url).toContain('https://');
		expect(out.storage_key).toMatch(/^u\/user-1\/audio\/.+\.mp3$/);
		expect(presignMock).toHaveBeenCalledTimes(1);
	});

	it('requires a declared size, since the signed PUT cannot enforce one', async () => {
		const res = makeRes();
		await handler(makeReq({ filename: 'clip.mp3' }), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('invalid_request');
		expect(presignMock).not.toHaveBeenCalled();
	});

	it('rejects a non-positive or unparseable declared size', async () => {
		for (const bytes of [0, -1, 'lots', null]) {
			const res = makeRes();
			await handler(makeReq({ filename: 'clip.mp3', bytes }), res);
			expect(res.statusCode).toBe(400);
		}
		expect(presignMock).not.toHaveBeenCalled();
	});

	it('refuses an oversized clip with 413 and never signs it', async () => {
		const res = makeRes();
		await handler(makeReq({ filename: 'huge.wav', content_type: 'audio/wav', bytes: MAX_AUDIO_BYTES + 1 }), res);
		expect(res.statusCode).toBe(413);
		expect(parseBody(res).error).toBe('payload_too_large');
		expect(presignMock).not.toHaveBeenCalled();
	});

	it('accepts exactly the cap', async () => {
		const res = makeRes();
		await handler(makeReq({ filename: 'big.wav', content_type: 'audio/wav', bytes: MAX_AUDIO_BYTES }), res);
		expect(res.statusCode).toBe(200);
	});

	it('consumes the per-user upload bucket and refuses when it is spent', async () => {
		uploadLimit.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 });
		const res = makeRes();
		await handler(makeReq({ filename: 'clip.mp3', bytes: 1000 }), res);
		expect(uploadLimit).toHaveBeenCalledWith('user-1');
		expect(res.statusCode).toBe(429);
		expect(presignMock).not.toHaveBeenCalled();
	});

	it('still rejects a non-audio content type before anything else', async () => {
		const res = makeRes();
		await handler(makeReq({ filename: 'clip.mp4', content_type: 'video/mp4', bytes: 1000 }), res);
		expect(res.statusCode).toBe(415);
		expect(presignMock).not.toHaveBeenCalled();
	});
});
