// Tests for POST /api/avatars/from-forge — the server-side save end of the chat
// "text → 3D avatar" pipeline. The endpoint fetches a generated GLB by URL,
// copies it into the caller's storage, and registers it as a first-class avatar
// (agent provisioning is fired separately and mocked here). DB, R2, auth, the
// SSRF-guarded fetch, and GLB inspection are mocked so the suite runs offline.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';
process.env.JWT_SECRET ||= 'test-secret-from-forge';

const authState = { session: { id: 'user-1' } };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => authState.session,
	authenticateBearer: async () => null,
	extractBearer: () => null,
	hasScope: () => false,
}));

vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn(async () => []), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { upload: vi.fn(async () => ({ success: true, reset: Date.now() + 3_600_000 })) },
	clientIp: vi.fn(() => '203.0.113.9'),
}));

const recordEvent = vi.fn();
vi.mock('../../api/_lib/usage.js', () => ({ recordEvent, logger: () => ({ info() {}, warn() {}, error() {} }) }));

const r2State = { put: vi.fn(async () => {}) };
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: (...a) => r2State.put(...a),
	publicUrl: (key) => `https://cdn.test/${key}`,
}));

const glbState = { valid: true, info: { isRigged: true, meshCount: 1, animationCount: 0 } };
vi.mock('../../api/_lib/glb-inspect.js', () => ({
	isValidGlbHeader: () => glbState.valid,
	inspectGlb: () => glbState.info,
}));

const createAvatar = vi.fn(async ({ input }) => ({
	id: 'avatar-uuid-0001',
	slug: input.slug,
	name: input.name,
	visibility: input.visibility,
	size_bytes: input.size_bytes,
	source: input.source,
}));
// The handler asks the account's "Default avatar visibility" preference for a
// request that did not name one, and this mock replaces the whole module, so it
// has to answer too. With no stored preference the real function returns the
// caller's fallback, which is what these tests assert on.
const defaultAvatarVisibilityFor = vi.fn(async (_userId, fallback = 'private') => fallback);
vi.mock('../../api/_lib/avatars.js', () => ({
	createAvatar,
	defaultAvatarVisibilityFor,
	storageKeyFor: ({ userId, slug }) => `u/${userId}/${slug}/x.glb`,
}));

const provisionAvatarAgent = vi.fn(async () => 'agent-1');
vi.mock('../../api/_lib/avatar-agent.js', () => ({ provisionAvatarAgent }));

// SSRF-guarded fetch — return a controllable fake Response; keep the real error class.
const fetchState = {
	ok: true,
	status: 200,
	contentLength: '512',
	body: new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer, // "glTF"
};
vi.mock('../../api/_lib/ssrf-guard.js', async (importOriginal) => {
	const mod = await importOriginal();
	return {
		...mod,
		fetchSafePublicUrl: vi.fn(async (url, _init, opts = {}) => {
			const parsed = new URL(url);
			if (parsed.protocol === 'http:' && !opts.allowHttp) throw new mod.SsrfBlockedError('http not allowed');
			return {
				ok: fetchState.ok,
				status: fetchState.status,
				headers: { get: (k) => (k.toLowerCase() === 'content-length' ? fetchState.contentLength : null) },
				arrayBuffer: async () => fetchState.body,
			};
		}),
	};
});

const handler = (await import('../../api/avatars/from-forge.js')).default;

function makeReq(body, { method = 'POST' } = {}) {
	const json = typeof body === 'string' ? body : JSON.stringify(body);
	const req = Readable.from([Buffer.from(json, 'utf8')]);
	req.method = method;
	req.url = '/api/avatars/from-forge';
	req.headers = { host: 'three.ws', 'content-type': 'application/json' };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		_body: null,
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this.writableEnded = true; if (b != null) this._body = b; },
	};
}

async function invoke(body, opts) {
	const req = makeReq(body, opts);
	const res = makeRes();
	await handler(req, res);
	return { res, json: res._body ? JSON.parse(res._body) : null };
}

beforeEach(() => {
	authState.session = { id: 'user-1' };
	r2State.put.mockClear();
	createAvatar.mockClear();
	provisionAvatarAgent.mockClear();
	recordEvent.mockClear();
	glbState.valid = true;
	glbState.info = { isRigged: true, meshCount: 1, animationCount: 0 };
	fetchState.ok = true;
	fetchState.status = 200;
	fetchState.contentLength = '512';
	fetchState.body = new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer;
});

describe('POST /api/avatars/from-forge', () => {
	it('saves a generated GLB as a first-class avatar', async () => {
		const { res, json } = await invoke({
			glb_url: 'https://cdn.test/forge/result.glb',
			name: 'Cyber Fox',
			source_prompt: 'a cyberpunk fox',
			rigged: true,
		});
		expect(res.statusCode).toBe(201);
		expect(json.avatar.id).toBe('avatar-uuid-0001');
		expect(json.view_url).toBe('https://three.ws/avatars/avatar-uuid-0001');
		// Copied into the caller's own namespace.
		expect(r2State.put).toHaveBeenCalledTimes(1);
		expect(r2State.put.mock.calls[0][0].key).toMatch(/^u\/user-1\//);
		// Registered as a studio avatar with provenance, and an agent provisioned.
		const input = createAvatar.mock.calls[0][0].input;
		expect(input.source).toBe('studio');
		expect(input.source_meta.source_glb_url).toBe('https://cdn.test/forge/result.glb');
		expect(input.source_meta.source_prompt).toBe('a cyberpunk fox');
		expect(provisionAvatarAgent).toHaveBeenCalledTimes(1);
	});

	it('defaults visibility to unlisted', async () => {
		const { json } = await invoke({ glb_url: 'https://cdn.test/a.glb', name: 'X' });
		expect(createAvatar.mock.calls[0][0].input.visibility).toBe('unlisted');
		expect(json.avatar.visibility).toBe('unlisted');
	});

	it('401s when not signed in', async () => {
		authState.session = null;
		const { res } = await invoke({ glb_url: 'https://cdn.test/a.glb', name: 'X' });
		expect(res.statusCode).toBe(401);
		expect(r2State.put).not.toHaveBeenCalled();
	});

	it('400s when glb_url or name is missing', async () => {
		expect((await invoke({ name: 'X' })).res.statusCode).toBe(400);
		expect((await invoke({ glb_url: 'https://cdn.test/a.glb' })).res.statusCode).toBe(400);
	});

	it('400s on a non-public (http) glb_url', async () => {
		const { res } = await invoke({ glb_url: 'http://cdn.test/a.glb', name: 'X' });
		expect(res.statusCode).toBe(400);
		expect(r2State.put).not.toHaveBeenCalled();
	});

	it('422s when the URL is not a valid GLB', async () => {
		glbState.valid = false;
		const { res } = await invoke({ glb_url: 'https://cdn.test/not.glb', name: 'X' });
		expect(res.statusCode).toBe(422);
		expect(createAvatar).not.toHaveBeenCalled();
	});

	it('413s when the GLB exceeds the size cap', async () => {
		fetchState.contentLength = String(65 * 1024 * 1024);
		const { res } = await invoke({ glb_url: 'https://cdn.test/huge.glb', name: 'X' });
		expect(res.statusCode).toBe(413);
		expect(r2State.put).not.toHaveBeenCalled();
	});
});
