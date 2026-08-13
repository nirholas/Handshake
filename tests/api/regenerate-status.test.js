// Contract coverage for GET /api/avatars/regenerate-status, the endpoint a
// /scan or /create/selfie client polls from capture submission to a stored
// rigged GLB. The GPU worker fleet and database are stubbed at their module
// boundaries; the handler itself (auth, job lookup, provider poll, error
// masking, finalize dispatch) runs for real.
//
// What this pins, and why each case is the thing that breaks:
//
//   1. queued -> running -> done progression: a job the worker just finished
//      is finalized through finalizeReconstructStage and the client receives
//      the new avatar id, the terminal proof the capture became a model.
//   2. The input-error relay: the worker classifies a bad capture ("no face
//      detected") as error_kind 'input' whose copy is caller-facing by
//      contract; the endpoint must return that copy verbatim instead of
//      collapsing it into the generic retry message, or every user with a
//      faceless photo is told "try again" forever.
//   3. Internal failures stay masked: error_kind 'internal' (or absent)
//      collapses to neutral copy, since the raw value can carry a vendor name
//      or correlation id meant for operators only.
//   4. Ownership: another user's job id is a 404, not an oracle.
//   5. The rig chain: a job parked at 'rigging' polls its child rig job via
//      pollRiggingStage and reports the real post-call status.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

const state = {
	job: null,
	userId: 'u1',
	statusReturn: null,
	persisted: [],
};

function resetState() {
	state.job = null;
	state.userId = 'u1';
	state.statusReturn = null;
	state.persisted = [];
}

// Job lookup + the in-flight status persist update. Branching on query text,
// same pattern as the auto-rig SSRF suite.
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = (Array.isArray(strings) ? strings.join('?') : String(strings)).toLowerCase();
	if (text.includes('update avatar_regen_jobs')) {
		state.persisted.push({ status: values[0], result_glb_url: values[1], error: values[2], error_kind: values[3] });
		return [];
	}
	if (text.includes('from avatar_regen_jobs')) {
		return state.job ? [state.job] : [];
	}
	return [];
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => ({ id: state.userId }),
	authenticateBearer: async () => null,
	extractBearer: () => null,
	hasScope: () => true,
}));

const providerInstance = { status: vi.fn(async () => state.statusReturn) };
vi.mock('../../api/_lib/regen-provider.js', () => ({
	getRegenProvider: async () => ({ name: 'gcp', instance: providerInstance }),
	getRegenProviderForMode: async () => ({ name: 'gcp', instance: providerInstance }),
	getRegenProviderForJob: async () => ({ name: 'gcp', instance: providerInstance }),
	getRegenProviderByName: async () => ({ name: 'gcp', instance: providerInstance }),
	getRegenProviderCandidates: async () => [{ name: 'gcp', instance: providerInstance }],
	BYOK_REGEN_PROVIDERS: [],
}));

const finalizeReconstructStageMock = vi.fn(async () => ({ status: 'done', resultAvatarId: 'avatar-1' }));
const pollRiggingStageMock = vi.fn(async () => ({ status: 'rigging' }));
vi.mock('../../api/_lib/reconstruct-finalize.js', () => ({
	finalizeReconstructStage: (...a) => finalizeReconstructStageMock(...a),
	pollRiggingStage: (...a) => pollRiggingStageMock(...a),
}));
vi.mock('../../api/_lib/auto-rig.js', () => ({
	finalizeAutoRigStage: vi.fn(async () => ({ status: 'done', resultAvatarId: 'sib-1' })),
	rigInfoIsRigged: () => false,
}));

const { dispatch } = await import('../../api/avatars/_actions.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function poll(jobId) {
	const req = { method: 'GET', url: `/api/avatars/regenerate-status?jobId=${jobId}`, headers: {} };
	const res = makeRes();
	await dispatch('regenerate-status', req, res);
	return { statusCode: res.statusCode, body: JSON.parse(res._body) };
}

