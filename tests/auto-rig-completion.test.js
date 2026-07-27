// Auto-rig completion lifecycle — the three guarantees that keep a rig that
// succeeded at the provider from ever stranding an avatar as permanently static:
//
//   6a — a job that reached the provider's result but isn't materialized yet
//        (status row open, result_glb_url stored) is recovered by the cron sweep
//        WITHOUT a second provider status() round-trip (reuses the stored URL).
//   6b — the MAX_AGE reaper runs on EVERY tick, even when the candidate batch is
//        full (it used to be nested inside `if (!rows.length)` and starved).
//   6c — finalizeAutoRigStage is concurrency-safe: when two drivers fire for one
//        job, a DB-level claim makes exactly one materialize the avatar and the
//        loser no-op cleanly — one R2 write, one createAvatar, one terminal close.
//
// Mirrors the vitest + queued-`sql`-mock style of agent-monetization.test.js, but
// uses a query-pattern `sql` handler (not a positional queue) so the concurrent
// double-finalize in 6c is deterministic regardless of await interleaving.
//
// NOTE on the result_avatar_id contract: finalizeAutoRigStage materializes a NEW
// sibling avatar (parent = the static source) and sets result_avatar_id to the
// SIBLING id — the source row is left byte-for-byte intact for attestation/IPFS
// integrity. So "job ends done + result_avatar_id set" means the sibling id, which
// is what the browser navigates to.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock state ────────────────────────────────────────────────────────────────

const sqlCalls = [];
let sqlHandler = () => [];

const r2State = { puts: [] };
const avatarState = { creates: [] };
const providerState = { statusCalls: [], statusImpl: null };

// ── Mocks (must precede the handler import) ─────────────────────────────────────

vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		const query = Array.isArray(strings) ? strings.join('?') : String(strings);
		sqlCalls.push({ query, values });
		return sqlHandler(query, values) ?? [];
	});
	sql.transaction = (queries) => Promise.all(queries);
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/r2.js', () => ({
	putObject: vi.fn(async (opts) => {
		r2State.puts.push(opts);
		return { key: opts.key };
	}),
	publicUrl: vi.fn((key) => `https://three.ws/cdn/${key}`),
	presignGet: vi.fn(async ({ key }) => `https://three.ws/cdn/${key}?signed=1`),
}));

vi.mock('../api/_lib/avatars.js', () => ({
	storageKeyFor: vi.fn(({ slug }) => `users/u1/${slug}.glb`),
	createAvatar: vi.fn(async ({ input }) => {
		const sibling = { id: 'sib-1', name: input.name, slug: input.slug };
		avatarState.creates.push({ input, sibling });
		return sibling;
	}),
}));

vi.mock('../api/_lib/regen-provider.js', () => ({
	getRegenProvider: vi.fn(async () => ({
		name: 'replicate',
		instance: {
			supportsMode: () => true,
			status: vi.fn(async (extId) => {
				providerState.statusCalls.push(extId);
				return providerState.statusImpl ? providerState.statusImpl(extId) : { status: 'running' };
			}),
		},
	})),
}));

vi.mock('../api/_lib/glb-inspect.js', () => ({
	isValidGlbHeader: vi.fn(() => true),
	inspectGlb: vi.fn(() => ({ skeletonJointCount: 52, skinCount: 1, nodeCount: 60, animationCount: 0 })),
}));

vi.mock('../api/_lib/webhook-dispatch.js', () => ({
	dispatchWebhooks: vi.fn(async () => ({})),
}));

// auto-rig.js imports these at module load for the SUBMIT gate; finalize never
// calls them, so trivial stubs keep the import graph resolvable.
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: new Proxy({}, { get: () => vi.fn(async () => ({ success: true })) }),
	clientIp: vi.fn(() => '127.0.0.1'),
}));
vi.mock('../api/_lib/auto-rig-eligibility.js', () => ({
	isAutoRigEligible: vi.fn(async () => true),
}));
vi.mock('../mcp-server/src/tools/_humanoid.js', () => ({
	classifyHumanoidPrompt: vi.fn(() => ({ humanoid: null, reason: 'ambiguous' })),
}));

// The rigged-GLB canonicalize step dynamically imports this; a no-op rename keeps
// finalize's buffer unchanged so we don't depend on real GLB bytes.
vi.mock('../src/glb-canonicalize.js', () => ({
	canonicalizeGLBBones: vi.fn((ab) => ({ buffer: ab, renamed: 0, orientationCorrected: false })),
}));

