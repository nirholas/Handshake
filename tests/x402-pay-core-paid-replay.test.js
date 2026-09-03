import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

// The browser payment core replays the gated resource with the X-PAYMENT proof
// once the wallet has signed. It replayed as a bodyless GET unconditionally,
// which is right for a paid GET page but silently wrong for a paid POST route:
// /api/agents/endpoint-shopper-run takes the task and budget in a JSON body, so
// the buyer settled on-chain and then got a 400 back instead of the run they
// paid for. `pay({ request })` carries the original request into the replay.
//
// These tests drive the real payEvm against a local server. Only the injected
// EIP-1193 provider stands in for a browser wallet extension (there is no
// extension in Node); the payload building, base64 encoding and replay are the
// shipped code paths, and nothing is broadcast to a chain.

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYER = '0x1111111111111111111111111111111111111111';

// window must exist before the module is imported: it attaches
// window.PaywallWallet on load and reads window.ethereum on every payment.
globalThis.window = globalThis.window || {};

const { payEvm, b64decode } = await import('../public/x402-pay-core.js');

function accept(origin) {
	return {
		scheme: 'exact',
		network: 'eip155:8453',
		asset: USDC,
		payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
		amount: '10000',
		maxTimeoutSeconds: 60,
		resource: `${origin}/api/agents/endpoint-shopper-run`,
		extra: { name: 'USD Coin', version: '2', decimals: 6 },
	};
}

// Minimal EIP-1193 wallet: enough for connect, chain check, balance read and
// the typed-data signature. Balance is deliberately ample so the fail-open
// pre-flight guard never short-circuits the flow under test.
function stubWallet() {
	return {
		isMetaMask: true,
		async request({ method }) {
			if (method === 'eth_requestAccounts') return [PAYER];
			if (method === 'eth_chainId') return '0x2105';
			if (method === 'eth_call') return '0x' + (10n ** 12n).toString(16).padStart(64, '0');
			if (method === 'eth_signTypedData_v4') return '0x' + 'ab'.repeat(65);
			throw new Error(`unexpected provider method ${method}`);
		},
	};
}

let server;
let origin;
let seen;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			seen = {
				method: req.method,
				body: Buffer.concat(chunks).toString('utf8'),
				contentType: req.headers['content-type'] || null,
				xPayment: req.headers['x-payment'] || null,
			};
			res.statusCode = 200;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ result: { answer: 'ok' }, steps: [], totalCostUsdc: '0.000000' }));
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
	seen = null;
	globalThis.window.ethereum = stubWallet();
});

describe('paid replay carries the request that earned the 402', () => {
	it('replays a paid POST route with its original JSON body', async () => {
		const a = accept(origin);
		const outcome = await payEvm({
			accept: a,
			resourceUrl: a.resource,
			walletName: 'metamask',
			request: {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ task: 'What is Ethereum current price?', maxCostUsd: 0.5 }),
			},
		});

		expect(seen.method).toBe('POST');
		expect(seen.contentType).toContain('application/json');
		expect(JSON.parse(seen.body)).toEqual({
			task: 'What is Ethereum current price?',
			maxCostUsd: 0.5,
		});
		expect(outcome.result).toEqual({ result: { answer: 'ok' }, steps: [], totalCostUsdc: '0.000000' });
	});

	it('signs the payment for the same resource it replays', async () => {
		const a = accept(origin);
		await payEvm({
			accept: a,
			resourceUrl: a.resource,
			walletName: 'metamask',
			request: { method: 'POST', body: '{"task":"t"}' },
		});

		const payload = b64decode(seen.xPayment);
		expect(payload.resource.url).toBe(a.resource);
		expect(payload.network).toBe('eip155:8453');
		expect(payload.payload.authorization.from.toLowerCase()).toBe(PAYER);
	});

	it('still replays as a bodyless GET when no request is supplied', async () => {
		const a = accept(origin);
		await payEvm({ accept: a, resourceUrl: a.resource, walletName: 'metamask' });

		expect(seen.method).toBe('GET');
		expect(seen.body).toBe('');
		expect(seen.xPayment).toBeTruthy();
	});
});
