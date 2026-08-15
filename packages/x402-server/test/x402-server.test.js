import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createX402Server,
	buildChallenge,
	feeSplit,
	fetchAdapter,
	ThreeWsError,
	NETWORK_SOLANA_MAINNET,
	NETWORK_BASE_MAINNET,
} from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real facilitator — we assert on request shaping
// and response parsing, which is all the SDK is responsible for. (Copied
// verbatim from @three-ws/forge's test harness.)
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

// A synthetic Solana fee payer + payTo (never a real address — see CLAUDE.md).
const SYNTH_SOLANA_PAYTO = 'THREEsynthetic1111111111111111111111111PayTo';
const SYNTH_SOLANA_FEEPAYER = 'THREEsynthetic1111111111111111111111FeePayer';
const SYNTH_BASE_PAYTO = '0x00000000000000000000000000000000DeaDBeef';
const SYNTH_TREASURY = 'TREASURYsynthetic111111111111111111111Treasury';

function xPaymentHeader(payload) {
	return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// A Node ServerResponse double that records status, headers, and the flushed
// body — enough to assert the wrapper attaches X-PAYMENT-RESPONSE and buffers
// the handler's writes until after settlement. Header lookups are
// case-insensitive, like a real ServerResponse.
function mockRes() {
	const headers = {};
	const chunks = [];
	return {
		statusCode: 200,
		writableEnded: false,
		setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return headers[String(k).toLowerCase()]; },
		write(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return true; },
		end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.writableEnded = true; return this; },
		get body() { return Buffer.concat(chunks).toString('utf8'); },
		get headers() { return headers; },
	};
}

function paidReq(header) {
	return { url: '/api/thing', headers: { host: 'three.ws', 'x-payment': header } };
}