function baseJob(overrides = {}) {
	return {
		job_id: 'gcp-job-1',
		user_id: 'u1',
		status: 'running',
		result_avatar_id: null,
		result_glb_url: null,
		error: null,
		error_kind: null,
		provider: 'gcp',
		ext_job_id: 'ext-1',
		created_at: new Date().toISOString(),
		mode: 'reconstruct',
		params: {},
		source_avatar_id: null,
		...overrides,
	};
}

const VALID_GLB = 'https://storage.googleapis.com/three-ws-avatar-reconstructions/avatars/x.glb';

beforeEach(() => {
	vi.clearAllMocks();
	resetState();
});

describe('regenerate-status: capture-to-avatar poll contract', () => {
	it('finalizes a finished worker job and returns the new avatar id', async () => {
		state.job = baseJob();
		state.statusReturn = { status: 'done', resultGlbUrl: VALID_GLB };
		const { statusCode, body } = await poll('gcp-job-1');
		expect(statusCode).toBe(200);
		expect(body.status).toBe('done');
		expect(body.resultAvatarId).toBe('avatar-1');
		expect(finalizeReconstructStageMock).toHaveBeenCalledTimes(1);
		// The fresh worker verdict is persisted before finalize runs, so a
		// finalize crash still leaves the cron sweep a durable URL to resume from.
		expect(state.persisted[0]).toMatchObject({ status: 'done', result_glb_url: VALID_GLB });
	});

	it('relays a caller-facing input error verbatim instead of masking it', async () => {
		state.job = baseJob();
		state.statusReturn = {
			status: 'failed',
			error: 'no face detected in any of the provided photos',
			errorKind: 'input',
		};
		const { body } = await poll('gcp-job-1');
		expect(body.status).toBe('failed');
		expect(body.error).toBe('no face detected in any of the provided photos');
		expect(state.persisted[0]).toMatchObject({ status: 'failed', error_kind: 'input' });
	});

	it('masks an internal worker failure into neutral retry copy', async () => {
		state.job = baseJob();
		state.statusReturn = {
			status: 'failed',
			error: 'internal error (ref a73c09c9cb5b)',
			errorKind: 'internal',
		};
		const { body } = await poll('gcp-job-1');
		expect(body.status).toBe('failed');
		expect(body.error).toBeTruthy();
		expect(body.error).not.toContain('a73c09c9cb5b');
		expect(body.error).not.toContain('internal error');
	});

	it('never returns a raw stored provider error to the client', async () => {
		state.job = baseJob({ status: 'failed', error: 'Replicate API 402: account out of credits', error_kind: null });
		const { body } = await poll('gcp-job-1');
		expect(body.status).toBe('failed');
		expect(body.error).not.toContain('Replicate');
		expect(body.error).not.toContain('402');
	});

	it("returns 404 for another user's job id", async () => {
		state.job = baseJob({ user_id: 'someone-else' });
		state.userId = 'u1';
		// The lookup is user-scoped at the SQL layer; simulate the empty result.
		state.job = null;
		const { statusCode, body } = await poll('gcp-job-1');
		expect(statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('polls the child rig job for a job parked at rigging', async () => {
		state.job = baseJob({ status: 'rigging', params: { rig: { extJobId: 'rig-9', unriggedUrl: VALID_GLB, storageKey: 'k', slug: 's' } } });
		pollRiggingStageMock.mockResolvedValueOnce({ status: 'done', resultAvatarId: 'avatar-rigged' });
		const { body } = await poll('gcp-job-1');
		expect(pollRiggingStageMock).toHaveBeenCalledTimes(1);
		expect(body.status).toBe('done');
		expect(body.resultAvatarId).toBe('avatar-rigged');
	});

	it('keeps polling live for a job the worker is still running', async () => {
		state.job = baseJob({ status: 'queued' });
		state.statusReturn = { status: 'running' };
		const { body } = await poll('gcp-job-1');
		expect(body.status).toBe('running');
		expect(finalizeReconstructStageMock).not.toHaveBeenCalled();
		expect(state.persisted[0]).toMatchObject({ status: 'running' });
	});
});
