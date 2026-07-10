// Prompt 15 — Save & manage subscription tiers API.
//
// /api/agents/:id/tiers is the agent-addressed REST view of the creator's
// subscription tiers (rows in `subscription_plans` scoped to one agent):
//
//   GET    /api/agents/:id/tiers             list active tiers (public)
//   POST   /api/agents/:id/tiers             create tier (owner)
//   PUT    /api/agents/:id/tiers/:tierId     update tier (owner)
//   PATCH  /api/agents/:id/tiers/:tierId     update tier (owner, alias of PUT)
//   DELETE /api/agents/:id/tiers/:tierId     deactivate tier (owner, soft-delete)
//
// The server is the trust boundary: ownership is checked against
// agent_identities (never the caller), cookie-session mutations require CSRF,
// the body is validated, and a delete is a soft-delete (active=false) that first
// counts active subscribers so paid fans keep access until their period ends.
// DB / auth / CSRF / limiter are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

// ── Content-addressed SQL mock ───────────────────────────────────────────────
// Classify each query by its text so call order never matters. Handles both the
// tagged-template form sql`…` and the dynamic function form sql(text, params)
// used by the UPDATE path. Every call is recorded for write-path assertions.
let agentRow = null;        // agent_identities ownership lookup → { user_id } | null
let tierRows = [];          // rows the GET list returns
let existingTier = null;    // update/delete existence lookup → { id } | null
let capCount = 0;           // active-tier count for the create cap
let subCount = 0;           // active subscriber count for delete
let calls = [];             // { q, values } for every query, in order

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	calls.push({ q, values });

	if (/FROM agent_identities/i.test(q)) {
		return Promise.resolve(agentRow ? [agentRow] : []);
	}
	// Subscriber count joins creator_subscriptions — check before the generic
	// subscription_plans count so it wins.
	if (/count\(\*\)[\s\S]*creator_subscriptions/i.test(q)) {
		return Promise.resolve([{ count: subCount }]);
	}
	if (/count\(\*\)[\s\S]*subscription_plans/i.test(q)) {
		return Promise.resolve([{ count: capCount }]);
	}
	if (/INSERT INTO subscription_plans/i.test(q)) {
		return Promise.resolve([{ id: 'new-tier-id', name: 'Supporter', active: true }]);
	}
	if (/UPDATE subscription_plans SET active = false/i.test(q)) {
		return Promise.resolve(existingTier ? [{ id: existingTier.id }] : []);
	}
	if (/UPDATE subscription_plans SET/i.test(q)) {
		return Promise.resolve(existingTier ? [{ ...existingTier, name: 'Updated' }] : []);
	}
	// Existence probe: selects exactly `id` (the list selects `id, name, …`).
	if (/SELECT id\s+FROM subscription_plans/i.test(q)) {
		return Promise.resolve(existingTier ? [existingTier] : []);
	}
	if (/FROM subscription_plans/i.test(q)) {
		return Promise.resolve(tierRows);
	}
	return Promise.resolve([]);
});
sqlMock.transaction = (queries) => Promise.all(queries);
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

// CSRF passes by default; flip `csrfOk=false` to exercise the gate. On failure
// the real requireCsrf writes the 403 itself, so the mock does too.
let csrfOk = true;
vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (req, res) => {
		if (csrfOk) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'csrf_invalid' }));
		return false;
	}),
}));

let rlSuccess = true;
// Tiers is a profile read: it fans out with 6 other calls on one agent-profile
// load, so it uses the dedicated `agentProfileIp` bucket rather than the shared
// `publicIp` pool (which ~150 endpoints drain).
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		agentProfileIp: vi.fn(async () => ({ success: rlSuccess, reset: Date.now() + 1000, limit: 240, remaining: 0 })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: tiers } = await import('../../api/agents/[id]/tiers.js');

const AGENT_ID = '00000000-0000-4000-8000-000000000abc';
const TIER_ID  = '00000000-0000-4000-8000-000000000def';
const OWNER    = 'owner-uuid';
const base     = `/api/agents/${AGENT_ID}/tiers`;
const findCall = (re) => calls.find((c) => re.test(c.q));

beforeEach(() => {
	sqlMock.mockClear();
	calls = [];
	agentRow = { user_id: OWNER };
	tierRows = [];
	existingTier = { id: TIER_ID, active: true };
	capCount = 0;
	subCount = 0;
	sessionUser = null;
	csrfOk = true;
	rlSuccess = true;
});

