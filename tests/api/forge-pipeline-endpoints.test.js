// Endpoint contracts for the /forge pipeline handlers: forge-og, forge-poster,
// forge-quality-check, forge-rembg, forge-remesh, forge-segment, forge-share,
// forge-stylize, forge-upload, forge-vote.
//
// Three of these pin regressions found while auditing the batch:
//
//  1. forge-stylize took `style` through a bare `STYLE_BOUNDS[body.style]`
//     truthiness test. Every Object.prototype key is truthy there, so
//     `style: "constructor"` walked past the allowlist and reached the worker
//     with an unknown filter and a NaN resolution.
//  2. forge-upload did the same with `content_type`. Object.freeze does not
//     detach a prototype, so `content_type: "constructor"` resolved to the
//     Object function and presigned an upload whose storage key ended in the
//     stringified builtin.
//  3. The four worker-backed pollers called provider.status() with no guard.
//     An upstream fault escaped to wrap() as a 500, which fires a Sentry
//     capture and an ops alert, once per poll, per client, for the length of
//     a worker outage. They now answer a clean 502.
//
// The DB, object storage, the worker provider, and the rate limiter are the
// process boundaries; everything inside them is the real handler code.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// forge-upload gates on the raw S3_* vars rather than on forge-store's helper,
// so the suite has to declare a configured deployment for it to get past the
// 503. Synthetic values: presignUpload and publicUrl are stubbed below, so
// nothing here reaches an object store.
const S3_ENV = {
	S3_ENDPOINT: 'https://s3.test.invalid',
	S3_BUCKET: 'test-bucket',
	S3_PUBLIC_DOMAIN: 'https://cdn.test.invalid',
	S3_ACCESS_KEY_ID: 'test-access-key',
	S3_SECRET_ACCESS_KEY: 'test-secret-key',
};
const savedS3 = {};
for (const [k, v] of Object.entries(S3_ENV)) {
	savedS3[k] = process.env[k];
	process.env[k] = v;
}
afterAll(() => {
	for (const k of Object.keys(S3_ENV)) {
		if (savedS3[k] === undefined) delete process.env[k];
		else process.env[k] = savedS3[k];
	}
});

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const rlAllow = { value: true };
const limitStub = vi.fn(async () => ({ success: rlAllow.value, reset: Date.now() + 1_000, limit: 10, remaining: 0 }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcp3dGenerate: (...a) => limitStub(...a),
		mcp3dStatus: (...a) => limitStub(...a),
		upload: (...a) => limitStub(...a),
		forgeVote: (...a) => limitStub(...a),
		visionUser: (...a) => limitStub(...a),
		visionIp: (...a) => limitStub(...a),
	},
	clientIp: () => '203.0.113.9',
}));

// Real SSRF policy is covered by its own suite; here it only has to let a
// known-good https URL through so the handler's own validation is what's tested.
class FakeSsrfError extends Error {}
vi.mock('../../api/_lib/ssrf.js', () => ({
	SsrfError: FakeSsrfError,
	assertPublicHttpsUrl: async (raw) => {
		if (typeof raw !== 'string' || !raw.startsWith('https://')) {
			throw new FakeSsrfError('must be a public https URL');
		}
		return raw;
	},
}));

const submitted = [];
const providerState = { configured: true, statusThrows: false };
vi.mock('../../api/_providers/gcp.js', () => ({
	createRegenProvider: () => {
		if (!providerState.configured) throw new Error('no gcp worker configured');
		return {
			supportsMode: () => true,
			async submit(job) {
				submitted.push(job);
				return { extJobId: 'j'.repeat(40), eta: 30 };
			},
			async status() {
				if (providerState.statusThrows) throw new Error('worker unreachable');
				return { status: 'running' };
			},
		};
	},
}));

const storeState = { enabled: true };
const castVoteMock = vi.fn();
const removeVoteMock = vi.fn();
const attachPosterMock = vi.fn();
vi.mock('../../api/_lib/forge-store.js', () => ({
	forgeStoreEnabled: () => storeState.enabled,
	hashClient: (raw) => (typeof raw === 'string' && raw.trim() ? `h-${raw.trim()}` : 'anon'),
	hashIp: (ip) => (ip ? `hip-${ip}` : null),
	castVote: (...a) => castVoteMock(...a),
	removeVote: (...a) => removeVoteMock(...a),
	attachPoster: (...a) => attachPosterMock(...a),
}));

