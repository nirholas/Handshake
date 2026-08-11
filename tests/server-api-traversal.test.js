import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './helpers/test-server.js';

// Guards a critical auth/route-gating bypass: dispatchApi() splits the /api path
// on "/" and only THEN percent-decodes each segment. An encoded separator
// ("%2f") lets one array element decode to a compound path like
// "x/../../vite.config" — after the split, so the per-segment "===".."" guard
// never sees it. path.join collapses the ".." and escapes API_ROOT, letting an
// attacker import() and invoke an arbitrary server-side .js as an
// unauthenticated handler, and reach "_"-prefixed internal helpers.
//
// This test boots the real server and asserts traversal probes 404 while normal
// routes still resolve.

let BASE;
let server;

// 90s, not 30s: startTestServer waits up to 60s for readiness because a boot
// that takes ~1.5s idle takes tens of seconds under full-suite load. A hook
// budget below that budget just fails first, with a less useful message.
beforeAll(async () => {
	server = await startTestServer();
	BASE = server.base;
}, 90000);

afterAll(() => {
	server?.close();
});

describe('api dispatcher rejects path traversal', () => {
	it('encoded ../ escape to a repo-root .js returns 404, not 200/500', async () => {
		// Would resolve to /workspaces/three.ws/vite.config.js and import()+invoke it.
		const res = await fetch(`${BASE}/api/x%2f..%2f..%2fvite.config`, { redirect: 'manual' });
		expect(res.status).toBe(404);
	}, 15000);

	it('encoded backslash escape returns 404', async () => {
		const res = await fetch(`${BASE}/api/x%5c..%5c..%5cvite.config`, { redirect: 'manual' });
		expect(res.status).toBe(404);
	}, 15000);

	it('encoded separator to reach an internal _-prefixed helper returns 404', async () => {
		// _lib helpers are meant to be non-routable; smuggling an encoded "/" must
		// not defeat the isRoutable("_...") guard.
		const res = await fetch(`${BASE}/api/x%2f_lib%2fanything`, { redirect: 'manual' });
		expect(res.status).toBe(404);
	}, 15000);

	it('a normal API route still resolves (guard is not over-broad)', async () => {
		const res = await fetch(`${BASE}/api/healthz`, { redirect: 'manual' });
		expect(res.status).toBe(200);
	}, 15000);
});
