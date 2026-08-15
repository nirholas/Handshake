// The money math and the guards around it. computeSplit decides how much
// $THREE is destroyed forever versus routed to the treasury, and the policy
// gates (per-burn USD cap, confirm gate, signer parsing) are the only things
// standing between an injected prompt and an irreversible mainnet burn, so
// every one of them is pinned here.
//
// Nothing in this file touches the network or signs anything: every assertion
// is on a pure function or on a guard that fires before the first fetch.
//
// Run: node --test packages/three-token-mcp/test/burn-policy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSplit, burnThree } from '../src/lib/token.js';
import { def as threeBurn } from '../src/tools/three-burn.js';
import { keypairFromSecret } from '../src/lib/solana.js';
import { MAX_BURN_USD, REQUIRE_CONFIRM, EXPECTED_BURN_ADDRESS } from '../src/config.js';

const CONFIG = {
	mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	burn_address: EXPECTED_BURN_ADDRESS,
	treasury: 'THREEsynthetic11111111111111111111111111111',
	decimals: 6,
};

const sum = (legs) => legs.reduce((t, l) => t + l.atomics, 0n);
const leg = (legs, role) => legs.find((l) => l.role === role);

// ── computeSplit ─────────────────────────────────────────────────────────────

test('the default 5000 bps splits evenly and conserves every atomic unit', () => {
	const legs = computeSplit(1_000_000n, 5000, CONFIG);
	assert.equal(legs.length, 2);
	assert.equal(legs[0].role, 'burn', 'the burn leg leads the transaction');
	assert.equal(leg(legs, 'burn').atomics, 500_000n);
	assert.equal(leg(legs, 'treasury').atomics, 500_000n);
	assert.equal(sum(legs), 1_000_000n);
	assert.equal(leg(legs, 'burn').address, EXPECTED_BURN_ADDRESS);
	assert.equal(leg(legs, 'treasury').address, CONFIG.treasury);
});

test('rounding dust goes to the burn leg, never to the treasury', () => {
	// 101 at 50/50 cannot split evenly; the odd unit must be destroyed.
	const legs = computeSplit(101n, 5000, CONFIG);
	assert.equal(leg(legs, 'burn').atomics, 51n);
	assert.equal(leg(legs, 'treasury').atomics, 50n);
	assert.equal(sum(legs), 101n);
	// Same rule at an awkward ratio: burn is never short of its share.
	const thirds = computeSplit(100n, 3333, CONFIG);
	assert.ok(leg(thirds, 'burn').atomics >= 33n);
	assert.equal(sum(thirds), 100n);
});

test('10000 bps burns everything and emits a single leg', () => {
	const legs = computeSplit(1_000_000n, 10_000, CONFIG);
	assert.equal(legs.length, 1);
	assert.equal(legs[0].role, 'burn');
	assert.equal(legs[0].atomics, 1_000_000n);
});

test('0 bps routes it all to the treasury and burns nothing', () => {
	const legs = computeSplit(1_000_000n, 0, CONFIG);
	assert.equal(legs.length, 1);
	assert.equal(legs[0].role, 'treasury');
	assert.equal(legs[0].atomics, 1_000_000n);
});

test('a config with no treasury burns the whole amount rather than dropping it', () => {
	const legs = computeSplit(1_000_000n, 5000, { ...CONFIG, treasury: null });
	assert.equal(legs.length, 1);
	assert.equal(legs[0].role, 'burn');
	assert.equal(legs[0].atomics, 1_000_000n);
	assert.equal(sum(legs), 1_000_000n);
});

test('out-of-range and fractional bps are clamped and rounded, never thrown at the chain', () => {
	assert.equal(sum(computeSplit(1_000n, -50, CONFIG)), 1_000n);
	assert.equal(leg(computeSplit(1_000n, -50, CONFIG), 'treasury').atomics, 1_000n);
	assert.equal(leg(computeSplit(1_000n, 99_999, CONFIG), 'burn').atomics, 1_000n);
	assert.equal(leg(computeSplit(1_000n, 2500.4, CONFIG), 'burn').atomics, 250n);
});

test('a zero total produces no legs at all', () => {
	assert.deepEqual(computeSplit(0n, 5000, CONFIG), []);
});

// ── policy gates (all fire before any network or signing) ────────────────────

test('the per-burn USD cap defaults to $100 and refuses anything above it', async () => {
	assert.equal(MAX_BURN_USD, 100);
	await assert.rejects(
		() => burnThree({ usd: MAX_BURN_USD + 0.01 }),
		(err) => err.code === 'over_burn_cap' && /MAX_BURN_USD/.test(err.message),
	);
});

test('a non-positive burn amount is refused outright', async () => {
	for (const usd of [0, -1, 'abc', undefined]) {
		await assert.rejects(() => burnThree({ usd }), (err) => err.code === 'bad_amount');
	}
});

test('three_burn demands confirm:true before it will execute', async () => {
	assert.equal(REQUIRE_CONFIRM, true, 'the confirm gate must default to on');
	const refused = await threeBurn.handler({ usd: 1 });
	assert.equal(refused.ok, false);
	assert.equal(refused.error, 'confirmation_required');
	assert.match(refused.message, /IRREVERSIBLE/);
	// And the gate is not satisfied by a truthy-but-not-true value.
	const sneaky = await threeBurn.handler({ usd: 1, confirm: 'yes' });
	assert.equal(sneaky.error, 'confirmation_required');
});

test('the confirm gate is checked before the burn cap, so a huge burn cannot slip past it', async () => {
	const refused = await threeBurn.handler({ usd: MAX_BURN_USD * 10 });
	assert.equal(refused.error, 'confirmation_required');
});

test('a missing or malformed signer fails with a clear code, not a crash', () => {
	assert.throws(() => keypairFromSecret(''), (err) => err.code === 'no_signer');
	assert.throws(() => keypairFromSecret('   '), (err) => err.code === 'no_signer');
	assert.throws(() => keypairFromSecret(JSON.stringify([1, 2, 3])), (err) => err.code === 'bad_secret');
});
