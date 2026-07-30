/**
 * world-health asset sweep: what counts as a missing blueprint asset.
 *
 * The sensor HEADs every asset the scene references and marks the world degraded
 * when one is gone, because a 404 crashes Hyperfy on join. Two defects made it
 * report a healthy world as broken:
 *   1. It swept `blueprints` verbatim. A live scene of 136 entries resolves to 17
 *      distinct files, so it fired 8x the requests inside a 10s budget and counted
 *      one broken file once per blueprint that referenced it.
 *   2. Any failure counted as "missing". An 8s timeout against a cold CDN edge
 *      raised a "World asset MISSING" ops alert and parked a degraded verdict for
 *      the full cache hour, identical to a genuine 404. Observed 2026-07-30: the
 *      sensor reported "1 blueprint asset(s) missing" while all 17 assets served
 *      200 to an independent sweep.
 *
 * Contracts under test:
 *   1. Distinct assets are swept once each, not once per referencing blueprint.
 *   2. A transient failure is retried, and a retry that succeeds is not a miss.
 *   3. A sustained transient failure degrades nothing and raises no alert.
 *   4. A 404 is authoritative: no retry, degraded, alert raised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../api/_lib/cache.js', () => ({ cacheSet: vi.fn(async () => {}) }));

import handler from '../api/cron/world-health.js';
import { sendOpsAlert } from '../api/_lib/alerts.js';

const SECRET = 'test-cron-secret';

// Two blueprints share one asset, a third has its own: 3 entries, 2 distinct URLs.
const SHARED = 'https://world.three.ws/assets/shared.glb';
const SOLO = 'https://world.three.ws/assets/solo.glb';
const STATUS_BODY = {
	protected: true,
	blueprints: [
		{ id: 'bp-a', assetUrl: SHARED },
		{ id: 'bp-b', assetUrl: SHARED },
		{ id: 'bp-c', assetUrl: SOLO },
	],
};

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

const req = () => ({
	method: 'GET',
	url: '/api/cron/world-health',
	headers: { authorization: `Bearer ${SECRET}` },
});

/**
 * Stub fetch: /status returns the scene, every other URL is resolved by `assets`,
 * a map of URL to an array of per-attempt outcomes (so a retry can differ from the
 * first try). Records each HEAD so we can assert the request count.
 */
function stubFetch(assets) {
	const heads = [];
	const attempts = new Map();
	vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
		const u = String(url);
		if (u.endsWith('/status')) {
			return { ok: true, status: 200, json: async () => STATUS_BODY };
		}
		expect(opts?.method).toBe('HEAD');
		heads.push(u);
		const n = attempts.get(u) || 0;
		attempts.set(u, n + 1);
		const plan = assets[u] || [200];
		const outcome = plan[Math.min(n, plan.length - 1)];
		if (outcome === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		return { ok: outcome >= 200 && outcome < 300, status: outcome };
	}));
	return heads;
}

let warnSpy;
let logSpy;
beforeEach(() => {
	process.env.CRON_SECRET = SECRET;
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	sendOpsAlert.mockReset();
});
afterEach(() => {
	vi.unstubAllGlobals();
	warnSpy.mockRestore();
	logSpy.mockRestore();
});

async function run() {
	const res = fakeRes();
	await handler(req(), res);
	return JSON.parse(res.body);
}

describe('world-health asset sweep', () => {
	it('sweeps each distinct asset once, not once per referencing blueprint', async () => {
		const heads = stubFetch({ [SHARED]: [200], [SOLO]: [200] });
		const body = await run();

		expect(body.status).toBe('ok');
		expect(body.blueprintCount).toBe(3);
		expect(body.assetCount).toBe(2);
		// 3 blueprints, 2 distinct assets, so exactly 2 HEADs.
		expect(heads).toHaveLength(2);
		expect(new Set(heads)).toEqual(new Set([SHARED, SOLO]));
	});

	it('retries a transient failure and clears it when the retry succeeds', async () => {
		const heads = stubFetch({ [SHARED]: ['timeout', 200], [SOLO]: [200] });
		const body = await run();

		expect(body.status).toBe('ok');
		expect(body.missingAssets).toBeUndefined();
		expect(body.unreachableAssets).toBeUndefined();
		// SHARED was tried twice, SOLO once.
		expect(heads.filter((u) => u === SHARED)).toHaveLength(2);
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('never degrades the world or alerts on a sustained transient failure', async () => {
		stubFetch({ [SHARED]: ['timeout'], [SOLO]: [200] });
		const body = await run();

		expect(body.status).toBe('ok');
		expect(body.missingAssets).toBeUndefined();
		expect(body.unreachableAssets).toHaveLength(1);
		expect(body.unreachableAssets[0].assetUrl).toBe(SHARED);
		// The regression: this used to raise "World asset MISSING" on a cold edge.
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('treats a 404 as authoritative: no retry, degraded, alert raised', async () => {
		const heads = stubFetch({ [SHARED]: [404], [SOLO]: [200] });
		const body = await run();

		expect(body.status).toBe('degraded');
		expect(body.unreachableAssets).toBeUndefined();
		expect(body.missingAssets).toHaveLength(1);
		// Counted once, but both blueprints that reference it are named.
		expect(body.missingAssets[0].blueprintIds).toEqual(['bp-a', 'bp-b']);
		// A 404 is the world's own answer, so it is never re-probed.
		expect(heads.filter((u) => u === SHARED)).toHaveLength(1);
		expect(sendOpsAlert).toHaveBeenCalledTimes(1);
		expect(sendOpsAlert.mock.calls[0][0]).toBe('World asset MISSING');
	});

	it('retries a 5xx before believing it, since the file may still be there', async () => {
		const heads = stubFetch({ [SHARED]: [503, 503], [SOLO]: [200] });
		const body = await run();

		expect(heads.filter((u) => u === SHARED)).toHaveLength(2);
		expect(body.status).toBe('ok');
		expect(body.unreachableAssets).toHaveLength(1);
		expect(body.unreachableAssets[0].status).toBe(503);
	});
});
