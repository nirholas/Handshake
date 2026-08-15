// Consent gate and revocation for X memory seeding.
//
// tests/api/x-memory-seed-transform.test.js pins the pure transform (what gets
// read, what gets stored, what never does). This file pins the half that decides
// whether the transform is allowed to run at all, and the half that undoes it:
//
//   - a POST without an explicit, current-version acceptance reads nothing from
//     X and burns none of the owner's re-seed budget,
//   - a grant stops authorizing seeds when the disclosure text moves on or the
//     connection starts pointing at a different X account,
//   - revoking deletes every memory the grant produced and clears the seed
//     stamp off the agent, whether or not a grant row survives to revoke.
//
// The handler and api/_lib/x-seed-consent.js both run for real against a routed
// `sql` double, so the actual DELETE predicate (match on the x_seed tag) is what
// gets asserted rather than a restatement of it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const AGENT = '99999999-8888-4777-8666-555555555555';
const OWNER = 'user-1';

// Routed `sql` double: each handler query is matched on its text, so a test
// states only the rows it cares about instead of counting positions in a queue.
const dbState = {
	agent: null,
	connection: null,
	consent: null,
	seededCount: 0,
	deletedMemoryIds: [],
	revokedConsentIds: [],
	queries: [],
	inserts: [],
};

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		const q = (Array.isArray(strings) ? strings.join('?') : String(strings))
			.replace(/\s+/g, ' ')
			.trim();
		dbState.queries.push({ q, values });

		if (/FROM agent_identities/i.test(q)) return dbState.agent ? [dbState.agent] : [];
		if (/FROM social_connections/i.test(q)) return dbState.connection ? [dbState.connection] : [];
		if (/FROM x_memory_consents/i.test(q)) return dbState.consent ? [dbState.consent] : [];
		if (/count\(\*\)::int AS count FROM agent_memories/i.test(q)) {
			return [{ count: dbState.seededCount }];
		}
		if (/^INSERT INTO x_memory_consents/i.test(q)) {
			dbState.consent = {
				id: 'consent-new',
				x_user_id: values[2],
				username: values[3],
				scope_version: values[4],
				granted_scopes: values[6] ?? null,
				granted_at: '2026-08-15T00:00:00.000Z',
				last_seeded_at: null,
				memories_seeded: 0,
				posts_read: 0,
			};
			return [dbState.consent];
		}
		if (/^INSERT INTO agent_memories/i.test(q)) {
			dbState.inserts.push(values);
			return [];
		}
		if (/^UPDATE x_memory_consents SET revoked_at/i.test(q)) {
			const ids = dbState.consent ? [{ id: dbState.consent.id, agent_id: AGENT }] : [];
			dbState.revokedConsentIds = ids;
			dbState.consent = null;
			return ids;
		}
		if (/^DELETE FROM agent_memories/i.test(q)) {
			const rows = dbState.deletedMemoryIds.map((id) => ({ id, agent_id: AGENT }));
			dbState.seededCount = 0;
			dbState.deletedMemoryIds = [];
			return rows;
		}
		return [];
	});
	return {
		sql,
		isDbUnavailableError: () => false,
		isDbCapacityError: () => false,
		isStoragePressured: () => false,
	};
});

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

const xSeed = vi.fn(async () => ({ success: true, limit: 1, remaining: 0, reset: 1 }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		xSeed: (...a) => xSeed(...a),
		authIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: { X_OAUTH_CLIENT_ID: 'test-client-id', X_OAUTH_CLIENT_SECRET: 'test-client-secret' },
}));

const llmComplete = vi.fn(async () => ({ text: '[]' }));
vi.mock('../../api/_lib/llm.js', () => ({ llmComplete: (...a) => llmComplete(...a) }));

vi.mock('../../api/auth/x/[action].js', () => ({
	decryptToken: vi.fn(() => 'plaintext-access-token'),
	encryptToken: vi.fn((t) => `enc:${t}`),
}));

const { default: handler } = await import('../../api/agents/[id]/memory-seed-x.js');
const { X_SEED_DISCLOSURE, X_SEED_SCOPE_VERSION } = await import(
	'../../api/_lib/x-memory-seed.js'
);

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload ?? null; },
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

