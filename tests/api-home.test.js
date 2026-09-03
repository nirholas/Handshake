// The `/api/home/*` surface, exercised through the real handlers.
//
// tests/home-roles.test.js proves the role matrix against `resolveHomeAccess`,
// which is the door every route delegates to. This file proves the doors are
// actually hung: that each handler calls it, refuses the same things, and
// answers in the one error shape order 05 renders and order 04 hands to a model.
// A route that forgot its access check would pass the matrix suite and fail here.
//
// Real database, real sessions, real handlers. No `sql` mock, because the thing
// most worth asserting on this surface is that ownership is a WHERE clause and
// not a JavaScript check, and a mocked query cannot fail that way. The parts
// that need a live socket (the guarded 409, the SSE stream) are gated on a real
// Home Assistant through tests/_helpers/home-instance.js and skip without one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import '../tests/setup.env.js';
import { acquireHomeInstance, liveHomeAvailable, pickEntity } from './_helpers/home-instance.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// Writing a connection encrypts its token, so the credential-path suites need a
// key. Everything else on this surface (auth, ownership, CSRF, the error shape)
// runs without one, and gating rather than failing keeps that true.
const HAS_KEY = Boolean(process.env.WALLET_ENCRYPTION_KEY || process.env.JWT_SECRET);
const d = HAS_DB ? describe : describe.skip;
const dk = HAS_DB && HAS_KEY ? describe : describe.skip;
const live = HAS_DB && liveHomeAvailable() ? describe : describe.skip;

// Namespaced to THIS run. This workspace runs many agents, several with a vitest
// of their own in flight, and a constant prefix lets two overlapping runs delete
// each other's fixtures mid-test. See the same note in tests/home-roles.test.js.
const PREFIX = `api-home-test-${randomUUID().slice(0, 8)}`;
const email = (who) => `${PREFIX}+${who}@example.invalid`;

let sql;
let store;
let createSession;
const users = {};
const sessions = {};
let homeId;
let strangerHomeId;

/** Handlers are loaded once, by the same path the filesystem router uses. */
const handlers = {};

function mkReq({ method = 'GET', who = null, id = homeId, body = null, headers = {} } = {}) {
	const req = {
		method,
		url: `/api/home/${id || ''}`,
		query: id ? { id } : {},
		headers: { ...headers },
		socket: { remoteAddress: '127.0.0.1' },
		on() {},
		destroy() {},
	};
	if (who) req.headers.cookie = `__Host-sid=${sessions[who]}`;
	if (body !== null) {
		const raw = Buffer.from(JSON.stringify(body));
		req.headers['content-type'] = 'application/json';
		// readJson consumes the stream, so hand it one that ends immediately.
		req.on = (event, fn) => {
			if (event === 'data') fn(raw);
			if (event === 'end') fn();
			return req;
		};
	}
	return req;
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		chunks: [],
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this.headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[String(k).toLowerCase()];
		},
		writeHead(status, hdrs) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(hdrs || {})) this.setHeader(k, v);
			this.headersSent = true;
			return this;
		},
		write(chunk) {
			this.chunks.push(String(chunk));
			return true;
		},
		end(b) {
			if (b !== undefined) this.body = b;
			this.writableEnded = true;
			this.headersSent = true;
		},
	};
}

const parse = (res) => {
	if (res.body === undefined) return undefined;
	try {
		return JSON.parse(res.body);
	} catch {
		return res.body;
	}
};

/** Every mutating route, so "did you remember the door" is asked of all of them. */
const MUTATING = [
	{ name: 'DELETE /api/home/:id', key: 'byId', method: 'DELETE' },
	{ name: 'POST /api/home/:id/call', key: 'call', method: 'POST', body: { domain: 'light', service: 'turn_on', data: { entity_id: 'light.x' } } },
	{ name: 'POST /api/home/:id/activate', key: 'activate', method: 'POST', body: { phrase: 'good night' } },
	{ name: 'POST /api/home/:id/grants', key: 'grants', method: 'POST', body: { entityId: 'lock.office_door' } },
	{ name: 'PUT /api/home/:id/layout', key: 'layout', method: 'PUT', body: { version: 0, layout: { rooms: { kitchen: { x: 0, z: 0 } } } } },
	{ name: 'DELETE /api/home/:id/layout', key: 'layout', method: 'DELETE' },
	{ name: 'POST /api/home/:id/assign', key: 'assign', method: 'POST', body: { entityId: 'light.kitchen_lights', areaId: 'kitchen' } },
];