const presignMock = vi.fn(async ({ key }) => `https://r2.example/${key}?sig=abc`);
vi.mock('../../api/_lib/r2.js', () => ({
	presignUpload: (...a) => presignMock(...a),
	publicUrl: (key) => `https://cdn.example/${key}`,
}));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => null,
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));

const gateState = { configured: false };
vi.mock('../../api/_lib/forge-quality-gate.js', () => ({
	qualityGateConfigured: () => gateState.configured,
	vertexQualityConfigured: () => false,
	QUALITY_GATE_DEFAULTS: { model: 'gemini-test', passScore: 60, maxRetries: 2 },
	runQualityGate: async () => ({ pass: true, qa_available: false, score: null }),
	buildRetryDirective: () => ({ retry: true }),
}));

const [og, poster, qualityCheck, rembg, remesh, segment, share, stylize, upload, vote] = await Promise.all([
	import('../../api/forge-og.js'),
	import('../../api/forge-poster.js'),
	import('../../api/forge-quality-check.js'),
	import('../../api/forge-rembg.js'),
	import('../../api/forge-remesh.js'),
	import('../../api/forge-segment.js'),
	import('../../api/forge-share.js'),
	import('../../api/forge-stylize.js'),
	import('../../api/forge-upload.js'),
	import('../../api/forge-vote.js'),
]).then((mods) => mods.map((m) => m.default));

const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESH = 'https://cdn.example/mesh.glb';
const JOB = 'j'.repeat(40);

function mkReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
	const hdrs = { ...headers };
	let rawBody;
	if (body !== undefined) {
		if (!hdrs['content-type']) hdrs['content-type'] = 'application/json';
		rawBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
	}
	return { method, url, headers: hdrs, rawBody, on() {}, destroy() {} };
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b === undefined ? '' : String(b); this.writableEnded = true; },
	};
}

