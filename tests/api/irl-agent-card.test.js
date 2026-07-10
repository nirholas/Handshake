// GET /api/irl/agent-card — IRL Inspect Card v2 (B2).
//
// The card is ONE server-side fan-out — agent record + on-chain Solana reputation
// + paid x402 services — merged into a single payload so a phone makes one call.
// These tests pin the two things the client trusts the server to get right:
//   1. the documented, explicit tier/score derivation from raw aggregates, and
//   2. the merged shape — incl. the two non-negotiable degradations: a reputation
//      query failure must NOT fail the card (services still render), and an agent
//      with no on-chain asset must show available:false, never a fabricated score.
// The DB / redis / rate-limit / r2 layers are mocked so the suite stays offline;
// the real http.js + (pure) agent-paid-services helpers run, so the actual JSON
// the client receives is what's asserted.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { deriveReputation } from '../../api/irl/agent-card.js';

// ── Mutable fixtures the sql router reads, reset per test ──────────────────────
let agentRow = null;     // agent_identities row (null → agent 404)
let agentThrows = false; // simulate a missing agent_identities table (query rejects)
let repAgg = null;       // reputation aggregate row
let repThrows = false;   // simulate a reputation-query failure (must degrade, not 500)
let repEmpty = false;    // simulate a successful-but-rowless reputation read ([] result)
let serviceRows = [];    // agent_paid_services rows
let servicesThrow = false; // simulate a missing agent_paid_services table (query rejects)
let pinRow = null;       // irl_pins row when resolving by ?pin=

// One tagged-template sql mock that routes by the query text, mirroring the real
// fan-out in buildCard(): agent SELECT, reputation WITH fb/val, services SELECT.
const sqlMock = vi.fn((strings) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/FROM agent_identities/i.test(q)) {
		if (agentThrows) return Promise.reject(new Error('relation "agent_identities" does not exist'));
		return Promise.resolve(agentRow ? [agentRow] : []);
	}
	if (/FROM irl_pins/i.test(q)) return Promise.resolve(pinRow ? [pinRow] : []);
	if (/solana_attestations[\s\S]*threews\.feedback/i.test(q)) {
		if (repThrows) return Promise.reject(new Error('rep table unavailable'));
		if (repEmpty) return Promise.resolve([]);   // successful read, zero rows
		return Promise.resolve([repAgg]);
	}
	if (/FROM agent_paid_services/i.test(q)) {
		if (servicesThrow) return Promise.reject(new Error('relation "agent_paid_services" does not exist'));
		return Promise.resolve(serviceRows);
	}
	return Promise.resolve([]);
});
// The handler uses `.catch(() => [])` on the agent + services queries, so the mock
// must expose `.catch`. Returning a real Promise (above) already does.
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

// No cache in tests — exercise the live fan-out every call, not a HIT.
vi.mock('../../api/_lib/redis.js', () => ({ getRedis: vi.fn(async () => null) }));

vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: (key) => `/cdn/${key}`,
	// thumbnailUrl mirrors r2.js: null for a missing key or the legacy *_og.png form.
	thumbnailUrl: (key) => (!key || /^https?:\/\/.*_og\.png$/i.test(key) ? null : `/cdn/${key}`),
}));

