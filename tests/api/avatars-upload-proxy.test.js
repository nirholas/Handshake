// Smoke tests for the /api/avatars/upload server-side proxy handler.
//
// Verifies the new handler in api/avatars/_actions.js — auth gate, content-type
// validation, body-size limit, checksum-mismatch path, and a happy-path POST
// that exercises the storage-key namespace and putObject contract. R2, DB,
// rate-limit, quota, and auth modules are mocked so the test runs offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/db.js', () => ({ sql: () => Promise.resolve([]) }));
vi.mock('../../api/_lib/usage.js', () => ({ recordEvent: () => {} }));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => ({ id: 'user-test-1' }),
	authenticateBearer: async () => null,
	extractBearer: () => null,
	hasScope: () => true,
}));

// CSRF check is wired into the proxy upload handler. Mock to always-pass —
// the CSRF contract is tested separately; here we want to exercise upload
// validation and storage paths.
vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: async () => true,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		upload: async () => ({ success: true }),
		avatarPatch: async () => ({ success: true }),
	},
	clientIp: () => '127.0.0.1',
}));

const putObjectMock = vi.fn(async () => undefined);
vi.mock('../../api/_lib/r2.js', () => ({
	presignUpload: async ({ key }) => `https://r2.test/upload/${key}?sig=mock`,
	headObject: async () => null,
	r2: {},
	publicUrl: (key) => `https://cdn.test/${key}`,
	putObject: putObjectMock,
}));

vi.mock('../../api/_lib/avatars.js', () => ({
	storageKeyFor: ({ userId, slug }) => `u/${userId}/${slug}/abc123.glb`,
	enforceQuotas: async () => undefined,
	searchPublicAvatars: async () => ({ avatars: [], next_cursor: null }),
	stripOwnerFor: (a) => a,
	listAvatars: async () => ({ avatars: [], next_cursor: null }),
	createAvatar: async (input) => ({ id: 'avatar-test', ...input }),
}));

// Use a real Readable so the handler's req.on('data')/('end') subscription
// happens before the bytes flow (Node buffers until the consumer attaches).
function makeReq({ body = Buffer.alloc(0), search = '', headers = {} } = {}) {
	const stream = body.length ? Readable.from([body]) : Readable.from([]);
	stream.method = 'POST';
	stream.url = `/api/avatars/upload${search}`;
	stream.headers = {
		'content-type': 'model/gltf-binary',
		'content-length': String(body.length),
		...headers,
	};
	return stream;
}

// Synthesize a minimum-viable binary glTF 2.0 buffer that passes the handler's
// magic+version+length header check. Payload is opaque zero bytes after the
// 12-byte header — we don't parse JSON/BIN chunks, just header validity.
function makeFakeGlb(payloadSize = 128) {
	const header = Buffer.alloc(12);
	header.writeUInt32LE(0x46546C67, 0); // magic 'glTF'
	header.writeUInt32LE(2, 4);          // version
	header.writeUInt32LE(12 + payloadSize, 8); // total length
	return Buffer.concat([header, Buffer.alloc(payloadSize)]);
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

// Dynamic import so vi.mock hoisting can intercept the dependency graph
// (top-level static imports would race the mock registration). The first
// test pays the cold-import cost — granted a longer timeout below.
async function dispatchUpload(req, res) {
	const { dispatch } = await import('../../api/avatars/_actions.js');
	await dispatch('upload', req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

beforeEach(() => {
	putObjectMock.mockClear();
});

describe('POST /api/avatars/upload', () => {
	it('happy path: stores GLB and returns storage_key + checksum', async () => {
		const glbBytes = makeFakeGlb(128);
		const { res, body } = await dispatchUpload(makeReq({ body: glbBytes }), makeRes());

		expect(res.statusCode).toBe(200);
		expect(body.storage_key).toMatch(/^u\/user-test-1\/draft-[a-z0-9]+\/abc123\.glb$/);
		expect(body.size_bytes).toBe(glbBytes.length);
		expect(body.content_type).toBe('model/gltf-binary');
		expect(body.checksum_sha256).toMatch(/^[a-f0-9]{64}$/);

		expect(putObjectMock).toHaveBeenCalledOnce();
		const [call] = putObjectMock.mock.calls;
		expect(call[0].body).toEqual(glbBytes);
		expect(call[0].contentType).toBe('model/gltf-binary');
	});

	it('rejects empty body with 400 empty_body', async () => {
		const { res, body } = await dispatchUpload(makeReq({ body: Buffer.alloc(0) }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('empty_body');
		expect(putObjectMock).not.toHaveBeenCalled();
	});

	it('rejects bogus content-type with 415', async () => {
		const { res, body } = await dispatchUpload(
			makeReq({ body: makeFakeGlb(32), search: '?content_type=text/plain' }),
			makeRes(),
		);
		expect(res.statusCode).toBe(415);
		expect(body.error).toBe('unsupported_media_type');
	});

	it('rejects bytes that are not valid GLB header with 415 invalid_glb', async () => {
		const notGlb = Buffer.from('<html>error page from a misbehaving proxy</html>');
		const { res, body } = await dispatchUpload(makeReq({ body: notGlb }), makeRes());
		expect(res.statusCode).toBe(415);
		expect(body.error).toBe('invalid_glb');
		expect(putObjectMock).not.toHaveBeenCalled();
	});

	it('rejects GLB with wrong total-length field with 415 invalid_glb', async () => {
		// Hand-craft a header that claims a larger length than the buffer has
		const bad = Buffer.alloc(20);
		bad.writeUInt32LE(0x46546C67, 0);
		bad.writeUInt32LE(2, 4);
		bad.writeUInt32LE(9999, 8); // lies about length
		const { res, body } = await dispatchUpload(makeReq({ body: bad }), makeRes());
		expect(res.statusCode).toBe(415);
		expect(body.error).toBe('invalid_glb');
	});

	it('rejects checksum mismatch with 400', async () => {
		const glb = makeFakeGlb(64);
		const { res, body } = await dispatchUpload(
			makeReq({ body: glb, search: '?sha256=deadbeef' + 'a'.repeat(56) }),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('checksum_mismatch');
		expect(putObjectMock).not.toHaveBeenCalled();
	});

	it('rejects declared content-length above 50 MB with 413', async () => {
		const { res, body } = await dispatchUpload(
			makeReq({
				body: makeFakeGlb(32),
				headers: { 'content-length': String(60 * 1024 * 1024) },
			}),
			makeRes(),
		);
		expect(res.statusCode).toBe(413);
		expect(body.error).toBe('payload_too_large');
	});

	it('honors caller-supplied slug', async () => {
		const { res, body } = await dispatchUpload(
			makeReq({ body: makeFakeGlb(64), search: '?slug=my-cool-avatar' }),
			makeRes(),
		);
		expect(res.statusCode).toBe(200);
		expect(body.storage_key).toBe('u/user-test-1/my-cool-avatar/abc123.glb');
	});
});