async function call({ method = 'GET', id = AGENT, body } = {}) {
	const req = {
		method,
		url: `/api/agents/${id}/memory/seed/x`,
		headers: {},
		socket: {},
		query: { id },
	};
	if (body !== undefined) {
		req.body = body;
		req.headers['content-type'] = 'application/json';
	}
	const res = mockRes();
	await handler(req, res);
	return res;
}

function liveConnection(overrides = {}) {
	return {
		id: 'conn-1',
		provider_uid: 'x-account-42',
		username: 'qauser',
		scopes: 'tweet.read users.read offline.access',
		access_token: 'enc-access',
		refresh_token: 'enc-refresh',
		expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		...overrides,
	};
}

function liveConsent(overrides = {}) {
	return {
		id: 'consent-1',
		x_user_id: 'x-account-42',
		username: 'qauser',
		scope_version: X_SEED_SCOPE_VERSION,
		granted_scopes: 'tweet.read users.read offline.access',
		granted_at: '2026-08-11T00:00:00.000Z',
		last_seeded_at: null,
		memories_seeded: 0,
		posts_read: 0,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	authState.session = { id: OWNER, email: 'qa@three.ws' };
	dbState.agent = { id: AGENT, user_id: OWNER, x_username: null, x_seeded_at: null };
	dbState.connection = null;
	dbState.consent = null;
	dbState.seededCount = 0;
	dbState.deletedMemoryIds = [];
	dbState.revokedConsentIds = [];
	dbState.queries = [];
	dbState.inserts = [];
	xSeed.mockResolvedValue({ success: true, limit: 1, remaining: 0, reset: 1 });
	vi.stubGlobal('fetch', vi.fn(async () => {
		throw new Error('the network must not be touched on a refusal path');
	}));
});

describe('GET /api/agents/:id/memory/seed/x', () => {
	it('requires a session', async () => {
		authState.session = null;
		const res = await call();
		expect(res.statusCode).toBe(401);
		expect(res.json).toMatchObject({ error: 'unauthorized' });
	});

	it('refuses an agent the caller does not own', async () => {
		dbState.agent = { id: AGENT, user_id: 'someone-else', x_username: null, x_seeded_at: null };
		const res = await call();
		expect(res.statusCode).toBe(403);
		expect(res.json).toMatchObject({ error: 'forbidden' });
	});

	it('serves the disclosure verbatim so the consent screen never carries its own copy', async () => {
		dbState.connection = liveConnection();
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.json.disclosure).toEqual(JSON.parse(JSON.stringify(X_SEED_DISCLOSURE)));
		expect(res.json.scope_version).toBe(X_SEED_SCOPE_VERSION);
		expect(res.json).toMatchObject({ connected: true, configured: true, username: 'qauser' });
		expect(res.json.consent).toMatchObject({ granted: false, reason: 'none' });
	});

	it('reports a connection that is present but not yet consented as ungranted', async () => {
		dbState.connection = liveConnection();
		dbState.seededCount = 0;
		const res = await call();
		expect(res.json.consent.granted).toBe(false);
		expect(res.json.fact_count).toBe(0);
	});

	it('retires a grant whose disclosure version has moved on', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent({ scope_version: '2020-01-01.0' });
		const res = await call();
		expect(res.json.consent).toMatchObject({ granted: false, reason: 'scope_version_changed' });
	});

	it('retires a grant when the connection now points at a different X account', async () => {
		dbState.connection = liveConnection({ provider_uid: 'x-account-99' });
		dbState.consent = liveConsent();
		const res = await call();
		expect(res.json.consent).toMatchObject({ granted: false, reason: 'account_changed' });
	});

	it('reports a live grant as active', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent({ last_seeded_at: '2026-08-12T00:00:00.000Z', memories_seeded: 12 });
		dbState.seededCount = 12;
		const res = await call();
		expect(res.json.consent).toMatchObject({
			granted: true,
			reason: 'active',
			username: 'qauser',
			memories_seeded: 12,
		});
		expect(res.json.fact_count).toBe(12);
	});
});

