import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Guards the x402 discovery contract: registry probes (x402scan, 402index,
// Bazaar validators) hit paid routes with whatever method they like, carrying
// no payment credentials, and require a spec-valid 402 challenge back — a 405
// or a pre-payment validation 400 reads as "not an x402 endpoint" and fails
// registration (the July 2026 x402scan run rejected 33 endpoints this way).
//
// The rule under test (api/_lib/x402-paid-endpoint.js + api/v1/x/[...slug].js):
//   • wrong method + NO payment/auth credentials → 402 challenge
//   • wrong method + credentials (a real caller redeeming) → strict 405
//
// The server boots with a Base receiver configured so challenges carry a
// non-empty accepts[]; no facilitator, DB, or Redis is needed to emit a 402.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18453;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

async function waitForServer(timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/api/healthz`);
			if (res.status > 0) return;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error('server did not start in time');
}

beforeAll(async () => {
	server = spawn(process.execPath, ['server/index.mjs'], {
		cwd: repoRoot,
		env: {
			...process.env,
			PORT: String(PORT),
			NODE_ENV: 'test',
			// Minimal payable-lane env so buildRequirements() yields a Base accept.
			X402_PAY_TO_BASE: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			X402_ADVERTISE_BASE: 'true',
		},
		stdio: 'ignore',
	});
	await waitForServer();
}, 30000);

afterAll(() => {
	server?.kill('SIGKILL');
});

async function expectChallenge(res) {
	expect(res.status).toBe(402);
	const body = await res.json();
	expect(body.x402Version).toBe(2);
	expect(Array.isArray(body.accepts)).toBe(true);
	expect(body.accepts.length).toBeGreaterThan(0);
	for (const accept of body.accepts) {
		// Runtime amounts are token atomic units (integer strings), never decimals.
		expect(accept.amount).toMatch(/^\d+$/);
	}
	return body;
}

describe('credential-less probes always reach the 402 challenge', () => {
	it('GET on a POST-only paidEndpoint route serves the challenge (was 405)', async () => {
		const res = await fetch(`${BASE}/api/x402/tutor`);
		await expectChallenge(res);
	}, 15000);

	it('GET on the POST-only aggregator endpoint serves the challenge via the front door (was 405)', async () => {
		const res = await fetch(`${BASE}/api/v1/x/openai/chat`);
		const body = await expectChallenge(res);
		expect(body.resource?.url ?? body.resourceUrl ?? '').toContain('/api/v1/x/openai/chat');
	}, 15000);

	it('POST on a GET-only free-lane aggregator endpoint serves the challenge, not 405', async () => {
		const res = await fetch(`${BASE}/api/v1/x/coingecko/price`, { method: 'POST' });
		await expectChallenge(res);
	}, 15000);

	it('wrong method WITH credentials stays a strict 405 for real callers', async () => {
		const res = await fetch(`${BASE}/api/x402/tutor`, {
			headers: { authorization: 'Bearer not-a-real-token' },
		});
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toContain('POST');
	}, 15000);

	it('bare probe on the dynamically-priced asset-download serves the challenge (was 400)', async () => {
		const res = await fetch(`${BASE}/api/x402/asset-download`);
		await expectChallenge(res);
	}, 15000);

	it('bare probe on the dynamically-priced skill-call serves the challenge (was 400)', async () => {
		const res = await fetch(`${BASE}/api/x402/skill-call`);
		await expectChallenge(res);
	}, 15000);

	it('empty-object POST body on fact-check serves the challenge (was 400)', async () => {
		const res = await fetch(`${BASE}/api/x402/fact-check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		await expectChallenge(res);
	}, 15000);
});
