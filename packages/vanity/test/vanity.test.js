import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	grind,
	expectedAttempts,
	validatePattern,
	base58Encode,
	createVanity,
	grindViaApi,
	ThreeWsError,
	PaymentRequiredError,
} from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints: we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
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

// --- base58 -----------------------------------------------------------------

test('base58Encode matches known vectors', () => {
	// Canonical Bitcoin Base58 test vector.
	assert.equal(base58Encode([...Buffer.from('Hello World')]), 'JxF12TrwUP45BMd');
	// 32 zero bytes is the Solana System Program address (all leading '1's).
	assert.equal(base58Encode(new Uint8Array(32)), '1'.repeat(32));
	// Leading zero bytes each render as a leading '1'.
	assert.equal(base58Encode([0, 0, 0, 1]), '1112');
	assert.equal(base58Encode([]), '');
});

// --- difficulty -------------------------------------------------------------

test('expectedAttempts is 58^n, adjusted for case-insensitivity', () => {
	assert.equal(expectedAttempts({ prefix: 'a' }), 58);
	assert.equal(expectedAttempts({ prefix: 'ab' }), 58 * 58);
	assert.equal(expectedAttempts({ prefix: 'a', suffix: 'b' }), 58 * 58);
	assert.equal(expectedAttempts({}), 1);
	// Case-insensitive letters with two valid Base58 cases halve the work.
	assert.equal(expectedAttempts({ prefix: 'a', ignoreCase: true }), 29);
	// 'o' has no uppercase Base58 sibling (O is excluded), so it stays at 58.
	assert.equal(expectedAttempts({ prefix: 'o', ignoreCase: true }), 58);
});

// --- validation -------------------------------------------------------------

test('validatePattern flags non-Base58 chars and overlong patterns', () => {
	assert.deepEqual(validatePattern('THREE'), { valid: true, errors: [] });
	const bad = validatePattern('O');
	assert.equal(bad.valid, false);
	assert.match(bad.errors[0], /invalid character 'O'/);
	const long = validatePattern('aaaaaaa');
	assert.equal(long.valid, false);
	assert.match(long.errors[0], /exceeds maximum of 6/);
});

// --- grind() ----------------------------------------------------------------

test('grind finds a 1-char prefix locally and returns a usable keypair', async () => {
	const ticks = [];
	const result = await grind({ prefix: 'A', onProgress: (p) => ticks.push(p) });

	assert.ok(result.publicKey.startsWith('A'), `expected prefix A, got ${result.publicKey}`);
	assert.equal(result.publicKey, base58Encode(result.secretKey.subarray(32)), 'public key encodes the trailing 32 bytes');
	assert.ok(result.secretKey instanceof Uint8Array);
	assert.equal(result.secretKey.length, 64, 'Solana 64-byte secret key layout');
	assert.ok(result.attempts >= 1);
	assert.equal(result.workers, 1);
	assert.equal(typeof result.durationMs, 'number');
	// A successful grind always emits a final progress tick.
	assert.ok(ticks.length >= 1);
	assert.equal(typeof ticks.at(-1).rate, 'number');
});

test('grind honours a suffix and case-insensitive matching', async () => {
	const result = await grind({ suffix: 'z', ignoreCase: true });
	assert.ok(result.publicKey.toLowerCase().endsWith('z'));
});

test('grind rejects bad input before doing any work', async () => {
	await assert.rejects(() => grind({}), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_input');
		assert.match(e.message, /prefix or suffix is required/);
		return true;
	});
	await assert.rejects(() => grind({ prefix: 'O' }), /invalid prefix/);
	await assert.rejects(() => grind({ suffix: 'aaaaaaa' }), /invalid suffix/);
});

test('grind rejects with AbortError when the signal is already aborted', async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => grind({ prefix: 'A', signal: controller.signal }), (e) => {
		assert.equal(e.name, 'AbortError');
		return true;
	});
});

// --- grindViaApi() (the paid x402 lane) -------------------------------------

test('grindViaApi shapes the hosted response and sends the query', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				address: 'THREEsynthetic1111111111111111111111111111',
				prefix: 'ag',
				suffix: null,
				ignoreCase: false,
				format: 'keypair',
				secretKeyBase58: 'SKsynthetic111',
				secretKey: Array(64).fill(0),
				attempts: 3364,
				durationMs: 134,
				expectedAttempts: 3364,
				network: 'solana',
				explorerUrl: 'https://solscan.io/account/THREEsynthetic1111111111111111111111111111',
			},
		},
	]);
	const client = createVanity({ fetch, baseUrl: 'https://three.ws' });
	const res = await client.grindViaApi({ prefix: 'ag', ignoreCase: true });

	assert.equal(calls[0].url.pathname, '/api/x402/vanity');
	assert.equal(calls[0].url.searchParams.get('prefix'), 'ag');
	assert.equal(calls[0].url.searchParams.get('ignoreCase'), '1');
	assert.equal(calls[0].url.searchParams.get('format'), null, 'default keypair format is omitted');
	assert.equal(res.address, 'THREEsynthetic1111111111111111111111111111');
	assert.ok(res.secretKey instanceof Uint8Array);
	assert.equal(res.secretKey.length, 64);
	assert.equal(res.network, 'solana');
});

test('grindViaApi rejects an over-long pattern before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createVanity({ fetch });
	await assert.rejects(() => client.grindViaApi({ prefix: 'abcd' }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_input');
		return true;
	});
	await assert.rejects(() => client.grindViaApi({ prefix: 'a', format: 'voxel' }), /Invalid format/);
	assert.equal(calls.length, 0);
});

test('grindViaApi maps a 402 to PaymentRequiredError with the x402 challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'solana', amount: '10000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const client = createVanity({ fetch });
	await assert.rejects(() => client.grindViaApi({ prefix: 'a' }), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});

test('grindViaApi maps a validation_error to a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 400, body: { error: 'validation_error', message: 'invalid prefix' } }]);
	const client = createVanity({ fetch });
	await assert.rejects(() => client.grindViaApi({ prefix: 'a' }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'validation_error');
		assert.equal(e.status, 400);
		return true;
	});
});

test('the default grindViaApi export is wired to a shared client', () => {
	assert.equal(typeof grindViaApi, 'function');
});

test('the standalone grindViaApi honours a per-call fetch and baseUrl', async () => {
	// The paid lane needs an x402-wrapped fetch, so a `fetch` passed straight to
	// the standalone export must actually be used: falling back to the global
	// one would send the call out unpaid and 402.
	const { fetch, calls } = stubFetch([{ body: { address: 'THREEsynthetic1111', network: 'solana' } }]);
	const res = await grindViaApi({ prefix: 'a', fetch, baseUrl: 'https://preview.three.ws' });

	assert.equal(calls.length, 1, 'the supplied fetch was called');
	assert.equal(calls[0].url.origin, 'https://preview.three.ws');
	assert.equal(calls[0].url.pathname, '/api/x402/vanity');
	assert.equal(calls[0].url.searchParams.get('prefix'), 'a');
	assert.equal(res.address, 'THREEsynthetic1111');
});

test('the standalone grindViaApi still validates before touching the supplied fetch', async () => {
	const { fetch, calls } = stubFetch([]);
	await assert.rejects(() => grindViaApi({ prefix: 'abcd', fetch }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_input');
		return true;
	});
	assert.equal(calls.length, 0);
});