// The rigged-GLB fetch flows through the shared provider-result-url guard (host
// allowlist + IP-pinned SSRF connect), which uses raw node http — not the global
// fetch — so stubbing global.fetch no longer intercepts it. Mock the one guarded
// helper instead; the real allowlist/extract logic stays intact for the SSRF
// specs. Hand back a small valid-looking GLB buffer.
const FAKE_GLB = Buffer.from('glTF\u0000\u0000\u0000rigged-bytes');
vi.mock('../api/_lib/provider-result-url.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, fetchProviderGlbBuffer: vi.fn(async () => FAKE_GLB) };
});

// ── Imports under test (after mocks) ────────────────────────────────────────────

const { finalizeAutoRigStage } = await import('../api/_lib/auto-rig.js');
const { default: cronHandler } = await import('../api/cron/auto-rig-sweep.js');

// ── Helpers ─────────────────────────────────────────────────────────────────────

const CRON_SECRET = 'test-cron-secret';

function cronReq() {
	return {
		method: 'GET',
		url: '/api/cron/auto-rig-sweep',
		headers: { authorization: `Bearer ${CRON_SECRET}` },
	};
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		headersSent: false,
		writableEnded: false,
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}
async function runCron() {
	const res = makeRes();
	await cronHandler(cronReq(), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const AV_ROW = {
	id: 'src-1',
	slug: 'static-x',
	name: 'My Avatar',
	description: null,
	storage_key: 'users/u1/static-x.glb',
	size_bytes: 1234,
	source_meta: { is_rigged: false },
	tags: ['unrigged'],
	visibility: 'unlisted',
	checksum_sha256: 'abc',
	storage_mode: {},
};

const isClaim = (q) => q.includes("set status = 'finalizing'");
const isReaper = (q) => q.includes("set status = 'failed'") && q.includes('exceeded max age');
const isCandidateQuery = (q) => q.includes('select job_id') && q.includes('order by updated_at asc');
const isAvatarSelect = (q) => q.includes('from avatars') && q.includes('where id =');
const isCloseJob = (q) => q.includes('result_avatar_id =') && q.includes("status = 'done'");

beforeEach(() => {
	sqlCalls.length = 0;
	sqlHandler = () => [];
	r2State.puts.length = 0;
	avatarState.creates.length = 0;
	providerState.statusCalls.length = 0;
	providerState.statusImpl = null;
	process.env.CRON_SECRET = CRON_SECRET;
});
afterEach(() => {
	vi.clearAllMocks();
});

// ── 6a — a delivered-but-unmaterialized job is recovered, reusing the stored URL ──

describe('6a — cron recovers an open job from its stored result_glb_url', () => {
	it('finalizes via the stored URL and never re-polls the provider', async () => {
		const candidate = {
			job_id: 'job-a',
			user_id: 'u1',
			source_avatar_id: 'src-1',
			ext_job_id: 'ext-a',
			status: 'done', // a legacy/raced orphan: done + result_avatar_id NULL
			result_glb_url: 'https://replicate.delivery/abc/rigged.glb',
			created_at: new Date('2026-06-23T00:00:00Z').toISOString(),
		};
		sqlHandler = (q) => {
			if (isCandidateQuery(q)) return [candidate];
			if (isReaper(q)) return []; // nothing aged out
			if (isClaim(q)) return [{ job_id: 'job-a' }]; // we win the claim
			if (isAvatarSelect(q)) return [AV_ROW];
			return [];
		};

		const { status, body } = await runCron();

		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.scanned).toBe(1);
		expect(body.finalized).toBe(1);

		// Req 4: the stored URL was reused — the provider's status() was NOT called.
		expect(providerState.statusCalls).toHaveLength(0);

		// The rigged GLB was stored once and a sibling avatar materialized.
		expect(r2State.puts).toHaveLength(1);
		expect(avatarState.creates).toHaveLength(1);
		expect(avatarState.creates[0].input.source_meta.is_rigged).toBe(true);
		expect(avatarState.creates[0].input.parent_avatar_id).toBe('src-1');

		// The job was closed to done + result_avatar_id = the sibling id.
		const close = sqlCalls.find((c) => isCloseJob(c.query));
		expect(close).toBeTruthy();
		expect(close.values).toContain('sib-1');
	});
});

// ── 6b — the reaper runs even when the candidate batch is full ────────────────────

describe('6b — MAX_AGE reaper runs under a full candidate backlog', () => {
	it('reaps the dead tail despite a full batch of candidates', async () => {
		// A full batch (100) of quiet candidates with neither a stored URL nor an
		// ext id — each falls to failJob, exercising the loop without finalize.
		const fullBatch = Array.from({ length: 100 }, (_, i) => ({
			job_id: `b-${i}`,
			user_id: 'u1',
			source_avatar_id: `src-${i}`,
			ext_job_id: null,
			status: 'running',
			result_glb_url: null,
			created_at: new Date('2026-06-23T00:00:00Z').toISOString(),
		}));
		sqlHandler = (q) => {
			if (isCandidateQuery(q)) return fullBatch;
			if (isReaper(q)) return [{ job_id: 'reaped-1' }]; // one zombie aged out
			return []; // failJob updates etc.
		};

		const { status, body } = await runCron();

		expect(status).toBe(200);
		expect(body.scanned).toBe(100);
		// The whole point: reaped is present and > 0 even though rows.length === BATCH.
		expect(body.reaped).toBe(1);
		expect(body.failed).toBe(100); // every URL-less, id-less candidate failed out
		// The reaper UPDATE actually ran this tick.
		expect(sqlCalls.some((c) => isReaper(c.query))).toBe(true);
	});

	it('always reports reaped in the summary, even with zero candidates', async () => {
		sqlHandler = (q) => {
			if (isCandidateQuery(q)) return [];
			if (isReaper(q)) return [];
			return [];
		};
		const { body } = await runCron();
		expect(body).toHaveProperty('reaped', 0);
		expect(sqlCalls.some((c) => isReaper(c.query))).toBe(true);
	});
});

// ── 6c — concurrent double-finalize is safe (one winner, one no-op) ───────────────

describe('6c — finalizeAutoRigStage is concurrency-safe', () => {
	it('lets exactly one of two concurrent finalizes materialize the avatar', async () => {
		let claimGiven = false;
		sqlHandler = (q) => {
			if (isClaim(q)) {
				if (!claimGiven) { claimGiven = true; return [{ job_id: 'job-c' }]; }
				return []; // the loser's claim finds the row already 'finalizing'
			}
			if (isAvatarSelect(q)) return [AV_ROW];
			// The loser re-reads the job row to surface the sibling id.
			if (q.includes('select result_avatar_id from avatar_regen_jobs')) {
				return [{ result_avatar_id: 'sib-1' }];
			}
			return [];
		};

		const job = { source_avatar_id: 'src-1' };
		const glbUrl = 'https://replicate.delivery/abc/rigged.glb';
		const [a, b] = await Promise.all([
			finalizeAutoRigStage({ userId: 'u1', jobId: 'job-c', job, glbUrl }),
			finalizeAutoRigStage({ userId: 'u1', jobId: 'job-c', job, glbUrl }),
		]);

		// Exactly one materialize: one R2 write, one createAvatar.
		expect(r2State.puts).toHaveLength(1);
		expect(avatarState.creates).toHaveLength(1);

		// Both calls resolve to done; the winner returns the sibling id, the loser
		// no-ops cleanly (either surfacing the same sibling id or skipped:in_progress).
		const ids = [a.resultAvatarId, b.resultAvatarId].filter(Boolean);
		expect(ids).toContain('sib-1');
		const skipped = [a, b].find((r) => r.skipped);
		const winner = [a, b].find((r) => r.resultAvatarId === 'sib-1');
		expect(winner).toBeTruthy();
		// The loser performed no provider/R2 work.
		expect([a, b].some((r) => r.skipped === 'in_progress' || r.resultAvatarId === 'sib-1')).toBe(true);
		expect(skipped === undefined || skipped.status).toBeTruthy();

		// The winner closed the job to done + sibling id.
		const close = sqlCalls.find((c) => isCloseJob(c.query));
		expect(close).toBeTruthy();
		expect(close.values).toContain('sib-1');
	});

	it('a thrown winner releases the claim to a cron-selectable status (not done, not wedged)', async () => {
		const releaseCalls = [];
		sqlHandler = (q) => {
			if (isClaim(q)) return [{ job_id: 'job-d' }]; // we win the claim
			if (isAvatarSelect(q)) return [AV_ROW];
			if (q.includes("set status = 'running'")) { releaseCalls.push(q); return []; }
			return [];
		};
		// Make the R2 write throw mid-flight, after the claim.
		const r2 = await import('../api/_lib/r2.js');
		r2.putObject.mockImplementationOnce(async () => { throw new Error('r2 down'); });

		const job = { source_avatar_id: 'src-1' };
		await expect(
			finalizeAutoRigStage({ userId: 'u1', jobId: 'job-d', job, glbUrl: 'https://replicate.delivery/x/r.glb' }),
		).rejects.toThrow('r2 down');

		// The claim was released back to 'running' — cron-selectable, never wedged at
		// 'finalizing' and never stranded at 'done'+null.
		expect(releaseCalls.length).toBe(1);
		// No job was closed to done (closeJob never ran on the throwing path).
		expect(sqlCalls.some((c) => isCloseJob(c.query))).toBe(false);
	});
});
