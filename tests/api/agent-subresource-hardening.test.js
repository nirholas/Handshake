// Regression cover for the /api/agents/:id sub-resources audited on 2026-08-10.
//
// Three classes of defect are locked down here, each reproduced against a live
// local server before the fix:
//
//  1. api/agents/_id/payments.js took `limit` and `cursor` straight from the
//     query string into SQL. `?limit=abc` became `LIMIT NaN`, `?limit=-5` became
//     a negative LIMIT, and `?cursor=notauuid` became an invalid uuid literal:
//     all three 500'd. The cursor also compared random v4 uuids (`ap.id < cursor`)
//     against a `created_at` ordering, so pages silently skipped and repeated rows.
//  2. api/agents/_id/memory/pin.js accepted any string as base64. `Buffer.from`
//     never throws on malformed input, it drops the bad characters, so garbage
//     was pinned to IPFS under a real-looking CID.
//  3. reputation / unlocks / reserves returned bodies personalized by
//     authentication (`is_owner`, and the owner-only `guidance` block) under
//     `cache-control: public`. Cloud CDN fronts /api/* and keys on the URL, so
//     one owner's response could be served to the next anonymous reader.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';
const OWNER_ID = 'user-owner-1';

const authState = { session: null, bearer: null };
const sqlState = { queue: [], calls: [] };
const trustState = { reputation: null, unlocks: null, reserves: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
	isSameSiteOrigin: vi.fn(() => true),
}));

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		sqlState.calls.push({
			query: Array.isArray(strings) ? strings.join('?') : String(strings),
			values,
		});
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	});
	sql.transaction = (queries) => Promise.all(queries);
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authedReadIp: vi.fn(async () => ({ success: true })),
		agentProfileIp: vi.fn(async () => ({ success: true })),
		publicIp: vi.fn(async () => ({ success: true })),
		upload: vi.fn(async () => ({ success: true })),
		unlockClaim: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/redis.js', () => ({ getRedis: vi.fn(async () => null) }));

vi.mock('../../api/_lib/trust/wallet-reputation.js', () => ({
	getAgentReputation: vi.fn(async () => trustState.reputation),
}));
vi.mock('../../api/_lib/trust/reputation-store.js', () => ({
	saveReputation: vi.fn(async () => {}),
}));
vi.mock('../../api/_lib/trust/proof-of-reserves.js', () => ({
	getProofOfReserves: vi.fn(async (_id, opts) => ({ ...trustState.reserves, is_owner: opts.isOwner })),
}));
vi.mock('../../api/_lib/trust/access.js', () => ({
	getAgentUnlocks: vi.fn(async () => trustState.unlocks),
	claimUnlock: vi.fn(async () => ({ key: 'x' })),
	resolveUserId: vi.fn(async () => authState.session?.id ?? null),
	AccessError: class AccessError extends Error {},
}));

const { handlePayments } = await import('../../api/agents/_id/payments.js');
const { default: pinHandler } = await import('../../api/agents/_id/memory/pin.js');
const { handleReputation } = await import('../../api/agents/_id/reputation.js');
const { handleUnlocks } = await import('../../api/agents/_id/unlocks.js');
const { handleReserves } = await import('../../api/agents/_id/reserves.js');

/** Run a handler that takes (req, res, agentId) and return status/body/headers. */
async function call(handler, reqOpts, ...extra) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res, ...extra);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

beforeEach(() => {
	authState.session = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	trustState.reputation = { agent_id: AGENT_ID, score: 42, guidance: { next: 'settle a payment' } };
	trustState.unlocks = { agent_id: AGENT_ID, tier: 'new', unlocks: [] };
	trustState.reserves = { agent_id: AGENT_ID, network: 'mainnet', flows: [] };
});

/** Queue the owner lookup every /payments read starts with, then its page rows. */
function queueOwnedAgent(rows = []) {
	sqlState.queue.push([{ id: AGENT_ID, user_id: OWNER_ID }]);
	sqlState.queue.push(rows);
}