test('buildChallenge() emits the exact v2 accepts[] envelope', () => {
	const challenge = buildChallenge({
		price: '50000',
		asset: 'usdc',
		payTo: { solana: SYNTH_SOLANA_PAYTO, base: SYNTH_BASE_PAYTO },
		feePayer: SYNTH_SOLANA_FEEPAYER,
		resourceUrl: 'https://three.ws/api/thing',
		description: 'Doc summarize',
	});

	assert.equal(challenge.x402Version, 2);
	assert.equal(challenge.error, 'X-PAYMENT header is required');
	assert.equal(challenge.resource.url, 'https://three.ws/api/thing');
	assert.equal(challenge.resource.description, 'Doc summarize');
	assert.equal(challenge.accepts.length, 2);

	// Solana leads (platform Solana-first ordering) and carries the fee payer.
	const sol = challenge.accepts[0];
	assert.equal(sol.scheme, 'exact');
	assert.equal(sol.network, NETWORK_SOLANA_MAINNET);
	assert.equal(sol.amount, '50000');
	assert.equal(sol.payTo, SYNTH_SOLANA_PAYTO);
	assert.equal(sol.asset, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
	assert.equal(sol.maxTimeoutSeconds, 60);
	assert.equal(sol.extra.name, 'USDC');
	assert.equal(sol.extra.decimals, 6);
	assert.equal(sol.extra.feePayer, SYNTH_SOLANA_FEEPAYER);

	// Base second, with the on-chain EIP-712 domain name "USD Coin" (not "USDC").
	const base = challenge.accepts[1];
	assert.equal(base.network, NETWORK_BASE_MAINNET);
	assert.equal(base.payTo, SYNTH_BASE_PAYTO);
	assert.equal(base.extra.name, 'USD Coin');
	assert.equal(base.extra.version, '2');
});

test('buildChallenge() advertises only the requested lane', () => {
	const challenge = buildChallenge({
		price: '2000',
		payTo: { solana: SYNTH_SOLANA_PAYTO, base: SYNTH_BASE_PAYTO },
		network: ['base'],
	});
	assert.equal(challenge.accepts.length, 1);
	assert.equal(challenge.accepts[0].network, NETWORK_BASE_MAINNET);
});

test('base-sepolia advertises the testnet USDC mint, not Base mainnet USDC', () => {
	const challenge = buildChallenge({
		price: '1000',
		payTo: { 'base-sepolia': SYNTH_BASE_PAYTO },
		network: ['base-sepolia'],
	});
	assert.equal(challenge.accepts.length, 1);
	// Circle's Base Sepolia USDC — distinct from Base mainnet's 0x8335… mint.
	assert.equal(challenge.accepts[0].asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
	assert.equal(challenge.accepts[0].extra.name, 'USD Coin');
});

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

test('acceptThree adds a $THREE Solana accept after USDC (both main assets)', () => {
	const challenge = buildChallenge({
		price: '10000',
		payTo: { solana: SYNTH_SOLANA_PAYTO, base: SYNTH_BASE_PAYTO },
		feePayer: SYNTH_SOLANA_FEEPAYER,
		acceptThree: true,
		threeAmount: '10000000',
	});
	// USDC-Solana, $THREE-Solana, then Base — $THREE rides after USDC so a
	// first-accept client still settles USDC.
	assert.equal(challenge.accepts.length, 3);
	const three = challenge.accepts[1];
	assert.equal(three.network, NETWORK_SOLANA_MAINNET);
	assert.equal(three.asset, THREE_MINT);
	assert.equal(three.amount, '10000000');
	assert.equal(three.extra.name, 'THREE');
	assert.equal(three.extra.decimals, 6);
	assert.equal(three.extra.feePayer, SYNTH_SOLANA_FEEPAYER);
});

test('acceptThree reuses the USDC price when threeAmount is omitted', () => {
	const challenge = buildChallenge({
		price: '50000',
		payTo: { solana: SYNTH_SOLANA_PAYTO },
		feePayer: SYNTH_SOLANA_FEEPAYER,
		acceptThree: true,
	});
	assert.equal(challenge.accepts.length, 2);
	assert.equal(challenge.accepts[1].asset, THREE_MINT);
	assert.equal(challenge.accepts[1].amount, '50000');
});

test("asset: 'three' pins the $THREE mint on Solana", () => {
	const challenge = buildChallenge({
		price: '10000000',
		asset: 'three',
		payTo: { solana: SYNTH_SOLANA_PAYTO },
		feePayer: SYNTH_SOLANA_FEEPAYER,
	});
	assert.equal(challenge.accepts.length, 1);
	assert.equal(challenge.accepts[0].asset, THREE_MINT);
	assert.equal(challenge.accepts[0].extra.name, 'THREE');
});

test("asset: 'three' on an EVM lane is rejected (Solana-only)", () => {
	assert.throws(
		() => buildChallenge({ price: '10000', asset: 'three', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] }),
		(err) => err instanceof ThreeWsError && err.code === 'invalid_input',
	);
});

test('a Solana accept without a feePayer is rejected with missing_fee_payer', () => {
	assert.throws(
		() => buildChallenge({ price: '1000', payTo: { solana: SYNTH_SOLANA_PAYTO } }),
		(e) => {
			assert.ok(e instanceof ThreeWsError);
			assert.equal(e.code, 'missing_fee_payer');
			return true;
		},
	);
});

test('the Solana sponsor falls back to X402_FEE_PAYER_SOLANA, and the option wins', () => {
	const previous = process.env.X402_FEE_PAYER_SOLANA;
	try {
		process.env.X402_FEE_PAYER_SOLANA = SYNTH_SOLANA_FEEPAYER;
		// Same call that throws with no env set: the sponsor now comes from the
		// environment, which is where a deployment keeps it.
		const fromEnv = buildChallenge({ price: '1000', payTo: { solana: SYNTH_SOLANA_PAYTO } });
		assert.equal(fromEnv.accepts[0].extra.feePayer, SYNTH_SOLANA_FEEPAYER);

		const explicit = buildChallenge({
			price: '1000',
			payTo: { solana: SYNTH_SOLANA_PAYTO },
			feePayer: 'THREEsynthetic11111111111111111111Explicit',
		});
		assert.equal(explicit.accepts[0].extra.feePayer, 'THREEsynthetic11111111111111111111Explicit');

		// A blank env is not a sponsor.
		process.env.X402_FEE_PAYER_SOLANA = '   ';
		assert.throws(
			() => buildChallenge({ price: '1000', payTo: { solana: SYNTH_SOLANA_PAYTO } }),
			(e) => e instanceof ThreeWsError && e.code === 'missing_fee_payer',
		);
	} finally {
		if (previous === undefined) delete process.env.X402_FEE_PAYER_SOLANA;
		else process.env.X402_FEE_PAYER_SOLANA = previous;
	}
});

test('buildChallenge() validates price + payTo before building', () => {
	assert.throws(() => buildChallenge({ payTo: { base: SYNTH_BASE_PAYTO } }), /needs a `price`/);
	assert.throws(() => buildChallenge({ price: '1.5', payTo: { base: SYNTH_BASE_PAYTO } }), /whole atomic amount/);
	assert.throws(() => buildChallenge({ price: '1000' }), /needs `payTo`/);
});

test('verifyPayment() POSTs the v2 verify body and shapes a valid result', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_SOLANA_PAYTO, network: NETWORK_SOLANA_MAINNET } },
	]);
	const server = createX402Server({ fetch });
	const accepts = buildChallenge({
		price: '50000',
		payTo: { solana: SYNTH_SOLANA_PAYTO },
		feePayer: SYNTH_SOLANA_FEEPAYER,
	}).accepts;

	const header = xPaymentHeader({ x402Version: 2, scheme: 'exact', network: NETWORK_SOLANA_MAINNET, payload: { transaction: 'abc' } });
	const verified = await server.verifyPayment({ paymentHeader: header, requirements: accepts });

	assert.equal(calls[0].url.pathname, '/verify');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.x402Version, 2);
	assert.equal(sent.paymentRequirements.network, NETWORK_SOLANA_MAINNET);
	assert.ok(sent.paymentPayload, 'decoded X-PAYMENT payload is forwarded');

	assert.equal(verified.ok, true);
	assert.equal(verified.payer, SYNTH_SOLANA_PAYTO);
	assert.equal(verified.network, NETWORK_SOLANA_MAINNET);
});

