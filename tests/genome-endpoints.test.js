// Agent Genome read/marketplace endpoints: preview, lineage, stud, edges.
// breed.js has its own suite (genome-breed.test.js); these pin the rest of the
// surface: preview determinism + fee disclosure, the lineage tree + the public
// anti-forgery verify path, stud PATCH semantics + fee clamping + rarest-first
// listing, and the star-map edge feed. DB + auth are mocked at the module
// boundary so the tests pin handler decisions, not infrastructure.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from './_helpers/monetization.js';

const A_ID = '11111111-1111-4111-8111-111111111111';
const B_ID = '22222222-2222-4222-8222-222222222222';
const C_ID = '33333333-3333-4333-8333-333333333333';
const CALLER = 'user-caller';
const OTHER = 'user-other';

const state = {
	session: { id: CALLER },
	rows: {},
	sqlQueue: [],
	sqlCalls: [],
};

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => state.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn(() => true),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true })),
		authedReadIp: vi.fn(async () => ({ success: true })),
		genomeStudWrite: vi.fn(async () => ({ success: true })),
	},
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

// Partial mock: keep the pure eligibility/policy/genome logic real, override
// the DB-touching loader preview.js uses.
vi.mock('../api/_lib/genome-agent.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		loadBreedingAgent: vi.fn(async (id) => state.rows[id] || null),
	};
});

const { default: previewHandler } = await import('../api/genome/preview.js');
const { default: lineageHandler } = await import('../api/genome/lineage.js');
const { default: studHandler } = await import('../api/genome/stud.js');
const { default: edgesHandler } = await import('../api/genome/edges.js');
const { genomeFromAgent, deriveGenome } = await import('../api/_lib/genome.js');