async function call(handler, reqInit) {
	const res = mkRes();
	await handler(mkReq(reqInit), res);
	return res;
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

beforeEach(() => {
	rlAllow.value = true;
	providerState.configured = true;
	providerState.statusThrows = false;
	storeState.enabled = true;
	gateState.configured = false;
	submitted.length = 0;
	sqlMock.mockReset();
	castVoteMock.mockReset();
	removeVoteMock.mockReset();
	attachPosterMock.mockReset();
	presignMock.mockClear();
	limitStub.mockClear();
});

describe('forge-stylize', () => {
	it('starts a job on a valid style and clamps the resolution', async () => {
		const res = await call(stylize, {
			method: 'POST',
			url: '/api/forge-stylize',
			body: { mesh_url: MESH, style: 'brick', resolution: 9_999 },
		});
		expect(res.statusCode).toBe(202);
		expect(parse(res)).toMatchObject({ job_id: JOB, status: 'queued', style: 'brick', resolution: 64 });
		expect(submitted[0].params).toMatchObject({ style: 'brick', resolution: 64 });
	});

	it('rejects a prototype key as a style instead of passing it to the worker', async () => {
		for (const style of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
			submitted.length = 0;
			const res = await call(stylize, {
				method: 'POST',
				url: '/api/forge-stylize',
				body: { mesh_url: MESH, style, resolution: 50 },
			});
			expect(res.statusCode).toBe(202);
			// Falls back to the default filter with a real resolution. The bug sent
			// `style: "constructor"` and a NaN resolution straight through.
			expect(parse(res).style).toBe('voxel');
			expect(submitted[0].params.style).toBe('voxel');
			expect(Number.isFinite(submitted[0].params.resolution)).toBe(true);
			expect(submitted[0].params.resolution).toBe(50);
		}
	});

	it('rejects a non-https mesh_url at the boundary', async () => {
		const res = await call(stylize, {
			method: 'POST',
			url: '/api/forge-stylize',
			body: { mesh_url: 'http://169.254.169.254/latest' },
		});
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_mesh_url');
	});

	it('answers 502, not 500, when the worker poll faults', async () => {
		providerState.statusThrows = true;
		const res = await call(stylize, { url: `/api/forge-stylize?job=${JOB}` });
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('stylize_status_failed');
		// No `status` field, so the client's poll loop retries rather than
		// treating a transient worker fault as a failed job.
		expect(parse(res).status).toBeUndefined();
	});

	it('503s with an actionable message when the worker is unconfigured', async () => {
		providerState.configured = false;
		const res = await call(stylize, { url: `/api/forge-stylize?job=${JOB}` });
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('unconfigured');
	});
});

describe('forge-rembg / forge-remesh / forge-segment', () => {
	const lanes = [
		{ name: 'rembg', handler: () => rembg, path: '/api/forge-rembg', urlField: 'image_url', code: 'rembg_status_failed' },
		{ name: 'remesh', handler: () => remesh, path: '/api/forge-remesh', urlField: 'mesh_url', code: 'remesh_status_failed' },
		{ name: 'segment', handler: () => segment, path: '/api/forge-segment', urlField: 'mesh_url', code: 'segment_status_failed' },
	];

	for (const lane of lanes) {
		it(`${lane.name}: queues a job on a valid source URL`, async () => {
			const res = await call(lane.handler(), {
				method: 'POST',
				url: lane.path,
				body: { [lane.urlField]: MESH },
			});
			expect(res.statusCode).toBe(202);
			expect(parse(res)).toMatchObject({ job_id: JOB, status: 'queued' });
		});

		it(`${lane.name}: 400s a malformed job id`, async () => {
			const res = await call(lane.handler(), { url: `${lane.path}?job=short` });
			expect(res.statusCode).toBe(400);
			expect(parse(res).error).toBe('invalid_job');
		});

		it(`${lane.name}: answers 502, not 500, when the worker poll faults`, async () => {
			providerState.statusThrows = true;
			const res = await call(lane.handler(), { url: `${lane.path}?job=${JOB}` });
			expect(res.statusCode).toBe(502);
			expect(parse(res).error).toBe(lane.code);
			expect(parse(res).status).toBeUndefined();
		});

		it(`${lane.name}: 405s a verb it does not serve`, async () => {
			const res = await call(lane.handler(), { method: 'DELETE', url: lane.path });
			expect(res.statusCode).toBe(405);
		});
	}
});

describe('forge-upload', () => {
	it('presigns an upload for an accepted image type', async () => {
		const res = await call(upload, {
			method: 'POST',
			url: '/api/forge-upload',
			headers: { 'x-forge-client': 'browser-1' },
			body: { content_type: 'image/png', size_bytes: 1_000 },
		});
		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.storage_key).toMatch(/^forge\/uploads\/[^/]+\/[0-9a-f-]{36}\.png$/);
		expect(out.method).toBe('PUT');
		expect(out.headers['content-type']).toBe('image/png');
		expect(out.upload_url).toContain(out.storage_key);
	});

	it('rejects a prototype key as a content type', async () => {
		for (const contentType of ['constructor', '__proto__', 'tostring']) {
			const res = await call(upload, {
				method: 'POST',
				url: '/api/forge-upload',
				body: { content_type: contentType, size_bytes: 1_000 },
			});
			expect(res.statusCode).toBe(400);
			expect(parse(res).error).toBe('invalid_content_type');
			expect(presignMock).not.toHaveBeenCalled();
		}
	});

	it('rejects a size outside the cap', async () => {
		for (const size of [0, -1, 9 * 1024 * 1024, 'big']) {
			const res = await call(upload, {
				method: 'POST',
				url: '/api/forge-upload',
				body: { content_type: 'image/png', size_bytes: size },
			});
			expect(res.statusCode).toBe(400);
			expect(parse(res).error).toBe('invalid_size');
		}
	});

	it('surfaces a presign failure as 502', async () => {
		presignMock.mockRejectedValueOnce(new Error('bucket unreachable'));
		const res = await call(upload, {
			method: 'POST',
			url: '/api/forge-upload',
			body: { content_type: 'image/webp', size_bytes: 2_000 },
		});
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('presign_failed');
	});
});

