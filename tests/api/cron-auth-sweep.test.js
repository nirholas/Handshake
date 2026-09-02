/**
 * Every handler under api/cron/ must be fail-closed to unauthenticated calls.
 *
 * Cron auth is a per-file inline guard (constant-time CRON_SECRET compare),
 * not something a wrapper enforces centrally, so a single future handler that
 * forgets the guard becomes directly internet-invokable: the server's
 * filesystem phase routes every api/cron/*.js file. The planned second layer
 * (Cloud Scheduler OIDC at the edge, fable-audit ENHANCEMENTS item 5) needs
 * gcloud access this workspace does not have; this sweep is the in-repo
 * control that holds the line meanwhile.
 *
 * The check is behavioral, not textual: each handler is invoked with NO
 * authorization header and must terminate with 401/403 (bad or missing
 * secret), 503 (CRON_SECRET unset), or 405 for a disallowed method: anything
 * else means the tick body started running for an anonymous caller. A
 * grep-based check would miss a guard that exists but is never called.
 *
 * api/cron/[name].js is a dispatcher that guards inside each sub-handler, so
 * its HANDLERS names are enumerated and every one is probed individually; the
 * unknown-name 404 path is asserted separately.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CRON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../api/cron');
const FILES = readdirSync(CRON_DIR).filter((f) => f.endsWith('.js')).sort();
const DISPATCHER = '[name].js';

// Fail-closed statuses an unauthenticated probe may receive. 405 is accepted
// per-method only; at least one probed method must return a closed status,
// otherwise the handler has no reachable auth path and gets flagged.
const CLOSED = new Set([401, 403, 503]);
const PROBE_METHODS = ['GET', 'POST'];
const PER_CALL_TIMEOUT_MS = 5000;

beforeAll(() => {
	// Deterministic guard branch: with a secret set, a missing header must be
	// refused outright. (Unset would also be fail-closed, a 503, but pin one
	// branch for clarity.)
	process.env.CRON_SECRET ||= 'test-cron-sweep-secret';
	// A cron body that DOES run anonymously must not reach a real database.
	delete process.env.DATABASE_URL;
});

// The dispatcher's HANDLERS map is module-private; enumerate its route names
// from source. This is enumeration only: the assertion itself stays
// behavioral (each name is actually invoked below).
function dispatcherNames() {
	const src = readFileSync(path.join(CRON_DIR, DISPATCHER), 'utf8');
	const block = src.match(/const HANDLERS = \{([\s\S]*?)\n\};/);
	expect(block, `${DISPATCHER}: HANDLERS map not found: update this sweep's enumerator`).toBeTruthy();
	const names = [...block[1].matchAll(/'([a-z0-9-]+)':/g)].map((m) => m[1]);
	expect(names.length).toBeGreaterThan(20);
	return names;
}

function makeReq(urlPath, method) {
	// The production server shims Vercel-style req.query from the route match;
	// the dispatcher reads its job id from req.query.name.
	const name = urlPath.replace(/^\/api\/cron\//, '').split('?')[0];
	return {
		method,
		url: urlPath,
		query: { name },
		headers: { host: 'three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}

// Node ServerResponse surface plus the Vercel-style status()/json() helpers
// the production server shims onto res (several cron guards respond through
// res.status(...).json(...)).
function makeRes(onEnd) {
	const r = { statusCode: 200, headersSent: false, writableEnded: false, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[String(k).toLowerCase()] = v; };
	r.getHeader = (k) => r._h[String(k).toLowerCase()];
	r.removeHeader = (k) => { delete r._h[String(k).toLowerCase()]; };
	r.write = () => { r.headersSent = true; return true; };
	r.writeHead = (code, headers) => {
		r.statusCode = code;
		for (const [k, v] of Object.entries(headers || {})) r.setHeader(k, v);
		r.headersSent = true;
		return r;
	};
	r.status = (code) => { r.statusCode = code; return r; };
	r.json = (obj) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(obj)); return r; };
	r.end = (b) => {
		r._b = b;
		r.headersSent = true;
		r.writableEnded = true;
		onEnd(r);
	};
	return r;
}

// Resolves with the response once the handler ends it. A handler that neither
// ends the response nor throws within the window is doing real work for an
// anonymous caller: report that as its own failure mode.
function probe(handler, urlPath, method) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ status: 'hung' }), PER_CALL_TIMEOUT_MS);
		const res = makeRes((r) => {
			clearTimeout(timer);
			resolve({ status: r.statusCode, body: r._b == null ? null : String(r._b) });
		});
		Promise.resolve()
			.then(() => handler(makeReq(urlPath, method), res))
			.then(() => {
				if (!res.writableEnded) {
					clearTimeout(timer);
					resolve({ status: 'no-response' });
				}
			})
			.catch((err) => {
				clearTimeout(timer);
				resolve({ status: 'threw', error: err?.message });
			});
	});
}

async function assertFailClosed(handler, urlPath, label) {
	let sawClosed = false;
	for (const method of PROBE_METHODS) {
		const out = await probe(handler, urlPath, method);
		expect(
			typeof out.status === 'number',
			`${label} [${method}] did not terminate the request cleanly (${out.status}${out.error ? `: ${out.error}` : ''}): the body ran without auth`,
		).toBe(true);
		expect(
			CLOSED.has(out.status) || out.status === 405,
			`${label} [${method}] answered ${out.status} to an unauthenticated call: expected 401/403/503 (or 405 for a disallowed method). Body: ${String(out.body).slice(0, 200)}`,
		).toBe(true);
		if (CLOSED.has(out.status)) sawClosed = true;
	}
	expect(
		sawClosed,
		`${label} returned 405 to every probed method: extend PROBE_METHODS so the sweep exercises its real method's auth path`,
	).toBe(true);
}

describe(`api/cron auth sweep (${FILES.length} handlers)`, () => {
	it('has handlers to sweep', () => {
		expect(FILES.length).toBeGreaterThan(50);
	});

	for (const file of FILES.filter((f) => f !== DISPATCHER)) {
		it(`${file} refuses unauthenticated invocation`, async () => {
			const mod = await import(pathToFileURL(path.join(CRON_DIR, file)).href);
			const handler = mod.default;
			expect(typeof handler, `${file} must default-export a handler (every file here is routable)`).toBe('function');
			await assertFailClosed(handler, `/api/cron/${file.replace(/\.js$/, '')}`, file);
		});
	}

	describe(`${DISPATCHER} dispatcher`, () => {
		it('404s an unknown cron name without running anything', async () => {
			const { default: handler } = await import(pathToFileURL(path.join(CRON_DIR, DISPATCHER)).href);
			const out = await probe(handler, '/api/cron/definitely-not-a-cron', 'GET');
			expect(out.status).toBe(404);
		});

		it('every dispatched name refuses unauthenticated invocation', async () => {
			const { default: handler } = await import(pathToFileURL(path.join(CRON_DIR, DISPATCHER)).href);
			for (const name of dispatcherNames()) {
				await assertFailClosed(handler, `/api/cron/${name}`, `${DISPATCHER} → ${name}`);
			}
		}, 120_000);
	});
});

// The sweep above only has value if it FAILS on a handler that forgot the
// guard. A behavioral check that silently degrades into a no-op (a probe that
// never reaches the body, an assertion that accepts anything) reads exactly
// like a passing suite, so the sweep is pointed at deliberately broken
// fixtures here and required to reject each one. These are the four ways a
// cron file has actually gone wrong, not hypotheticals: no guard at all, a
// guard whose verdict is discarded, a body that answers before the guard, and
// a handler that starts real work and never responds.
describe('the sweep fails on an unguarded handler', () => {
	const label = 'fixture.js';
	const url = '/api/cron/fixture';

	async function expectSweepRejects(handler, why) {
		await expect(
			assertFailClosed(handler, url, label),
			`the sweep accepted ${why}: it is no longer enforcing anything`,
		).rejects.toThrow();
	}

	it('rejects a handler with no guard at all', async () => {
		await expectSweepRejects(async (_req, res) => {
			res.status(200).json({ ok: true, swept: 3 });
		}, 'a handler that runs its body for an anonymous caller');
	});

	it('rejects a handler that computes the verdict and ignores it', async () => {
		// The real-world shape: `isCronAuthorized(req)` called without `if (!...)`.
		await expectSweepRejects(async (req, res) => {
			const authorized = String(req.headers.authorization || '').startsWith('Bearer ');
			res.status(200).json({ ok: true, authorized });
		}, 'a handler that evaluates auth but never acts on it');
	});

	it('rejects a handler that answers 200 before reaching its guard', async () => {
		// A health/ping short-circuit placed above the guard: fail-open for any
		// caller that does not send the method the guard sits behind.
		await expectSweepRejects(async (req, res) => {
			if (req.method === 'GET') return res.status(200).json({ ok: true, ping: true });
			return res.status(401).json({ error: 'unauthorized' });
		}, 'a handler whose GET path bypasses the guard');
	});

	it('rejects a handler that starts work and never responds', async () => {
		// Never terminating is not "closed": the body is already running.
		await expectSweepRejects(() => new Promise(() => {}), 'a handler that hangs while doing work');
	}, 20_000);

	it('accepts a correctly guarded handler', async () => {
		// The positive control: without it, a sweep that rejected everything
		// would also pass all four cases above.
		await assertFailClosed(async (_req, res) => {
			res.status(401).json({ error: 'unauthorized', message: 'invalid cron secret' });
		}, url, label);
	});
});
