// Auto-rig spend / abuse / privacy / humanoid gates (api/_lib/auto-rig.js).
//
// Every gate must land BEFORE the paid rerig job is submitted: a denied
// rate limit, an ineligible plan, a non-humanoid prompt, or a private avatar
// without opt-in must all skip the submit AND leave no avatar_regen_jobs row.
// The whole module is mocked down to the in-memory limiter + a stubbed provider
// so the suite runs offline and never hits Replicate, Redis, R2, or a real DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { inspectGlb } from '../api/_lib/glb-inspect.js';
import { rigInfoIsRigged } from '../api/_lib/auto-rig.js';

// ── Controllable mocks ────────────────────────────────────────────────────────

// DB: branch on the query so the in-flight check, the eligibility user lookup,
// and the source_meta/job writes each return what the test sets.
const sqlState = { users: [], inFlight: [], calls: [] };
const sql = vi.fn(async (strings, ...vals) => {
	const q = Array.isArray(strings) ? strings.join('§') : String(strings);
	sqlState.calls.push({ q, vals });
	if (/from users/i.test(q)) return sqlState.users;
	if (/from avatar_regen_jobs/i.test(q)) return sqlState.inFlight; // the select; insert uses "into"
	return [];
});
vi.mock('../api/_lib/db.js', () => ({ sql: (...a) => sql(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// Provider: rerig-capable, with a spy on submit.
const submit = vi.fn(async () => ({ extJobId: 'ext-job-123' }));
vi.mock('../api/_lib/regen-provider.js', () => ({
	getRegenProvider: async () => ({
		name: 'replicate',
		instance: { supportsMode: (m) => m === 'rerig', submit },
	}),
	getRegenProviderForMode: async (mode) =>
		mode === 'rerig'
			? { name: 'replicate', instance: { supportsMode: (m) => m === 'rerig', submit } }
			: { name: 'none', instance: null },
}));

// In-memory limiter, each bucket independently togglable.
const limitState = { rig: true, rigDaily: true, rigGlobal: true };
const reset = () => Date.now() + 3_600_000;
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		rig: vi.fn(async () => ({ success: limitState.rig, reset: reset() })),
		rigDaily: vi.fn(async () => ({ success: limitState.rigDaily, reset: reset() })),
		rigGlobal: vi.fn(async () => ({ success: limitState.rigGlobal, reset: reset() })),
	},
}));

// R2: distinguish the public URL from the presigned URL so the privacy test can
// assert which one was handed to the provider.
const presignGet = vi.fn(async ({ key }) => `https://signed.test/${key}?sig=presigned`);
vi.mock('../api/_lib/r2.js', () => ({
	publicUrl: (key) => `https://cdn.test/${key}`,
	presignGet: (...a) => presignGet(...a),
	putObject: vi.fn(async () => {}),
}));

// storageKeyFor is only used by the finalize stage; stub it so the module loads
// without pulling the real avatars.js (DB-backed) graph.
vi.mock('../api/_lib/avatars.js', () => ({
	storageKeyFor: ({ userId, slug }) => `u/${userId}/${slug}.glb`,
	createAvatar: vi.fn(async () => ({ id: 'sibling-1', slug: 's', name: 'n' })),
}));

// Tier resolution without the Solana/price graph: a wallet → top tier, none → member.
vi.mock('../api/_lib/three-tier.js', () => ({
	resolveUserTier: async (u) => ({ tier: { level: u?.wallet_address ? 4 : 0 } }),
	TIERS: [
		{ level: 0, id: 'member' },
		{ level: 1, id: 'bronze' },
		{ level: 2, id: 'silver' },
		{ level: 3, id: 'gold' },
		{ level: 4, id: 'genesis' },
	],
}));

const { maybeAutoRigAvatar } = await import('../api/_lib/auto-rig.js');

function avatarRow(overrides = {}) {
	return {
		id: 'avatar-1',
		storage_key: 'u/user-1/avatar-1.glb',
		source_meta: {},
		visibility: 'public',
		...overrides,
	};
}

// The last source_meta written by a stampSourceMeta() merge update.
function lastStampedMeta() {
	for (let i = sqlState.calls.length - 1; i >= 0; i--) {
		const c = sqlState.calls[i];
		if (/update avatars/i.test(c.q) && /source_meta/i.test(c.q)) {
			try {
				return JSON.parse(c.vals[0]);
			} catch {
				return null;
			}
		}
	}
	return null;
}

function jobInserted() {
	return sqlState.calls.some((c) => /insert into avatar_regen_jobs/i.test(c.q));
}

