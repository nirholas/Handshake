// Tests for the shared payment-policy core and the dry-run simulator.
//
// The whole value of /api/pay/simulate is that its answer is binding: if the
// dry run says a call settles, the enforcer must settle it. That guarantee
// rests on both surfaces importing api/_lib/pay/policy.js rather than each
// implementing the rules. So this file tests the predicates directly, and then
// adds a structural test asserting the governor still delegates to them, which
// is the assertion that fails if a future change reintroduces a second copy.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	SESSION_LIMITS,
	usdToAtomics,
	atomicsToUsd,
	normalizeHost,
	canonicalizeAllowlist,
	hostMatches,
	statusVerdict,
	expiryVerdict,
	allowlistVerdict,
	perTxVerdict,
	budgetVerdict,
	evaluateCall,
	replay,
} from '../api/_lib/pay/policy.js';

import { describeRail, selectRail } from '../api/_lib/pay/probe.js';
import { parseCalls, parsePolicy, buildSteps, recommend } from '../api/pay/simulate.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_NET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

describe('USDC atomics', () => {
	it('converts dollars to 6-decimal atomics', () => {
		expect(usdToAtomics(1)).toBe(1_000_000n);
		expect(usdToAtomics(0.001)).toBe(1000n);
		expect(usdToAtomics(0.000001)).toBe(1n);
	});

	it('rounds sub-atomic amounts rather than truncating to zero', () => {
		// $0.0000004 is below one atomic unit. Truncation would make it free.
		expect(usdToAtomics(0.0000004)).toBe(0n);
		expect(usdToAtomics(0.0000006)).toBe(1n);
	});

	it('round-trips through atomicsToUsd', () => {
		for (const usd of [0.001, 0.25, 1, 12.5, 1000]) {
			expect(atomicsToUsd(usdToAtomics(usd))).toBeCloseTo(usd, 9);
		}
	});
});

describe('host normalization', () => {
	it('reduces URLs, ports, and casing to a bare hostname', () => {
		expect(normalizeHost('https://API.Example.com/v1/data?x=1')).toBe('api.example.com');
		expect(normalizeHost('example.com:8443')).toBe('example.com');
		expect(normalizeHost('  Example.COM  ')).toBe('example.com');
	});

	it('returns empty for junk instead of throwing', () => {
		expect(normalizeHost('')).toBe('');
		expect(normalizeHost(null)).toBe('');
		expect(normalizeHost(undefined)).toBe('');
	});

	it('deduplicates and drops empties when canonicalizing an allowlist', () => {
		expect(canonicalizeAllowlist(['https://a.com/x', 'A.com', '', null, 'b.com'])).toEqual([
			'a.com',
			'a.com',
			'b.com',
		]);
	});
});

describe('hostMatches', () => {
	it('accepts the exact host and true subdomains', () => {
		expect(hostMatches('example.com', 'example.com')).toBe(true);
		expect(hostMatches('api.example.com', 'example.com')).toBe(true);
		expect(hostMatches('a.b.example.com', 'example.com')).toBe(true);
	});

	it('refuses a lookalike domain that merely ends in the allowed string', () => {
		// The bug a bare endsWith() would ship: an attacker registers
		// evil-example.com and inherits every allowlist naming example.com.
		expect(hostMatches('evil-example.com', 'example.com')).toBe(false);
		expect(hostMatches('notexample.com', 'example.com')).toBe(false);
	});

	it('refuses empty operands', () => {
		expect(hostMatches('', 'example.com')).toBe(false);
		expect(hostMatches('example.com', '')).toBe(false);
	});
});