test('verifyPayment() accepts the positional (header, expected) shape', async () => {
	const { fetch } = stubFetch([{ body: { isValid: true, payer: SYNTH_BASE_PAYTO } }]);
	const server = createX402Server({ fetch });
	const challenge = buildChallenge({ price: '1000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] });
	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '1000' } } });
	const verified = await server.verifyPayment(header, challenge);
	assert.equal(verified.ok, true);
});

test('a facilitator-rejected payment returns a fresh 402 body, not a throw', async () => {
	const { fetch } = stubFetch([{ body: { isValid: false, invalidReason: 'underpaid' } }]);
	const server = createX402Server({ fetch });
	const accepts = buildChallenge({ price: '50000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] }).accepts;
	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '10' } } });
	const res = await server.verifyPayment({ paymentHeader: header, requirements: accepts });

	assert.equal(res.ok, false);
	assert.equal(res.code, 'invalid_payment');
	assert.equal(res.body.x402Version, 2);
	assert.deepEqual(res.body.accepts, accepts);
});

test('a facilitator outage on /verify is a typed 502, never a rejected payment', async () => {
	const { fetch } = stubFetch([{ status: 502, body: { error: 'bad_gateway' } }]);
	const server = createX402Server({ fetch });
	const accepts = buildChallenge({ price: '1000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] }).accepts;
	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '1000' } } });
	await assert.rejects(() => server.verifyPayment({ paymentHeader: header, requirements: accepts }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.status, 502);
		return true;
	});
});

test('settlePayment() POSTs /settle and shapes the receipt', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_SOLANA_PAYTO } },
		{ body: { success: true, transaction: 'TXSIG123', network: NETWORK_SOLANA_MAINNET, payer: SYNTH_SOLANA_PAYTO } },
	]);
	const server = createX402Server({ fetch });
	const accepts = buildChallenge({ price: '50000', payTo: { solana: SYNTH_SOLANA_PAYTO }, feePayer: SYNTH_SOLANA_FEEPAYER }).accepts;
	const header = xPaymentHeader({ network: NETWORK_SOLANA_MAINNET, payload: { transaction: 'abc' } });

	const verified = await server.verifyPayment({ paymentHeader: header, requirements: accepts });
	const receipt = await server.settlePayment({ verified });

	assert.equal(calls[1].url.pathname, '/settle');
	assert.equal(receipt.transaction, 'TXSIG123');
	assert.equal(receipt.network, NETWORK_SOLANA_MAINNET);
	assert.equal(receipt.payer, SYNTH_SOLANA_PAYTO);
});

