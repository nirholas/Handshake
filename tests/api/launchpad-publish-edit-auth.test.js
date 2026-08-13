// POST /api/launchpad/publish: who may overwrite a published Launchpad page.
//
// The studio publishes anonymously, so the slug row IS the account: the first
// publisher gets an `ownerSecret` and only that secret (or the session that
// created the row) may republish. Every one of those decisions is made by the
// write statements themselves (a claiming `INSERT ... ON CONFLICT DO NOTHING`
// followed by an `UPDATE` whose WHERE re-asserts the secret/session match), so
// there is no read-then-write window for a second publisher to slip through.
//
// The regression these pin: the handler used to SELECT the row first and decide
// in JavaScript. Two first publishes of the same slug racing each other both
// read "no row", both minted a secret, and both returned 200. The loser silently
// overwrote the winner's page and walked away with a secret that hashed to
// nothing in the table, so it could never edit again. Verified against a real
// Postgres before the fix (two concurrent publishes, both 200, one stored hash).
//
// DB / auth / limiter are mocked so the suite stays offline; the assertions are
// on the SQL text and bound parameters, which is where the guard now lives.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { invoke } from '../_helpers/monetization.js';

// ── SQL mock ─────────────────────────────────────────────────────────────────
// Two statements can reach the DB: the claiming INSERT and the guarded UPDATE.
// `insertClaims` decides whether the INSERT won the slug; `updateReturns`
// decides whether the UPDATE matched an authorized row (and what secret hash it
// left behind). Every call is recorded so the guard's parameters are assertable.
let insertClaims = true;
let updateReturns = null; // null = no authorized row matched
let calls = [];

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	calls.push({ q, values });
	if (/INSERT INTO launchpad_pages/i.test(q)) {
		return Promise.resolve(insertClaims ? [{ slug: values[0] }] : []);
	}
	if (/UPDATE launchpad_pages/i.test(q)) {
		return Promise.resolve(updateReturns ? [updateReturns] : []);
	}
	return Promise.resolve([]);
});
sqlMock.transaction = (queries) => Promise.all(queries);
vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000, limit: 60, remaining: 59 })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: publish } = await import('../../api/launchpad/publish.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function draft(overrides = {}) {
	return {
		slug: 'audit-page',
		template: 'paid-concierge',
		identity: {
			brand: '#22d3ee',
			wallet: '0x00000000000000000000000000000000000000aa',
			theme: 'dark',
		},
		avatar: { src: 'https://three.ws/cdn/a.glb', name: 'Ava' },
		copy: { headline: 'Ask Ava', tagline: 'Concierge', cta: 'Ask' },
		monetize: { kind: 'per-question', price: 0.25, currency: 'USDC', chain: 'base' },
		...overrides,
	};
}

const post = (body) =>
	invoke(publish, { method: 'POST', url: '/api/launchpad/publish', body });

const findCall = (re) => calls.find((c) => re.test(c.q));

beforeEach(() => {
	sqlMock.mockClear();
	calls = [];
	insertClaims = true;
	updateReturns = null;
	sessionUser = null;
});

describe('POST /api/launchpad/publish: claiming a slug', () => {
	it('first publish claims the slug with a conflict-safe INSERT and returns the secret', async () => {
		const { status, body } = await post(draft());

		expect(status).toBe(200);
		expect(body.slug).toBe('audit-page');
		expect(body.url).toMatch(/\/p\/audit-page$/);
		expect(body.ownerSecret).toMatch(/^[0-9a-f]{64}$/);

		const insert = findCall(/INSERT INTO launchpad_pages/i);
		expect(insert).toBeTruthy();
		// The claim must not overwrite an existing row on conflict.
		expect(insert.q).toMatch(/ON CONFLICT \(slug\) DO NOTHING/i);
		// The stored hash is the hash of the secret handed to the caller.
		expect(insert.values).toContain(sha256(body.ownerSecret));
		// A won claim ends the request: no UPDATE follows it.
		expect(findCall(/UPDATE launchpad_pages/i)).toBeUndefined();
	});

	it('losing the claim race with no credentials is 409 and yields no secret', async () => {
		insertClaims = false; // another publisher inserted the row first
		updateReturns = null; // and the edit guard matches nothing

		const { status, body } = await post(draft());

		expect(status).toBe(409);
		expect(body.error).toBe('slug_taken');
		expect(body.ownerSecret).toBeUndefined();
		expect(findCall(/UPDATE launchpad_pages/i)).toBeTruthy();
	});

	it('never returns a secret the database did not store', async () => {
		insertClaims = false;
		// The row already had a secret, so the UPDATE leaves it untouched.
		updateReturns = { owner_secret_hash: sha256('the-real-owners-secret') };

		const { status, body } = await post(draft({ ownerSecret: 'x'.repeat(64) }));

		expect(status).toBe(200);
		expect(body.ownerSecret).toBeUndefined();
	});
});