beforeEach(() => {
	sql.mockClear();
	submit.mockClear();
	presignGet.mockClear();
	sqlState.users = [];
	sqlState.inFlight = [];
	sqlState.calls = [];
	limitState.rig = true;
	limitState.rigDaily = true;
	limitState.rigGlobal = true;
	delete process.env.AUTO_RIG_REQUIRE_TIER;
	delete process.env.AUTO_RIG_PRIVATE;
});

describe('maybeAutoRigAvatar — happy path', () => {
	it('submits a paid rig for a humanoid public avatar via the public CDN URL', async () => {
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow(),
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r.queued).toBe(true);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(submit.mock.calls[0][0].sourceUrl).toBe('https://cdn.test/u/user-1/avatar-1.glb');
		expect(jobInserted()).toBe(true);
		expect(lastStampedMeta()).toMatchObject({ rig_mesh_sent_external: true, rig_mesh_url_kind: 'public' });
	});

	it('proceeds with no prompt and leaves a no_prompt breadcrumb', async () => {
		const r = await maybeAutoRigAvatar({ userId: 'user-1', avatar: avatarRow(), rigInfo: { is_rigged: false } });
		expect(r.queued).toBe(true);
		expect(submit).toHaveBeenCalledTimes(1);
		// The no-prompt breadcrumb is stamped before submit; the external stamp after.
		const stamped = sqlState.calls
			.filter((c) => /update avatars/i.test(c.q) && /source_meta/i.test(c.q))
			.map((c) => JSON.parse(c.vals[0]));
		expect(stamped.some((m) => m.auto_rig_humanoid_check === 'no_prompt')).toBe(true);
	});

	it('skips an already-rigged avatar without submitting', async () => {
		const r = await maybeAutoRigAvatar({ userId: 'user-1', avatar: avatarRow(), rigInfo: { is_rigged: true } });
		expect(r).toEqual({ queued: false, skipped: 'already_rigged' });
		expect(submit).not.toHaveBeenCalled();
	});
});

describe('maybeAutoRigAvatar — rate limits', () => {
	const cases = [
		['rig', 'rate_limited'],
		['rigDaily', 'daily_cap'],
		['rigGlobal', 'global_cap'],
	];
	for (const [bucket, reason] of cases) {
		it(`denies on ${bucket} → ${reason}, no submit, no job row`, async () => {
			limitState[bucket] = false;
			const r = await maybeAutoRigAvatar({
				userId: 'user-1',
				avatar: avatarRow(),
				rigInfo: { is_rigged: false },
				prompt: 'a cartoon astronaut',
			});
			expect(r).toEqual({ queued: false, skipped: reason });
			expect(submit).not.toHaveBeenCalled();
			expect(jobInserted()).toBe(false);
		});
	}
});

describe('maybeAutoRigAvatar — plan / tier gate', () => {
	it('passes an authenticated owner under the default (open) policy', async () => {
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow(),
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r.queued).toBe(true);
	});

	it('blocks a user who lacks the required tier (no wallet, free plan)', async () => {
		process.env.AUTO_RIG_REQUIRE_TIER = 'silver';
		sqlState.users = [{ plan: 'free', wallet_address: null }];
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow(),
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r).toEqual({ queued: false, skipped: 'plan_gate' });
		expect(submit).not.toHaveBeenCalled();
	});

	it('lets a $THREE holder through the required tier', async () => {
		process.env.AUTO_RIG_REQUIRE_TIER = 'silver';
		sqlState.users = [{ plan: 'free', wallet_address: 'So1anaWa11etAddress1111111111111111111111111' }];
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow(),
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r.queued).toBe(true);
	});
});

describe('maybeAutoRigAvatar — humanoid gate', () => {
	it('skips a confident non-humanoid prompt and records the reason', async () => {
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow(),
			rigInfo: { is_rigged: false },
			prompt: 'an oak dining table',
		});
		expect(r).toEqual({ queued: false, skipped: 'not_humanoid' });
		expect(submit).not.toHaveBeenCalled();
		expect(jobInserted()).toBe(false);
		const meta = lastStampedMeta();
		expect(meta.auto_rig_skipped).toBe('not_humanoid');
		expect(typeof meta.auto_rig_skip_reason).toBe('string');
	});

	it('proceeds for an ambiguous / clearly-humanoid prompt', async () => {
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow(),
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r.queued).toBe(true);
		expect(submit).toHaveBeenCalledTimes(1);
	});
});