describe('individual policy verdicts', () => {
	it('permits an active session and names the state otherwise', () => {
		expect(statusVerdict('active')).toBeNull();
		expect(statusVerdict('exhausted').code).toBe('session_inactive');
		expect(statusVerdict('exhausted').message).toBe('Session budget is exhausted');
		expect(statusVerdict('cancelled').message).toBe('Session has been cancelled');
		expect(statusVerdict('expired').message).toBe('Session has expired');
		expect(statusVerdict('weird').message).toBe('Session is weird');
	});

	it('rejects only a past expiry', () => {
		const now = new Date('2026-07-31T00:00:00Z');
		expect(expiryVerdict('2026-07-31T00:00:01Z', now)).toBeNull();
		expect(expiryVerdict('2026-07-30T23:59:59Z', now).code).toBe('session_expired');
	});

	it('treats a null or unparseable expiry as no expiry rather than expired', () => {
		// Failing open here is deliberate and safe: the budget still bounds spend,
		// whereas failing closed would brick every session whose row lacks a TTL.
		expect(expiryVerdict(null)).toBeNull();
		expect(expiryVerdict('not a date')).toBeNull();
	});

	it('treats an empty allowlist as "any host"', () => {
		expect(allowlistVerdict('https://anything.example/x', [])).toBeNull();
		expect(allowlistVerdict('https://anything.example/x', null)).toBeNull();
	});

	it('blocks a host that is not on a non-empty allowlist', () => {
		const v = allowlistVerdict('https://evil.test/x', ['example.com']);
		expect(v.code).toBe('allowlist_blocked');
		expect(v.detail).toEqual({ host: 'evil.test', allowlist: ['example.com'] });
	});

	it('allows a subdomain of an allowlisted domain', () => {
		expect(allowlistVerdict('https://api.example.com/x', ['example.com'])).toBeNull();
	});

	it('reports an unparseable target URL as a block, never as a pass', () => {
		const v = allowlistVerdict('not-a-url', ['example.com']);
		expect(v.code).toBe('allowlist_blocked');
		expect(v.message).toContain('Invalid target URL');
	});

	it('enforces the per-transaction ceiling at the boundary', () => {
		expect(perTxVerdict(500_000n, 500_000n)).toBeNull(); // exactly at the cap passes
		const v = perTxVerdict(500_001n, 500_000n);
		expect(v.code).toBe('per_tx_exceeded');
		expect(v.detail).toEqual({ amount_usd: 0.500001, cap_usd: 0.5 });
	});

	it('treats a null ceiling as uncapped', () => {
		expect(perTxVerdict(999_000_000n, null)).toBeNull();
	});

	it('enforces the budget at the boundary', () => {
		expect(budgetVerdict(1000n, 1000n)).toBeNull();
		const v = budgetVerdict(1001n, 1000n);
		expect(v.code).toBe('insufficient_budget');
		expect(v.detail).toEqual({ need_usd: 0.001001, remaining_usd: 0.001 });
	});
});

describe('evaluateCall rule ordering', () => {
	const base = {
		url: 'https://blocked.test/x',
		amountAtomics: 10_000_000n,
		policy: {
			status: 'active',
			expiresAt: new Date(Date.now() + 60_000),
			allowedHosts: ['example.com'],
			maxPerTxAtomics: 1n,
		},
		remainingAtomics: 0n,
	};

	it('reports the allowlist before the ceiling and the budget', () => {
		// All three rules would reject this call. Reporting the budget first would
		// send the user to fund a session that still could not reach the host.
		expect(evaluateCall(base).code).toBe('allowlist_blocked');
	});

	it('reports the ceiling before the budget', () => {
		const v = evaluateCall({ ...base, url: 'https://example.com/x' });
		expect(v.code).toBe('per_tx_exceeded');
	});

	it('reports state before everything else', () => {
		const v = evaluateCall({ ...base, policy: { ...base.policy, status: 'cancelled' } });
		expect(v.code).toBe('session_inactive');
	});

	it('reports expiry before the allowlist', () => {
		const v = evaluateCall({
			...base,
			policy: { ...base.policy, expiresAt: new Date(Date.now() - 1000) },
		});
		expect(v.code).toBe('session_expired');
	});

	it('returns null when every rule permits the call', () => {
		expect(
			evaluateCall({
				url: 'https://api.example.com/x',
				amountAtomics: 1000n,
				policy: {
					status: 'active',
					expiresAt: new Date(Date.now() + 60_000),
					allowedHosts: ['example.com'],
					maxPerTxAtomics: 5000n,
				},
				remainingAtomics: 5000n,
			}),
		).toBeNull();
	});
});

