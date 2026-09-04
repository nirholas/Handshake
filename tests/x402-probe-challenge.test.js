import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './helpers/test-server.js';

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

let BASE;
let server;

beforeAll(async () => {
	server = await startTestServer({
		env: {
			// Minimal payable-lane env so buildRequirements() yields a Base accept.
			X402_PAY_TO_BASE: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			X402_ADVERTISE_BASE: 'true',
			// pay-by-name builds its own Solana-only accept list and answers 503
			// not_configured without these three, so the probe would never reach
			// the challenge the test below asserts.
			X402_PAY_TO_SOLANA: 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU',
			X402_FEE_PAYER_SOLANA: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW',
			X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		},
		timeoutMs: 60_000,
	});
	BASE = server.base;
	// Warm the paid-route stacks. healthz readiness says nothing about the x402
	// handler graph: the child imports it lazily on the first paid-route hit, and
	// under full-suite load that cold import runs tens of seconds, which blew the
	// first test's 15s budget. Charging the warm-up to the hook budget keeps each
	// test measuring the challenge contract, not the import graph. The responses
	// are deliberately ignored; the tests below re-assert them against warm code.
	// Every distinct handler below, not just the first two: each /api/x402/<name>
	// is its own module with its own lazy import graph, so warming `tutor` alone
	// left `cosmetic-purchase` and friends to pay their cold import inside a 15s
	// test budget and time out under full-suite load. The hook has 120s for this.
	await Promise.all(
		[
			'/api/x402/tutor',
			'/api/x402/asset-download',
			'/api/x402/skill-call',
			'/api/x402/cosmetic-purchase',
			'/api/x402/animation-download',
			'/api/x402/fact-check',
			'/api/x402/pipeline',
			'/api/x402/pay-by-name',
			'/api/v1/x/openai/chat',
			'/api/v1/x/coingecko/price',
		].map((route) => fetch(`${BASE}${route}`).catch(() => {})),
	);
}, 120_000);

afterAll(() => {
	server?.close();
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

	it('bare probe on cosmetic-purchase serves the challenge (was 400/404)', async () => {
		const res = await fetch(`${BASE}/api/x402/cosmetic-purchase`);
		await expectChallenge(res);
	}, 15000);

	it('placeholder-param probe on cosmetic-purchase serves the challenge, not 404 (x402scan fills required strings with a placeholder)', async () => {
		const res = await fetch(`${BASE}/api/x402/cosmetic-purchase?id=string&account=string`);
		await expectChallenge(res);
	}, 15000);

	it('bare probe on animation-download serves the challenge (was 400)', async () => {
		const res = await fetch(`${BASE}/api/x402/animation-download`);
		await expectChallenge(res);
	}, 15000);

	it('non-uuid placeholder probe on animation-download serves the challenge, not 400', async () => {
		const res = await fetch(`${BASE}/api/x402/animation-download?id=string`);
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

	// pipeline and pay-by-name validated the request body BEFORE pricing it, so a
	// bare `POST` with no body answered 400 (`invalid_stages`, `payer_wallet must
	// be a base58 Solana public key`). Measured against production 2026-09-04:
	// they were the only two of the 60 paid routes absent from the x402scan
	// origin listing that answered a bodyless probe with anything other than a
	// 402 or an honest 503, which is exactly the shape that fails registration.

	it('bodyless POST on pipeline serves the challenge, not the stage-validation 400', async () => {
		const res = await fetch(`${BASE}/api/x402/pipeline`, { method: 'POST' });
		await expectChallenge(res);
	}, 15000);

	it('pipeline prices a probe at the catalog example chain (generate + rig)', async () => {
		// The catalog advertises the example chain's price for this route, so an
		// unpriceable probe body must quote that same amount or the directory
		// lists a price no buyer is ever shown. The child server inherits this
		// process's env, so the stage prices behind both are identical.
		const { priceForChain } = await import('../api/_lib/pipeline.js');
		const res = await fetch(`${BASE}/api/x402/pipeline`, { method: 'POST' });
		const body = await expectChallenge(res);
		expect(body.accepts[0].amount).toBe(priceForChain(['generate', 'rig']).atomics);
	}, 15000);

	it('a body naming an unknown stage still reaches the challenge, not a 400', async () => {
		const res = await fetch(`${BASE}/api/x402/pipeline`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ stages: ['not-a-stage'] }),
		});
		await expectChallenge(res);
	}, 15000);

	it('bodyless POST on pay-by-name serves the paid-resolve challenge, not the prep 400', async () => {
		const res = await fetch(`${BASE}/api/x402/pay-by-name`, { method: 'POST' });
		const body = await expectChallenge(res);
		expect(body.resource?.url ?? body.resourceUrl ?? '').toContain('/api/x402/pay-by-name');
	}, 15000);

	it('pay-by-name still routes an explicit mode=prep to prep validation', async () => {
		const res = await fetch(`${BASE}/api/x402/pay-by-name`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mode: 'prep' }),
		});
		expect(res.status).toBe(400);
	}, 15000);
});