describe('POST /api/agents/:id/memory/seed/x consent gate', () => {
	it('reads nothing from X and records no grant when consent is absent', async () => {
		dbState.connection = liveConnection();
		const res = await call({ method: 'POST', body: {} });

		expect(res.statusCode).toBe(403);
		expect(res.json).toMatchObject({ error: 'consent_required' });
		expect(res.json.disclosure).toEqual(JSON.parse(JSON.stringify(X_SEED_DISCLOSURE)));
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(dbState.queries.some((c) => /INSERT INTO x_memory_consents/i.test(c.q))).toBe(false);
	});

	it('does not burn the re-seed budget on a refused call', async () => {
		dbState.connection = liveConnection();
		await call({ method: 'POST', body: {} });
		expect(xSeed).not.toHaveBeenCalled();
	});

	it('refuses an acceptance pinned to a disclosure version that is no longer current', async () => {
		dbState.connection = liveConnection();
		const res = await call({
			method: 'POST',
			body: { consent: { accepted: true, scope_version: '2020-01-01.0' } },
		});
		expect(res.statusCode).toBe(403);
		expect(res.json).toMatchObject({ error: 'consent_required' });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('refuses an acceptance that carries the right version but never says yes', async () => {
		dbState.connection = liveConnection();
		const res = await call({
			method: 'POST',
			body: { consent: { accepted: false, scope_version: X_SEED_SCOPE_VERSION } },
		});
		expect(res.statusCode).toBe(403);
		expect(res.json).toMatchObject({ error: 'consent_required' });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('refuses to seed at all without a live X connection', async () => {
		dbState.connection = null;
		const res = await call({
			method: 'POST',
			body: { consent: { accepted: true, scope_version: X_SEED_SCOPE_VERSION } },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json).toMatchObject({ error: 'not_connected' });
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(xSeed).not.toHaveBeenCalled();
	});

	it('requires a session before anything else', async () => {
		authState.session = null;
		const res = await call({
			method: 'POST',
			body: { consent: { accepted: true, scope_version: X_SEED_SCOPE_VERSION } },
		});
		expect(res.statusCode).toBe(401);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('POST /api/agents/:id/memory/seed/x seeding', () => {
	const profilePayload = {
		data: {
			id: 'x-account-42',
			username: 'qauser',
			name: 'QA User',
			description: 'Builds agent tooling on Solana',
			public_metrics: { followers_count: 300, following_count: 120 },
		},
	};
	const postsPayload = {
		data: [
			{ text: 'Shipping the retargeting rig today, legs finally land right.', created_at: '2026-08-10T00:00:00Z' },
			{ text: 'Solana settlement latency is the whole product, everything else is UI.', created_at: '2026-08-09T00:00:00Z' },
			{ text: 'Spent the morning deleting code. Best refactor of the week.', created_at: '2026-08-08T00:00:00Z' },
		],
	};

	function stubXApi() {
		vi.stubGlobal('fetch', vi.fn(async (url) => {
			if (String(url).includes('/2/users/me')) {
				return { ok: true, json: async () => profilePayload };
			}
			return { ok: true, json: async () => postsPayload };
		}));
	}

	it('grants consent, reads X once, and writes tagged memory rows', async () => {
		dbState.connection = liveConnection();
		stubXApi();
		llmComplete.mockResolvedValue({
			text: JSON.stringify([
				'Works on avatar retargeting and rigging.',
				'Believes settlement latency is the core of a payments product.',
				'Prefers deleting code over adding it.',
			]),
		});

		const res = await call({
			method: 'POST',
			body: { consent: { accepted: true, scope_version: X_SEED_SCOPE_VERSION } },
		});

		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ username: 'qauser', seeded: 3, posts_read: 3, distilled_by: 'model' });
		expect(xSeed).toHaveBeenCalledWith(AGENT);
		expect(dbState.inserts).toHaveLength(3);

		// Every stored row carries the tag revocation matches on, and the consent
		// id that authorized it.
		for (const values of dbState.inserts) {
			expect(values.some((v) => Array.isArray(v) && v.includes('x_seed'))).toBe(true);
			const ctx = values.find((v) => typeof v === 'string' && v.includes('consent_id'));
			expect(JSON.parse(ctx)).toMatchObject({ source: 'x_seed', consent_id: 'consent-new' });
		}
	});

	it('replaces the previous batch instead of stacking a second generation', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent();
		stubXApi();
		llmComplete.mockResolvedValue({ text: JSON.stringify(['Ships avatar tooling.']) });

		const res = await call({ method: 'POST', body: {} });

		expect(res.statusCode).toBe(200);
		const deletes = dbState.queries.filter((c) => /^DELETE FROM agent_memories/i.test(c.q));
		expect(deletes.length).toBe(1);
		expect(deletes[0].q).toMatch(/tags && ARRAY/i);
	});

	it('refuses when the connected account is not the account that consented', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent();
		vi.stubGlobal('fetch', vi.fn(async (url) => {
			if (String(url).includes('/2/users/me')) {
				return {
					ok: true,
					json: async () => ({ data: { ...profilePayload.data, id: 'x-account-77' } }),
				};
			}
			return { ok: true, json: async () => postsPayload };
		}));

		const res = await call({ method: 'POST', body: {} });

		expect(res.statusCode).toBe(409);
		expect(res.json).toMatchObject({ error: 'account_mismatch' });
		expect(dbState.inserts).toHaveLength(0);
	});

	it('still seeds from derived facts when the distiller is unavailable', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent();
		stubXApi();
		llmComplete.mockRejectedValue(new Error('no provider'));

		const res = await call({ method: 'POST', body: {} });

		expect(res.statusCode).toBe(200);
		expect(res.json.distilled_by).toBe('derived');
		expect(res.json.seeded).toBeGreaterThan(0);
	});

	it('reports the re-seed window instead of reading X again', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent();
		xSeed.mockResolvedValue({ success: false, limit: 1, remaining: 0, reset: 60 });

		const res = await call({ method: 'POST', body: {} });

		expect(res.statusCode).toBe(429);
		expect(res.json).toMatchObject({ error: 'rate_limited' });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('DELETE /api/agents/:id/memory/seed/x', () => {
	it('revokes the grant and deletes every memory it produced', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent();
		dbState.seededCount = 4;
		dbState.deletedMemoryIds = ['m1', 'm2', 'm3', 'm4'];

		const res = await call({ method: 'DELETE' });

		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({
			revoked: true,
			deleted: 4,
			consents_revoked: 1,
			remaining: 0,
		});
		expect(res.json.consent).toMatchObject({ granted: false, reason: 'revoked' });
	});

	it('deletes on the x_seed tag, so rows from a superseded grant go too', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent();
		dbState.deletedMemoryIds = ['m1'];

		await call({ method: 'DELETE' });

		const del = dbState.queries.find((c) => /^DELETE FROM agent_memories/i.test(c.q));
		expect(del.q).toMatch(/tags && ARRAY/i);
		expect(del.q).not.toMatch(/consent_id/i);
		expect(del.values).toContain('x_seed');
	});

	it('clears the seed stamp off the agent so the UI stops claiming a seed', async () => {
		dbState.connection = liveConnection();
		dbState.consent = liveConsent();
		dbState.deletedMemoryIds = ['m1'];

		await call({ method: 'DELETE' });

		const stamp = dbState.queries.find(
			(c) => /^UPDATE agent_identities SET x_username = NULL/i.test(c.q),
		);
		expect(stamp).toBeTruthy();
	});

	it('is idempotent and still purges when no grant row survives to revoke', async () => {
		dbState.connection = liveConnection();
		dbState.consent = null;
		dbState.seededCount = 2;
		dbState.deletedMemoryIds = ['orphan-1', 'orphan-2'];

		const res = await call({ method: 'DELETE' });

		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ revoked: true, deleted: 2, consents_revoked: 0, remaining: 0 });
	});

	it('requires a session and ownership', async () => {
		authState.session = null;
		expect((await call({ method: 'DELETE' })).statusCode).toBe(401);

		authState.session = { id: OWNER };
		dbState.agent = { id: AGENT, user_id: 'someone-else', x_username: null, x_seeded_at: null };
		expect((await call({ method: 'DELETE' })).statusCode).toBe(403);
	});
});