describe('replay', () => {
	const policy = {
		budgetAtomics: 10_000n, // $0.01
		maxPerTxAtomics: null,
		allowedHosts: [],
		status: 'active',
		expiresAt: null,
	};
	const call = (n) => ({ url: `https://example.com/${n}`, amountAtomics: 3000n });

	it('spends down the budget across the sequence', () => {
		const out = replay([call(1), call(2), call(3)], policy);
		expect(out.steps.every((s) => s.allowed)).toBe(true);
		expect(out.spentAtomics).toBe(9000n);
		expect(out.remainingAtomics).toBe(1000n);
	});

	it('refuses exactly the call that no longer fits, and every one after it', () => {
		const out = replay([call(1), call(2), call(3), call(4), call(5)], policy);
		expect(out.steps.map((s) => s.allowed)).toEqual([true, true, true, false, false]);
		expect(out.steps[3].rejection.code).toBe('insufficient_budget');
		expect(out.spentAtomics).toBe(9000n);
	});

	it('lets a cheaper later call through after an expensive one is refused', () => {
		// The budget is not "closed" by a refusal: the enforcer only reserves on
		// success, so a $0.001 call still settles after a $1 call was turned away.
		const out = replay(
			[
				{ url: 'https://example.com/big', amountAtomics: 50_000n },
				{ url: 'https://example.com/small', amountAtomics: 1000n },
			],
			policy,
		);
		expect(out.steps.map((s) => s.allowed)).toEqual([false, true]);
		expect(out.spentAtomics).toBe(1000n);
	});

	it('charges nothing for a refused call', () => {
		const out = replay([{ url: 'https://blocked.test/x', amountAtomics: 1000n }], {
			...policy,
			allowedHosts: ['example.com'],
		});
		expect(out.steps[0].allowed).toBe(false);
		expect(out.spentAtomics).toBe(0n);
		expect(out.remainingAtomics).toBe(10_000n);
	});

	it('exposes the running balance around each step', () => {
		const out = replay([call(1), call(2)], policy);
		expect(out.steps[0].remainingBeforeAtomics).toBe(10_000n);
		expect(out.steps[0].remainingAfterAtomics).toBe(7000n);
		expect(out.steps[1].remainingBeforeAtomics).toBe(7000n);
		expect(out.steps[1].remainingAfterAtomics).toBe(4000n);
	});

	it('handles an empty call list', () => {
		const out = replay([], policy);
		expect(out.steps).toEqual([]);
		expect(out.spentAtomics).toBe(0n);
	});
});

describe('402 rail description', () => {
	it('parses an amount as BigInt, never as a float', () => {
		// 9007199254740993 is beyond Number's exact integer range. Parsing it as a
		// float would silently change the price.
		const rail = describeRail({ network: SOLANA_NET, asset: USDC, amount: '9007199254740993' });
		expect(rail.amount_atomics).toBe('9007199254740993');
	});

	it('reports a null price for an unparseable amount instead of guessing zero', () => {
		const rail = describeRail({ network: SOLANA_NET, asset: USDC, amount: 'free!' });
		expect(rail.amount_atomics).toBeNull();
		expect(rail.amount_usd).toBeNull();
	});

	it('converts atomics to dollars', () => {
		const rail = describeRail({ network: SOLANA_NET, asset: USDC, amount: '1000', payTo: 'abc' });
		expect(rail.amount_usd).toBe(0.001);
		expect(rail.pay_to).toBe('abc');
		expect(rail.usdc).toBe(true);
	});
});

describe('rail selection', () => {
	const rails = [
		describeRail({ network: 'base', asset: '0x833589', amount: '2000' }),
		describeRail({ network: SOLANA_NET, asset: 'SomeOtherMint', amount: '3000' }),
		describeRail({ network: SOLANA_NET, asset: USDC, amount: '1000' }),
	];

	it('prefers the Solana USDC rail, which is what a session settles on', () => {
		expect(selectRail(rails, 'solana').asset).toBe(USDC);
	});

	it('selects the requested EVM rail when the session is a base session', () => {
		expect(selectRail(rails, 'base').network).toBe('base');
	});

	it('returns null when the endpoint offers nothing on the session network', () => {
		expect(selectRail([describeRail({ network: 'base', amount: '1' })], 'solana')).toBeNull();
	});
});

