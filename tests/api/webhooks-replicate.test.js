// Tests for /api/webhooks/replicate — Standard Webhooks signature verification
// and DB-update side effects. The handler is the security boundary for a
// public endpoint that mutates avatar_regen_jobs rows, so signature handling
// is the highest-priority thing to test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

// In-memory job table so the test can assert what the webhook wrote.
const jobsByExtId = new Map();
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = strings.join('?').toLowerCase();
	if (text.includes('select') && text.includes('from avatar_regen_jobs')) {
		const extJobId = values[0];
		const row = jobsByExtId.get(extJobId);
		return row ? [row] : [];
	}
	if (text.includes('update avatar_regen_jobs')) {
		// Distinguish status update vs result_avatar_id update by # of values
		const isMaterialize = text.includes('result_avatar_id');
		if (isMaterialize) {
			const [resultAvatarId, jobId] = values;
			for (const row of jobsByExtId.values()) {
				if (row.job_id === jobId) row.result_avatar_id = resultAvatarId;
			}
		} else {
			const [status, glbUrl, errorMsg, jobId] = values;
			for (const row of jobsByExtId.values()) {
				if (row.job_id === jobId) {
					row.status = status;
					row.result_glb_url = glbUrl;
					row.error = errorMsg;
				}
			}
		}
		return [];
	}
	return [];
});
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock }));

const putObjectMock = vi.fn(async () => undefined);
vi.mock('../../api/_lib/r2.js', () => ({ putObject: putObjectMock }));

const createAvatarMock = vi.fn(async ({ input }) => ({
	id: 'avatar-from-webhook',
	...input,
}));
vi.mock('../../api/_lib/avatars.js', () => ({
	storageKeyFor: ({ userId, slug }) => `u/${userId}/${slug}/wbhk.glb`,
	createAvatar: createAvatarMock,
}));

// Don't actually fetch the result GLB URL — return a tiny fake buffer.
const ORIGINAL_FETCH = globalThis.fetch;

