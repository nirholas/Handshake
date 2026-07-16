/**
 * Recovery tests for NVCF "request not found or expired" on the free NVIDIA
 * NIM poll path (api/forge.js pollNvidiaStatus).
 *
 * NVCF pexec results are consume-once: the first status GET after completion
 * takes the artifact and later GETs 404. In production this failed 53 of 134
 * nvidia jobs in one 36h window — overlapping polls raced each other, and
 * results that aged out of NVCF retention were lost outright. The poll layer
 * now recovers instead of dead-ending:
 *   • the upstream poll is single-flighted per task id (lock losers report
 *     running, never touch NVCF);
 *   • on a 404, a completion already materialized by a racing poll is
 *     returned as done;
 *   • otherwise the SAME generation is resubmitted once (the prompt lives on
 *     the creation row) and the old task id is aliased to the new one so the
 *     client's poll handle keeps working;
 *   • only when no recovery is possible does the failure surface.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		NVIDIA_API_KEY: 'test-nvidia-key',
		JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
	});
});

// ── shared cache: in-memory stand-ins for cacheGet/cacheSet/locks ────────────
const cacheStore = new Map();
const lockDenials = new Set(); // lock keys that acquireLock must refuse
const acquireLock = vi.fn(async (key) => !lockDenials.has(key));
const releaseLock = vi.fn(async () => {});
const cacheGet = vi.fn(async (key) => (cacheStore.has(key) ? cacheStore.get(key) : null));
const cacheSet = vi.fn(async (key, value) => {
	cacheStore.set(key, value);
});
vi.mock('../../api/_lib/cache.js', async (importActual) => {
	const actual = await importActual();
	return { ...actual, acquireLock, releaseLock, cacheGet, cacheSet };
});

// ── NVIDIA provider ──────────────────────────────────────────────────────────
const nvStatus = vi.fn();
const nvTextTo3d = vi.fn();
vi.mock('../../api/_providers/nvidia.js', () => ({
	createNvidiaProvider: () => ({ status: nvStatus, textTo3d: nvTextTo3d }),
}));

// ── forge store ──────────────────────────────────────────────────────────────
const findByJob = vi.fn();
const materializeCreation = vi.fn(async ({ glbUrl }) => ({
	id: 'creation-1',
	glbUrl,
	quality: null,
	compression: null,
}));
const markFailed = vi.fn(async () => {});
vi.mock('../../api/_lib/forge-store.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		findByJob,
		materializeCreation,
		markFailed,
		hashClient: () => 'client-hash',
		hashIp: () => 'ip-hash',
	};
});

vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: {
			...actual.limits,
			mcp3dStatus: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		},
		clientIp: () => '203.0.113.9',
	};
});

const { default: handler } = await import('../../api/forge.js');
const { encodeJobToken } = await import('../../api/_lib/forge-job-token.js');

const TASK_ID = 'nvcf-req-0001';
const EXPIRED = { status: 'failed', error: 'NVCF request not found or expired', code: 'nvcf_expired' };
const jobToken = () => encodeJobToken({ provider: 'nvidia', kind: 'text-to-3d', taskId: TASK_ID });

function makeReq(url) {
	return {
		method: 'GET',
		url,
		headers: { 'x-forge-client': 'tester' },
		on() {},
	};
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(body) {
			this.body = body ? JSON.parse(body) : null;
		},
	};
}

async function poll() {
	const res = makeRes();
	await handler(makeReq(`/api/forge?job=${encodeURIComponent(jobToken())}`), res);
	return res;
}

const baseRow = {
	id: 'creation-1',
	status: 'generating',
	glb_url: null,
	prompt: 'a small red toy robot',
	tier: 'standard',
	backend: 'nvidia',
	path: 'image',
};

beforeEach(() => {
	vi.clearAllMocks();
	cacheStore.clear();
	lockDenials.clear();
});

describe('NVCF expiry recovery on the nvidia poll path', () => {
	it('returns done when a racing poll already materialized the creation', async () => {
		nvStatus.mockResolvedValueOnce(EXPIRED);
		findByJob.mockResolvedValue({ ...baseRow, status: 'done', glb_url: 'https://cdn.example/done.glb' });

		const res = await poll();
		expect(res.body.status).toBe('done');
		expect(res.body.glb_url).toBe('https://cdn.example/done.glb');
		expect(markFailed).not.toHaveBeenCalled();
		expect(nvTextTo3d).not.toHaveBeenCalled();
	});

	it('resubmits the same generation once and aliases the new request id', async () => {
		nvStatus.mockResolvedValueOnce(EXPIRED);
		findByJob.mockResolvedValue({ ...baseRow });
		nvTextTo3d.mockResolvedValueOnce({ taskId: 'nvcf-req-0002' });

		const res = await poll();
		expect(res.body.status).toBe('running');
		expect(nvTextTo3d).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: baseRow.prompt }),
		);
		expect(cacheStore.get(`nvcf:alias:${TASK_ID}`)).toBe('nvcf-req-0002');
		expect(markFailed).not.toHaveBeenCalled();

		// The next poll for the ORIGINAL job handle must hit the aliased id.
		nvStatus.mockResolvedValueOnce({ status: 'done', resultGlbUrl: 'https://cdn.example/resub.glb' });
		const res2 = await poll();
		expect(nvStatus).toHaveBeenLastCalledWith({ taskId: 'nvcf-req-0002' });
		expect(res2.body.status).toBe('done');
	});

	it('completes inline when the resubmit finishes synchronously', async () => {
		nvStatus.mockResolvedValueOnce(EXPIRED);
		findByJob.mockResolvedValue({ ...baseRow });
		nvTextTo3d.mockResolvedValueOnce({ taskId: null, resultGlbUrl: 'https://cdn.example/sync.glb' });

		const res = await poll();
		expect(res.body.status).toBe('done');
		expect(res.body.glb_url).toBe('https://cdn.example/sync.glb');
		expect(markFailed).not.toHaveBeenCalled();
	});

	it('reports running (not failed) when another instance owns the resubmit', async () => {
		nvStatus.mockResolvedValueOnce(EXPIRED);
		findByJob.mockResolvedValue({ ...baseRow });
		lockDenials.add(`nvcf:resub:${TASK_ID}`);

		const res = await poll();
		expect(res.body.status).toBe('running');
		expect(nvTextTo3d).not.toHaveBeenCalled();
		expect(markFailed).not.toHaveBeenCalled();
	});

	it('single-flights the upstream poll: a lock loser never touches NVCF', async () => {
		lockDenials.add(`nvcf:poll-lock:${TASK_ID}`);

		const res = await poll();
		expect(res.body.status).toBe('running');
		expect(nvStatus).not.toHaveBeenCalled();
	});

	it('surfaces the failure only when no recovery is possible (no stored prompt)', async () => {
		nvStatus.mockResolvedValueOnce(EXPIRED);
		findByJob.mockResolvedValue(null);

		const res = await poll();
		expect(res.body.status).toBe('failed');
		expect(markFailed).toHaveBeenCalled();
		expect(nvTextTo3d).not.toHaveBeenCalled();
	});
});
