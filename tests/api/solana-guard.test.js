// api/agents/solana-guard.js, the Self-Defending Wallet control surface.
//
// Not routed on its own: /api/agents/solana-guard is swallowed by the
// /api/agents/([^/]+) catch-all, so the only way in is
// /api/agents/:id/solana/guard -> api/agents/solana-wallet.js -> handleGuard.
// These tests drive the handler exactly the way that dispatcher does.
//
// The collaborators that touch Postgres and the spend policy (anomaly-events,
// agent-trade-guards) are mocked. wallet-anomaly is pure and runs for real, so
// the config defaults, sensitivity presets, and publicConfig projection under
// test are the shipped ones rather than fixtures.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair, PublicKey } from '@solana/web3.js';

const SAFE_ADDR = Keypair.generate().publicKey.toBase58();
// A PDA: off-curve, so it cannot sign and must be refused as a sweep target.
const PDA_ADDR = PublicKey.findProgramAddressSync(
	[Buffer.from('guard-test')],
	new PublicKey('11111111111111111111111111111111'),
)[0].toBase58();

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

const sqlState = { agent: null, updates: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		const q = (typeof strings === 'string' ? strings : strings.join('?')).toLowerCase();
		if (/update agent_anomaly_events/.test(q)) {
			sqlState.updates.push(q);
			return [];
		}
		if (/from agent_identities/.test(q)) return sqlState.agent ? [sqlState.agent] : [];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { walletRead: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const csrfState = { ok: true };
vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (req, res) => {
		if (csrfState.ok) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'forbidden', error_description: 'csrf' }));
		return false;
	}),
}));

const guardState = { frozen: false, setCalls: [] };
vi.mock('../../api/_lib/agent-trade-guards.js', async () => {
	const real = await vi.importActual('../../api/_lib/agent-trade-guards.js');
	return {
		validateSolanaAddress: real.validateSolanaAddress,
		getSpendLimits: vi.fn(() => ({ frozen: guardState.frozen })),
		setSpendLimits: vi.fn(async (agentId, userId, patch) => {
			guardState.setCalls.push({ agentId, userId, patch });
			guardState.frozen = patch.frozen === true;
			return { frozen: guardState.frozen };
		}),
	};
});

const eventsState = { events: [], flags: [], event: null, statuses: [], taught: null, saved: null };
vi.mock('../../api/_lib/anomaly-events.js', () => ({
	listAnomalyEvents: vi.fn(async () => eventsState.events),
	listOpenFlags: vi.fn(async () => eventsState.flags),
	getAnomalyEvent: vi.fn(async () => eventsState.event),
	setAnomalyStatus: vi.fn(async (eventId, patch) => {
		eventsState.statuses.push({ eventId, ...patch });
	}),
	loadBaselineForDisplay: vi.fn(async () => ({ samples: 12, median_usd: 4.5 })),
	saveAnomalyConfig: vi.fn(async (agentId, meta, patch) => {
		eventsState.saved = patch;
		const { getAnomalyConfig } = await import('../../api/_lib/wallet-anomaly.js');
		return { ...getAnomalyConfig(meta), ...patch, allow_destinations: patch.allow_destinations ?? [] };
	}),
	teachFromApproval: vi.fn(async (agentId, meta, evt) => {
		eventsState.taught = evt;
		const { getAnomalyConfig } = await import('../../api/_lib/wallet-anomaly.js');
		return { ...getAnomalyConfig(meta), allow_destinations: [evt.destination] };
	}),
}));

const { default: handleGuard } = await import('../../api/agents/solana-guard.js');

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

function makeReq(method, { body = null, url = '/api/agents/x/solana/guard' } = {}) {
	const payload = body === null ? [] : [Buffer.from(JSON.stringify(body))];
	const req = Readable.from(payload);
	req.method = method;
	req.url = url;
	req.headers = { host: 'localhost', 'content-type': 'application/json', origin: 'http://localhost' };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(c) { if (c !== undefined) this.body += c; this.writableEnded = true; },
	};
}