describe('simulator input parsing', () => {
	it('accepts a bare URL string', () => {
		const [call] = parseCalls(['https://example.com/a']);
		expect(call).toMatchObject({ url: 'https://example.com/a', method: 'GET', times: 1 });
	});

	it('rejects an empty or non-array calls list', () => {
		expect(() => parseCalls([])).toThrow(/non-empty/);
		expect(() => parseCalls(null)).toThrow(/non-empty/);
	});

	it('requires https even on a dev box, where validatePublicUrl would allow http', () => {
		// The endpoint is unauthenticated and fetches caller-chosen URLs, so it must
		// not be laxer locally than in production.
		expect(() => parseCalls(['http://example.com/a'])).toThrow(/public https/);
		expect(() => parseCalls(['file:///etc/passwd'])).toThrow(/public https/);
		expect(() => parseCalls(['gopher://example.com/a'])).toThrow(/public https/);
	});

	it('refuses a literal private address before any DNS work', () => {
		// Without this the simulator would be an SSRF probe with a friendly UI.
		// A public hostname that resolves inward is caught later, at probe time,
		// by resolvePublicHost and the connect-time address pin.
		expect(() => parseCalls(['https://169.254.169.254/latest/meta-data/'])).toThrow(/private address/);
		expect(() => parseCalls(['https://127.0.0.1/admin'])).toThrow(/private address/);
		expect(() => parseCalls(['https://10.0.0.5/internal'])).toThrow(/private address/);
		expect(() => parseCalls(['https://[::1]/admin'])).toThrow(/private address/);
	});

	it('clamps repetition to a sane range', () => {
		expect(parseCalls([{ url: 'https://example.com/a', times: 0 }])[0].times).toBe(1);
		expect(parseCalls([{ url: 'https://example.com/a', times: 1e9 }])[0].times).toBe(500);
	});

	it('rejects a negative supplied price', () => {
		expect(() => parseCalls([{ url: 'https://example.com/a', price_usd: -1 }])).toThrow(
			/non-negative/,
		);
	});

	it('caps the number of endpoints a single simulation may probe', () => {
		const many = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`);
		expect(() => parseCalls(many)).toThrow(/distinct endpoints/);
	});

	it('does not count supplied-price calls against the probe cap', () => {
		// They cost no outbound request, so bounding them would be arbitrary.
		const many = Array.from({ length: 30 }, (_, i) => ({
			url: `https://example.com/${i}`,
			price_usd: 0.01,
		}));
		expect(parseCalls(many)).toHaveLength(30);
	});
});

describe('simulator policy parsing', () => {
	it('clamps a budget to the range session creation accepts', () => {
		expect(parsePolicy({ budget_usd: 99_999 }).budgetUsd).toBe(SESSION_LIMITS.MAX_BUDGET_USD);
		expect(parsePolicy({ budget_usd: 0.0000001 }).budgetUsd).toBe(SESSION_LIMITS.MIN_BUDGET_USD);
	});

	it('says so when it clamped, rather than silently changing the answer', () => {
		expect(parsePolicy({ budget_usd: 99_999 }).notes.join(' ')).toMatch(/lowered/);
		expect(parsePolicy({ budget_usd: 0.0000001 }).notes.join(' ')).toMatch(/raised/);
	});

	it('clamps the TTL to the creatable range', () => {
		expect(parsePolicy({ expiry_seconds: 1 }).expirySeconds).toBe(SESSION_LIMITS.MIN_TTL_SECONDS);
		expect(parsePolicy({ expiry_seconds: 1e12 }).expirySeconds).toBe(SESSION_LIMITS.MAX_TTL_SECONDS);
	});

	it('flags a per-tx ceiling that can never bind', () => {
		const p = parsePolicy({ budget_usd: 1, max_per_tx_usd: 5 });
		expect(p.notes.join(' ')).toMatch(/never bind/);
	});

	it('drops a nonsense ceiling instead of enforcing it', () => {
		const p = parsePolicy({ budget_usd: 1, max_per_tx_usd: -3 });
		expect(p.maxPerTxUsd).toBeNull();
		expect(p.notes.join(' ')).toMatch(/ignored/);
	});

	it('accepts an allowlist as an array or a delimited string, deduplicated', () => {
		expect(parsePolicy({ allowed_hosts: ['A.com', 'https://a.com/x', 'b.com'] }).allowedHosts)
			.toEqual(['a.com', 'b.com']);
		expect(parsePolicy({ allowed_hosts: 'a.com, b.com  c.com' }).allowedHosts)
			.toEqual(['a.com', 'b.com', 'c.com']);
	});

	it('defaults to Solana and only accepts base as an alternative', () => {
		expect(parsePolicy({}).network).toBe('solana');
		expect(parsePolicy({ network: 'base' }).network).toBe('base');
		expect(parsePolicy({ network: 'ethereum' }).network).toBe('solana');
	});
});

