// Core-path coverage for the protocol leg of the modal: step 1 of
// `pay()` (discover the 402 challenge), exercised over a REAL HTTP server
// speaking real x402 responses. Steps 2-4 (connect / authorize / verify) need a
// wallet extension and a browser, so they are covered by the live demo page in
// `examples/`; everything a merchant's server can get wrong about the challenge
// itself is covered here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { discover } from '../src/x402-modal.js';

// A real x402 v2 PaymentRequired envelope, shaped exactly as a merchant emits
// it: two `accepts` entries (Solana + Base), spec-canonical `maxAmountRequired`
// on one of them so the normalization is exercised end to end.
const CHALLENGE = {
	x402Version: 2,
	error: 'X-PAYMENT header is required',
	resource: { url: 'http://127.0.0.1/paid/echo', description: 'echo a string' },
	accepts: [
		{
			scheme: 'exact',
			network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
			asset: 'THREEsynthetic11111111111111111111111111111',
			payTo: 'THREEsynthetic22222222222222222222222222222',
			maxAmountRequired: '1000',
			extra: { name: 'USDC', decimals: 6, feePayer: 'THREEsynthetic33333333333333333333333333333' },
		},
		{
			scheme: 'exact',
			network: 'eip155:8453',
			asset: '0x0000000000000000000000000000000000000001',
			payTo: '0x0000000000000000000000000000000000000002',
			amount: '1000',
			extra: { name: 'USDC', decimals: 6, version: '2' },
		},
	],
};

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

// One server, several routes, each reproducing a challenge style seen in the
// wild. Started once for the file and torn down at the end.
async function startServer() {
	const seen = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		seen.push({
			method: req.method,
			url: req.url,
			contentType: req.headers['content-type'],
			auth: req.headers.authorization,
			body: Buffer.concat(chunks).toString('utf8'),
		});

		if (req.url === '/paid/echo') {
			res.writeHead(402, { 'content-type': 'application/json' });
			return res.end(JSON.stringify(CHALLENGE));
		}
		// MCP 2025-06-18: 401 carrying the whole envelope in a base64 header.
		if (req.url === '/mcp/echo') {
			res.writeHead(401, { 'payment-required': b64(CHALLENGE), 'content-type': 'application/json' });
			return res.end(JSON.stringify({ error: 'payment required' }));
		}
		// 402 whose body carries only an error string; the envelope is header-side.
		if (req.url === '/header-only') {
			res.writeHead(402, { 'payment-required': b64(CHALLENGE), 'content-type': 'application/json' });
			return res.end(JSON.stringify({ error: 'payment required' }));
		}
		// 402 with a body that parses but advertises nothing payable.
		if (req.url === '/empty-accepts') {
			res.writeHead(402, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ x402Version: 2, accepts: [] }));
		}
		// A free route: pointing the modal here must be a loud error, not a silent pass.
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true, free: true }));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address();
	return { origin: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

test('discover() parses a real 402 challenge and normalizes maxAmountRequired', async (t) => {
	const srv = await startServer();
	t.after(srv.close);

	const challenge = await discover({ endpoint: `${srv.origin}/paid/echo` });

	assert.equal(challenge.x402Version, 2);
	assert.equal(challenge.accepts.length, 2);
	// Spec-canonical maxAmountRequired coerced to the `amount` everything downstream reads.
	assert.equal(challenge.accepts[0].amount, '1000');
	assert.equal(challenge.accepts[0].network, CHALLENGE.accepts[0].network);
	// An entry that already carried `amount` is passed through untouched.
	assert.equal(challenge.accepts[1].amount, '1000');
	assert.equal(challenge.accepts[1].network, 'eip155:8453');
});

test('discover() reads the MCP 401 + payment-required header envelope', async (t) => {
	const srv = await startServer();
	t.after(srv.close);

	const challenge = await discover({ endpoint: `${srv.origin}/mcp/echo` });
	assert.equal(challenge.accepts.length, 2);
	assert.equal(challenge.accepts[0].amount, '1000');
});

test('discover() falls back to the header envelope when the 402 body has no accepts', async (t) => {
	const srv = await startServer();
	t.after(srv.close);

	const challenge = await discover({ endpoint: `${srv.origin}/header-only` });
	assert.equal(challenge.accepts.length, 2);
});

test('discover() forwards method, body and headers to the merchant', async (t) => {
	const srv = await startServer();
	t.after(srv.close);

	await discover({
		endpoint: `${srv.origin}/paid/echo`,
		method: 'POST',
		body: { text: 'hello world' },
		headers: { authorization: 'Bearer merchant-token' },
	});

	const req = srv.seen.at(-1);
	assert.equal(req.method, 'POST');
	assert.equal(req.auth, 'Bearer merchant-token');
	// An object body is JSON-encoded and content-type is set for the caller.
	assert.equal(req.contentType, 'application/json');
	assert.deepEqual(JSON.parse(req.body), { text: 'hello world' });
});

test('discover() rejects a free endpoint instead of silently succeeding', async (t) => {
	const srv = await startServer();
	t.after(srv.close);

	await assert.rejects(
		() => discover({ endpoint: `${srv.origin}/free` }),
		/did not return 402 \(got 200\)/,
	);
});

test('discover() rejects a 402 that advertises nothing payable', async (t) => {
	const srv = await startServer();
	t.after(srv.close);

	await assert.rejects(
		() => discover({ endpoint: `${srv.origin}/empty-accepts` }),
		/no `accepts` array could be found/,
	);
});

test('discover() requires an endpoint', async () => {
	await assert.rejects(() => discover({}), /endpoint is required/);
});
