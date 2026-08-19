// The guardrail layer: exact decimal maths, and every rule that can refuse a
// spend, including the ones that matter most when they are wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toBaseUnits, fromBaseUnits } from '../src/lib/solana.js';
import { normalizePolicy, normalizeHost, evaluateSpend, spentInWindow } from '../src/lib/policy.js';

const D = 6;
const u = (s) => toBaseUnits(s, D);

test('amounts convert exactly, with no float drift', () => {
	assert.equal(u('1'), 1_000_000n);
	assert.equal(u('0.000001'), 1n);
	assert.equal(u('1234.567891'), 1_234_567_891n);
	assert.equal(fromBaseUnits(1_000_000n, D), '1');
	assert.equal(fromBaseUnits(1n, D), '0.000001');
	assert.equal(fromBaseUnits(1_234_567_891n, D), '1234.567891');
	// 0.1 + 0.2 is the classic float failure. Base units make it exact.
	assert.equal(u('0.1') + u('0.2'), u('0.3'));
	assert.throws(() => u('1.1234567'), /decimal places/);
	assert.throws(() => u('-5'), /positive decimal/);
	assert.throws(() => u('abc'), /positive decimal/);
});

test('policy normalization rejects incoherent rules', () => {
	assert.throws(() => normalizePolicy({ per_tx: '10', daily: '5' }), /never be reachable/);
	assert.throws(() => normalizePolicy({ per_tx: 'lots' }), /positive decimal/);
	assert.throws(() => normalizePolicy({ expires_at: 'soon' }), /ISO timestamp/);
	assert.throws(() => normalizePolicy({ allow_recipients: ['not-an-address'] }), /valid Solana address/);

	const cleared = normalizePolicy({ per_tx: null }, { per_tx: '5' });
	assert.equal(cleared.per_tx, null, 'null clears a cap');

	const kept = normalizePolicy({ daily: '50' }, { per_tx: '5' });
	assert.equal(kept.per_tx, '5', 'unmentioned fields survive a patch');
});

test('hosts normalize from bare names and full URLs alike', () => {
	assert.equal(normalizeHost('Example.COM'), 'example.com');
	assert.equal(normalizeHost('https://api.example.com/v1/thing?x=1'), 'api.example.com');
	assert.throws(() => normalizeHost(''), /cannot be empty/);
});

test('each guardrail refuses for its own reason', () => {
	const policy = normalizePolicy({ per_tx: '5', daily: '20', allow_hosts: ['example.com'] });
	const base = { policy, decimals: D, remainingAllowance: u('1000') };

	assert.equal(evaluateSpend({ ...base, amount: u('1'), host: 'example.com' }).allowed, true);
	assert.equal(evaluateSpend({ ...base, amount: u('6'), host: 'example.com' }).code, 'over_per_tx');
	assert.equal(evaluateSpend({ ...base, amount: u('5'), spentToday: u('18'), host: 'example.com' }).code, 'over_daily');
	assert.equal(evaluateSpend({ ...base, amount: u('1'), host: 'evil.com' }).code, 'host_not_allowed');
	assert.equal(evaluateSpend({ ...base, amount: u('1'), host: 'api.example.com' }).allowed, true, 'subdomains inherit');
	assert.equal(evaluateSpend({ ...base, amount: 0n, host: 'example.com' }).code, 'bad_amount');

	const paused = normalizePolicy({ paused: true }, policy);
	assert.equal(evaluateSpend({ ...base, policy: paused, amount: u('1'), host: 'example.com' }).code, 'paused');

	const expired = normalizePolicy({ expires_at: '2020-01-01T00:00:00Z' }, policy);
	assert.equal(evaluateSpend({ ...base, policy: expired, amount: u('1'), host: 'example.com' }).code, 'expired');
});

test('the on-chain allowance is checked even when local caps pass', () => {
	const policy = normalizePolicy({ per_tx: '100' });
	const decision = evaluateSpend({ policy, amount: u('50'), decimals: D, remainingAllowance: u('10') });
	assert.equal(decision.allowed, false);
	assert.equal(decision.code, 'over_allowance');
});

test('an empty allowlist means unrestricted, not locked out', () => {
	const policy = normalizePolicy({ per_tx: '5' });
	const decision = evaluateSpend({
		policy,
		amount: u('1'),
		decimals: D,
		remainingAllowance: u('100'),
		recipient: 'So11111111111111111111111111111111111111112',
		host: 'anywhere.example',
	});
	assert.equal(decision.allowed, true);
	assert.ok(decision.checks.some((c) => c.check === 'recipient' && /unrestricted/.test(c.detail)));
});

test('the confirm threshold blocks once and passes when confirmed', () => {
	const policy = normalizePolicy({ confirm_over: '1' });
	const base = { policy, decimals: D, remainingAllowance: u('100') };

	const blocked = evaluateSpend({ ...base, amount: u('2') });
	assert.equal(blocked.allowed, false);
	assert.equal(blocked.requires_confirm, true);
	assert.equal(blocked.code, 'needs_confirmation');

	assert.equal(evaluateSpend({ ...base, amount: u('2'), confirm: true }).allowed, true);
	assert.equal(evaluateSpend({ ...base, amount: u('1') }).allowed, true, 'at the threshold is not over it');
});

test('a hard refusal outranks a confirmation prompt', () => {
	// An over-cap spend must report the cap, never invite the caller to confirm
	// its way past one.
	const policy = normalizePolicy({ per_tx: '5', confirm_over: '1' });
	const decision = evaluateSpend({ policy, amount: u('50'), decimals: D, remainingAllowance: u('1000') });
	assert.equal(decision.code, 'over_per_tx');
	assert.equal(decision.requires_confirm, false);
});

test('the daily window only counts allowed spends inside it', () => {
	const now = new Date('2026-08-19T12:00:00Z');
	const ledger = [
		{ at: '2026-08-19T11:00:00Z', allowed: true, base_units: '1000000' },
		{ at: '2026-08-19T10:00:00Z', allowed: false, base_units: '9000000' },
		{ at: '2026-08-17T10:00:00Z', allowed: true, base_units: '5000000' },
	];
	assert.equal(spentInWindow(ledger, { hours: 24, now }), 1_000_000n, 'refusals and old rows are excluded');
	assert.equal(spentInWindow(ledger, { hours: 24 * 7, now }), 6_000_000n);
});