describe('GET /api/agents/:id/payments query hardening', () => {
	beforeEach(() => {
		authState.session = { id: OWNER_ID };
	});

	for (const [label, qs] of [
		['non-numeric limit', '?limit=abc'],
		['negative limit', '?limit=-5'],
		['zero limit', '?limit=0'],
		['oversized limit', '?limit=99999'],
	]) {
		it(`answers 200 for a ${label} instead of 500ing in Postgres`, async () => {
			queueOwnedAgent();
			const { status } = await call(handlePayments, { url: `/api/agents/${AGENT_ID}/payments${qs}` }, AGENT_ID);
			expect(status).toBe(200);
			const limitValue = sqlState.calls.at(-1).values.at(-1);
			expect(Number.isInteger(limitValue)).toBe(true);
			// One extra row is fetched to detect a next page; the window is 1..100.
			expect(limitValue).toBeGreaterThanOrEqual(2);
			expect(limitValue).toBeLessThanOrEqual(101);
		});
	}

	it('rejects a malformed cursor with 400 rather than an invalid-uuid 500', async () => {
		queueOwnedAgent();
		const { status, body } = await call(
			handlePayments,
			{ url: `/api/agents/${AGENT_ID}/payments?cursor=notauuid` },
			AGENT_ID,
		);
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects a cursor whose id half is not a uuid', async () => {
		queueOwnedAgent();
		const { status } = await call(
			handlePayments,
			{ url: `/api/agents/${AGENT_ID}/payments?cursor=2026-01-01T00:00:00.000Z|nope` },
			AGENT_ID,
		);
		expect(status).toBe(400);
	});

	it('paginates on created_at with the id as tiebreaker, not on the random uuid alone', async () => {
		queueOwnedAgent();
		await call(
			handlePayments,
			{
				url: `/api/agents/${AGENT_ID}/payments?cursor=2026-01-01T00:00:00.000Z|00000000-0000-4000-8000-0000000000b2`,
			},
			AGENT_ID,
		);
		const { query } = sqlState.calls.at(-1);
		expect(query).toContain('order by ap.created_at desc, ap.id desc');
		expect(query).toContain('ap.created_at < ');
	});

	it('emits a next_cursor in `<iso>|<uuid>` form only when another page exists', async () => {
		const rows = Array.from({ length: 3 }, (_, i) => ({
			id: `00000000-0000-4000-8000-00000000000${i}`,
			created_at: new Date(Date.UTC(2026, 0, 3 - i)),
		}));
		queueOwnedAgent(rows);
		const { status, body } = await call(
			handlePayments,
			{ url: `/api/agents/${AGENT_ID}/payments?limit=2` },
			AGENT_ID,
		);
		expect(status).toBe(200);
		expect(body.payments).toHaveLength(2);
		expect(body.next_cursor).toBe('2026-01-02T00:00:00.000Z|00000000-0000-4000-8000-000000000001');
	});

	it('returns a null next_cursor on the last page', async () => {
		queueOwnedAgent([{ id: '00000000-0000-4000-8000-000000000001', created_at: new Date() }]);
		const { body } = await call(handlePayments, { url: `/api/agents/${AGENT_ID}/payments?limit=2` }, AGENT_ID);
		expect(body.next_cursor).toBeNull();
	});
});

describe('POST /api/agents/:id/memory/pin base64 validation', () => {
	beforeEach(() => {
		authState.session = { id: OWNER_ID };
	});

	for (const [label, data] of [
		['non-base64 characters', '!!!not base64!!!'],
		['a length that is not a multiple of four', 'aGVsbG8'],
		['padding in the middle', 'aGV=bG8='],
	]) {
		it(`rejects ${label} before anything reaches the pinning provider`, async () => {
			sqlState.queue.push([{ id: AGENT_ID }]);
			const { status, body } = await call(pinHandler, {
				method: 'POST',
				url: `/api/agents/${AGENT_ID}/memory/pin`,
				body: { filename: 'MEMORY.md', data },
			});
			expect(status).toBe(400);
			expect(body.error).toBe('validation_error');
		});
	}

	it('accepts well-formed base64 and gets as far as the pinning-provider check', async () => {
		sqlState.queue.push([{ id: AGENT_ID }]);
		const priorJwt = process.env.PINATA_JWT;
		delete process.env.PINATA_JWT;
		try {
			const { status, body } = await call(pinHandler, {
				method: 'POST',
				url: `/api/agents/${AGENT_ID}/memory/pin`,
				body: { filename: 'MEMORY.md', data: 'IyBoZWxsbwo=' },
			});
			// The payload passed validation; only the unconfigured provider stopped it.
			expect(status).toBe(503);
			expect(body.error).toBe('pinning_unconfigured');
		} finally {
			if (priorJwt !== undefined) process.env.PINATA_JWT = priorJwt;
		}
	});
});

describe('personalized public reads are not shared-cacheable', () => {
	const cases = [
		{
			name: 'reputation',
			run: () => call(handleReputation, { url: `/api/agents/${AGENT_ID}/reputation` }, AGENT_ID),
			publicCache: 'public, max-age=60, stale-while-revalidate=300',
		},
		{
			name: 'unlocks',
			run: () => call(handleUnlocks, { url: `/api/agents/${AGENT_ID}/unlocks` }, AGENT_ID),
			publicCache: 'public, max-age=30, stale-while-revalidate=180',
		},
		{
			name: 'reserves',
			run: () => call(handleReserves, { url: `/api/agents/${AGENT_ID}/reserves` }, AGENT_ID),
			publicCache: 'public, max-age=30, stale-while-revalidate=120',
		},
	];

	for (const { name, run, publicCache } of cases) {
		it(`${name}: an anonymous read stays CDN-cacheable`, async () => {
			const { status, headers } = await run();
			expect(status).toBe(200);
			expect(headers['cache-control']).toBe(publicCache);
		});

		it(`${name}: an authenticated read is private and never stored`, async () => {
			authState.session = { id: OWNER_ID };
			sqlState.queue.push([{ ok: 1 }]); // ownership probe
			const { status, headers } = await run();
			expect(status).toBe(200);
			expect(headers['cache-control']).toBe('private, no-store');
		});

		it(`${name}: Vary names the credential headers the body depends on`, async () => {
			const { headers } = await run();
			const vary = String(headers.vary || '').toLowerCase();
			expect(vary).toContain('cookie');
			expect(vary).toContain('authorization');
		});
	}

	it('reputation withholds the owner-only guidance block from anonymous readers', async () => {
		const { body } = await call(handleReputation, { url: `/api/agents/${AGENT_ID}/reputation` }, AGENT_ID);
		expect(body.is_owner).toBe(false);
		expect(body.guidance).toBeUndefined();
	});

	it('reputation returns the guidance block to the owner', async () => {
		authState.session = { id: OWNER_ID };
		sqlState.queue.push([{ ok: 1 }]);
		const { body } = await call(handleReputation, { url: `/api/agents/${AGENT_ID}/reputation` }, AGENT_ID);
		expect(body.is_owner).toBe(true);
		expect(body.guidance).toEqual({ next: 'settle a payment' });
	});
});