describe('forge-vote', () => {
	it('casts a vote and returns the authoritative tally', async () => {
		castVoteMock.mockResolvedValueOnce({ creationId: UUID, voteCount: 4, voted: true });
		const res = await call(vote, {
			method: 'POST',
			url: '/api/forge-vote',
			headers: { 'x-forge-client': 'browser-1' },
			body: { creation_id: UUID },
		});
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ ok: true, creation_id: UUID, vote_count: 4, voted: true });
		expect(castVoteMock).toHaveBeenCalledWith({ creationId: UUID, voterKey: 'h-browser-1', ipHash: 'hip-203.0.113.9' });
	});

	it('removes a vote on an explicit vote:false', async () => {
		removeVoteMock.mockResolvedValueOnce({ creationId: UUID, voteCount: 3, voted: false });
		const res = await call(vote, {
			method: 'POST',
			url: '/api/forge-vote',
			headers: { 'x-forge-client': 'browser-1' },
			body: { creation_id: UUID, vote: false },
		});
		expect(res.statusCode).toBe(200);
		expect(parse(res).voted).toBe(false);
		expect(castVoteMock).not.toHaveBeenCalled();
	});

	it('refuses a vote with no stable client id', async () => {
		const res = await call(vote, { method: 'POST', url: '/api/forge-vote', body: { creation_id: UUID } });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('no_client_id');
		expect(castVoteMock).not.toHaveBeenCalled();
	});

	it('404s a creation that is not votable', async () => {
		castVoteMock.mockResolvedValueOnce(null);
		const res = await call(vote, {
			method: 'POST',
			url: '/api/forge-vote',
			headers: { 'x-forge-client': 'browser-1' },
			body: { creation_id: UUID },
		});
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('not_votable');
	});

	it('400s a malformed creation id', async () => {
		const res = await call(vote, {
			method: 'POST',
			url: '/api/forge-vote',
			headers: { 'x-forge-client': 'browser-1' },
			body: { creation_id: 'not-a-uuid' },
		});
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_creation');
	});
});

describe('forge-poster', () => {
	const PNG = 'data:image/png;base64,iVBORw0KGgo=';

	it('attaches a poster and returns the stored preview URL', async () => {
		attachPosterMock.mockResolvedValueOnce('https://cdn.example/forge/h-browser/poster.png');
		const res = await call(poster, {
			method: 'POST',
			url: '/api/forge-poster',
			headers: { 'x-forge-client': 'browser-1' },
			body: { creation_id: UUID, image: PNG },
		});
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ ok: true, stored: true });
		expect(attachPosterMock.mock.calls[0][0]).toMatchObject({
			id: UUID,
			clientKey: 'h-browser-1',
			contentType: 'image/png',
			ext: 'png',
		});
	});

	it('reports a benign no-op as stored:false rather than an error', async () => {
		attachPosterMock.mockResolvedValueOnce(null);
		const res = await call(poster, {
			method: 'POST',
			url: '/api/forge-poster',
			headers: { 'x-forge-client': 'browser-1' },
			body: { creation_id: UUID, image: PNG },
		});
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ ok: true, stored: false, preview_image_url: null });
	});

	it('400s anything that is not a webp/png/jpeg data URL', async () => {
		for (const image of ['notadataurl', 'data:image/gif;base64,R0lGOD', 'data:image/png;base64,', 'data:text/html,<script>']) {
			const res = await call(poster, {
				method: 'POST',
				url: '/api/forge-poster',
				headers: { 'x-forge-client': 'browser-1' },
				body: { creation_id: UUID, image },
			});
			expect(res.statusCode).toBe(400);
			expect(parse(res).error).toBe('invalid_image');
			expect(attachPosterMock).not.toHaveBeenCalled();
		}
	});

	it('short-circuits cleanly when persistence is unconfigured', async () => {
		storeState.enabled = false;
		const res = await call(poster, {
			method: 'POST',
			url: '/api/forge-poster',
			body: { creation_id: UUID, image: PNG },
		});
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ ok: false, stored: false, reason: 'persistence_unconfigured' });
	});
});

describe('forge-quality-check', () => {
	it('serves a capability probe on GET', async () => {
		const res = await call(qualityCheck, { url: '/api/forge-quality-check' });
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ configured: false, provider: null, passScore: 60, maxRetries: 2 });
	});

	it('serves the same probe on HEAD', async () => {
		gateState.configured = true;
		const res = await call(qualityCheck, { method: 'HEAD', url: '/api/forge-quality-check' });
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ configured: true, provider: 'platform-vision' });
	});

	it('400s a POST with no model to score', async () => {
		const res = await call(qualityCheck, { method: 'POST', url: '/api/forge-quality-check', body: {} });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('bad_request');
	});

	it('scores a supplied render and fails open', async () => {
		const res = await call(qualityCheck, {
			method: 'POST',
			url: '/api/forge-quality-check',
			body: { renderUrl: 'https://cdn.example/render.png', prompt: 'a red chair' },
		});
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ verdict: { pass: true, qa_available: false, score: null }, retry: null });
	});
});