function parentRow(id, ownerId, over = {}) {
	return {
		id,
		user_id: ownerId,
		name: `Parent ${id.slice(0, 4)}`,
		is_public: true,
		meta: { solana_address: `Sol-${id}`, ...(over.meta || {}) },
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

const founder = (id) =>
	genomeFromAgent({
		id,
		persona_tone_tags: ['precise'],
		voice_provider: 'elevenlabs',
		voice_id: `voice-${id}`,
		voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
		appearance: { morphs: { headScale: 0.8 }, colors: { hair: '#aa3311' } },
		skills: ['trading'],
		avatar_id: null,
		meta: {},
	});

// One tree-node row as loadNodes() selects it.
function nodeRow(id, over = {}) {
	return {
		id,
		name: `Agent ${id.slice(0, 4)}`,
		is_public: true,
		user_id: CALLER,
		avatar_id: null,
		meta: {},
		avatar_thumbnail_key: null,
		...over,
	};
}

beforeEach(() => {
	state.session = { id: CALLER };
	state.rows = { [A_ID]: parentRow(A_ID, CALLER), [B_ID]: parentRow(B_ID, CALLER) };
	state.sqlQueue = [];
	state.sqlCalls = [];
});

const preview = (body) =>
	invoke(previewHandler, { method: 'POST', url: '/api/genome/preview', body: { parent_a: A_ID, parent_b: B_ID, ...body } });

describe('preview', () => {
	it('401s without a session or bearer', async () => {
		state.session = null;
		const { status, body } = await preview({});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('rejects an agent previewing against itself', async () => {
		const { status, body } = await invoke(previewHandler, {
			method: 'POST',
			url: '/api/genome/preview',
			body: { parent_a: A_ID, parent_b: A_ID },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('404s when a parent does not exist', async () => {
		delete state.rows[B_ID];
		const { status } = await preview({});
		expect(status).toBe(404);
	});

	it('is deterministic: same seed previews the identical child, seed echoed', async () => {
		const one = await preview({ seed: 'preview-seed' });
		const two = await preview({ seed: 'preview-seed' });
		expect(one.status).toBe(200);
		expect(one.body.seed).toBe('preview-seed');
		expect(JSON.stringify(one.body.genome)).toBe(JSON.stringify(two.body.genome));
		expect(one.body.genome.generation).toBe(1);
		expect(one.body.stud_fee_three).toBe(0);
		expect(one.body.consent_required).toBe(false);
	});

	it('discloses the $THREE stud fee and consent for a cross-owner stud', async () => {
		state.rows[B_ID] = parentRow(B_ID, OTHER, {
			meta: { genome_breeding: { stud: true, stud_fee_three: 25 }, solana_address: `Sol-${B_ID}` },
		});
		const { status, body } = await preview({ seed: 's' });
		expect(status).toBe(200);
		expect(body.stud_fee_three).toBe(25);
		expect(body.consent_required).toBe(true);
		expect(body.parents.b.cross_owner).toBe(true);
	});
});

describe('lineage', () => {
	it('400s on a missing or malformed agentId', async () => {
		const bare = await invoke(lineageHandler, { method: 'GET', url: '/api/genome/lineage' });
		expect(bare.status).toBe(400);
		const junk = await invoke(lineageHandler, { method: 'GET', url: '/api/genome/lineage?agentId=not-a-uuid' });
		expect(junk.status).toBe(400);
	});

	it('404s for an unknown agent', async () => {
		state.sqlQueue = [[]];
		const { status } = await invoke(lineageHandler, { method: 'GET', url: `/api/genome/lineage?agentId=${C_ID}` });
		expect(status).toBe(404);
	});

	it('renders the full tree: parents, ancestors, bred flag, private masking', async () => {
		const genomeA = founder(A_ID);
		const genomeB = founder(B_ID);
		const child = deriveGenome({ parentA: genomeA, parentB: genomeB, seed: 'real' });
		const childRow = nodeRow(C_ID, { meta: { genome: child, bred_from: { seed: 'real' } } });
		const birth = {
			parent_a_agent_id: A_ID,
			parent_b_agent_id: B_ID,
			seed: 'real',
			genome_hash: child.genome_hash,
			generation: 1,
			pedigree_tier: 'common',
			created_at: '2026-08-01T00:00:00Z',
		};
		const parentsBatch = [nodeRow(A_ID), nodeRow(B_ID, { is_public: false })];
		state.sqlQueue = [
			[childRow], // loadNode
			[birth], // birth record
			[], // children
			parentsBatch, // parents + co-parents batch
			[{ child_agent_id: C_ID, parent_a_agent_id: A_ID, parent_b_agent_id: B_ID }], // ancestor walk depth 1
			parentsBatch, // ancestor nodes depth 1
			[], // ancestor walk depth 2 terminates
		];
		const { status, body } = await invoke(lineageHandler, { method: 'GET', url: `/api/genome/lineage?agentId=${C_ID}` });
		expect(status).toBe(200);
		expect(body.bred).toBe(true);
		expect(body.seed).toBe('real');
		expect(body.agent.generation).toBe(1);
		expect(body.parents.map((p) => p.id).sort()).toEqual([A_ID, B_ID]);
		expect(body.children).toEqual([]);
		expect(body.ancestors).toHaveLength(2);
		expect(body.ancestors.every((a) => a.depth === 1 && a.of === C_ID)).toBe(true);
		// A private parent reveals only that it exists.
		expect(body.parents.find((p) => p.id === B_ID).name).toBe('Private agent');
	});

	it('verify=1 confirms a genuinely derived child', async () => {
		const genomeA = founder(A_ID);
		const genomeB = founder(B_ID);
		const child = deriveGenome({ parentA: genomeA, parentB: genomeB, seed: 'real' });
		state.sqlQueue = [
			[nodeRow(C_ID, { meta: { genome: child, bred_from: { seed: 'real' } } })], // loadNode gate
			[
				{
					id: C_ID,
					name: 'Child',
					meta: {
						genome: child,
						bred_from: {
							seed: 'real',
							parent_a: { agent_id: A_ID, name: 'A', genome: genomeA },
							parent_b: { agent_id: B_ID, name: 'B', genome: genomeB },
						},
					},
					seed: 'real',
					genome_hash: child.genome_hash,
				},
			],
		];
		const { status, body } = await invoke(lineageHandler, {
			method: 'GET',
			url: `/api/genome/lineage?agentId=${C_ID}&verify=1`,
		});
		expect(status).toBe(200);
		expect(body.verifiable).toBe(true);
		expect(body.valid).toBe(true);
		expect(body.genome_hash).toBe(child.genome_hash);
	});

	it('verify=1 flags a forged child whose genome was not derived from its claimed parents', async () => {
		const genomeA = founder(A_ID);
		const genomeB = founder(B_ID);
		const child = deriveGenome({ parentA: genomeA, parentB: genomeB, seed: 'real' });
		const forged = { ...child, brain: { ...child.brain, boldness: 0.999 } };
		state.sqlQueue = [
			[nodeRow(C_ID, { meta: { genome: forged, bred_from: { seed: 'real' } } })], // loadNode gate
			[
				{
					id: C_ID,
					name: 'Forged',
					meta: {
						genome: forged,
						bred_from: {
							seed: 'real',
							parent_a: { agent_id: A_ID, name: 'A', genome: genomeA },
							parent_b: { agent_id: B_ID, name: 'B', genome: genomeB },
						},
					},
					seed: 'real',
					genome_hash: child.genome_hash,
				},
			],
		];
		const { body } = await invoke(lineageHandler, {
			method: 'GET',
			url: `/api/genome/lineage?agentId=${C_ID}&verify=1`,
		});
		expect(body.verifiable).toBe(true);
		expect(body.valid).toBe(false);
	});

	it('verify=0 is an explicit off switch, not a truthy string', async () => {
		state.sqlQueue = [[nodeRow(C_ID)], [], [], []];
		const { body } = await invoke(lineageHandler, {
			method: 'GET',
			url: `/api/genome/lineage?agentId=${C_ID}&verify=0`,
		});
		// The tree shape, not the verify shape.
		expect(body.verifiable).toBeUndefined();
		expect(body.agent.id).toBe(C_ID);
	});
});

describe('stud marketplace', () => {
	it('GET lists studs rarest-first and clamps a junk fee to 0', async () => {
		const genomeA = founder(A_ID);
		const genomeB = founder(B_ID);
		const deep = deriveGenome({ parentA: genomeA, parentB: genomeB, seed: 'deep' });
		state.sqlQueue = [
			[
				// Shallow founder listed first in the DB order to prove re-sorting.
				{ id: A_ID, name: 'Founder', avatar_id: null, meta: { genome_breeding: { stud: true, stud_fee_three: -3 } }, skills: ['trading'], avatar_thumbnail_key: null },
				{ id: C_ID, name: 'Deep', avatar_id: null, meta: { genome: deep, genome_breeding: { stud: true, stud_fee_three: 10 } }, skills: [], avatar_thumbnail_key: null },
			],
		];
		const { status, body } = await invoke(studHandler, { method: 'GET', url: '/api/genome/stud?limit=5' });
		expect(status).toBe(200);
		expect(body.studs).toHaveLength(2);
		expect(body.studs[0].id).toBe(C_ID);
		expect(body.studs[0].generation).toBe(1);
		expect(body.studs[0].pedigree.score).toBeGreaterThan(body.studs[1].pedigree.score);
		expect(body.studs.find((s) => s.id === A_ID).stud_fee_three).toBe(0);
	});

	it('POST 401s without a session', async () => {
		state.session = null;
		const { status } = await invoke(studHandler, {
			method: 'POST',
			url: '/api/genome/stud',
			body: { agent_id: A_ID, stud: true },
		});
		expect(status).toBe(401);
	});

	it('POST 400s on a malformed agent_id', async () => {
		const { status, body } = await invoke(studHandler, {
			method: 'POST',
			url: '/api/genome/stud',
			body: { agent_id: 'nope', stud: true },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('POST 403s when the caller does not own the agent', async () => {
		state.sqlQueue = [[{ id: A_ID, user_id: OTHER, meta: {} }]];
		const { status, body } = await invoke(studHandler, {
			method: 'POST',
			url: '/api/genome/stud',
			body: { agent_id: A_ID, stud: true },
		});
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});

	it('POST patches only the supplied fields: a fee-only body keeps stud + breedable', async () => {
		state.sqlQueue = [
			[{ id: A_ID, user_id: CALLER, meta: { genome_breeding: { breedable: false, stud: true, stud_fee_three: 40 } } }],
			[], // update
		];
		const { status, body } = await invoke(studHandler, {
			method: 'POST',
			url: '/api/genome/stud',
			body: { agent_id: A_ID, stud_fee_three: 10 },
		});
		expect(status).toBe(200);
		expect(body.genome_breeding).toEqual({ breedable: false, stud: true, stud_fee_three: 10 });
	});

	it('POST clamps the fee into [0, 1000000] $THREE', async () => {
		state.sqlQueue = [[{ id: A_ID, user_id: CALLER, meta: {} }], []];
		const low = await invoke(studHandler, {
			method: 'POST',
			url: '/api/genome/stud',
			body: { agent_id: A_ID, stud_fee_three: -5 },
		});
		expect(low.body.genome_breeding.stud_fee_three).toBe(0);
		state.sqlQueue = [[{ id: A_ID, user_id: CALLER, meta: {} }], []];
		const high = await invoke(studHandler, {
			method: 'POST',
			url: '/api/genome/stud',
			body: { agent_id: A_ID, stud_fee_three: 9e9 },
		});
		expect(high.body.genome_breeding.stud_fee_three).toBe(1_000_000);
	});
});

describe('edges', () => {
	it('maps breeding rows into star-map edges with a public cache header', async () => {
		state.sqlQueue = [
			[
				{ parent_a_agent_id: A_ID, parent_b_agent_id: B_ID, child_agent_id: C_ID, generation: 1, pedigree_tier: 'common' },
			],
		];
		const { status, body, res } = await invoke(edgesHandler, { method: 'GET', url: '/api/genome/edges?limit=5' });
		expect(status).toBe(200);
		expect(body.edges).toEqual([{ a: A_ID, b: B_ID, child: C_ID, generation: 1, tier: 'common' }]);
		expect(res.headers['cache-control']).toContain('s-maxage=60');
	});

	it('rejects non-GET methods', async () => {
		const { status } = await invoke(edgesHandler, { method: 'POST', url: '/api/genome/edges' });
		expect(status).toBe(405);
	});
});