async function invoke(method, opts = {}) {
	const res = makeRes();
	await handleGuard(makeReq(method, opts), res, AGENT_ID);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function ownedAgent(meta = {}) {
	return { id: AGENT_ID, user_id: 'owner-1', meta };
}

beforeEach(() => {
	authState.session = { id: 'owner-1' };
	sqlState.agent = ownedAgent();
	sqlState.updates = [];
	csrfState.ok = true;
	guardState.frozen = false;
	guardState.setCalls = [];
	eventsState.events = [];
	eventsState.flags = [];
	eventsState.event = null;
	eventsState.statuses = [];
	eventsState.taught = null;
	eventsState.saved = null;
});

describe('GET /api/agents/:id/solana/guard', () => {
	it('returns config, presets, baseline, open flags, and the timeline', async () => {
		guardState.frozen = true;
		eventsState.flags = [{
			id: 9n, network: 'mainnet', category: 'withdraw', asset: 'SOL', usd: '120.5',
			destination: SAFE_ADDR, score: '0.91', decision: 'freeze', critical: true,
			sensitivity: 'balanced', factors: ['size', 'new_destination'], summary: 'unusually large',
			status: 'flagged', hour_utc: 3, swept: false, adjudicated_at: null, created_at: '2026-08-01T03:00:00Z',
		}];
		eventsState.events = eventsState.flags;

		const { status, body } = await invoke('GET');
		expect(status).toBe(200);
		expect(body.data.frozen).toBe(true);
		expect(body.data.config.sensitivity).toBe('balanced');
		expect(body.data.config.learned_destinations).toBe(0);
		expect(body.data.presets.length).toBeGreaterThan(0);
		expect(body.data.baseline).toEqual({ samples: 12, median_usd: 4.5 });
		expect(body.data.open_flags[0]).toMatchObject({ id: '9', usd: 120.5, score: 0.91, critical: true });
		expect(body.data.timeline.items).toHaveLength(1);
		// One page of results is short of the default limit, so there is no cursor.
		expect(body.data.timeline.next_cursor).toBeNull();
	});

	it('rejects an unauthenticated caller', async () => {
		authState.session = null;
		expect((await invoke('GET')).status).toBe(401);
	});

	it('rejects a caller who does not own the agent', async () => {
		sqlState.agent = { ...ownedAgent(), user_id: 'someone-else' };
		expect((await invoke('GET')).status).toBe(403);
	});

	it('404s an agent that does not exist', async () => {
		sqlState.agent = null;
		expect((await invoke('GET')).status).toBe(404);
	});
});

describe('PUT /api/agents/:id/solana/guard', () => {
	it('saves sensitivity, enabled, and a safe address', async () => {
		const { status, body } = await invoke('PUT', {
			body: { enabled: true, sensitivity: 'strict', safe_address: SAFE_ADDR },
		});
		expect(status).toBe(200);
		expect(eventsState.saved).toEqual({ enabled: true, sensitivity: 'strict', safe_address: SAFE_ADDR });
		expect(body.data.config.sensitivity).toBe('strict');
	});

	it('clears everything the guard has learned', async () => {
		await invoke('PUT', { body: { clear_learned: true } });
		expect(eventsState.saved).toEqual({ allow_destinations: [], size_ceiling_usd: null, extra_hours: [] });
	});

	it('rejects an unknown sensitivity', async () => {
		const { status, body } = await invoke('PUT', { body: { sensitivity: 'paranoid' } });
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_sensitivity');
	});

	it('refuses a PDA as the safe-sweep address', async () => {
		// Funds swept to an off-curve address can never be moved again.
		const { status, body } = await invoke('PUT', { body: { safe_address: PDA_ADDR } });
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_address');
		expect(body.error_description).toMatch(/PDA/);
	});

	it('refuses a malformed safe address', async () => {
		const { status, body } = await invoke('PUT', { body: { safe_address: 'not-an-address!' } });
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_address');
	});

	it('requires CSRF on a mutation', async () => {
		csrfState.ok = false;
		expect((await invoke('PUT', { body: { enabled: false } })).status).toBe(403);
	});
});

describe('POST /api/agents/:id/solana/guard (adjudication)', () => {
	beforeEach(() => {
		eventsState.event = { id: 7n, destination: SAFE_ADDR, usd: 120.5, hour_utc: 3 };
		guardState.frozen = true;
	});

	it('unfreezes and settles every open flag', async () => {
		const { status, body } = await invoke('POST', { body: { action: 'unfreeze' } });
		expect(status).toBe(200);
		expect(body.data).toEqual({ frozen: false, action: 'unfreeze' });
		expect(guardState.setCalls).toEqual([{ agentId: AGENT_ID, userId: 'owner-1', patch: { frozen: false } }]);
		expect(sqlState.updates).toHaveLength(1);
	});

	it('approve teaches the baseline and unfreezes', async () => {
		const { status, body } = await invoke('POST', { body: { action: 'approve', event_id: 7 } });
		expect(status).toBe(200);
		expect(eventsState.taught).toEqual({ destination: SAFE_ADDR, usd: 120.5, hour_utc: 3 });
		expect(eventsState.statuses).toEqual([{ eventId: '7', status: 'approved', userId: 'owner-1' }]);
		expect(body.data.frozen).toBe(false);
		expect(body.data.config.learned_destinations).toBe(1);
	});

	it('deny records the verdict and leaves the wallet frozen', async () => {
		const { status, body } = await invoke('POST', { body: { action: 'deny', event_id: 7 } });
		expect(status).toBe(200);
		expect(body.data.frozen).toBe(true);
		expect(guardState.setCalls).toHaveLength(0);
		expect(eventsState.statuses).toEqual([{ eventId: '7', status: 'denied', userId: 'owner-1' }]);
	});

	it('mark_swept records the sweep against the flag', async () => {
		const { status, body } = await invoke('POST', { body: { action: 'mark_swept', event_id: 7 } });
		expect(status).toBe(200);
		expect(body.data.swept).toBe(true);
		expect(eventsState.statuses).toEqual([{ eventId: '7', status: 'denied', userId: 'owner-1', swept: true }]);
	});

	it('rejects an adjudication with no event id', async () => {
		const { status, body } = await invoke('POST', { body: { action: 'approve' } });
		expect(status).toBe(400);
		expect(body.error_description).toMatch(/event_id/);
	});

	it('404s an event that belongs to another agent', async () => {
		eventsState.event = null;
		expect((await invoke('POST', { body: { action: 'approve', event_id: 7 } })).status).toBe(404);
	});

	it('rejects an unknown action', async () => {
		const { status, body } = await invoke('POST', { body: { action: 'thaw', event_id: 7 } });
		expect(status).toBe(400);
		expect(body.error_description).toMatch(/approve, deny, mark_swept, or unfreeze/);
	});
});

describe('method handling', () => {
	it('rejects DELETE', async () => {
		expect((await invoke('DELETE')).status).toBe(405);
	});
});
