// Agent Genome breeding endpoint — the security-critical invariants:
//   • ownership invariant: the child gets fresh wallets distinct from BOTH parents,
//     and neither parent row is mutated by a breed;
//   • idempotency: replaying a breeding key returns the same child, never twins;
//   • cooldown: a parent on cooldown can't be bred;
//   • cross-owner stud consent: a fee-bearing stud requires a $THREE settlement.
//
// DB + wallet + chain + storage are mocked at the module boundary so the test
// pins the handler's decisions, not infrastructure.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from './_helpers/monetization.js';

const A_ID = '11111111-1111-4111-8111-111111111111';
const B_ID = '22222222-2222-4222-8222-222222222222';
const CALLER = 'user-caller';
const OTHER = 'user-other';

const state = {
	session: { id: CALLER },
	rows: {},
	cooldown: { [A_ID]: 0, [B_ID]: 0 },
	sqlQueue: [],
	sqlCalls: [],
	wallets: { evm: '0xCHILDevm', solana: 'ChildSolana1111' },
};

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => state.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn(() => true),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		const query = Array.isArray(strings) ? strings.join('?') : String(strings);
		state.sqlCalls.push({ query, values });
		return state.sqlQueue.length ? state.sqlQueue.shift() : [];
	});
	sql.transaction = (qs) => Promise.all(qs);
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/agent-wallet.js', () => ({
	provisionAgentWallets: vi.fn(async () => state.wallets),
}));

vi.mock('../api/_lib/avatars.js', () => ({
	createAvatar: vi.fn(async () => ({ id: 'child-avatar' })),
	storageKeyFor: vi.fn(() => 'u/caller/child/x.glb'),
}));
vi.mock('../api/_lib/r2.js', () => ({
	copyObject: vi.fn(async () => true),
	headObject: vi.fn(async () => ({ size: 1 })),
}));
vi.mock('../api/_lib/bake.js', () => ({ bakeAndUploadAppearance: vi.fn(async () => null) }));
vi.mock('../api/_lib/webhook-dispatch.js', () => ({ dispatchWebhooks: vi.fn(async () => {}) }));
vi.mock('../api/_lib/usage.js', () => ({ recordEvent: vi.fn(() => {}) }));
vi.mock('../api/_lib/skill-license-onchain.js', () => ({
	minterKeypair: vi.fn(() => null), // not configured in test → grants recorded as deferred
	mintSkillLicenseOnchain: vi.fn(async () => ({ alreadyMinted: false, signature: 'sig' })),
}));

// Partial mock: keep the pure eligibility/genome logic real, override the two
// DB-touching loaders.
vi.mock('../api/_lib/genome-agent.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		loadBreedingAgent: vi.fn(async (id) => state.rows[id] || null),
		cooldownRemainingMs: vi.fn(async (id) => state.cooldown[id] || 0),
	};
});

const { default: breedHandler } = await import('../api/genome/breed.js');

function parentRow(id, ownerId, over = {}) {
	return {
		id,
		user_id: ownerId,
		name: `Parent ${id.slice(0, 4)}`,
		is_public: true,
		meta: { solana_address: `Sol-${id}`, wallet_address: `0xevm-${id}`, ...(over.meta || {}) },
		skills: over.skills || ['trading'],
		persona_tone_tags: ['precise'],
		voice_provider: 'elevenlabs',
		voice_id: `voice-${id}`,
		voice_model: 'eleven_flash_v2_5',
		voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
		avatar_id: null,
		avatar_storage_key: null,
		avatar_appearance: { morphs: { headScale: 0.8 }, colors: { hair: '#aa3311' } },
		...over,
	};
}

beforeEach(() => {
	state.session = { id: CALLER };
	state.rows = { [A_ID]: parentRow(A_ID, CALLER), [B_ID]: parentRow(B_ID, CALLER) };
	state.cooldown = { [A_ID]: 0, [B_ID]: 0 };
	state.sqlQueue = [];
	state.sqlCalls = [];
	state.wallets = { evm: '0xCHILDevm', solana: 'ChildSolana1111' };
});

const breed = (body) =>
	invoke(breedHandler, { method: 'POST', url: '/api/genome/breed', body: { parent_a: A_ID, parent_b: B_ID, ...body } });

