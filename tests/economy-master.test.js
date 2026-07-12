// Guard-logic tests for the economy funding root (api/_lib/economy-master.js).
// planTopUps is pure, so we can assert the reserve floor, per-engine cap, per-run
// cap, dust skip, and neediest-first ordering without any RPC or key.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
	planTopUps,
	filterToRegistry,
	RESERVE_SOL,
	PER_TOPUP_MAX_SOL,
	RUN_CAP_SOL,
} from '../api/_lib/economy-master.js';

// Defaults (no env overrides): reserve 0.02 (rent-exemption + fee headroom,
// not a business-scale gate), per-engine 0.5, run cap 2.
test('defaults are the documented guard values', () => {
	assert.equal(RESERVE_SOL, 0.02);
	assert.equal(PER_TOPUP_MAX_SOL, 0.5);
	assert.equal(RUN_CAP_SOL, 2);
});

test('reserve floor: a master below reserve funds nothing', () => {
	const { plan, totalSol, spendableSol } = planTopUps(0.01, [
		{ name: 'a', pubkey: 'A', currentSol: 0, refillToSol: 0.3 },
	]);
	assert.equal(spendableSol, 0);
	assert.equal(plan.length, 0);
	assert.equal(totalSol, 0);
});

test('a thinly funded master still spends nearly all of it (no oversized reserve gate)', () => {
	// 0.302 SOL master — the real prod balance this fix targets. Should be
	// able to spend ~0.282 of it, not sit fully locked behind a 1 SOL floor.
	const { plan, totalSol, spendableSol } = planTopUps(0.302, [
		{ name: 'engine', pubkey: 'E', currentSol: 0, refillToSol: 5 },
	]);
	assert.ok(spendableSol > 0.28 && spendableSol < 0.29);
	assert.equal(plan.length, 1);
	assert.equal(totalSol, spendableSol);
});

test('per-engine cap: one engine gets at most PER_TOPUP_MAX_SOL', () => {
	const { plan } = planTopUps(10, [
		{ name: 'greedy', pubkey: 'G', currentSol: 0, refillToSol: 3 },
	]);
	assert.equal(plan.length, 1);
	assert.equal(plan[0].sol, 0.5); // capped from a 3 SOL deficit
});

test('per-run cap: a sweep spends at most RUN_CAP_SOL total', () => {
	const targets = Array.from({ length: 6 }, (_, i) => ({
		name: `e${i}`,
		pubkey: `P${i}`,
		currentSol: 0,
		refillToSol: 0.5,
	}));
	const { plan, totalSol, skipped } = planTopUps(10, targets); // spendable ~9.98, runCap 2
	assert.equal(totalSol, 2);
	assert.equal(plan.length, 4); // 4 × 0.5 = 2.0
	assert.ok(skipped.some((s) => s.reason === 'run_cap_reached'));
});

test('per-run cap: a want exceeding the remaining budget is clamped, not skipped', () => {
	// master 1.32 → spendable 1.3 → runCap 1.3 (below the fixed 2 SOL cap, so the
	// balance itself is the binding constraint). Three engines each want the
	// per-engine max (0.5), but only 1.3 total exists: A and B get funded in
	// full, C should get the LEFTOVER 0.3 rather than being skipped outright —
	// a thin run cap should still be spent down, not wasted.
	const { plan, totalSol, skipped } = planTopUps(1.32, [
		{ name: 'a', pubkey: 'A', currentSol: 0, refillToSol: 1.0 },
		{ name: 'b', pubkey: 'B', currentSol: 0, refillToSol: 1.0 },
		{ name: 'c', pubkey: 'C', currentSol: 0, refillToSol: 1.0 },
	]);
	assert.equal(totalSol, 1.3);
	assert.equal(plan.length, 3);
	assert.equal(plan[0].sol, 0.5);
	assert.equal(plan[1].sol, 0.5);
	assert.equal(plan[2].sol, 0.3);
	assert.equal(skipped.length, 0);
});

test('dust: a sub-threshold deficit is skipped, not churned', () => {
	const { plan, skipped } = planTopUps(10, [
		{ name: 'hair', pubkey: 'H', currentSol: 0.499, refillToSol: 0.5 },
	]);
	assert.equal(plan.length, 0);
	assert.deepEqual(skipped, [{ name: 'hair', reason: 'below_dust_threshold' }]);
});

test('neediest first: the most-drained engine is planned before a less-needy one', () => {
	const { plan } = planTopUps(1.5, [
		{ name: 'small', pubkey: 'S', currentSol: 0.4, refillToSol: 0.5 }, // deficit 0.1
		{ name: 'big', pubkey: 'B', currentSol: 0.0, refillToSol: 0.5 }, // deficit 0.5
	]);
	assert.equal(plan[0].name, 'big');
});

// filterToRegistry is the hard leak guard: SOL can only ever move to a resolved
// registry signer, never off-registry and never the master itself.
test('allowlist: an off-registry pubkey is rejected, never funded', () => {
	const allowed = new Set(['ENGINE_A', 'ENGINE_B']);
	const { safe, rejected } = filterToRegistry(
		[
			{ name: 'legit', pubkey: 'ENGINE_A', currentSol: 0, refillToSol: 0.5 },
			{ name: 'attacker', pubkey: 'EVIL_ADDR', currentSol: 0, refillToSol: 0.5 },
		],
		allowed,
		'MASTER',
	);
	assert.deepEqual(safe.map((t) => t.name), ['legit']);
	assert.deepEqual(rejected, [{ name: 'attacker', pubkey: 'EVIL_ADDR', reason: 'not_in_registry' }]);
});

test('allowlist: the master is never a top-up target of itself', () => {
	const allowed = new Set(['MASTER', 'ENGINE_A']);
	const { safe, rejected } = filterToRegistry(
		[{ name: 'economy-master', pubkey: 'MASTER', currentSol: 0, refillToSol: 999 }],
		allowed,
		'MASTER',
	);
	assert.equal(safe.length, 0);
	assert.deepEqual(rejected, [{ name: 'economy-master', pubkey: 'MASTER', reason: 'is_master' }]);
});

test('allowlist: an empty registry funds nothing (safe default)', () => {
	const { safe, rejected } = filterToRegistry(
		[{ name: 'e', pubkey: 'ENGINE_A', currentSol: 0, refillToSol: 0.5 }],
		new Set(),
		'MASTER',
	);
	assert.equal(safe.length, 0);
	assert.equal(rejected.length, 1);
});
