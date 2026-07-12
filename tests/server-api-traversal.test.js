import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18453;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

async function waitForServer(timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/api/healthz`, { redirect: 'manual' });
			if (res.status > 0) return;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error('server did not start in time');
}

beforeAll(async () => {
	server = spawn(process.execPath, ['server/index.mjs'], {
		cwd: repoRoot,
		env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
		stdio: 'ignore',
	});
	await waitForServer();
}, 30000);

afterAll(() => {
	server?.kill('SIGKILL');
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