test('paid() returns a 402 challenge when no X-PAYMENT header is present', async () => {
	const { fetch } = stubFetch([]);
	const server = createX402Server({ fetch });
	const handler = server.paid(
		{ price: '10000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] },
		async (_req, res) => res.end('should not run'),
	);

	const captured = { headers: {}, body: null, ended: false };
	const req = { url: '/api/thing', headers: { host: 'three.ws' } };
	const res = {
		statusCode: 200,
		writableEnded: false,
		setHeader(k, v) { captured.headers[k] = v; },
		end(b) { captured.ended = true; captured.body = b; this.writableEnded = true; },
	};
	await handler(req, res);

	assert.equal(res.statusCode, 402);
	assert.ok(captured.headers['PAYMENT-REQUIRED'], 'base64 PAYMENT-REQUIRED header is set');
	const body = JSON.parse(captured.body);
	assert.equal(body.x402Version, 2);
	assert.equal(body.accepts[0].network, NETWORK_BASE_MAINNET);
});

test('paid() verifies, runs the handler, then settles on a paid call', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_BASE_PAYTO } },
		{ body: { success: true, transaction: 'TX_PAID', network: NETWORK_BASE_MAINNET, payer: SYNTH_BASE_PAYTO } },
	]);
	const server = createX402Server({ fetch });
	const order = [];
	let settledReceipt = null;
	const handler = server.paid(
		{
			price: '10000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'],
			onSettled: (r) => { settledReceipt = r; },
		},
		async (_req, res, payment) => {
			order.push('work');
			assert.equal(payment.payer, SYNTH_BASE_PAYTO);
			res.end(JSON.stringify({ ok: true }));
		},
	);

	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '10000', to: SYNTH_BASE_PAYTO } } });
	const req = { url: '/api/thing', headers: { host: 'three.ws', 'x-payment': header } };
	const res = { statusCode: 200, writableEnded: false, setHeader() {}, end() { this.writableEnded = true; } };
	const receipt = await handler(req, res);

	// verify ran before settle (and the work ran between them).
	assert.equal(calls[0].url.pathname, '/verify');
	assert.equal(calls[1].url.pathname, '/settle');
	assert.deepEqual(order, ['work']);
	assert.equal(receipt.transaction, 'TX_PAID');
	assert.equal(settledReceipt.transaction, 'TX_PAID');
});

test('paid() attaches the X-PAYMENT-RESPONSE receipt header to a write-style (Express) handler', async () => {
	const { fetch } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_BASE_PAYTO } },
		{ body: { success: true, transaction: 'TX_RCPT', network: NETWORK_BASE_MAINNET, payer: SYNTH_BASE_PAYTO } },
	]);
	const server = createX402Server({ fetch });
	const handler = server.paid(
		{ price: '10000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] },
		// Express-style: the handler ends its own response. The good must NOT ship
		// before settlement, and the receipt header MUST be on the flushed 200.
		async (_req, res) => {
			res.statusCode = 201;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ good: 'premium data' }));
		},
	);

	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '10000' } } });
	const res = mockRes();
	await handler(paidReq(header), res);

	// The buffered response flushed with its own status + body preserved.
	assert.equal(res.statusCode, 201);
	assert.deepEqual(JSON.parse(res.body), { good: 'premium data' });
	// The settlement receipt rides the same 200 the buyer receives.
	const receiptHeader = res.getHeader('X-PAYMENT-RESPONSE');
	assert.ok(receiptHeader, 'X-PAYMENT-RESPONSE header is set on the response');
	const receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8'));
	assert.equal(receipt.transaction, 'TX_RCPT');
	assert.equal(receipt.network, NETWORK_BASE_MAINNET);
});

test('paid() serialises a return-value handler with the receipt header', async () => {
	const { fetch } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_BASE_PAYTO } },
		{ body: { success: true, transaction: 'TX_RET', network: NETWORK_BASE_MAINNET, payer: SYNTH_BASE_PAYTO } },
	]);
	const server = createX402Server({ fetch });
	const handler = server.paid(
		{ price: '10000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] },
		// Return-value style: no res.* calls, just return the good.
		async (_req, _res, payment) => ({ good: 'returned data', paidBy: payment.payer }),
	);

	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '10000' } } });
	const res = mockRes();
	await handler(paidReq(header), res);

	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.body), { good: 'returned data', paidBy: SYNTH_BASE_PAYTO });
	assert.ok(res.getHeader('X-PAYMENT-RESPONSE'), 'return-value handlers still get the receipt header');
});