function makeReq({ body, headers = {} }) {
	const buf = Buffer.from(body, 'utf8');
	const stream = Readable.from([buf]);
	stream.method = 'POST';
	stream.url = '/api/webhooks/replicate';
	stream.headers = {
		'content-type': 'application/json',
		'content-length': String(buf.length),
		...headers,
	};
	return stream;
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

async function callWebhook(req, res) {
	const handler = (await import('../../api/webhooks/replicate.js')).default;
	await handler(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

// Build a valid Standard Webhooks signature for a body, given the raw signing
// key (no whsec_ prefix). We use the same shape Replicate sends.
function signed({ signingKey, body, id = randomUUID(), timestamp = Math.floor(Date.now() / 1000) }) {
	const signed = `${id}.${timestamp}.${body}`;
	const sig = createHmac('sha256', Buffer.from(signingKey, 'base64'))
		.update(signed)
		.digest('base64');
	return {
		'webhook-id': id,
		'webhook-timestamp': String(timestamp),
		'webhook-signature': `v1,${sig}`,
	};
}

const ORIGINAL_SIGNING_KEY = process.env.REPLICATE_WEBHOOK_SIGNING_KEY;

beforeEach(() => {
	jobsByExtId.clear();
	putObjectMock.mockClear();
	createAvatarMock.mockClear();
	sqlMock.mockClear();
	globalThis.fetch = vi.fn(async () => ({
		ok: true,
		arrayBuffer: async () => new Uint8Array(Buffer.alloc(256)).buffer,
	}));
	process.env.REPLICATE_WEBHOOK_SIGNING_KEY = undefined;
	if (ORIGINAL_SIGNING_KEY === undefined) delete process.env.REPLICATE_WEBHOOK_SIGNING_KEY;
	else process.env.REPLICATE_WEBHOOK_SIGNING_KEY = ORIGINAL_SIGNING_KEY;
});

afterEach();
function afterEach() { /* placeholder to keep linter calm */ }

describe('POST /api/webhooks/replicate', () => {
	it('accepts unsigned webhook when no signing key is configured (dev)', async () => {
		delete process.env.REPLICATE_WEBHOOK_SIGNING_KEY;
		jobsByExtId.set('pred-1', { job_id: 'job-1', user_id: 'u1', status: 'running', mode: 'restyle' });

		const body = JSON.stringify({ id: 'pred-1', status: 'succeeded', output: 'https://x/a.glb' });
		const { res, body: out } = await callWebhook(makeReq({ body }), makeRes());

		expect(res.statusCode).toBe(200);
		expect(out.ok).toBe(true);
		expect(out.verified).toBe(false); // not verified, just accepted
		expect(out.status).toBe('done');
		expect(jobsByExtId.get('pred-1').status).toBe('done');
		expect(jobsByExtId.get('pred-1').result_glb_url).toBe('https://x/a.glb');
	});

	it('rejects a tampered body when signing key is set', async () => {
		const key = Buffer.from('a-secret-32-byte-symmetric-key__').toString('base64');
		process.env.REPLICATE_WEBHOOK_SIGNING_KEY = `whsec_${key}`;

		jobsByExtId.set('pred-2', { job_id: 'job-2', user_id: 'u1', status: 'running', mode: 'restyle' });

		const realBody = JSON.stringify({ id: 'pred-2', status: 'succeeded', output: 'https://ok.glb' });
		const headers = signed({ signingKey: key, body: realBody });
		const tamperedBody = realBody.replace('https://ok.glb', 'https://evil.glb');

		const { res, body: out } = await callWebhook(makeReq({ body: tamperedBody, headers }), makeRes());
		expect(res.statusCode).toBe(401);
		expect(out.error).toBe('invalid_signature');
		expect(jobsByExtId.get('pred-2').status).toBe('running');
	});

	it('accepts a correctly signed webhook and updates status to done', async () => {
		const key = Buffer.from('b-secret-32-byte-symmetric-key__').toString('base64');
		process.env.REPLICATE_WEBHOOK_SIGNING_KEY = `whsec_${key}`;
		jobsByExtId.set('pred-3', { job_id: 'job-3', user_id: 'u1', status: 'running', mode: 'restyle' });

		const body = JSON.stringify({ id: 'pred-3', status: 'succeeded', output: ['https://x/result.glb'] });
		const headers = signed({ signingKey: key, body });

		const { res, body: out } = await callWebhook(makeReq({ body, headers }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(out.verified).toBe(true);
		expect(out.status).toBe('done');
		expect(jobsByExtId.get('pred-3').result_glb_url).toBe('https://x/result.glb');
	});

	it('rejects a replay with a stale timestamp', async () => {
		const key = Buffer.from('c-secret-32-byte-symmetric-key__').toString('base64');
		process.env.REPLICATE_WEBHOOK_SIGNING_KEY = `whsec_${key}`;
		jobsByExtId.set('pred-4', { job_id: 'job-4', user_id: 'u1', status: 'running', mode: 'restyle' });

		const body = JSON.stringify({ id: 'pred-4', status: 'failed', error: 'oom' });
		const stale = Math.floor(Date.now() / 1000) - 60 * 60; // 1 hour old
		const headers = signed({ signingKey: key, body, timestamp: stale });

		const { res, body: out } = await callWebhook(makeReq({ body, headers }), makeRes());
		expect(res.statusCode).toBe(401);
		expect(out.error).toBe('invalid_signature');
	});

	it('materializes the avatar when status flips to done for a reconstruct job', async () => {
		delete process.env.REPLICATE_WEBHOOK_SIGNING_KEY;
		jobsByExtId.set('pred-5', {
			job_id: 'job-5',
			user_id: 'u1',
			status: 'running',
			mode: 'reconstruct',
			params: { name: 'Selfie cool', visibility: 'private' },
		});

		const body = JSON.stringify({ id: 'pred-5', status: 'succeeded', output: 'https://x/recon.glb' });
		const { res, body: out } = await callWebhook(makeReq({ body }), makeRes());

		expect(res.statusCode).toBe(200);
		expect(out.status).toBe('done');
		expect(putObjectMock).toHaveBeenCalledOnce();
		expect(createAvatarMock).toHaveBeenCalledOnce();
		expect(createAvatarMock.mock.calls[0][0].input.source).toBe('reconstruct');
		expect(jobsByExtId.get('pred-5').result_avatar_id).toBe('avatar-from-webhook');
	});

	it('ignores predictions that do not match any job row (other apps in same account)', async () => {
		delete process.env.REPLICATE_WEBHOOK_SIGNING_KEY;
		const body = JSON.stringify({ id: 'pred-unrelated', status: 'succeeded' });
		const { res, body: out } = await callWebhook(makeReq({ body }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(out.ignored).toBeDefined();
		expect(putObjectMock).not.toHaveBeenCalled();
	});
});

globalThis.fetch = ORIGINAL_FETCH;