describe('forge-og', () => {
	it('302s to the creation preview when one exists', async () => {
		sqlMock.mockResolvedValueOnce([{ id: UUID, prompt: 'a red chair', preview_image_url: 'https://cdn.example/p.png' }]);
		const res = await call(og, { url: `/api/forge-og?id=${UUID}` });
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('https://cdn.example/p.png');
	});

	it('renders an SVG card when the row has no preview', async () => {
		sqlMock.mockResolvedValueOnce([{ id: UUID, prompt: 'a <script> chair', preview_image_url: null }]);
		const res = await call(og, { url: `/api/forge-og?id=${UUID}` });
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('image/svg+xml');
		expect(res.body).toContain('&lt;script&gt;');
		expect(res.body).not.toContain('<script>');
	});

	it('falls back to a 404 card on a malformed id without touching the DB', async () => {
		const res = await call(og, { url: '/api/forge-og?id=not-a-uuid' });
		expect(res.statusCode).toBe(404);
		expect(res.headers['content-type']).toContain('image/svg+xml');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('falls back to a card when the DB read throws', async () => {
		sqlMock.mockRejectedValueOnce(new Error('db down'));
		const res = await call(og, { url: `/api/forge-og?id=${UUID}` });
		expect(res.statusCode).toBe(404);
		expect(res.headers['content-type']).toContain('image/svg+xml');
	});
});

describe('forge-share', () => {
	it('bakes escaped OG, Twitter, Frame and oEmbed tags into the page', async () => {
		sqlMock.mockResolvedValueOnce([
			{ id: UUID, prompt: 'a "quoted" <chair>', preview_image_url: 'https://cdn.example/p.png', status: 'done' },
		]);
		const res = await call(share, { url: `/api/forge-share?id=${UUID}` });
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.body).toContain('property="og:image" content="https://cdn.example/p.png"');
		expect(res.body).toContain('name="twitter:card" content="summary_large_image"');
		expect(res.body).toContain('property="fc:frame" content="vNext"');
		expect(res.body).toContain('application/json+oembed');
		expect(res.body).toContain('&quot;quoted&quot;');
		expect(res.body).not.toContain('<chair>');
	});

	it('points og:image at the card endpoint when the row has no preview', async () => {
		sqlMock.mockResolvedValueOnce([{ id: UUID, prompt: 'a chair', preview_image_url: null, status: 'done' }]);
		const res = await call(share, { url: `/api/forge-share?id=${UUID}` });
		expect(res.body).toContain(`/api/forge-og?id=${UUID}`);
	});

	it('redirects to /forge on a malformed or unknown id', async () => {
		const bad = await call(share, { url: '/api/forge-share?id=nope' });
		expect(bad.statusCode).toBe(302);
		expect(bad.headers.location).toContain('/forge');
		expect(sqlMock).not.toHaveBeenCalled();

		sqlMock.mockResolvedValueOnce([]);
		const missing = await call(share, { url: `/api/forge-share?id=${UUID}` });
		expect(missing.statusCode).toBe(302);
		expect(missing.headers.location).toContain('/forge');
	});
});

describe('rate limiting', () => {
	it('429s every metered lane when the bucket is exhausted', async () => {
		rlAllow.value = false;
		const cases = [
			[stylize, { method: 'POST', url: '/api/forge-stylize', body: { mesh_url: MESH } }],
			[rembg, { method: 'POST', url: '/api/forge-rembg', body: { image_url: MESH } }],
			[remesh, { url: `/api/forge-remesh?job=${JOB}` }],
			[segment, { url: `/api/forge-segment?job=${JOB}` }],
			[upload, { method: 'POST', url: '/api/forge-upload', body: { content_type: 'image/png', size_bytes: 10 } }],
			[vote, { method: 'POST', url: '/api/forge-vote', headers: { 'x-forge-client': 'b' }, body: { creation_id: UUID } }],
			[poster, { method: 'POST', url: '/api/forge-poster', body: { creation_id: UUID, image: 'data:image/png;base64,iVBORw0KGgo=' } }],
		];
		for (const [handler, reqInit] of cases) {
			const res = await call(handler, reqInit);
			expect(res.statusCode).toBe(429);
			expect(res.headers['retry-after']).toBeDefined();
		}
	});
});
