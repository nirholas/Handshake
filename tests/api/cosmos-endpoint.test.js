// /api/cosmos: the text→world lane behind /cosmos.
//
// The contract under test is what the BROWSER is allowed to see. The upstream
// gateway answers a retired model with `Function '<uuid>': Not found for account
// '<id>'`, and that string was rendered verbatim in the page's error banner: an
// operator detail (with the account id in it) offered to the user as something to
// retry. So: every failure maps to lane copy the caller can act on, a retired lane
// reports 503 so the page lands in its designed offline state, and the poll never
// hands back provider diagnostics.
//
// The provider module is stubbed at the seam; no network, no live NVCF spend.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const textToWorld = vi.fn();
const status = vi.fn();
const configured = vi.fn(() => true);

vi.mock('../../api/_providers/nvidia-cosmos.js', () => ({
	nvidiaCosmosConfigured: (...a) => configured(...a),
	createNvidiaCosmosProvider: () => ({ textToWorld, status }),
}));

function makeReq({ method = 'POST', url = '/api/cosmos', body = null } = {}) {
	const raw = body == null ? '' : JSON.stringify(body);
	const stream = Readable.from(raw ? [Buffer.from(raw)] : []);
	stream.method = method;
	stream.url = url;
	stream.headers = { 'content-type': 'application/json', host: 'three.ws' };
	stream.socket = { remoteAddress: '127.0.0.1' };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(b) {
			this._body = b;
			this.writableEnded = true;
		},
	};
}

async function dispatch(req) {
	const res = makeRes();
	const mod = await import('../../api/cosmos.js');
	await mod.default(req, res);
	return { status: res.statusCode, body: res._body ? JSON.parse(res._body) : null };
}

// The exact upstream body the live account received on the retired model.
const RETIRED_DETAIL = "Function '01327741-a1cb-4bdb-a31e-5391c8ca48c2': Not found for account 'umJDGCKdQZeA'";

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	configured.mockReturnValue(true);
	textToWorld.mockReset();
	status.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('/api/cosmos: submit failures never leak upstream detail', () => {
	it('answers a retired lane with 503 lane_unavailable and page-ready copy', async () => {
		textToWorld.mockRejectedValue(
			Object.assign(new Error(RETIRED_DETAIL), { code: 'lane_unavailable', status: 503, providerStatus: 404 }),
		);
		const res = await dispatch(makeReq({ body: { prompt: 'a neon tokyo street in the rain' } }));

		expect(res.status).toBe(503);
		expect(res.body.error).toBe('lane_unavailable');
		expect(res.body.message).toMatch(/offline right now/i);
		expect(JSON.stringify(res.body)).not.toContain('01327741');
		expect(JSON.stringify(res.body)).not.toContain('umJDGCKdQZeA');
	});

	it('maps an unclassified provider failure to 502 with generic copy', async () => {
		textToWorld.mockRejectedValue(Object.assign(new Error(RETIRED_DETAIL), { code: 'provider_error' }));
		const res = await dispatch(makeReq({ body: { prompt: 'a desert canyon at dusk' } }));

		expect(res.status).toBe(502);
		expect(res.body.error).toBe('provider_error');
		expect(res.body.message).not.toContain('Function');
	});

	it('keeps the retry hint on a rate limit', async () => {
		textToWorld.mockRejectedValue(
			Object.assign(new Error('slow down'), { code: 'rate_limited', retryAfter: 12 }),
		);
		const res = await dispatch(makeReq({ body: { prompt: 'a snowy mountain pass' } }));

		expect(res.status).toBe(429);
		expect(res.body.retry_after).toBe(12);
	});

	it('reports an unconfigured deployment as 503 without starting a job', async () => {
		configured.mockReturnValue(false);
		const res = await dispatch(makeReq({ body: { prompt: 'a bioluminescent forest' } }));

		expect(res.status).toBe(503);
		expect(res.body.error).toBe('unconfigured');
		expect(textToWorld).not.toHaveBeenCalled();
	});

	it('still rejects a too-short prompt before touching the provider', async () => {
		const res = await dispatch(makeReq({ body: { prompt: 'a' } }));
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_prompt');
		expect(textToWorld).not.toHaveBeenCalled();
	});

	it('hands back the job handle on an accepted submit', async () => {
		textToWorld.mockResolvedValue({ taskId: 'req-world-42' });
		const res = await dispatch(makeReq({ body: { prompt: 'a golden savanna at sunset', seed: 7 } }));

		expect(res.status).toBe(202);
		expect(res.body.job_id).toBe('req-world-42');
		expect(textToWorld).toHaveBeenCalledWith({ prompt: 'a golden savanna at sunset', seed: 7 });
	});
});

describe('/api/cosmos: the poll hands back status, never diagnostics', () => {
	const JOB = 'req-world-4242424242424242';

	it('blanks the provider error while the job is still running', async () => {
		status.mockResolvedValue({ status: 'running', error: 'NVIDIA Cosmos poll returned 500' });
		const res = await dispatch(makeReq({ method: 'GET', url: `/api/cosmos?job=${JOB}` }));

		expect(res.status).toBe(200);
		expect(res.body.status).toBe('running');
		expect(res.body.error).toBeNull();
	});

	it('replaces a failure detail with copy the page can render', async () => {
		status.mockResolvedValue({ status: 'failed', error: 'failed to persist video: bucket unreachable' });
		const res = await dispatch(makeReq({ method: 'GET', url: `/api/cosmos?job=${JOB}` }));

		expect(res.body.status).toBe('failed');
		expect(res.body.error).toMatch(/could not finish this world/i);
		expect(res.body.error).not.toContain('bucket');
	});

	it('returns the durable clip URL on completion', async () => {
		status.mockResolvedValue({ status: 'done', resultVideoUrl: 'https://three.ws/cdn/forge/cosmos/a.mp4' });
		const res = await dispatch(makeReq({ method: 'GET', url: `/api/cosmos?job=${JOB}` }));

		expect(res.body.status).toBe('done');
		expect(res.body.video_url).toBe('https://three.ws/cdn/forge/cosmos/a.mp4');
		expect(res.body.error).toBeNull();
	});

	it('rejects a malformed job id without calling the provider', async () => {
		const res = await dispatch(makeReq({ method: 'GET', url: '/api/cosmos?job=nope' }));
		expect(res.status).toBe(400);
		expect(status).not.toHaveBeenCalled();
	});
});
