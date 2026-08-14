import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createPumpfunSkills,
	NATIVE_MINT,
	ThreeWsError,
	PaymentRequiredError,
} from '../src/index.js';

// $THREE is the only coin. Tests use the real $THREE mint or a clearly-synthetic
// placeholder, never a third-party mint.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SYNTH_MINT = 'THREEsynthetic1111111111111111111111111111';
const WALLET = 'YourWa11et1111111111111111111111111111111111';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints, we assert on request shaping and
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

test('createCoin() posts camelCase inputs + encoding and returns the mint', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { transaction: 'AQID', mintPublicKey: SYNTH_MINT, brandMark: '3ws' } },
	]);
	const client = createPumpfunSkills({ fetch });
	const res = await client.createCoin({
		user: WALLET,
		name: '$THREE',
		symbol: 'THREE',
		uri: 'https://ipfs.io/ipfs/Qm/metadata.json',
		solLamports: '250000000',
	});

	assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://fun-block.pump.fun/agents/create-coin');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.name, '$THREE');
	assert.equal(sent.solLamports, '250000000');
	assert.equal(sent.encoding, 'base64', 'encoding:base64 is always sent');
	assert.ok(!('mayhemMode' in sent), 'unset options are pruned from the body');
	assert.equal(res.transaction, 'AQID');
	assert.equal(res.mint, SYNTH_MINT);
	assert.equal(res.brandMark, '3ws');
	assert.equal(res.encoding, 'base64');
});

test('swap() targets /agents/swap with the buy route', async () => {
	const { fetch, calls } = stubFetch([{ body: { transaction: 'BUYTX' } }]);
	const client = createPumpfunSkills({ fetch });
	const res = await client.swap({
		inputMint: NATIVE_MINT,
		outputMint: SYNTH_MINT,
		amount: '100000000',
		user: WALLET,
		slippagePct: 2,
	});

	assert.equal(calls[0].url.pathname, '/agents/swap');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.inputMint, NATIVE_MINT);
	assert.equal(sent.outputMint, SYNTH_MINT);
	assert.equal(sent.amount, '100000000');
	assert.equal(sent.slippagePct, 2);
	assert.equal(res.transaction, 'BUYTX');
});

test('coinFees() reads coins-v2 and maps snake_case → camelCase FeeInfo', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				mint: THREE_MINT,
				creator: WALLET,
				complete: false,
				bonding_curve: 'BondingCurve111',
				pump_swap_pool: null,
				is_cashback_coin: false,
			},
		},
	]);
	const client = createPumpfunSkills({ fetch });
	const fees = await client.coinFees(THREE_MINT);

	assert.equal(calls[0].url.origin, 'https://frontend-api-v3.pump.fun');
	assert.equal(calls[0].url.pathname, `/coins-v2/${THREE_MINT}`);
	assert.equal(fees.mint, THREE_MINT);
	assert.equal(fees.bondingCurve, 'BondingCurve111');
	assert.equal(fees.pool, null);
	assert.equal(fees.isGraduated, false);
	assert.equal(fees.feeDestination, 'creator');
	assert.equal(fees.creatorVaultLamports, '0');
});

test('coinFees() detects graduation and cashback routing', async () => {
	const { fetch } = stubFetch([
		{
			body: {
				mint: SYNTH_MINT,
				creator: WALLET,
				complete: true,
				bonding_curve: 'BC',
				pump_swap_pool: 'Pool222',
				is_cashback_coin: [true],
			},
		},
	]);
	const client = createPumpfunSkills({ fetch });
	const fees = await client.coinFees(SYNTH_MINT);
	assert.equal(fees.isGraduated, true);
	assert.equal(fees.pool, 'Pool222');
	assert.equal(fees.isCashbackCoin, true);
	assert.equal(fees.feeDestination, 'cashback');
});

test('sharingConfig() rejects bps that do not sum to 10000 before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createPumpfunSkills({ fetch });
	await assert.rejects(
		() => client.sharingConfig({
			mint: SYNTH_MINT,
			user: WALLET,
			shareholders: [{ address: WALLET, bps: 4000 }, { address: WALLET, bps: 4000 }],
		}),
		/sum to 10000/,
	);
	assert.equal(calls.length, 0);
});

test('sharingConfig() posts a valid 10000-bps split to /agents/sharing-config', async () => {
	const { fetch, calls } = stubFetch([{ body: { transaction: 'SHARETX' } }]);
	const client = createPumpfunSkills({ fetch });
	const res = await client.sharingConfig({
		mint: SYNTH_MINT,
		user: WALLET,
		shareholders: [{ address: WALLET, bps: 6000 }, { address: WALLET, bps: 4000 }],
	});
	assert.equal(calls[0].url.pathname, '/agents/sharing-config');
	assert.equal(res.transaction, 'SHARETX');
});

test('missing required inputs are rejected before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createPumpfunSkills({ fetch });
	await assert.rejects(() => client.createCoin({ name: '$THREE', symbol: 'THREE' }), /needs a non-empty `user`/);
	await assert.rejects(() => client.swap({ inputMint: NATIVE_MINT }), /needs a non-empty `outputMint`/);
	await assert.rejects(() => client.collectFees({ mint: SYNTH_MINT }), /needs a non-empty `user`/);
	assert.equal(calls.length, 0);
});

test('frontRunningProtection without a tipAmount is rejected before network', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createPumpfunSkills({ fetch });
	await assert.rejects(
		() => client.swap({ inputMint: NATIVE_MINT, outputMint: SYNTH_MINT, amount: '1', user: WALLET, frontRunningProtection: true }),
		/needs a `tipAmount`/,
	);
	assert.equal(calls.length, 0);
});

test('a non-2xx from /agents/* surfaces as a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 400, body: { error: 'insufficient_sol', message: 'Not enough SOL.' } }]);
	const client = createPumpfunSkills({ fetch });
	await assert.rejects(
		() => client.swap({ inputMint: NATIVE_MINT, outputMint: SYNTH_MINT, amount: '1', user: WALLET }),
		(e) => {
			assert.ok(e instanceof ThreeWsError);
			assert.equal(e.code, 'insufficient_sol');
			assert.equal(e.status, 400);
			return true;
		},
	);
});

test('402 surfaces as PaymentRequiredError carrying the x402 challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'eip155:8453', maxAmountRequired: '150000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const client = createPumpfunSkills({ fetch });
	await assert.rejects(
		() => client.collectFees({ mint: SYNTH_MINT, user: WALLET }),
		(e) => {
			assert.ok(e instanceof PaymentRequiredError);
			assert.deepEqual(e.accepts, accepts);
			return true;
		},
	);
});

test('a custom coinsV2Base overrides the read backend (devnet)', async () => {
	const { fetch, calls } = stubFetch([{ body: { mint: SYNTH_MINT, creator: WALLET, complete: false, bonding_curve: 'BC' } }]);
	const client = createPumpfunSkills({ fetch, coinsV2Base: 'https://devnet.example/coins-v2' });
	await client.coinFees(SYNTH_MINT);
	assert.equal(calls[0].url.origin, 'https://devnet.example');
	assert.equal(calls[0].url.pathname, `/coins-v2/${SYNTH_MINT}`);
});
