// POST /api/motion-swap { action: "upload" } presigns a direct-to-storage PUT
// and tells the client how long that URL stays usable.
//
// The advertised `expires_in` and the signature's real lifetime have to be the
// same number. They were not: the handler reported 600 while presignUpload
// signs for 300, so a client that queued a large video on the strength of that
// promise could start the PUT after the signature had died and get a bare 403
// from R2 with nothing in our logs. This asserts the two against each other
// rather than against a literal, so the next change to either one is caught.
//
// The signer is the real one (AWS SigV4 is pure HMAC, no network), with throwaway
// credentials. Only the rate limiter is stubbed, since it needs Redis.
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.S3_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
process.env.S3_BUCKET = 'test-bucket';
process.env.S3_PUBLIC_DOMAIN = 'https://cdn.example.com';
process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		upload: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcp3dGenerate: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcp3dStatus: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
	},
	clientIp: vi.fn(() => '203.0.113.7'),
}));

const { default: handler } = await import('../../api/motion-swap.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) {
			this.headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[String(k).toLowerCase()];
		},
		end(body) {
			this.body = body ?? null;
		},
	};
}

function makeReq(body) {
	const payload = JSON.stringify(body);
	const req = Readable.from([Buffer.from(payload, 'utf8')]);
	req.method = 'POST';
	req.url = '/api/motion-swap';
	req.headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' };
	return req;
}

async function presign(body) {
	const res = makeRes();
	await handler(makeReq(body), res);
	return { res, json: JSON.parse(res.body) };
}

describe('POST /api/motion-swap action=upload', () => {
	it('advertises exactly the lifetime the signature actually has', async () => {
		const { res, json } = await presign({
			action: 'upload',
			content_type: 'video/mp4',
			size_bytes: 1_048_576,
		});
		expect(res.statusCode).toBe(200);
		const signedFor = Number(new URL(json.upload_url).searchParams.get('X-Amz-Expires'));
		expect(signedFor).toBeGreaterThan(0);
		expect(json.expires_in).toBe(signedFor);
	});

	it('returns a PUT target and the public URL the video will land on', async () => {
		const { json } = await presign({
			action: 'upload',
			content_type: 'video/quicktime',
			size_bytes: 2048,
		});
		expect(json.method).toBe('PUT');
		expect(json.headers['content-type']).toBe('video/quicktime');
		expect(json.upload_url).toContain('.mov?');
		expect(json.public_url).toBe(
			`https://cdn.example.com/${new URL(json.upload_url).pathname.replace(/^\//, '')}`,
		);
	});

	it('rejects a content type the motion worker cannot decode', async () => {
		const { res, json } = await presign({
			action: 'upload',
			content_type: 'image/png',
			size_bytes: 2048,
		});
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('invalid_content_type');
	});

	it('rejects a size outside the 1 byte to 256 MB window', async () => {
		for (const size_bytes of [0, -1, 256 * 1024 * 1024 + 1]) {
			const { res, json } = await presign({ action: 'upload', content_type: 'video/mp4', size_bytes });
			expect(res.statusCode).toBe(400);
			expect(json.error).toBe('invalid_size');
		}
	});
});
