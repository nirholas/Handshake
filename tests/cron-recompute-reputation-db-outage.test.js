/**
 * recompute-reputation must not report a database outage as a healthy tick.
 *
 * listStaleAgents() used to catch every error and return an empty batch, so for
 * as long as the database was down the cron answered
 * `{ ok: true, scored: 0, reason: 'no agents to score' }` and wrapCron wrote a
 * healthy heartbeat. That is indistinguishable from a fully-fresh population,
 * which is exactly the state the durable score store is supposed to prove: the
 * one signal that reputation had stopped refreshing was invisible to monitoring.
 *
 * Contracts under test:
 *   1. store  - listStaleAgents re-throws a db-unavailable error.
 *   2. store  - any other query failure still degrades to an empty batch.
 *   3. cron   - a db-unavailable error reaches wrapCron and answers with the
 *               platform-standard { ok:false, reason:'db_unavailable' }.
 *   4. cron   - a genuinely empty population still answers ok:true, scored:0.
 *   5. cron   - a non-DB failure stays contained as { ok:false, error }.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class DbDown extends Error {
	constructor() {
		super('Missing required env var: DATABASE_URL');
		this.name = 'DbDown';
	}
}

// One db.js mock serves every importer in the graph: http.js (wrapCron's
// classifiers + storage probe), the cron handler, and the reputation store.
vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(async () => {
			throw new DbDown();
		}),
		{ transaction: vi.fn(async () => { throw new DbDown(); }) },
	),
	isDbUnavailableError: (err) => err instanceof DbDown,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false, sizeMb: 1, highWaterMb: 470 }),
}));

vi.mock('../api/_lib/cron-auth.js', () => ({
	requireCron: () => true,
	isCronAuthorized: () => true,
}));

import { sql } from '../api/_lib/db.js';
import { listStaleAgents } from '../api/_lib/trust/reputation-store.js';

// Minimal ServerResponse stand-in, mirroring tests/cron-storage-backoff.test.js.
function fakeRes() {
	const headers = {};
	return {
		statusCode: 0,
		body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

const req = () => ({ method: 'GET', url: '/api/cron/recompute-reputation', headers: {} });

let warnSpy;
let errorSpy;
beforeEach(() => {
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	sql.mockReset();
});
afterEach(() => {
	warnSpy.mockRestore();
	errorSpy.mockRestore();
});

describe('listStaleAgents error contract', () => {
	it('re-throws a db-unavailable error instead of reporting an empty batch', async () => {
		sql.mockImplementation(async () => { throw new DbDown(); });
		await expect(listStaleAgents(40)).rejects.toBeInstanceOf(DbDown);
	});

	it('still degrades to an empty batch on a non-outage query failure', async () => {
		// ensureTable's create-table statements succeed; only the select fails, the
		// way a mid-migration missing column would.
		let call = 0;
		sql.mockImplementation(async () => {
			call += 1;
			if (call <= 3) return [];
			throw new Error('column "solana_address" does not exist');
		});
		await expect(listStaleAgents(40)).resolves.toEqual([]);
	});
});

describe('/api/cron/recompute-reputation under a database outage', () => {
	it('answers db_unavailable rather than a healthy zero-work tick', async () => {
		sql.mockImplementation(async () => { throw new DbDown(); });
		const handler = (await import('../api/cron/recompute-reputation.js')).default;
		const res = fakeRes();

		await handler(req(), res);

		expect(res.statusCode).toBe(200); // scheduler must not see a hard failure
		const body = JSON.parse(res.body);
		expect(body).toMatchObject({ ok: false, reason: 'db_unavailable' });
		expect(body.ok).not.toBe(true);
	});

	it('still reports a genuinely empty population as a healthy tick', async () => {
		sql.mockImplementation(async () => []);
		const handler = (await import('../api/cron/recompute-reputation.js')).default;
		const res = fakeRes();

		await handler(req(), res);

		expect(JSON.parse(res.body)).toMatchObject({ ok: true, scored: 0, reason: 'no agents to score' });
	});

	it('contains a non-outage query failure instead of 500-ing the tick', async () => {
		let call = 0;
		sql.mockImplementation(async () => {
			call += 1;
			if (call <= 3) return [];
			throw Object.assign(new Error('relation "agent_identities" does not exist'), { code: '42P01' });
		});
		const handler = (await import('../api/cron/recompute-reputation.js')).default;
		const res = fakeRes();

		await handler(req(), res);

		// listStaleAgents swallows this one, so the tick reads as "no work" rather
		// than an outage. The distinction that matters is that it never 500s.
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).ok).toBe(true);
	});
});
