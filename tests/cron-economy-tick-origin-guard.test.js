// The economy heartbeat must not fan out from a machine that is not production
// (api/cron/economy-tick.js).
//
// economy-tick fires thirty-six money engines over HTTP at env.APP_ORIGIN, which
// falls back to https://three.ws whenever PUBLIC_APP_ORIGIN is unset. That is the
// default state of a laptop, a CI box, or an audit session, so simply booting the
// handler there and calling it with the production cron secret aims the whole
// economy at production from a process that is not production. On 2026-08-14 one
// such run put 36 rejected calls into the production log inside a single minute.
//
// Pinned here:
//   1. no K_SERVICE + a remote origin → no fetch at all, a reported skip, 200
//   2. no K_SERVICE + a loopback origin → the fan-out runs (a deliberate local test)
//   3. K_SERVICE set → the fan-out runs, so the real Cloud Run heartbeat is untouched
import { test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/cron-auth.js', () => ({ requireCron: () => true }));
vi.mock('../api/_lib/cache.js', () => ({ cacheSet: async () => {} }));
vi.mock('../api/_lib/usage.js', () => ({
	logger: () => ({ info() {}, warn() {}, error() {} }),
}));

const handler = (await import('../api/cron/economy-tick.js')).default;

function makeRes() {
	return {
		statusCode: 0,
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader() {},
		getHeader() {},
		status(code) { this.statusCode = code; return this; },
		end(payload) {
			this.writableEnded = true;
			if (payload && this.body === null) {
				try { this.body = JSON.parse(payload); } catch { this.body = payload; }
			}
			return this;
		},
		json(payload) { this.body = payload; return this; },
	};
}

const savedService = process.env.K_SERVICE;
const savedOrigin = process.env.PUBLIC_APP_ORIGIN;
let fetched = [];

beforeEach(() => {
	fetched = [];
	vi.stubGlobal('fetch', async (url) => {
		fetched.push(String(url));
		return { ok: true, status: 200, json: async () => ({}) };
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (savedService === undefined) delete process.env.K_SERVICE;
	else process.env.K_SERVICE = savedService;
	if (savedOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
	else process.env.PUBLIC_APP_ORIGIN = savedOrigin;
});

async function run() {
	const res = makeRes();
	await handler({ method: 'GET', url: '/api/cron/economy-tick', headers: {} }, res);
	return res;
}

test('an undeployed process aimed at a remote origin fires nothing', async () => {
	delete process.env.K_SERVICE;
	process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

	const res = await run();

	expect(fetched).toEqual([]);
	expect(res.body.skipped).toBe('not_deployed');
	expect(res.body.ok).toBe(true);
	expect(res.body.origin).toBe('https://three.ws');
	expect(res.body.engines).toBeGreaterThan(0);
});

test('an undeployed process aimed at a loopback origin still fans out', async () => {
	delete process.env.K_SERVICE;
	process.env.PUBLIC_APP_ORIGIN = 'http://127.0.0.1:3111';

	const res = await run();

	expect(res.body.skipped).toBeUndefined();
	expect(fetched.length).toBeGreaterThan(0);
	expect(fetched.every((u) => u.startsWith('http://127.0.0.1:3111/'))).toBe(true);
});

test('a Cloud Run revision fans out as before', async () => {
	process.env.K_SERVICE = 'three-ws-api';
	process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

	const res = await run();

	expect(res.body.skipped).toBeUndefined();
	expect(res.body.fired).toBe(fetched.length);
	expect(fetched.every((u) => u.startsWith('https://three.ws/'))).toBe(true);
});