const { default: handler } = await import('../../api/irl/agent-card.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}

async function getCard(qs) {
	const res = makeRes();
	await handler({ url: `/api/irl/agent-card?${qs}`, method: 'GET', headers: { host: 'x' } }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch { /* non-JSON body */ }
	return { res, body: parsed };
}

beforeEach(() => {
	sqlMock.mockClear();
	agentRow = {
		id: 'agent-1', name: 'Atlas', description: '  Trip-planning agent for explorers.  ',
		home_url: null, meta: { sol_mint_address: 'THREEsynthetic1111111111111111111111111111', network: 'mainnet' },
		avatar_thumbnail_key: 'thumbs/atlas.png', avatar_visibility: 'public',
	};
	repAgg = { fb_total: 20, score_avg: 4.6, unique_attesters: 9, val_passed: 3, val_failed: 0, tasks_accepted: 14 };
	agentThrows = false;
	repThrows = false;
	repEmpty = false;
	servicesThrow = false;
	serviceRows = [
		{ slug: 'route-plan', name: 'Route planning', description: 'Plan a multi-stop trip', price_atomics: '50000', network: 'base' },
		{ slug: 'weather', name: 'Weather brief', description: null, price_atomics: '10000', network: 'base' },
	];
	pinRow = null;
});

describe('deriveReputation — documented tier/score formula', () => {
	it('floors to "new" with no attestations (no fabricated score)', () => {
		const r = deriveReputation({ fbTotal: 0, scoreAvg: 0, uniqueAttesters: 0, valPassed: 0, valFailed: 0, tasksAccepted: 0 });
		expect(r.score).toBe(0);
		expect(r.tier).toBe('new');
		expect(r.attestation_count).toBe(0);
	});

	it('maps a strong on-chain record to a high tier', () => {
		// 5-star avg (full quality), ~50 attesters (full breadth), all validations pass.
		const r = deriveReputation({ fbTotal: 40, scoreAvg: 5, uniqueAttesters: 50, valPassed: 10, valFailed: 0, tasksAccepted: 30 });
		expect(r.score).toBe(100);
		expect(r.tier).toBe('elite');
		expect(r.attestation_count).toBe(50); // fb_total(40) + val_passed(10)
	});

	it('is monotonic across the tier ladder new < emerging < trusted < elite', () => {
		const score = (a) => deriveReputation(a).score;
		const sNew      = score({ fbTotal: 1, scoreAvg: 1.2, uniqueAttesters: 1, valPassed: 0, valFailed: 2, tasksAccepted: 0 });
		const sEmerging = score({ fbTotal: 5, scoreAvg: 3,   uniqueAttesters: 3, valPassed: 1, valFailed: 1, tasksAccepted: 1 });
		const sTrusted  = score({ fbTotal: 20, scoreAvg: 4.3, uniqueAttesters: 12, valPassed: 5, valFailed: 0, tasksAccepted: 8 });
		const sElite    = score({ fbTotal: 40, scoreAvg: 4.9, uniqueAttesters: 45, valPassed: 12, valFailed: 0, tasksAccepted: 30 });
		expect(sNew).toBeLessThan(sEmerging);
		expect(sEmerging).toBeLessThan(sTrusted);
		expect(sTrusted).toBeLessThan(sElite);
		expect(deriveReputation({ fbTotal: 40, scoreAvg: 4.9, uniqueAttesters: 45, valPassed: 12, valFailed: 0, tasksAccepted: 30 }).tier).toBe('elite');
	});

	it('clamps score into [0,100] and never exceeds it', () => {
		const r = deriveReputation({ fbTotal: 999, scoreAvg: 5, uniqueAttesters: 9999, valPassed: 999, valFailed: 0, tasksAccepted: 999 });
		expect(r.score).toBeGreaterThanOrEqual(0);
		expect(r.score).toBeLessThanOrEqual(100);
	});
});

describe('GET /api/irl/agent-card — merged payload', () => {
	it('returns the merged agent + reputation + services shape in one response', async () => {
		const { res, body } = await getCard('agent_id=agent-1');
		expect(res.statusCode).toBe(200);
		const card = body.card;
		// agent
		expect(card.agent).toMatchObject({ id: 'agent-1', name: 'Atlas', profile_url: '/agents/agent-1' });
		expect(card.agent.bio).toBe('Trip-planning agent for explorers.'); // trimmed
		expect(card.agent.thumbnail_url).toBe('/cdn/thumbs/atlas.png');
		// reputation — real, derived, available
		expect(card.reputation.available).toBe(true);
		expect(card.reputation.tier).toBeDefined();
		expect(card.reputation.score).toBeGreaterThan(0);
		expect(card.reputation.unique_attesters).toBe(9);
		// services — real USDC prices, ordered cheapest-first by the SQL, with endpoints
		expect(card.services).toHaveLength(2);
		expect(card.services[0]).toMatchObject({ skill: 'route-plan', name: 'Route planning', price_usd: 0.05, currency: 'USDC', chain: 'base' });
		expect(card.services[0].x402_endpoint).toContain('/api/x402/service/route-plan');
		expect(card.services[1].price_usd).toBe(0.01);
	});

	it('degrades gracefully when the reputation query fails — services still render', async () => {
		repThrows = true;
		const { res, body } = await getCard('agent_id=agent-1');
		expect(res.statusCode).toBe(200);
		expect(body.card.reputation.available).toBe(false);
		expect(body.card.reputation.degraded).toBe(true);
		expect(body.card.services).toHaveLength(2); // the menu is unaffected
	});

	it('never 500s when the reputation table is missing on a fresh DB (degrades, no leak)', async () => {
		// A fresh / mid-migration DB rejects the solana_attestations read. The card
		// must come back 200 with reputation degraded — not a 500 / stack trace.
		repThrows = true;
		const { res, body } = await getCard('agent_id=agent-1');
		expect(res.statusCode).toBe(200);
		expect(body.error).toBeUndefined();
		expect(body.card.reputation).toMatchObject({ available: false, degraded: true });
		expect(body.card.reputation.asset).toBe('THREEsynthetic1111111111111111111111111111');
	});

	it('treats a successful-but-rowless reputation read as zero, not a 500 (undefined-row guard)', async () => {
		// The coalesce'd aggregate normally returns one row; a driver/partial edge
		// could yield []. buildCard must not throw on row.fb_total — it derives from
		// zeros and the card is available with a fresh score, never degraded/500.
		repEmpty = true;
		const { res, body } = await getCard('agent_id=agent-1');
		expect(res.statusCode).toBe(200);
		expect(body.error).toBeUndefined();
		expect(body.card.reputation.available).toBe(true);
		expect(body.card.reputation.degraded).toBeUndefined();
		expect(body.card.reputation.score).toBe(0);
		expect(body.card.reputation.tier).toBe('new');
		expect(body.card.reputation.attestation_count).toBe(0);
		expect(body.card.services).toHaveLength(2);
	});

	it('coerces null aggregate columns to zero rather than NaN/throwing', async () => {
		// score_avg etc. can come back null from coalesce-less driver paths; the
		// derivation must still produce a finite score, not NaN.
		repAgg = { fb_total: null, score_avg: null, unique_attesters: null, val_passed: null, val_failed: null, tasks_accepted: null };
		const { res, body } = await getCard('agent_id=agent-1');
		expect(res.statusCode).toBe(200);
		expect(body.card.reputation.available).toBe(true);
		expect(Number.isFinite(body.card.reputation.score)).toBe(true);
		expect(body.card.reputation.score).toBe(0);
		expect(body.card.reputation.unique_attesters).toBe(0);
	});

	it('survives a fresh DB where agent_identities itself is missing (no 500)', async () => {
		// The agent query .catch(() => []) → no agent → genuine 404 for an explicit
		// agent_id, never an uncaught 500 / stack trace.
		agentThrows = true;
		const { res, body } = await getCard('agent_id=agent-1');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('survives a fresh DB where agent_paid_services is missing — empty menu, no 500', async () => {
		// The services query .catch(() => []) → empty menu; reputation + agent still render.
		servicesThrow = true;
		const { res, body } = await getCard('agent_id=agent-1');
		expect(res.statusCode).toBe(200);
		expect(body.error).toBeUndefined();
		expect(body.card.services).toEqual([]);
		expect(body.card.agent.name).toBe('Atlas');
	});

	it('shows no-reputation (available:false) for an agent with no on-chain asset, never a number', async () => {
		agentRow.meta = {}; // no sol_mint_address
		const { res, body } = await getCard('agent_id=agent-1');
		expect(res.statusCode).toBe(200);
		expect(body.card.reputation).toEqual({ asset: null, available: false });
		expect(body.card.reputation.score).toBeUndefined();
	});

	it('renders an empty services array when the agent sells nothing', async () => {
		serviceRows = [];
		const { body } = await getCard('agent_id=agent-1');
		expect(body.card.services).toEqual([]);
	});

	it('hides a private avatar thumbnail', async () => {
		agentRow.avatar_visibility = 'private';
		const { body } = await getCard('agent_id=agent-1');
		expect(body.card.agent.thumbnail_url).toBeNull();
	});

	it('404s a genuine unknown agent_id', async () => {
		agentRow = null;
		const { res, body } = await getCard('agent_id=ghost');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBeDefined();
	});

	it('400s when neither agent_id nor pin is supplied', async () => {
		const { res } = await getCard('');
		expect(res.statusCode).toBe(400);
	});

	it('degrades a pin whose linked agent is private/deleted to an anonymous card (no 404)', async () => {
		pinRow = { agent_id: 'missing-agent', avatar_name: 'Wanderer', caption: 'hi', x402_endpoint: null };
		agentRow = null; // the linked agent resolves to nothing
		const { res, body } = await getCard('pin=pin-1');
		expect(res.statusCode).toBe(200);
		expect(body.card.anonymous).toBe(true);
		expect(body.card.agent.name).toBe('Wanderer');
		expect(body.card.reputation.available).toBe(false);
	});
});