describe('POST /api/launchpad/publish: editing a published slug', () => {
	it('binds the provided secret hash into the UPDATE guard, never the raw secret', async () => {
		insertClaims = false;
		const secret = 'a'.repeat(64);
		updateReturns = { owner_secret_hash: sha256(secret) };

		const { status } = await post(draft({ ownerSecret: secret }));

		expect(status).toBe(200);
		const update = findCall(/UPDATE launchpad_pages/i);
		expect(update.q).toMatch(/WHERE slug =/i);
		expect(update.q).toMatch(/owner_secret_hash =/i);
		expect(update.values).toContain(sha256(secret));
		expect(update.values).not.toContain(secret);
	});

	it('keeps a launched mint when the republished draft predates the launch', async () => {
		insertClaims = false;
		updateReturns = { owner_secret_hash: sha256('s') };

		await post(draft({ ownerSecret: 'b'.repeat(64) }));

		const update = findCall(/UPDATE launchpad_pages/i);
		expect(update.q).toMatch(/token_mint\s*=\s*COALESCE/i);
	});

	it('offers the session user as an alternative to the secret', async () => {
		insertClaims = false;
		sessionUser = { id: USER_ID };
		updateReturns = { owner_secret_hash: sha256('someone-elses') };

		const { status } = await post(draft());

		expect(status).toBe(200);
		const update = findCall(/UPDATE launchpad_pages/i);
		expect(update.q).toMatch(/user_id =/i);
		expect(update.values).toContain(USER_ID);
	});

	it('mints a secret for a legacy row that had none, once ownership is proven', async () => {
		insertClaims = false;
		sessionUser = { id: USER_ID };
		// Capture the hash the UPDATE tried to COALESCE in, and echo it back as the
		// stored value, exactly what Postgres does for a row with a NULL hash.
		sqlMock.mockImplementation((strings, ...values) => {
			const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
			calls.push({ q, values });
			if (/INSERT INTO launchpad_pages/i.test(q)) return Promise.resolve([]);
			if (/UPDATE launchpad_pages/i.test(q)) {
				// The minted hash is the parameter bound into COALESCE(owner_secret_hash, $n).
				const minted = values.find((v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v));
				return Promise.resolve([{ owner_secret_hash: minted }]);
			}
			return Promise.resolve([]);
		});

		const { status, body } = await post(draft());

		expect(status).toBe(200);
		expect(body.ownerSecret).toMatch(/^[0-9a-f]{64}$/);
		const update = findCall(/UPDATE launchpad_pages/i);
		expect(update.values).toContain(sha256(body.ownerSecret));
	});
});

describe('POST /api/launchpad/publish: input boundary', () => {
	it('rejects a malformed slug before touching the database', async () => {
		const { status, body } = await post(draft({ slug: 'Not A Slug' }));

		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(calls).toHaveLength(0);
	});

	it('rejects a payout wallet that does not match the settlement chain', async () => {
		const { status, body } = await post(
			draft({ monetize: { kind: 'per-question', price: 1, currency: 'USDC', chain: 'solana' } }),
		);

		expect(status).toBe(400);
		expect(body.error_description).toMatch(/solana address/);
		expect(calls).toHaveLength(0);
	});
});
