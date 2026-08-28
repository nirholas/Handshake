import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnockError, confirmationFor, formatUsdc, knock, quote, receipt } from '../src/index.js';

const FREE_DOOR = {
	handle: 'ada', display_name: 'Ada', free: true, price: '$0.00', price_atomics: '0',
	currency: 'USDC', networks: [], max_chars: 600, headline: null, greeting: null,
	endpoint: 'https://three.ws/api/knock/send', protocol: 'http',
};
const PAID_DOOR = {
	...FREE_DOOR, free: false, price: '$0.05', price_atomics: '50000',
	networks: ['solana'], endpoint: 'https://three.ws/api/x402/knock?to=ada', protocol: 'x402',
};

function stubFetch(routes) {
	const calls = [];
	const f = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		const key = Object.keys(routes).find((k) => String(url).includes(k));
		if (!key) return new Response('{"error":"not_found"}', { status: 404, headers: { 'content-type': 'application/json' } });
		const { status = 200, body } = routes[key];
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	};
	f.calls = calls;
	return f;
}

test('formatUsdc renders atomic units the way the API does', () => {
	assert.equal(formatUsdc(0n), '$0.00');
	assert.equal(formatUsdc('50000'), '$0.05');
	assert.equal(formatUsdc('1000'), '$0.001');
	assert.equal(formatUsdc('1000000'), '$1.00');
	assert.equal(formatUsdc('1234500000'), '$1234.50');
});

test('quote normalizes the handle and reads the public door', async () => {
	const f = stubFetch({ '/api/knock/door': { body: { door: PAID_DOOR } } });
	const door = await quote('@ADA', { fetch: f });
	assert.equal(door.price, '$0.05');
	assert.match(f.calls[0].url, /handle=ada/);
});

test('quote refuses a handle that could never be one', async () => {
	await assert.rejects(() => quote('not a handle!', { fetch: stubFetch({}) }), (err) => {
		assert.ok(err instanceof KnockError);
		assert.equal(err.code, 'bad_handle');
		return true;
	});
});

test('a free door sends with nothing but fetch', async () => {
	const f = stubFetch({
		'/api/knock/door': { body: { door: FREE_DOOR } },
		'/api/knock/send': { status: 201, body: { ok: true, knock_id: 'k1', delivered_to: 'Ada', paid: '$0.00', receipt_url: 'https://three.ws/api/knock/reply?id=k1&token=t', duplicate: false } },
	});
	const result = await knock({ to: 'ada', from: 'Bob', message: 'a real message', fetch: f });
	assert.equal(result.knock_id, 'k1');
	const sent = JSON.parse(f.calls[1].init.body);
	assert.equal(sent.to, 'ada');
	assert.equal(sent.sender_kind, 'agent');
});

test('a priced door refuses to guess a wallet', async () => {
	const f = stubFetch({ '/api/knock/door': { body: { door: PAID_DOOR } } });
	await assert.rejects(() => knock({ to: 'ada', from: 'Bob', message: 'a real message', fetch: f }), (err) => {
		assert.equal(err.code, 'payment_required');
		assert.match(err.message, /fetchWithPayment/);
		return true;
	});
});

test('a priced door pays through the caller-supplied x402 fetch', async () => {
	const f = stubFetch({ '/api/knock/door': { body: { door: PAID_DOOR } } });
	let paidUrl = null;
	const fetchWithPayment = async (url, init) => {
		paidUrl = String(url);
		assert.equal(JSON.parse(init.body).subject, 'hello');
		return new Response(JSON.stringify({ ok: true, knock_id: 'k2', delivered_to: 'Ada', paid: '$0.05', receipt_url: 'r', duplicate: false }), {
			status: 200, headers: { 'content-type': 'application/json' },
		});
	};
	const result = await knock({ to: 'ada', from: 'Bob', message: 'a real message', subject: 'hello', fetch: f, fetchWithPayment });
	assert.equal(result.paid, '$0.05');
	assert.equal(paidUrl, PAID_DOOR.endpoint);
});

test('maxPriceAtomics is checked before any payment is attempted', async () => {
	const f = stubFetch({ '/api/knock/door': { body: { door: PAID_DOOR } } });
	let paid = false;
	await assert.rejects(
		() => knock({
			to: 'ada', from: 'Bob', message: 'a real message', maxPriceAtomics: 10000n, fetch: f,
			fetchWithPayment: async () => { paid = true; return new Response('{}'); },
		}),
		(err) => {
			assert.equal(err.code, 'over_budget');
			return true;
		},
	);
	assert.equal(paid, false, 'nothing may be paid once the ceiling is exceeded');
});

test('a message longer than the door allows never reaches the network', async () => {
	const f = stubFetch({ '/api/knock/door': { body: { door: { ...FREE_DOOR, max_chars: 40 } } } });
	await assert.rejects(() => knock({ to: 'ada', from: 'Bob', message: 'x'.repeat(41), fetch: f }), (err) => {
		assert.equal(err.code, 'message_too_long');
		return true;
	});
	assert.equal(f.calls.length, 1, 'only the door read happened');
});

test('server errors surface with their code and status', async () => {
	const f = stubFetch({
		'/api/knock/door': { body: { door: FREE_DOOR } },
		'/api/knock/send': { status: 429, body: { error: 'door_full', error_description: 'full for today' } },
	});
	await assert.rejects(() => knock({ to: 'ada', from: 'Bob', message: 'a real message', fetch: f }), (err) => {
		assert.equal(err.code, 'door_full');
		assert.equal(err.status, 429);
		return true;
	});
});

test('receipt reads the knock state back with no account', async () => {
	const f = stubFetch({ '/api/knock/reply': { body: { knock: { id: 'k1', status: 'replied', reply: 'sure', seen: true, amount: '$0.05' } } } });
	const state = await receipt('https://three.ws/api/knock/reply?id=k1&token=t', { fetch: f });
	assert.equal(state.reply, 'sure');
});

test('confirmationFor names the recipient, amount, token and chain', () => {
	const c = confirmationFor(PAID_DOOR);
	assert.equal(c.recipient, 'Ada (@ada)');
	assert.equal(c.amount, '$0.05');
	assert.equal(c.token, 'USDC');
	assert.deepEqual(c.chains, ['solana']);
	assert.match(c.note, /settles directly/);
});