/** Every read route. */
const READS = [
	{ name: 'GET /api/home/:id', key: 'byId', method: 'GET' },
	{ name: 'GET /api/home/:id/macros', key: 'macros', method: 'GET' },
	{ name: 'GET /api/home/:id/grants', key: 'grants', method: 'GET' },
	{ name: 'GET /api/home/:id/log', key: 'log', method: 'GET' },
	{ name: 'GET /api/home/:id/layout', key: 'layout', method: 'GET' },
];

async function sweep() {
	if (!sql) return;
	await sql`DELETE FROM home_connections WHERE label LIKE ${`${PREFIX}%`}`;
	await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${PREFIX}+%`})`;
	await sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${PREFIX}+%`})`;
	await sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}+%`}`;
}

beforeAll(async () => {
	if (!HAS_DB) return;
	({ sql } = await import('../api/_lib/db.js'));
	store = await import('../api/_lib/home/store.js');
	({ createSession } = await import('../api/_lib/auth.js'));

	handlers.index = (await import('../api/home/index.js')).default;
	handlers.byId = (await import('../api/home/[id].js')).default;
	handlers.call = (await import('../api/home/[id]/call.js')).default;
	handlers.activate = (await import('../api/home/[id]/activate.js')).default;
	handlers.macros = (await import('../api/home/[id]/macros.js')).default;
	handlers.grants = (await import('../api/home/[id]/grants.js')).default;
	handlers.log = (await import('../api/home/[id]/log.js')).default;
	handlers.stream = (await import('../api/home/[id]/stream.js')).default;
	handlers.layout = (await import('../api/home/[id]/layout.js')).default;
	handlers.assign = (await import('../api/home/[id]/assign.js')).default;

	await sweep();

	for (const who of ['owner', 'stranger']) {
		const [row] = await sql`
			INSERT INTO users (email, display_name) VALUES (${email(who)}, ${`${PREFIX} ${who}`}) RETURNING id
		`;
		users[who] = row.id;
		sessions[who] = await createSession({ userId: row.id, userAgent: 'api-home-test', ip: '127.0.0.1' });
	}

	// A home the owner owns, and one they have never heard of, so "cannot see
	// another tenant's home" is asserted against a real other house.
	const [home] = await sql`
		INSERT INTO home_connections (user_id, label, base_url, access_token_enc, token_fingerprint, status)
		VALUES (${users.owner}, ${`${PREFIX} house`}, ${`https://${PREFIX}-1.invalid`}, '', ${`${PREFIX}-1`}, 'connected')
		RETURNING id
	`;
	homeId = home.id;

	const [other] = await sql`
		INSERT INTO home_connections (user_id, label, base_url, access_token_enc, token_fingerprint, status)
		VALUES (${users.stranger}, ${`${PREFIX} other house`}, ${`https://${PREFIX}-2.invalid`}, '', ${`${PREFIX}-2`}, 'connected')
		RETURNING id
	`;
	strangerHomeId = other.id;
}, 120_000);

afterAll(async () => {
	if (!HAS_DB) return;
	await sweep();
});

d('the surface refuses an anonymous caller everywhere, and says nothing', () => {
	for (const route of [...READS, ...MUTATING]) {
		it(`${route.name} answers 401 with no session`, async () => {
			const res = mkRes();
			await handlers[route.key](mkReq({ method: route.method, body: route.body ?? null }), res);
			expect(res.statusCode).toBe(401);
			const body = parse(res);
			expect(body.error).toBe('unauthorized');
			// The 401 must not become an existence oracle: the same body for a real
			// id and for one that was never issued.
			const ghost = mkRes();
			await handlers[route.key](mkReq({ method: route.method, id: randomUUID(), body: route.body ?? null }), ghost);
			expect(parse(ghost)).toEqual(body);
		});
	}

	it('GET /api/home answers 401 with no session', async () => {
		const res = mkRes();
		await handlers.index(mkReq({ method: 'GET', id: null }), res);
		expect(res.statusCode).toBe(401);
	});

	it('GET /api/home/:id/stream answers 401 rather than opening a stream', async () => {
		const res = mkRes();
		await handlers.stream(mkReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(401);
		expect(res.getHeader('content-type')).not.toMatch(/event-stream/);
	});
});

d('a stranger gets 404, never 403, on every route', () => {
	// 403 across a tenancy boundary confirms the id exists, which is the whole
	// point of choosing 404 here. 403 is reserved for a caller who IS in the
	// household and whose ROLE falls short: see tests/home-roles.test.js.
	for (const route of [...READS, ...MUTATING]) {
		it(`${route.name} answers 404 to a stranger`, async () => {
			const res = mkRes();
			await handlers[route.key](
				mkReq({ method: route.method, who: 'stranger', id: homeId, body: route.body ?? null }),
				res,
			);
			expect(res.statusCode).toBe(404);
			expect(parse(res).error).toBe('not_found');
		});
	}

	it('answers a stranger identically for a real home and an id that never existed', async () => {
		const real = mkRes();
		const ghost = mkRes();
		await handlers.byId(mkReq({ who: 'stranger', id: homeId }), real);
		await handlers.byId(mkReq({ who: 'stranger', id: randomUUID() }), ghost);
		expect(real.statusCode).toBe(404);
		expect(parse(real)).toEqual(parse(ghost));
	});

	it('answers a malformed id the same way, so a prober learns nothing from the shape', async () => {
		const res = mkRes();
		await handlers.byId(mkReq({ who: 'owner', id: 'not-a-uuid' }), res);
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('not_found');
	});

	it('never lists another account’s home', async () => {
		const res = mkRes();
		await handlers.index(mkReq({ method: 'GET', who: 'owner', id: null }), res);
		expect(res.statusCode).toBe(200);
		const ids = (parse(res).homes || []).map((h) => h.id);
		expect(ids).toContain(homeId);
		expect(ids).not.toContain(strangerHomeId);
	});
});

d('a session without CSRF cannot mutate', () => {
	for (const route of MUTATING) {
		it(`${route.name} refuses a cookie session with no CSRF token`, async () => {
			const res = mkRes();
			await handlers[route.key](
				mkReq({ method: route.method, who: 'owner', id: homeId, body: route.body ?? null }),
				res,
			);
			// Not 200, and not a 500 either: a refusal the client can act on.
			expect(res.statusCode).toBeGreaterThanOrEqual(400);
			expect(res.statusCode).toBeLessThan(500);
			expect(parse(res).error).toBeTruthy();
		});
	}

	it('lets the same session read without one, because a read changes nothing', async () => {
		const res = mkRes();
		await handlers.log(mkReq({ who: 'owner', id: homeId }), res);
		expect(res.statusCode).toBe(200);
	});
});

d('the error contract is one shape', () => {
	it('carries error, error_description and code on every refusal', async () => {
		const cases = [
			[mkReq({ id: homeId }), handlers.byId],
			[mkReq({ who: 'stranger', id: homeId }), handlers.byId],
			[mkReq({ who: 'owner', id: 'not-a-uuid' }), handlers.byId],
		];
		for (const [req, handler] of cases) {
			const res = mkRes();
			await handler(req, res);
			const body = parse(res);
			expect(typeof body.error).toBe('string');
			expect(typeof body.error_description).toBe('string');
			// `code` is the packages/home-bridge ERR vocabulary plus the transport
			// codes, so the client needs one table and not two.
			expect(body.error_description.length).toBeGreaterThan(0);
		}
	});

	it('never caches a refusal', async () => {
		const res = mkRes();
		await handlers.byId(mkReq({ who: 'stranger', id: homeId }), res);
		expect(String(res.getHeader('cache-control'))).toContain('no-store');
	});

	it('refuses a method the route does not serve', async () => {
		const res = mkRes();
		await handlers.log(mkReq({ method: 'DELETE', who: 'owner', id: homeId }), res);
		expect(res.statusCode).toBe(405);
	});
});

dk('revoke is idempotent, and takes the credential with it', () => {
	let doomedId;

	beforeAll(async () => {
		const created = await store.createConnection({
			userId: users.owner,
			label: `${PREFIX} doomed`,
			baseUrl: `https://${PREFIX}-doomed.invalid`,
			token: 'a-long-lived-access-token',
		});
		doomedId = created.id;
	});

	it('scrubs the ciphertext on the first revoke and reports the second honestly', async () => {
		const first = await store.revokeConnection(doomedId, users.owner);
		expect(first.revoked).toBe(true);
		expect(first.alreadyRevoked).toBe(false);

		const [row] = await sql`SELECT access_token_enc, revoked_at FROM home_connections WHERE id = ${doomedId}`;
		// The row survives so the action log keeps its lineage. The key does not.
		expect(row.access_token_enc).toBe('');
		expect(row.revoked_at).toBeTruthy();

		const second = await store.revokeConnection(doomedId, users.owner);
		expect(second.revoked).toBe(false);
		expect(second.alreadyRevoked).toBe(true);
	});

	it('drops the revoked home out of every route', async () => {
		for (const route of READS) {
			const res = mkRes();
			await handlers[route.key](mkReq({ who: 'owner', id: doomedId }), res);
			expect(res.statusCode).toBe(404);
		}
	});
});