test('paid() with streaming:true settles BEFORE the handler writes, header up-front', async () => {
	const order = [];
	const { fetch, calls } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_BASE_PAYTO } },
		{ body: { success: true, transaction: 'TX_STREAM', network: NETWORK_BASE_MAINNET, payer: SYNTH_BASE_PAYTO } },
	]);
	const server = createX402Server({ fetch });
	const handler = server.paid(
		{ price: '10000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'], streaming: true },
		async (_req, res) => {
			// Header must already be present when a streaming handler starts writing.
			order.push('work');
			assert.ok(res.getHeader('X-PAYMENT-RESPONSE'), 'streaming handler sees the receipt header up-front');
			res.write('chunk-1;');
			res.end('chunk-2');
		},
	);

	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '10000' } } });
	const res = mockRes();
	await handler(paidReq(header), res);

	// settle (calls[1]) ran before the work wrote its body.
	assert.equal(calls[1].url.pathname, '/settle');
	assert.deepEqual(order, ['work']);
	assert.equal(res.body, 'chunk-1;chunk-2');
});

test('paid() skips settlement and returns 500 when the handler throws (no funds move)', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_BASE_PAYTO } },
		// No settle response queued — asserting settle is NEVER called.
	]);
	const server = createX402Server({ fetch });
	const handler = server.paid(
		{ price: '10000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] },
		async () => { throw new Error('work exploded'); },
	);

	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '10000' } } });
	const res = mockRes();
	await handler(paidReq(header), res);

	assert.equal(calls.length, 1, 'only /verify ran — settlement was skipped on a failed handler');
	assert.equal(calls[0].url.pathname, '/verify');
	assert.equal(res.statusCode, 500);
	assert.ok(!res.getHeader('X-PAYMENT-RESPONSE'), 'no receipt on a failed, unsettled call');
	assert.equal(JSON.parse(res.body).error, 'handler_error');
});

test('paid() supports a fetch-style adapter (Request → Response)', async () => {
	const { fetch } = stubFetch([]);
	const server = createX402Server({ fetch });
	const handler = server.paid(
		{ price: '5000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'], adapter: fetchAdapter },
		async () => new Response(JSON.stringify({ ok: true })),
	);
	const request = new Request('https://three.ws/api/thing');
	const response = await handler(request);
	assert.equal(response.status, 402);
	assert.ok(response.headers.get('PAYMENT-REQUIRED'));
	const body = await response.json();
	assert.equal(body.accepts[0].network, NETWORK_BASE_MAINNET);
});

test('feeSplit() carves the fee OUT of the price (never marks up the buyer)', () => {
	// 2.5% of $1.00 (1_000_000 atomics): buyer still pays 1_000_000, creator nets 975_000, fee 25_000.
	const split = feeSplit('1000000', 250, SYNTH_TREASURY);
	assert.equal(split.price, '1000000');
	assert.equal(split.net, '975000');
	assert.equal(split.fee, '25000');
	assert.equal(split.bps, 250);
	assert.equal(split.recipient, SYNTH_TREASURY);
});

test('feeSplit() clamps bps to 10% and returns null when no fee applies', () => {
	// Over-max bps clamps to 1000 (10%): fee 100_000 on 1_000_000.
	assert.equal(feeSplit('1000000', 5000, SYNTH_TREASURY).fee, '100000');
	// Rate 0 → no fee.
	assert.equal(feeSplit('1000000', 0, SYNTH_TREASURY), null);
	// No recipient → no fee.
	assert.equal(feeSplit('1000000', 250, ''), null);
	// Sub-atomic fee (floor → 0) → null so the creator keeps the whole price.
	assert.equal(feeSplit('3', 250, SYNTH_TREASURY), null);
});

test('buildChallenge() surfaces the fee plan on the envelope when configured', () => {
	const challenge = buildChallenge({
		price: '1000000',
		payTo: { base: SYNTH_BASE_PAYTO },
		network: ['base'],
		feeBps: 250,
		feeTo: SYNTH_TREASURY,
	});
	assert.equal(challenge.fee.fee, '25000');
	assert.equal(challenge.fee.net, '975000');
	assert.equal(challenge.fee.recipient, SYNTH_TREASURY);
});