describe('simulator step construction', () => {
	const priced = (amount) =>
		new Map([
			[
				'GET https://api.example.com/data',
				{
					probe: { kind: 'priced', rails: [], description: null },
					rail: describeRail({ network: SOLANA_NET, asset: USDC, amount, payTo: 'x' }),
				},
			],
		]);

	it('expands a repeated call into one step per repetition', () => {
		const calls = parseCalls([{ url: 'https://api.example.com/data', times: 3 }]);
		const { steps } = buildSteps(calls, priced('1000'), 'solana');
		expect(steps).toHaveLength(3);
		expect(steps.map((s) => s.repetition)).toEqual([1, 2, 3]);
		expect(steps.every((s) => s.amountAtomics === 1000n)).toBe(true);
	});

	it('marks a free endpoint as free rather than as a zero-dollar payment', () => {
		// The executor returns before governance when there is no 402, so a free
		// call can never be allowlist-blocked. Modelling it as a $0 payment would
		// make the simulator predict a refusal the enforcer would never raise.
		const calls = parseCalls(['https://api.example.com/data']);
		const map = new Map([
			['GET https://api.example.com/data', { probe: { kind: 'free', status: 200 }, rail: null }],
		]);
		const { steps } = buildSteps(calls, map, 'solana');
		expect(steps[0].free).toBe(true);
		expect(steps[0].priceable).toBe(false);
	});

	it('reports an unreachable endpoint as a problem and never as free', () => {
		const calls = parseCalls(['https://api.example.com/data']);
		const map = new Map([
			[
				'GET https://api.example.com/data',
				{ probe: { kind: 'error', code: 'endpoint_unreachable', message: 'nope' }, rail: null },
			],
		]);
		const { steps, problems } = buildSteps(calls, map, 'solana');
		expect(steps[0].priceable).toBe(false);
		expect(steps[0].free).toBe(false);
		expect(problems[0].code).toBe('endpoint_unreachable');
	});

	it('reports which networks an endpoint does offer when the session network is absent', () => {
		const calls = parseCalls(['https://api.example.com/data']);
		const map = new Map([
			[
				'GET https://api.example.com/data',
				{
					probe: { kind: 'priced', rails: [describeRail({ network: 'base', amount: '10' })] },
					rail: null,
				},
			],
		]);
		const { steps, problems } = buildSteps(calls, map, 'solana');
		expect(problems[0].code).toBe('no_rail_for_network');
		expect(steps[0].pricing.networks_offered).toEqual(['base']);
	});

	it('uses a supplied price without probing', () => {
		const calls = parseCalls([{ url: 'https://api.example.com/data', price_usd: 0.25 }]);
		const { steps } = buildSteps(calls, new Map(), 'solana');
		expect(steps[0].amountAtomics).toBe(250_000n);
		expect(steps[0].pricing.source).toBe('supplied');
	});
});

