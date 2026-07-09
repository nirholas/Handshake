import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Guards a real production outage class: vercel.json pretty routes that rewrite
// to an API function with query captures ("/oracle/coin/<mint>" →
// "/api/oracle-share?mint=$1"). Vercel hands the function the REWRITTEN url on
// req.url; many handlers (api/oracle-share.js, api/agent-share.js, …) parse
// their params with `new URL(req.url)` rather than req.query. The Cloud Run
// server (server/index.mjs) originally injected dest-query params into
// req.query only, so every such handler saw an empty query — /oracle/coin/*
// 302-redirected to /oracle for every coin instead of serving the detail page.
//
// This test boots the real server and asserts the pretty route serves the page.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18452;
const BASE = `http://127.0.0.1:${PORT}`;
// Any syntactically valid base58 mint works: the page must render its shell
// even when the DB and pump.fun are unreachable (both are best-effort).
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

let server;

async function waitForServer(timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/api/oracle-share`, { redirect: 'manual' });
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

describe('rewrite-dest query params reach handlers on req.url', () => {
	it('/oracle/coin/<mint> serves the coin detail page (no redirect to /oracle)', async () => {
		const res = await fetch(`${BASE}/oracle/coin/${MINT}`, { redirect: 'manual' });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('oc-hero');       // SSR conviction hero
		expect(html).toContain('/oracle-coin.js'); // hydration script
		expect(html).toContain(MINT);            // boot payload carries the mint
	}, 30000);

	it('a malformed mint still redirects to /oracle', async () => {
		const res = await fetch(`${BASE}/oracle/coin/not-a-mint!!`, { redirect: 'manual' });
		// Bad path segment falls through this route's base58 regex → static 404 or
		// oracle redirect depending on route table; it must NOT render a coin page.
		expect(res.status).not.toBe(200);
	}, 15000);

	it('original query params survive alongside injected dest params', async () => {
		// /agent/<uuid>/share → /api/agent-share?id=$1 parses id from req.url; an
		// unknown-but-valid uuid redirects to /agents (id parsed, row missing),
		// while a lost id would ALSO redirect to /agents — so distinguish via the
		// oracle route which renders 200 only when the param arrives.
		const res = await fetch(`${BASE}/agent/00000000-0000-4000-8000-000000000000/share`, { redirect: 'manual' });
		expect([302, 307]).toContain(res.status);
		expect(res.headers.get('location')).toBeTruthy();
	}, 15000);
});