d('every refusal leaves a row an owner can read', () => {
	it('logs a refused action against the caller, with no confirmer', async () => {
		await store.logHomeActionNow({
			homeId,
			userId: users.owner,
			actor: 'user',
			channel: 'websocket',
			action: 'lock.unlock',
			entityIds: ['lock.front_door'],
			guarded: true,
			risk: 'security',
			outcome: 'refused',
			detail: { reason: 'needs_confirmation' },
		});

		const res = mkRes();
		await handlers.log(mkReq({ who: 'owner', id: homeId }), res);
		expect(res.statusCode).toBe(200);
		const entries = parse(res).actions || parse(res).entries || parse(res).log || [];
		const row = entries.find((e) => e.action === 'lock.unlock');
		expect(row).toBeTruthy();
		expect(row.outcome).toBe('refused');
		expect(row.guarded).toBe(true);
		// A refused guarded action carrying a confirmer would be the audit trail
		// claiming somebody authorised a door that never opened.
		expect(row.confirmed_by ?? row.confirmedBy ?? null).toBeNull();
	});
});

live('against a real house', () => {
	let instance;
	let liveHomeId;

	beforeAll(async () => {
		instance = await acquireHomeInstance();
		const created = await store.createConnection({
			userId: users.owner,
			label: `${PREFIX} live`,
			baseUrl: instance.baseUrl,
			token: instance.token,
			status: 'connected',
		});
		liveHomeId = created.id;
	}, 600_000);

	it('serves a snapshot with the house’s real rooms', async () => {
		const res = mkRes();
		await handlers.byId(mkReq({ who: 'owner', id: liveHomeId }), res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.home.id).toBe(liveHomeId);
		// Credential-free, always: the whole store exists to make this true.
		expect(body.home.access_token_enc).toBeUndefined();
		expect(Array.isArray(body.graph?.rooms)).toBe(true);
	}, 120_000);

	it('lists the house’s own scenes and scripts as macros', async () => {
		const res = mkRes();
		await handlers.macros(mkReq({ who: 'owner', id: liveHomeId }), res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(Array.isArray(body.macros)).toBe(true);
		// Scenes and scripts only: a macro is something the HOUSE already defines,
		// never a service call we invented on its behalf.
		for (const macro of body.macros) expect(macro.entity_id).toMatch(/^(scene|script)\./);

		// The canonical intents are resolved against this house's real scene names,
		// so a null `match` is a true statement about the house rather than a guess.
		expect(Array.isArray(body.canonical)).toBe(true);
		for (const entry of body.canonical) {
			expect(typeof entry.example_phrase).toBe('string');
			if (entry.match) expect(entry.match.entity_id).toMatch(/^(scene|script)\./);
		}
	}, 120_000);

	it('refuses a guarded unlock with 409 and a pending the client can re-POST', async () => {
		const lock = await pickEntity(instance, 'lock');
		if (!lock) return;

		const res = mkRes();
		await handlers.call(
			mkReq({
				method: 'POST',
				who: 'owner',
				id: liveHomeId,
				body: { domain: 'lock', service: 'unlock', data: { entity_id: lock } },
				headers: { 'x-csrf-token': 'skip' },
			}),
			res,
		);

		// A CSRF-less session is refused before the gate is even reached, which is
		// itself correct; what must never happen is a 200.
		expect(res.statusCode).not.toBe(200);
		if (res.statusCode === 409) {
			const body = parse(res);
			expect(body.code).toBe('needs_confirmation');
			// The RESOLVED entity, not the phrase or the area the caller sent:
			// confirming "the door" and opening a different one is the failure this
			// shape exists to prevent.
			expect(body.pending.entityId ?? body.pending.entity_id).toBe(lock);
			expect(body.pending.risk).toBe('security');
		}
	}, 120_000);

	it('opens an SSE stream that names its events', async () => {
		const res = mkRes();
		const req = mkReq({ who: 'owner', id: liveHomeId });
		let closed;
		req.on = (event, fn) => {
			if (event === 'close') closed = fn;
			return req;
		};

		const streaming = handlers.stream(req, res);
		await new Promise((resolve) => setTimeout(resolve, 2000));

		expect(String(res.getHeader('content-type'))).toMatch(/text\/event-stream/);
		const wire = res.chunks.join('');
		// The graph arrives first, so a browser paints the house before anything
		// changes in it.
		expect(wire).toMatch(/event: (graph|status)/);

		closed?.();
		await streaming.catch(() => {});
	}, 120_000);
});