describe('happy path — a real child is born', () => {
	it('mints a child with fresh wallets distinct from both parents', async () => {
		// Queue: replay-check (none), child insert, skill-grant meta update, breeding
		// insert. The breeding insert RETURNS the recorded row; an empty result there
		// means the breeding key lost a race and the handler retires the child.
		state.sqlQueue = [[], [{ id: 'child-agent' }], [], [{ child_agent_id: 'child-agent' }]];
		const { status, body } = await breed({ seed: 'deterministic-seed' });
		expect(status).toBe(201);
		expect(body.child.id).toBe('child-agent');
		expect(body.child.solana_address).toBe('ChildSolana1111');
		// Distinct from both parents.
		expect(body.child.solana_address).not.toBe('Sol-' + A_ID);
		expect(body.child.solana_address).not.toBe('Sol-' + B_ID);
		expect(body.child.wallet_address).not.toBe('0xevm-' + A_ID);
		expect(body.genome.generation).toBe(1);
		expect(body.genome_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(body.seed).toBe('deterministic-seed');
	});

	it('never issues an UPDATE/DELETE against a parent agent row', async () => {
		state.sqlQueue = [[], [{ id: 'child-agent' }], [], [{ child_agent_id: 'child-agent' }]];
		await breed({ seed: 's' });
		const mutatedParent = state.sqlCalls.some(
			(c) => /update|delete/i.test(c.query) && (c.values.includes(A_ID) || c.values.includes(B_ID)),
		);
		expect(mutatedParent).toBe(false);
	});

	it('aborts if the child wallet collides with a parent (invariant breach)', async () => {
		state.wallets = { evm: '0xevm-' + A_ID, solana: 'Sol-' + A_ID };
		state.sqlQueue = [[], [{ id: 'child-agent' }], [], []];
		const { status, body } = await breed({ seed: 's' });
		expect(status).toBe(500);
		expect(body.error).toBe('ownership_invariant_violation');
	});
});

describe('idempotency', () => {
	it('returns the existing child for a replayed breeding key', async () => {
		// First sql call (replay check) finds an existing child; then loadChildSummary.
		state.sqlQueue = [[{ child_agent_id: 'existing-child' }], [{ id: 'existing-child', name: 'Twinless', meta: {} }]];
		const { status, body } = await breed({ seed: 'same' });
		expect(status).toBe(200);
		expect(body.deduped).toBe(true);
		expect(body.child.id).toBe('existing-child');
	});
});

describe('cooldown', () => {
	it('refuses to breed a parent still on cooldown', async () => {
		state.cooldown[A_ID] = 60 * 60 * 1000;
		state.sqlQueue = [[]]; // replay check only — should bail before insert
		const { status, body } = await breed({ seed: 's' });
		expect(status).toBe(409);
		expect(body.error).toBe('breeding_cooldown');
		expect(body.cooldown_remaining_ms).toBeGreaterThan(0);
	});
});

describe('cross-owner stud consent', () => {
	it('402s when a fee-bearing stud has no $THREE settlement', async () => {
		state.rows[B_ID] = parentRow(B_ID, OTHER, { meta: { genome_breeding: { stud: true, stud_fee_three: 25 }, solana_address: `Sol-${B_ID}` } });
		state.sqlQueue = [[]];
		const { status, body } = await breed({ seed: 's' });
		expect(status).toBe(402);
		expect(body.error).toBe('stud_fee_required');
		expect(body.stud_fee_three).toBe(25);
		expect(body.coin).toBe('$THREE');
	});

	it('403s when a non-owned parent is not listed as a stud', async () => {
		state.rows[B_ID] = parentRow(B_ID, OTHER); // public but not a stud
		state.sqlQueue = [[]];
		const { status, body } = await breed({ seed: 's' });
		expect(status).toBe(403);
		expect(body.error).toBe('parent_ineligible');
	});
});

describe('validation', () => {
	it('rejects an agent breeding with itself', async () => {
		const { status } = await invoke(breedHandler, {
			method: 'POST',
			url: '/api/genome/breed',
			body: { parent_a: A_ID, parent_b: A_ID },
		});
		expect(status).toBe(400);
	});
});