// ── Path / method guards ──────────────────────────────────────────────────────
describe('routing guards', () => {
	it('400s on a non-UUID agent id', async () => {
		const { status, body } = await invoke(tiers, { method: 'GET', url: '/api/agents/not-a-uuid/tiers' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('400s on a non-UUID tier id', async () => {
		sessionUser = { id: OWNER };
		const { status, body } = await invoke(tiers, {
			method: 'PUT', url: `${base}/not-a-uuid`, body: { name: 'X' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('405s on POST with a tier id', async () => {
		sessionUser = { id: OWNER };
		const { status } = await invoke(tiers, { method: 'POST', url: `${base}/${TIER_ID}`, body: {} });
		expect(status).toBe(405);
	});
});

// ── GET — public list ──────────────────────────────────────────────────────────
describe('GET /api/agents/:id/tiers', () => {
	it('returns active tiers without auth', async () => {
		tierRows = [
			{ id: TIER_ID, name: 'Supporter', price_usd: '5.00', interval: 'monthly', perks: [], included_skills: ['web-search'], active: true },
		];
		const { status, body } = await invoke(tiers, { method: 'GET', url: base });
		expect(status).toBe(200);
		expect(body.tiers).toHaveLength(1);
		expect(body.tiers[0].name).toBe('Supporter');
		expect(body.tiers[0].included_skills).toEqual(['web-search']);
		// Only active tiers are queried.
		expect(findCall(/FROM subscription_plans[\s\S]*active = true/i)).toBeDefined();
	});

	it('returns an empty list when the agent has no tiers', async () => {
		const { status, body } = await invoke(tiers, { method: 'GET', url: base });
		expect(status).toBe(200);
		expect(body.tiers).toEqual([]);
	});

	it('429s when rate-limited', async () => {
		rlSuccess = false;
		const { status } = await invoke(tiers, { method: 'GET', url: base });
		expect(status).toBe(429);
	});
});

// ── POST — create ───────────────────────────────────────────────────────────────
describe('POST /api/agents/:id/tiers', () => {
	const body = { name: 'Supporter', price_usd: 5, interval: 'monthly', included_skills: ['web-search'] };

	it('401s when unauthenticated', async () => {
		const { status, body: out } = await invoke(tiers, { method: 'POST', url: base, body });
		expect(status).toBe(401);
		expect(out.error).toBe('unauthorized');
	});

	it('403s when the agent belongs to another user', async () => {
		sessionUser = { id: 'not-the-owner' };
		agentRow = null; // ownership query (scoped to user_id) returns nothing
		const { status, body: out } = await invoke(tiers, { method: 'POST', url: base, body });
		expect(status).toBe(403);
		expect(out.error).toBe('forbidden');
		expect(findCall(/INSERT INTO subscription_plans/i)).toBeUndefined();
	});

	it('403s when the CSRF token is missing/invalid', async () => {
		sessionUser = { id: OWNER };
		csrfOk = false;
		const { status, body: out } = await invoke(tiers, { method: 'POST', url: base, body });
		expect(status).toBe(403);
		expect(out.error).toBe('csrf_invalid');
	});

	it('400s when the price is below the $0.99 minimum', async () => {
		sessionUser = { id: OWNER };
		const { status, body: out } = await invoke(tiers, {
			method: 'POST', url: base, body: { name: 'Cheap', price_usd: 0.5 },
		});
		expect(status).toBe(400);
		expect(out.error).toBe('validation_error');
		expect(findCall(/INSERT INTO subscription_plans/i)).toBeUndefined();
	});

	it('409s when the creator already has 3 active tiers', async () => {
		sessionUser = { id: OWNER };
		capCount = 3;
		const { status, body: out } = await invoke(tiers, { method: 'POST', url: base, body });
		expect(status).toBe(409);
		expect(out.error).toBe('conflict');
		expect(findCall(/INSERT INTO subscription_plans/i)).toBeUndefined();
	});

	it('creates the tier with included_skills for the owner', async () => {
		sessionUser = { id: OWNER };
		const { status, body: out } = await invoke(tiers, { method: 'POST', url: base, body });
		expect(status).toBe(201);
		expect(out.tier).toBeDefined();
		const ins = findCall(/INSERT INTO subscription_plans/i);
		expect(ins).toBeDefined();
		// VALUES (creator_id, agent_id, name, price_usd, interval, perks, included_skills)
		expect(ins.values[0]).toBe(OWNER);
		expect(ins.values[1]).toBe(AGENT_ID);
		expect(ins.values[2]).toBe('Supporter');
		expect(ins.values[3]).toBe(5);
		expect(ins.values[6]).toEqual(['web-search']);
	});

	it('429s when rate-limited', async () => {
		sessionUser = { id: OWNER };
		rlSuccess = false;
		const { status } = await invoke(tiers, { method: 'POST', url: base, body });
		expect(status).toBe(429);
	});
});

// ── PUT / PATCH — update ────────────────────────────────────────────────────────
describe('PUT/PATCH /api/agents/:id/tiers/:tierId', () => {
	const url = `${base}/${TIER_ID}`;

	it('401s when unauthenticated', async () => {
		const { status } = await invoke(tiers, { method: 'PUT', url, body: { price_usd: 9 } });
		expect(status).toBe(401);
	});

	it('404s when the tier does not exist for this agent', async () => {
		sessionUser = { id: OWNER };
		existingTier = null;
		const { status, body: out } = await invoke(tiers, { method: 'PUT', url, body: { price_usd: 9 } });
		expect(status).toBe(404);
		expect(out.error).toBe('not_found');
	});

	it('403s when the CSRF token is missing/invalid', async () => {
		sessionUser = { id: OWNER };
		csrfOk = false;
		const { status } = await invoke(tiers, { method: 'PUT', url, body: { price_usd: 9 } });
		expect(status).toBe(403);
	});

	it('400s when no updatable fields are provided', async () => {
		sessionUser = { id: OWNER };
		const { status, body: out } = await invoke(tiers, { method: 'PUT', url, body: {} });
		expect(status).toBe(400);
		expect(out.error).toBe('validation_error');
	});

	it('updates the tier via PUT', async () => {
		sessionUser = { id: OWNER };
		const { status, body: out } = await invoke(tiers, {
			method: 'PUT', url, body: { name: 'Updated', price_usd: 9, included_skills: ['summarize'] },
		});
		expect(status).toBe(200);
		expect(out.tier).toBeDefined();
		const upd = findCall(/UPDATE subscription_plans SET/i);
		expect(upd).toBeDefined();
		// Dynamic params end with [tierId, creatorId] (see handler).
		expect(upd.values[0]).toContain(TIER_ID);
		expect(upd.values[0]).toContain(OWNER);
	});

	it('also accepts PATCH as an alias', async () => {
		sessionUser = { id: OWNER };
		const { status } = await invoke(tiers, { method: 'PATCH', url, body: { active: false } });
		expect(status).toBe(200);
		expect(findCall(/UPDATE subscription_plans SET/i)).toBeDefined();
	});
});

// ── DELETE — soft-delete ────────────────────────────────────────────────────────
describe('DELETE /api/agents/:id/tiers/:tierId', () => {
	const url = `${base}/${TIER_ID}`;

	it('401s when unauthenticated', async () => {
		const { status } = await invoke(tiers, { method: 'DELETE', url });
		expect(status).toBe(401);
	});

	it('403s for a non-owner', async () => {
		sessionUser = { id: 'not-the-owner' };
		agentRow = null;
		const { status, body: out } = await invoke(tiers, { method: 'DELETE', url });
		expect(status).toBe(403);
		expect(out.error).toBe('forbidden');
		expect(findCall(/UPDATE subscription_plans SET active = false/i)).toBeUndefined();
	});

	it('soft-deletes (active=false), never a hard delete', async () => {
		sessionUser = { id: OWNER };
		const { status, body: out } = await invoke(tiers, { method: 'DELETE', url });
		expect(status).toBe(200);
		expect(out.ok).toBe(true);
		expect(out.active_subscribers).toBe(0);
		expect(findCall(/UPDATE subscription_plans SET active = false/i)).toBeDefined();
		expect(findCall(/DELETE FROM subscription_plans/i)).toBeUndefined();
	});

	it('reports active subscribers who keep access until period end', async () => {
		sessionUser = { id: OWNER };
		subCount = 4;
		const { status, body: out } = await invoke(tiers, { method: 'DELETE', url });
		expect(status).toBe(200);
		expect(out.active_subscribers).toBe(4);
		expect(out.message).toMatch(/4 subscriber/);
	});

	it('404s when the tier does not exist for this agent', async () => {
		sessionUser = { id: OWNER };
		existingTier = null; // soft-delete UPDATE returns nothing
		const { status, body: out } = await invoke(tiers, { method: 'DELETE', url });
		expect(status).toBe(404);
		expect(out.error).toBe('not_found');
	});
});