describe('maybeAutoRigAvatar — privacy', () => {
	it('does not send a private avatar externally without opt-in', async () => {
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow({ visibility: 'private' }),
			visibility: 'private',
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r).toEqual({ queued: false, skipped: 'private_opt_out' });
		expect(submit).not.toHaveBeenCalled();
		expect(presignGet).not.toHaveBeenCalled();
		expect(jobInserted()).toBe(false);
	});

	it('with AUTO_RIG_PRIVATE=presigned, hands a short-lived presigned URL', async () => {
		process.env.AUTO_RIG_PRIVATE = 'presigned';
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow({ visibility: 'private' }),
			visibility: 'private',
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r.queued).toBe(true);
		expect(presignGet).toHaveBeenCalledWith({ key: 'u/user-1/avatar-1.glb', expiresIn: 3600 });
		expect(submit.mock.calls[0][0].sourceUrl).toBe('https://signed.test/u/user-1/avatar-1.glb?sig=presigned');
		expect(submit.mock.calls[0][0].sourceUrl).not.toContain('cdn.test');
		expect(lastStampedMeta()).toMatchObject({ rig_mesh_sent_external: true, rig_mesh_url_kind: 'presigned' });
	});

	it('keeps using the public URL for an unlisted avatar', async () => {
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow({ visibility: 'unlisted' }),
			visibility: 'unlisted',
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r.queued).toBe(true);
		expect(submit.mock.calls[0][0].sourceUrl).toBe('https://cdn.test/u/user-1/avatar-1.glb');
		expect(lastStampedMeta()).toMatchObject({ rig_mesh_url_kind: 'public' });
	});
});

describe('maybeAutoRigAvatar — in-flight idempotency consumes no budget', () => {
	it('skips without submitting when a rig job is already in flight', async () => {
		sqlState.inFlight = [{ '1': 1 }];
		const r = await maybeAutoRigAvatar({
			userId: 'user-1',
			avatar: avatarRow(),
			rigInfo: { is_rigged: false },
			prompt: 'a cartoon astronaut',
		});
		expect(r).toEqual({ queued: false, skipped: 'already_in_flight' });
		expect(submit).not.toHaveBeenCalled();
	});
});

// Requirement 8: the from-forge rig decision must come from server-side
// inspectGlb, never the client `rigged` body flag. Build real fixtures and prove
// the derived rigInfo (the exact expression from-forge passes) follows the GLB.
describe('from-forge rig decision derives from inspectGlb, not the client flag', () => {
	// Minimal valid GLB with a JSON chunk we control (same construction the
	// glb-inspect suite uses) so inspectGlb runs against real bytes.
	function makeGlb(gltfJson) {
		const jsonText = JSON.stringify(gltfJson);
		const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
		const jsonBytes = Buffer.from(padded, 'utf8');
		const total = 12 + 8 + jsonBytes.length;
		const buf = Buffer.alloc(total);
		buf.writeUInt32LE(0x46546c67, 0); // 'glTF'
		buf.writeUInt32LE(2, 4);
		buf.writeUInt32LE(total, 8);
		buf.writeUInt32LE(jsonBytes.length, 12);
		buf.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
		jsonBytes.copy(buf, 20);
		return buf;
	}

	const riggedGlb = makeGlb({
		asset: { version: '2.0' },
		skins: [{ joints: [0, 1, 2] }],
		nodes: [{ name: 'hips' }, { name: 'spine' }, { name: 'head' }],
		meshes: [{ name: 'body' }],
	});
	const staticGlb = makeGlb({
		asset: { version: '2.0' },
		nodes: [{ name: 'root' }],
		meshes: [{ name: 'body' }],
	});

	// The exact derivation api/avatars/from-forge.js feeds to maybeAutoRigAvatar.
	const rigInfoFromGlb = (buf) => {
		const info = inspectGlb(buf) || {};
		return { is_rigged: info.isRigged === true, skeleton_joint_count: info.skeletonJointCount ?? null };
	};

	it('client rigged:true on a static GLB still rigs (server inspection wins)', () => {
		const rigInfo = rigInfoFromGlb(staticGlb);
		expect(rigInfo.is_rigged).toBe(false);
		expect(rigInfoIsRigged(rigInfo)).toBe(false); // → maybeAutoRigAvatar would proceed to rig
	});

	it('client rigged:false on a skinned GLB is treated as already-rigged', () => {
		const rigInfo = rigInfoFromGlb(riggedGlb);
		expect(rigInfo.is_rigged).toBe(true);
		expect(rigInfo.skeleton_joint_count).toBe(3);
		expect(rigInfoIsRigged(rigInfo)).toBe(true); // → maybeAutoRigAvatar skips (already_rigged)
	});
});
