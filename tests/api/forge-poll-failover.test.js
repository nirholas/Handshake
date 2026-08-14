/**
 * Poll-time lane failover, end to end through the api/forge.js poll handler.
 *
 * tests/forge-failover.test.js pins the failover LIBRARY in isolation. What had
 * no coverage at all was the wiring in the poll handler: a job that dies on one
 * lane must be re-dispatched onto the next, bound to the ORIGINAL job id, and
 * reported as still running so the client's existing poll loop keeps working.
 * The two orderings that matter are only observable here:
 *
 *   · the successor is bound BEFORE status:"running" is returned, so a client is
 *     never told to keep polling a handle nothing can resolve;
 *   · `attempted` accumulates across hops, so the chain never re-picks a lane
 *     that already failed and cannot loop back onto the paid Replicate lane.
 *
 * Hop exhaustion is the other half: at MAX_FAILOVER_HOPS the job goes terminal
 * with retryable:true plus the lanes a fresh retry could still use, so the UI
 * offers an engine switch instead of a dead end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Set at module scope, not in beforeAll: the job handle below is signed while
// the module body evaluates, which happens before any hook runs.
Object.assign(process.env, {
	APP_ORIGIN: 'https://three.ws',
	JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
	// Three redispatchable lanes configured (two self-hosted GCP workers plus
	// the paid Replicate lane), so the chain has room to hop more than once and
	// the hop cap, not a lane shortage, is what ends it.
	MODEL_TRELLIS_URL: 'https://model-trellis.example.run.app',
	GCP_HUNYUAN3D_URL: 'https://hunyuan3d.example.run.app',
	GCP_RECONSTRUCTION_KEY: 'test-gcp-key',
	REPLICATE_API_TOKEN: 'test-replicate-token',
});

// The lane that owns the job reports a hard failure on every poll. Each submit
// mints a DISTINCT upstream id, exactly as a real worker does, so successive
// hops address different jobs instead of colliding on one id.
let submitSeq = 0;
vi.mock('../../api/_providers/gcp.js', () => ({
	createRegenProvider: () => ({
		submit: vi.fn(async () => ({ extJobId: `gcp-successor-${++submitSeq}` })),
		status: vi.fn(async () => ({ status: 'failed', error: 'worker OOM on the reconstruct step' })),
	}),
}));
vi.mock('../../api/_providers/replicate.js', () => ({
	createRegenProvider: () => ({
		submit: vi.fn(async () => ({ extJobId: `r8-pred-${++submitSeq}` })),
		status: vi.fn(async () => ({ status: 'failed', error: 'prediction failed' })),
	}),
}));

// Store: creation rows keyed by upstream job id, the way the real table is.
// This is what makes hop accumulation observable: each redispatch writes a row
// for its successor naming the NEW lane, so the next poll reads that lane as
// the one that just failed. A fixture that always reported the original lane
// would hide a failover chain re-picking a dead lane forever.
const ORIGINAL_TASK = 'gcp-original-task';
const BASE_ROW = {
	tier: 'standard',
	path: 'image',
	prompt: 'a knight',
	preview_image_url: 'https://cdn.example/ref.png',
	views_requested: 1,
	views_used: 1,
	multiview: false,
};
const rows = new Map();
const createCreation = vi.fn(async (args) => {
	rows.set(args.replicateJobId, { ...BASE_ROW, backend: args.backend });
	return `creation-${rows.size}`;
});
const markFailed = vi.fn(async () => {});
const markSupersededBy = vi.fn(async () => true);
vi.mock('../../api/_lib/forge-store.js', () => ({
	hashClient: (v) => `client:${v || 'anon'}`,
	hashIp: (v) => `ip:${v}`,
	createCreation: (...a) => createCreation(...a),
	materializeCreation: vi.fn(async ({ glbUrl }) => ({ id: 'creation-x', glbUrl })),
	markFailed: (...a) => markFailed(...a),
	markSupersededBy: (...a) => markSupersededBy(...a),
	findByJob: vi.fn(async ({ replicateJobId }) => rows.get(replicateJobId) ?? null),
}));

// Lane health is up for everything: lane SELECTION is not what this file tests.
vi.mock('../../api/_lib/forge-lane-health.js', () => ({
	laneHealthSnapshot: vi.fn(async () => ({ byId: {} })),
	markLaneUnhealthy: vi.fn(async () => {}),
}));

// The successor-chain store, in memory. bindJobSuccessor/resolveLiveJob keep
// their real semantics (one record per ORIGINAL id) so ordering is observable.
const chain = new Map();
const bindOrder = [];
vi.mock('../../api/_lib/forge-failover.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		resolveLiveJob: vi.fn(async (jobId) => chain.get(jobId) ?? null),
		bindJobSuccessor: vi.fn(async (jobId, record) => {
			bindOrder.push(`bind:${jobId}->${record.backend}#${record.hop}`);
			chain.set(jobId, { ...record });
			return true;
		}),
	};
});

vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: { ...actual.limits, mcp3dStatus: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })) },
		clientIp: () => '203.0.113.9',
	};
});

const { default: handler } = await import('../../api/forge.js');
const { encodeJobToken } = await import('../../api/_lib/forge-job-token.js');
const { MAX_FAILOVER_HOPS } = await import('../../api/_lib/forge-failover.js');

function makeReq(jobId) {
	return {
		method: 'GET',
		url: `/api/forge?job=${encodeURIComponent(jobId)}`,
		headers: { 'x-forge-client': 'tester' },
		on(event, cb) {
			if (event === 'end') cb();
		},
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

async function poll(jobId) {
	const res = makeRes();
	await handler(makeReq(jobId), res);
	return res;
}

const JOB = encodeJobToken({ provider: 'gcp', taskId: ORIGINAL_TASK });

beforeEach(() => {
	chain.clear();
	bindOrder.length = 0;
	rows.clear();
	// The original job's own row: submitted on the self-hosted TRELLIS lane.
	rows.set(ORIGINAL_TASK, { ...BASE_ROW, backend: 'trellis_selfhost' });
	submitSeq = 0;
	createCreation.mockClear();
	markFailed.mockClear();
	markSupersededBy.mockClear();
});

describe('poll-time failover: first hop', () => {
	it('reports running on the next lane instead of surfacing the failure', async () => {
		const res = await poll(JOB);

		expect(res.body.status).toBe('running');
		expect(res.body.job_id).toBe(JOB);
		expect(res.body.failover_from).toBe('trellis_selfhost');
		expect(res.body.backend).toBeTruthy();
		expect(res.body.backend).not.toBe('trellis_selfhost');
	});

	it('binds the successor to the ORIGINAL job id, so the client keeps its poll url', async () => {
		await poll(JOB);
		expect(chain.has(JOB)).toBe(true);
		expect(chain.get(JOB)).toMatchObject({ hop: 1, attempted: ['trellis_selfhost'] });
		expect(typeof chain.get(JOB).handle).toBe('string');
	});

	it('records the failure and writes a provenance row for the successor', async () => {
		await poll(JOB);
		expect(markFailed).toHaveBeenCalledTimes(1);
		expect(createCreation).toHaveBeenCalledTimes(1);
		// The failed attempt is linked to its successor once the chain is durable,
		// so the outcome ledger reads the hop as a recovery rather than a loss.
		expect(markSupersededBy).toHaveBeenCalledWith(
			expect.objectContaining({ replicateJobId: ORIGINAL_TASK, successorId: expect.any(String) }),
		);
		// The redispatch reconstructs from the single stored view, and says so.
		expect(createCreation.mock.calls[0][0]).toMatchObject({
			previewImageUrl: 'https://cdn.example/ref.png',
			viewsRequested: 1,
			viewsUsed: 1,
			multiview: false,
		});
	});

	it('binds the successor BEFORE reporting running', async () => {
		// Ordering is the whole point: reporting "running" first would hand the
		// client a handle that resolveLiveJob cannot chase yet.
		const res = await poll(JOB);
		expect(bindOrder).toEqual(['bind:' + JOB + '->' + res.body.backend + '#1']);
		expect(chain.get(JOB).backend).toBe(res.body.backend);
	});
});

describe('poll-time failover: hop accumulation and exhaustion', () => {
	it('never re-picks a lane that already failed, and stops at the hop cap', async () => {
		const lanes = [];
		let last = null;
		for (let i = 0; i < MAX_FAILOVER_HOPS + 1; i++) {
			last = await poll(JOB);
			if (last.body.status !== 'running') break;
			expect(lanes).not.toContain(last.body.backend);
			lanes.push(last.body.backend);
		}

		// Every hop tried a distinct lane, and the chain never exceeded the cap.
		expect(new Set(lanes).size).toBe(lanes.length);
		expect(lanes.length).toBeLessThanOrEqual(MAX_FAILOVER_HOPS);
		expect(chain.get(JOB)?.hop ?? 0).toBeLessThanOrEqual(MAX_FAILOVER_HOPS);
	});

	it('accumulates attempted lanes across hops', async () => {
		await poll(JOB);
		const firstAttempted = [...chain.get(JOB).attempted];
		const secondLane = chain.get(JOB).backend;

		await poll(JOB);
		const secondAttempted = chain.get(JOB).attempted;

		expect(firstAttempted).toEqual(['trellis_selfhost']);
		expect(secondAttempted).toContain('trellis_selfhost');
		expect(secondAttempted).toContain(secondLane);
		expect(secondAttempted.length).toBeGreaterThan(firstAttempted.length);
	});

	it('ends terminal-but-retryable once the lanes are exhausted', async () => {
		let res;
		for (let i = 0; i < MAX_FAILOVER_HOPS + 2; i++) {
			res = await poll(JOB);
			if (res.body.status === 'failed') break;
		}

		expect(res.body.status).toBe('failed');
		// Never a bare dead end: the error is masked to neutral copy and the
		// response names what a fresh retry could still use (or omits the
		// affordance entirely when nothing is left).
		expect(res.body.error).toBeTruthy();
		expect(res.body.error).not.toMatch(/OOM|worker/i);
		if (res.body.retryable) {
			expect(Array.isArray(res.body.retry_backends)).toBe(true);
			expect(res.body.retry_backends).not.toContain('trellis_selfhost');
		}
	});
});
