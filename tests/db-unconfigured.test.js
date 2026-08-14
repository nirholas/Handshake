// Regression: a missing/empty/malformed DATABASE_URL must degrade GRACEFULLY,
// not 500-storm every DB-backed read.
//
// The lazy Neon client is built on first query use, so a bad/absent
// DATABASE_URL throws there — and that throw used to fire SYNCHRONOUSLY inside a
// fragment's `.catch()`/`.then()`, bypassing per-query guards (a `.catch(fn)`
// only runs `fn` on a rejection, never on a throw from `.catch()` itself) and
// landing as an unclassified 500 instead of the intended 503. These tests pin
// the two contracts that keep the platform degrading cleanly:
//   1. `sql\`…\`.catch(fallback)` recovers instead of throwing synchronously.
//   2. The resulting error classifies as db-unavailable → wrap() returns 503.

import { describe, it, expect, beforeAll } from 'vitest';

// Force the unconfigured path BEFORE db.js is imported. `req('DATABASE_URL')`
// throws `Missing required env var: DATABASE_URL` on an empty/unset value.
let sql, sqlValues, isDbUnavailableError;
beforeAll(async () => {
	// env.js now resolves the connection string from DATABASE_URL OR any standard
	// Vercel-Postgres/Neon integration alias, so clearing the bare name alone no
	// longer guarantees the unconfigured path — a developer's .env.local may set
	// POSTGRES_URL etc. Clear every source so this regression is honest everywhere.
	for (const name of [
		'DATABASE_URL',
		'POSTGRES_URL',
		'DATABASE_URL_UNPOOLED',
		'POSTGRES_URL_NON_POOLING',
		'NEON_DATABASE_URL',
		'POSTGRES_PRISMA_URL',
	]) {
		delete process.env[name];
	}
	// Fresh module instance so the lazy client starts uninitialized.
	const mod = await import('../api/_lib/db.js?unconfigured');
	({ sql, sqlValues, isDbUnavailableError } = mod);
});

describe('db.js with an unconfigured DATABASE_URL', () => {
	it('routes a tagged-template construction failure through .catch() instead of throwing synchronously', async () => {
		// The exact oracle/stats shape: a guarded query (whose fallback is a row
		// array) inside Promise.all. The key assertion is that we REACH the fallback
		// at all — a sync throw from `.catch()` would have rejected the Promise.all.
		const [rows] = await Promise.all([
			sql`select count(*) as n from anything`.catch(() => [{ n: 0 }]),
		]);
		expect(rows).toEqual([{ n: 0 }]);
		expect(rows[0].n).toBe(0);
	});

	it('rejects (not throws) from await, so an outer try/catch can handle it', async () => {
		let caught = null;
		try {
			await sql`select 1`;
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(isDbUnavailableError(caught)).toBe(true);
	});

	it('routes the function-form sql(query, params) failure through .catch() too', async () => {
		const recovered = await sql('select 1', []).catch(() => 'fallback');
		expect(recovered).toBe('fallback');
	});

	it('classifies the construction failure as db-unavailable (→ graceful 503, not 500)', async () => {
		const err = await sql`select 1`.then(
			() => null,
			(e) => e,
		);
		expect(err).toBeTruthy();
		expect(isDbUnavailableError(err)).toBe(true);
	});

	it('classifies a suspended-Neon-endpoint message (both phrasings)', () => {
		const disabled = Object.assign(new Error('The endpoint has been disabled. Enable it using Neon API and retry.'), {
			name: 'NeonDbError',
		});
		expect(isDbUnavailableError(disabled)).toBe(true);
		const legacy = Object.assign(new Error('endpoint is disabled'), { name: 'NeonDbError' });
		expect(isDbUnavailableError(legacy)).toBe(true);
	});

	it('still surfaces sqlValues build-time validation as a real throw (not masked)', () => {
		expect(() => sqlValues([])).toThrow();
	});

	// A live Neon outage / cold-compute wake does NOT surface as a missing env var
	// — the connection string is present but the HTTP transport fails. Neon's
	// driver wraps that as `NeonDbError: Error connecting to database: fetch
	// failed`. This used to fall through every branch (the NeonDbError branch never
	// checked 'fetch failed'; the TypeError branch never ran for a NeonDbError) and
	// 500-stormed every DB endpoint at once instead of degrading to a single 503.
	it('classifies a Neon connection-level transport failure as db-unavailable (→ 503, not 500)', () => {
		const fetchFailed = Object.assign(new Error('Error connecting to database: fetch failed'), {
			name: 'NeonDbError',
		});
		expect(isDbUnavailableError(fetchFailed)).toBe(true);

		// Same failure when the cause is carried on .sourceError rather than the message.
		const wrapped = Object.assign(new Error('Error connecting to database'), {
			name: 'NeonDbError',
			sourceError: new TypeError('fetch failed'),
		});
		expect(isDbUnavailableError(wrapped)).toBe(true);

		for (const m of [
			'Connection terminated unexpectedly',
			'terminating connection due to administrator command',
			'sorry, too many clients already / remaining connection slots are reserved',
			'read ECONNRESET',
			'connect ETIMEDOUT',
		]) {
			expect(isDbUnavailableError(Object.assign(new Error(m), { name: 'NeonDbError' }))).toBe(true);
		}
	});

	it('still 500s on a real SQL fault (syntax / undefined column) — not masked as 503', () => {
		const syntax = Object.assign(new Error('syntax error at or near "$3"'), { name: 'NeonDbError' });
		expect(isDbUnavailableError(syntax)).toBe(false);
		const undefinedCol = Object.assign(new Error('column "nope" does not exist'), { name: 'NeonDbError' });
		expect(isDbUnavailableError(undefinedCol)).toBe(false);
	});

	it('classifies a bare `fetch failed` TypeError (pre-wrap transport error)', () => {
		expect(isDbUnavailableError(new TypeError('fetch failed'))).toBe(true);
	});

	it('classifies the WebSocket Pool’s ErrorEvent, which carries no message at all', () => {
		// The ws-based Pool (scripts that share code with crons, e.g.
		// scripts/sniper-evolve.mjs) rejects with a DOM ErrorEvent, not an Error,
		// when its socket never opens. Its name and message are both empty and
		// String() is "[object ErrorEvent]", so every message-based branch reads it
		// as a code bug. Proven against a real Postgres: api/cron/sniper-evolve
		// answered `{"ok":false,"error":""}` with a GREEN heartbeat, the exact
		// dead-loop-behind-a-green-check shape the fleet watchdog exists to catch.
		// ErrorEvent is not a Node global, so the driver builds the event from its
		// own bundled class. Reconstruct the observed shape rather than reaching
		// for a global that does not exist in the runtime this ships on.
		class WsErrorEvent {
			constructor(cause) {
				this.error = cause;
				this.type = 'error';
				this.stack = 'Error\n    at ws/index.js';
			}
			get message() { return ''; }
		}
		const event = new WsErrorEvent(new TypeError());
		expect(event.message).toBe('');
		expect(event.name).toBeUndefined();
		expect(isDbUnavailableError(event)).toBe(true);

		// A plain Error still has to go through the message branches, so a genuine
		// SQL fault cannot slip into the transient bucket via this door.
		expect(isDbUnavailableError(new Error('column "nope" does not exist'))).toBe(false);
	});
});