describe('policy recommendation', () => {
	const step = (url, usd) => ({
		url,
		priceable: true,
		free: false,
		amountAtomics: usdToAtomics(usd),
	});

	it('recommends a budget covering the whole sequence, rounded up to the cent', () => {
		const rec = recommend([step('https://a.com/x', 0.004), step('https://a.com/y', 0.008)], {
			allowedHosts: [],
			network: 'solana',
			expirySeconds: 3600,
		});
		expect(rec.exact_cost_usd).toBeCloseTo(0.012, 9);
		expect(rec.budget_usd).toBe(0.02);
	});

	it('sets the ceiling to the largest single payment in the run', () => {
		const rec = recommend([step('https://a.com/x', 0.01), step('https://a.com/y', 0.5)], {
			allowedHosts: [],
			network: 'solana',
			expirySeconds: 3600,
		});
		expect(rec.max_per_tx_usd).toBe(0.5);
	});

	it('lists every host the run touches', () => {
		const rec = recommend([step('https://a.com/x', 0.01), step('https://b.com/y', 0.01)], {
			allowedHosts: [],
			network: 'solana',
			expirySeconds: 3600,
		});
		expect(rec.allowed_hosts).toEqual(['a.com', 'b.com']);
	});

	it('names the hosts the proposed allowlist is missing', () => {
		const rec = recommend([step('https://a.com/x', 0.01), step('https://b.com/y', 0.01)], {
			allowedHosts: ['a.com'],
			network: 'solana',
			expirySeconds: 3600,
		});
		expect(rec.missing_hosts).toEqual(['b.com']);
	});

	it('counts a subdomain as covered by its parent domain entry', () => {
		const rec = recommend([step('https://api.a.com/x', 0.01)], {
			allowedHosts: ['a.com'],
			network: 'solana',
			expirySeconds: 3600,
		});
		expect(rec.missing_hosts).toEqual([]);
	});

	it('never recommends a budget below the creatable minimum', () => {
		const rec = recommend([], { allowedHosts: [], network: 'solana', expirySeconds: 3600 });
		expect(rec.budget_usd).toBe(SESSION_LIMITS.MIN_BUDGET_USD);
		expect(rec.max_per_tx_usd).toBeNull();
	});

	it('caps the recommendation at the creatable maximum', () => {
		const rec = recommend([step('https://a.com/x', 5000)], {
			allowedHosts: [],
			network: 'solana',
			expirySeconds: 3600,
		});
		expect(rec.budget_usd).toBe(SESSION_LIMITS.MAX_BUDGET_USD);
	});
});

describe('the enforcer and the simulator share one rule set', () => {
	const governor = read('api/_lib/pay/spend-governor.js');
	const flat = governor.replace(/\s+/g, ' ');

	it('imports its predicates from policy.js', () => {
		expect(governor).toMatch(/from '\.\/policy\.js'/);
		for (const fn of ['statusVerdict', 'expiryVerdict', 'allowlistVerdict', 'perTxVerdict']) {
			expect(governor, `the governor no longer uses ${fn}`).toContain(fn);
		}
	});

	it('does not reimplement the allowlist suffix rule inline', () => {
		// This is the exact line that used to live in the governor. If it comes
		// back, the simulator and the enforcer can drift apart again.
		expect(flat).not.toMatch(/targetHost\.endsWith/);
	});

	it('still decides the budget in SQL, not in JavaScript', () => {
		// The pure budgetVerdict is advisory. Only a predicated UPDATE is race-safe,
		// so the atomic reservation must remain a single statement.
		expect(flat).toContain('UPDATE payment_sessions SET spent_usdc = spent_usdc +');
		expect(flat).toContain('AND (budget_usdc - spent_usdc) >=');
	});

	it('keeps the simulator free of any signing or database path', () => {
		const sim = read('api/pay/simulate.js');
		for (const forbidden of ['@solana/web3.js', 'loadSeedKeypair', 'X-PAYMENT', '../_lib/db.js']) {
			expect(sim, `simulate.js must not reach for ${forbidden}`).not.toContain(forbidden);
		}
	});
});
