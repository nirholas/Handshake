/**
 * Agora economy read model (api/agora/[action].js) — shapes + empty/error paths.
 *
 * The 3D Commons and every dashboard read this endpoint, so its contract matters:
 * an unknown action 404s, a non-GET 405s, a rate-limit 429s, an empty economy
 * returns an HONEST empty state (never fabricated citizens), the board degrades
 * gracefully when the x402 bazaar is down (200 + errors[], AgenC tasks still
 * render), and the passport validates its selector / 404s an unknown citizen.
 *
 * We drive the REAL wrapped handler and mock only the I/O boundary — the DB
 * (a query-aware fake `sql`, same approach as tests/launcher-engine.test.js), the
 * x402 Bazaar, the rate limiter, and the on-chain SDK — so no mock ships in app
 * code and the handler's own shaping/branching runs unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
	citizens: [],
	openTasks: [],
	pop: [{ total: 0, agents: 0, humans: 0, active_24h: 0 }],
	prof: [],
	status: [],
	flow: [{ three_atomic: '0', payouts: 0 }],
	completed: [{ n: 0 }],
	recent: [],
	topEarners: [],
	passportRow: undefined, // undefined ⇒ not found
	activity: [],
	bazaarItems: [],
	bazaarThrows: false,
	rlSuccess: true,
}));

// Query-aware fake `sql`: route by the joined template text, ignore interpolated
// values (fragments compose in as opaque objects). Mirrors launcher-engine.test.
vi.mock('../api/_lib/db.js', () => {
	const sql = (strings, ...vals) => {
		if (!Array.isArray(strings)) return { __frag: true };
		const q = strings.join(' ').toLowerCase();
		let rows = [];
		if (q.includes('as three_atomic')) rows = H.flow;
		else if (q.includes('as total')) rows = H.pop;
		else if (q.includes('group by profession')) rows = H.prof;
		else if (q.includes('group by status')) rows = H.status;
		else if (q.includes("'completed_task'") && q.includes('count(')) rows = H.completed;
		else if (q.includes('earned_three_atomic > 0')) rows = H.topEarners;
		else if (q.includes('from agora_activity') && q.includes('citizen_id =')) rows = H.activity;
		// The board's open lane filters on `a.kind in ('posted_task', 'hired')`, so the
		// 'posted_task' literal identifies it precisely. Match that BEFORE the pulse
		// `recent` query (which also selects a.task_pda + joins agora_citizens) so the
		// two don't collide.
		else if (q.includes('from agora_activity') && q.includes("'posted_task'")) rows = H.openTasks;
		else if (q.includes('order by a.created_at desc') && q.includes('join agora_citizens')) rows = H.recent;
		else if (q.includes('from agora_citizens where id')) rows = H.passportRow === undefined ? [] : [H.passportRow];
		else if (q.includes('from agora_citizens where agenc_agent_pda')) rows = H.passportRow === undefined ? [] : [H.passportRow];
		else if (q.includes('from agora_citizens where agenc_agent_id')) rows = H.passportRow === undefined ? [] : [H.passportRow];
		else if (q.includes('from agora_citizens')) rows = H.citizens;
		return Promise.resolve(rows);
	};
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => false, drain: async () => {} }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '1.2.3.4',
	limits: { publicIp: async () => ({ success: H.rlSuccess, limit: 60, remaining: 0, reset: Date.now() + 1000 }) },
}));
vi.mock('../api/_lib/x402/bazaar-client.js', () => ({
	Bazaar: class {
		async list() {
			if (H.bazaarThrows) throw new Error('bazaar_unavailable');
			return { items: H.bazaarItems, errors: [] };
		}
	},
	filterByNetwork: (items) => items,
	filterByMaxPrice: (items) => items,
}));
vi.mock('@tetsuo-ai/sdk', () => ({ getAgent: async () => null }));

import handler from '../api/agora/[action].js';

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; },
		get headersSent() { return this.ended; },
		get writableEnded() { return this.ended; },
	};
}

async function call(action, { method = 'GET', query = {} } = {}) {
	const req = { method, url: `/api/agora/${action}`, headers: {}, query: { action, ...query } };
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res };
}

beforeEach(() => {
	H.citizens = [];
	H.openTasks = [];
	H.pop = [{ total: 0, agents: 0, humans: 0, active_24h: 0 }];
	H.prof = []; H.status = [];
	H.flow = [{ three_atomic: '0', payouts: 0 }];
	H.completed = [{ n: 0 }];
	H.recent = []; H.topEarners = [];
	H.passportRow = undefined; H.activity = [];
	H.bazaarItems = []; H.bazaarThrows = false;
	H.rlSuccess = true;
});

describe('router', () => {
	it('404s an unknown action', async () => {
		const { status, body } = await call('nonsense');
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('405s a non-GET method', async () => {
		const { status } = await call('citizens', { method: 'POST' });
		expect(status).toBe(405);
	});

	it('429s when the rate limiter denies', async () => {
		H.rlSuccess = false;
		const { status, body } = await call('pulse');
		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

describe('citizens', () => {
	it('returns an honest empty state on zero rows (never fabricated)', async () => {
		const { status, body } = await call('citizens');
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.empty).toBe(true);
		expect(body.count).toBe(0);
		expect(body.citizens).toEqual([]);
		expect(Array.isArray(body.professions)).toBe(true);
		expect(body.professions.length).toBe(8); // the documented bit map
	});

	it('shapes a projected row into the world-renderable contract', async () => {
		H.citizens = [{
			id: 'c1', kind: 'agent', display_name: 'Aria', avatar_url: 'https://a/glb',
			profession: 'sculptor', capability_bits: 2, status: 'idle',
			agenc_agent_id: 'abc', agenc_agent_pda: 'PDA1', agenc_cluster: 'devnet', identity_source: 'handle',
			pos_x: 1, pos_z: 2, home_x: 0, home_z: 0,
			reputation: 5, stake_lamports: 1000, earned_three_atomic: 250000, tasks_completed: 3, tasks_posted: 1,
		}];
		const { body } = await call('citizens');
		expect(body.empty).toBe(false);
		expect(body.count).toBe(1);
		const c = body.citizens[0];
		expect(c.displayName).toBe('Aria');
		expect(c.capabilityBits).toBe('2'); // BigInt-safe string
		expect(c.stakeLamports).toBe('1000');
		expect(c.earnedThreeAtomic).toBe('250000');
		expect(c.agenc.registered).toBe(true);
		expect(c.professions.map((p) => p.key)).toContain('sculptor'); // bit 1 set
	});
});

describe('board', () => {
	it('is honestly empty when both lanes are empty', async () => {
		const { status, body } = await call('board');
		expect(status).toBe(200);
		expect(body.empty).toBe(true);
		expect(body.tasks).toEqual([]);
		expect(body.services).toEqual([]);
	});

	it('degrades gracefully when the bazaar lane is down (200 + errors[], AgenC tasks still render)', async () => {
		H.bazaarThrows = true;
		H.openTasks = [{
			kind: 'posted_task', task_pda: 'T1', task_id: 'id1', profession: 'fetcher',
			amount_atomic: 1000, reward_mint: null, reward_label: '0.001 SOL', narrative: 'a job',
			created_at: '2026-07-02T00:00:00Z', tx_signature: 'sig', meta: {},
			creator_id: 'c1', creator_name: 'Aria', agenc_cluster: 'devnet',
		}];
		const { status, body } = await call('board');
		expect(status).toBe(200);
		expect(body.tasks.length).toBe(1);
		expect(body.tasks[0].taskPda).toBe('T1');
		expect(body.errors.some((e) => e.source === 'x402')).toBe(true);
		expect(body.empty).toBe(false); // AgenC lane still populated
	});
});

describe('pulse', () => {
	it('returns an honest empty snapshot for a fresh economy', async () => {
		const { status, body } = await call('pulse');
		expect(status).toBe(200);
		expect(body.empty).toBe(true);
		expect(body.coin.symbol).toBe('$THREE');
		expect(body.population.total).toBe(0);
		expect(body.economy.threeEarned24hAtomic).toBe('0');
		expect(body.topEarners).toEqual([]);
	});

	it('reports a populated economy', async () => {
		H.pop = [{ total: 12, agents: 9, humans: 3, active_24h: 4 }];
		H.completed = [{ n: 7 }];
		H.flow = [{ three_atomic: '999', payouts: 2 }];
		H.topEarners = [{ id: 'c1', display_name: 'Aria', profession: 'sculptor', reputation: 20, earned_three_atomic: 999, tasks_completed: 7 }];
		H.recent = [{ id: 'a1', kind: 'completed_task', narrative: 'Aria sculpted a fox', reward_label: '999 $THREE', created_at: '2026-07-02T00:00:00Z', task_pda: 'T1', deliverable_url: 'https://cdn/x.glb', citizen_id: 'c1', actor: 'Aria', profession: 'sculptor' }];
		const { body } = await call('pulse');
		expect(body.empty).toBe(false);
		expect(body.population.total).toBe(12);
		expect(body.economy.tasksCompleted24h).toBe(7);
		expect(body.economy.threeEarned24hAtomic).toBe('999');
		expect(body.topEarners[0].displayName).toBe('Aria');
		// recent narration is routed correctly (not stolen by the board branch)
		expect(body.recent).toHaveLength(1);
		expect(body.recent[0].narrative).toBe('Aria sculpted a fox');
		expect(body.recent[0].actor).toBe('Aria');
	});
});

describe('passport', () => {
	it('400s when no selector is supplied', async () => {
		const { status, body } = await call('passport');
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('404s an unknown citizen', async () => {
		const { status, body } = await call('passport', { query: { id: '00000000-0000-4000-8000-00000000dead' } });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('404s a non-uuid id without touching the database (probe strings must not 500)', async () => {
		const { status, body } = await call('passport', { query: { id: 'verification-probe-citizen' } });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns the projection + activity for a found citizen (on-chain best-effort, null pda ⇒ no RPC)', async () => {
		// agora_citizens.id is a uuid column — the fixture must use one, matching
		// what production Postgres would accept (a bare 'c1' throws 22P02 there).
		const cid = '11111111-1111-4111-8111-111111111111';
		H.passportRow = {
			id: cid, kind: 'agent', display_name: 'Aria', profession: 'scribe', capability_bits: 4,
			status: 'idle', agenc_agent_id: 'abc', agenc_agent_pda: null, agenc_cluster: 'devnet',
			pos_x: 0, pos_z: 0, home_x: 0, home_z: 0, reputation: 3,
			stake_lamports: 0, earned_three_atomic: 0, tasks_completed: 0, tasks_posted: 0,
		};
		H.activity = [{
			id: 'a1', kind: 'registered', narrative: 'Aria registered', profession: 'scribe',
			task_pda: null, task_id: null, amount_atomic: null, reward_mint: null, reward_label: null,
			tx_signature: 'sig', proof_hash: null, deliverable_url: null, rep_before: null, rep_after: 3,
			created_at: '2026-07-02T00:00:00Z',
		}];
		const { status, body } = await call('passport', { query: { id: cid } });
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.citizen.displayName).toBe('Aria');
		expect(body.onchain).toBeNull(); // null pda ⇒ no on-chain read attempted
		expect(body.activity.length).toBe(1);
		expect(body.activity[0].kind).toBe('registered');
	});
});
