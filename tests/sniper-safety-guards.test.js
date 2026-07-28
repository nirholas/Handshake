import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Query-aware fake `sql` for launcher-funding's ledger reads. Each source can be
// toggled to throw (missing-table simulation) to prove the fail-open contract.
const H = vi.hoisted(() => ({ launcherRunsThrows: false, sniperEventsThrows: false, launcherSol: 0, sniperLamports: 0 }));
vi.mock('../api/_lib/db.js', () => {
	const sql = (strings) => {
		const q = Array.isArray(strings) ? strings.join(' ').toLowerCase() : '';
		if (q.includes('from launcher_runs')) {
			if (H.launcherRunsThrows) return Promise.reject(new Error('relation "launcher_runs" does not exist'));
			return Promise.resolve([{ s: H.launcherSol }]);
		}
		if (q.includes('from sniper_funding_events')) {
			if (H.sniperEventsThrows) return Promise.reject(new Error('relation "sniper_funding_events" does not exist'));
			return Promise.resolve([{ s: H.sniperLamports / 1e9 }]);
		}
		return Promise.resolve([]);
	};
	return { sql, LAMPORTS_PER_SOL: 1_000_000_000, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

import { parseAgentIds } from '../workers/agent-sniper/config.js';
import { mayhemVerdict, mayhemGate } from '../workers/agent-sniper/mayhem-gate.js';
import { marketCapBandReason, scoreMint } from '../workers/agent-sniper/scorer.js';
import { checkDailyLoss } from '../api/_lib/agent-trade-guards.js';
import { effectiveDailyLossLimitLamports } from '../workers/agent-sniper/strategy-store.js';
import { criticalFirewallReason, classifyRoundTripRevert, probeQuoteLamports } from '../api/_lib/trade-firewall.js';
import { withinMasterDailyCap, masterDailyOutflowSol } from '../api/_lib/launcher-funding.js';

describe('parseAgentIds (worker agent scoping)', () => {
	it('returns null for unset / empty / whitespace', () => {
		expect(parseAgentIds(undefined)).toBeNull();
		expect(parseAgentIds('')).toBeNull();
		expect(parseAgentIds('   ')).toBeNull();
	});
	it('parses comma/space/newline separated UUIDs, lowercased + de-duped', () => {
		const a = 'c315ac7e-1c9e-46f8-8921-909dd572024d';
		const b = 'A633660F-D013-407D-832D-6C505A9EA15A';
		expect(parseAgentIds(`${a}, ${b}\n${a}`)).toEqual([a, b.toLowerCase()]);
	});
	it('drops non-UUID tokens, returns null if none valid', () => {
		expect(parseAgentIds('not-a-uuid, also-bad')).toBeNull();
		expect(parseAgentIds('nope, c315ac7e-1c9e-46f8-8921-909dd572024d')).toEqual(['c315ac7e-1c9e-46f8-8921-909dd572024d']);
	});
});

describe('mayhemVerdict (owner rule: no pump.fun Mayhem tokens)', () => {
	it('skips a Mayhem token', () => {
		expect(mayhemVerdict(true)).toEqual({ pass: false, reason: 'mayhem_excluded' });
	});
	it('allows a normal (non-Mayhem) token', () => {
		expect(mayhemVerdict(false)).toEqual({ pass: true });
	});
	it('allows-on-unknown by default, but skips when strict', () => {
		expect(mayhemVerdict(null)).toEqual({ pass: true, unknown: true });
		expect(mayhemVerdict(null, { strict: true })).toEqual({ pass: false, reason: 'mayhem_unknown', unknown: true });
		expect(mayhemVerdict(undefined, { strict: true })).toEqual({ pass: false, reason: 'mayhem_unknown', unknown: true });
	});
});

describe('mayhemGate', () => {
	it('is a no-op pass-through when the filter is disabled (no RPC)', async () => {
		await expect(mayhemGate('AnyMint111', { mayhemFilter: false })).resolves.toEqual({ pass: true });
	});
});

describe('marketCapBandReason (owner rule: buy only $10k–$100k, fail closed)', () => {
	const band = { min_market_cap_usd: 10_000, max_market_cap_usd: 100_000 };
	it('passes a coin inside the band', () => {
		expect(marketCapBandReason(50_000, band)).toBeNull();
	});
	it('blocks below the floor (a sub-$10k rug)', () => {
		expect(marketCapBandReason(4_500, band)).toMatch(/^mc_below_min:/);
	});
	it('blocks above the ceiling', () => {
		expect(marketCapBandReason(250_000, band)).toMatch(/^mc_above_max:/);
	});
	it('FAILS CLOSED on unknown market cap when a floor exists — never buys blind', () => {
		expect(marketCapBandReason(null, band)).toMatch(/^mc_below_min:n\/a</);
		expect(marketCapBandReason(undefined, band)).toMatch(/^mc_below_min:n\/a</);
	});
	it('is a no-op when the strategy configures no band', () => {
		expect(marketCapBandReason(null, {})).toBeNull();
		expect(marketCapBandReason(3, {})).toBeNull();
	});
});

describe('criticalFirewallReason (fail-closed: warnings that mean "unproven", not "safe")', () => {
	it('returns null for no assessment / clean checks', () => {
		expect(criticalFirewallReason(null)).toBeNull();
		expect(criticalFirewallReason({ checks: [{ status: 'pass', reason: 'authorities_renounced' }] })).toBeNull();
	});
	it('flags an unproven round-trip (honeypot sim unavailable)', () => {
		expect(criticalFirewallReason({ checks: [{ status: 'warn', reason: 'simulation_unavailable' }] }))
			.toBe('simulation_unavailable');
	});
	it('flags active mint authority (infinite-supply rug)', () => {
		expect(criticalFirewallReason({ checks: [{ status: 'warn', reason: 'mint_authority_active' }] }))
			.toBe('mint_authority_active');
	});
	it('does NOT flag a non-critical warning (e.g. price impact)', () => {
		expect(criticalFirewallReason({ checks: [{ status: 'warn', reason: 'price_impact' }] })).toBeNull();
	});
	it('ignores a critical code that actually passed', () => {
		expect(criticalFirewallReason({ checks: [{ status: 'pass', reason: 'mint_authority_active' }] })).toBeNull();
	});
});

describe('classifyRoundTripRevert (only a SELL-leg revert has the honeypot shape)', () => {
	// The real false positive from production: the probe payer could not fund the
	// simulated buy (system program 0x1) and the coin was blocked as a "honeypot".
	it('classifies an underfunded BUY leg as a warn, not a honeypot', () => {
		const v = classifyRoundTripRevert(
			{ InstructionError: [1, { Custom: 1 }] },
			['Transfer: insufficient lamports 143824832, need 296296295', 'Program failed'],
			3,
		);
		expect(v).toMatchObject({ leg: 'buy', status: 'warn', reason: 'buy_leg_underfunded' });
	});
	it('classifies any other BUY-leg revert (e.g. slippage) as a warn', () => {
		const v = classifyRoundTripRevert({ InstructionError: [2, { Custom: 6001 }] }, ['TooMuchSolRequired'], 3);
		expect(v).toMatchObject({ leg: 'buy', status: 'warn', reason: 'buy_leg_reverted' });
	});
	it('keeps a SELL-leg revert as a fatal honeypot fail', () => {
		const v = classifyRoundTripRevert({ InstructionError: [4, { Custom: 3012 }] }, [], 3);
		expect(v).toMatchObject({ leg: 'sell', status: 'fail', reason: 'roundtrip_reverted' });
	});
	// A funding failure often carries no InstructionError to read a leg off: a payer
	// whose account does not exist, or cannot cover the fee/rent, fails the whole
	// message. That is the poorest possible wallet, not the most dangerous possible
	// coin — reading it as a trapped exit is what labelled 336 ordinary bonding-curve
	// launches "honeypot" in a single afternoon.
	it('reads an unattributable FUNDING failure as an underfunded buy, not a honeypot', () => {
		expect(classifyRoundTripRevert('AccountNotFound', [], 3))
			.toMatchObject({ leg: 'buy', status: 'warn', reason: 'buy_leg_underfunded' });
		expect(classifyRoundTripRevert({ InsufficientFundsForRent: { account_index: 0 } }, [], 3))
			.toMatchObject({ status: 'warn', reason: 'buy_leg_underfunded' });
		expect(classifyRoundTripRevert('BlockhashNotFound', ['Transfer: insufficient lamports 1, need 2'], 3))
			.toMatchObject({ status: 'warn', reason: 'buy_leg_underfunded' });
	});
	it('still fails closed when an unattributable failure is not funding-shaped', () => {
		expect(classifyRoundTripRevert('BlockhashNotFound', [], 3)).toMatchObject({ status: 'fail', reason: 'roundtrip_reverted' });
		expect(classifyRoundTripRevert({ Custom: 3012 }, ['Program log: transfer hook rejected'], 3))
			.toMatchObject({ status: 'fail', reason: 'roundtrip_reverted' });
	});
});

describe('probeQuoteLamports (a honeypot traps any size — probe what the wallet can fund)', () => {
	const SOL = (n) => BigInt(Math.round(n * 1e9));
	it('keeps the full entry size when the balance is unknown', () => {
		expect(probeQuoteLamports(SOL(0.2), null)).toBe(SOL(0.2));
	});
	it('keeps the full entry size when the wallet can afford it', () => {
		expect(probeQuoteLamports(SOL(0.2), SOL(2.13))).toBe(SOL(0.2));
	});
	// luna's exact production shape: 0.2 SOL configured, 0.0153 SOL in the wallet.
	it('shrinks the probe to what a thin wallet can simulate', () => {
		const probe = probeQuoteLamports(SOL(0.2), SOL(0.0153));
		expect(probe).toBe(SOL(0.0153) - SOL(0.006));
		expect(probe).toBeLessThan(SOL(0.2));
	});
	it('returns null when even a minimum probe is unaffordable', () => {
		expect(probeQuoteLamports(SOL(0.2), SOL(0.006))).toBeNull();
		expect(probeQuoteLamports(SOL(0.2), 0n)).toBeNull();
	});
	it('never probes larger than the real entry', () => {
		expect(probeQuoteLamports(SOL(0.01), SOL(5))).toBe(SOL(0.01));
	});
});

describe('probe_unaffordable is a critical (unproven-safety) reason', () => {
	it('blocks a fail-closed caller rather than passing an unvetted coin', () => {
		expect(criticalFirewallReason({ checks: [{ status: 'warn', reason: 'probe_unaffordable' }] })).toBe('probe_unaffordable');
	});
	it('does not treat an underfunded buy leg as critical — the coin was not the problem', () => {
		expect(criticalFirewallReason({ checks: [{ status: 'warn', reason: 'buy_leg_underfunded' }] })).toBeNull();
	});
});

describe('scoreMint creator-launch gate (fail closed)', () => {
	it('skips a serial rugger over the launch cap', () => {
		const r = scoreMint({ market_cap_usd: 50_000, creator_launches: 25 }, { max_creator_launches: 10 });
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('creator_too_many_launches');
	});
	it('FAILS CLOSED when creator history is unknown but a cap is set', () => {
		const r = scoreMint({ market_cap_usd: 50_000, creator_launches: null }, { max_creator_launches: 10 });
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('creator_launches_unknown');
	});
});

describe('withinMasterDailyCap (hard master outflow ceiling)', () => {
	it('no cap when capSol is 0 / negative / non-finite', () => {
		expect(withinMasterDailyCap(5, 5, 0).ok).toBe(true);
		expect(withinMasterDailyCap(5, 5, -1).ok).toBe(true);
		expect(withinMasterDailyCap(5, 5, NaN).ok).toBe(true);
	});
	it('allows a transfer that stays within the cap (incl. exact boundary)', () => {
		expect(withinMasterDailyCap(1.0, 0.5, 2).ok).toBe(true);
		expect(withinMasterDailyCap(1.5, 0.5, 2).ok).toBe(true); // exactly at cap
	});
	it('refuses a transfer that would exceed the cap', () => {
		const r = withinMasterDailyCap(1.8, 0.5, 2);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/master_daily_cap/);
	});
});

describe('checkDailyLoss (realized-loss circuit breaker)', () => {
	const SOL = 1_000_000_000n;
	it('no breaker when limit is null / 0 / negative', () => {
		expect(checkDailyLoss(-5n * SOL, null)).toBeNull();
		expect(checkDailyLoss(-5n * SOL, 0n)).toBeNull();
		expect(checkDailyLoss(-5n * SOL, -1n)).toBeNull();
	});
	it('a profitable or break-even day never blocks', () => {
		expect(checkDailyLoss(3n * SOL, SOL)).toBeNull();
		expect(checkDailyLoss(0n, SOL)).toBeNull();
	});
	it('a loss shallower than the limit passes', () => {
		expect(checkDailyLoss(-1n * SOL, 2n * SOL)).toBeNull();
	});
	it('blocks once the net loss reaches the limit (inclusive)', () => {
		const atCap = checkDailyLoss(-2n * SOL, 2n * SOL);
		expect(atCap?.reason).toBe('daily_loss_limit');
		const over = checkDailyLoss(-3n * SOL, 2n * SOL);
		expect(over?.reason).toBe('daily_loss_limit');
		expect(over.detail.loss_lamports).toBe((3n * SOL).toString());
	});
	it('accepts string / number net values (DB numeric text)', () => {
		expect(checkDailyLoss('-2000000000', 1_000_000_000n)?.reason).toBe('daily_loss_limit');
	});
});

describe('effectiveDailyLossLimitLamports (env band ∧ per-strategy, tighter wins)', () => {
	const OLD = process.env.SNIPER_MAX_DAILY_LOSS_SOL;
	afterEach(() => {
		if (OLD == null) delete process.env.SNIPER_MAX_DAILY_LOSS_SOL;
		else process.env.SNIPER_MAX_DAILY_LOSS_SOL = OLD;
	});
	it('null when neither env nor strategy sets a cap', () => {
		delete process.env.SNIPER_MAX_DAILY_LOSS_SOL;
		expect(effectiveDailyLossLimitLamports({})).toBeNull();
	});
	it('env floor alone protects an unconfigured strategy', () => {
		process.env.SNIPER_MAX_DAILY_LOSS_SOL = '0.5';
		expect(effectiveDailyLossLimitLamports({})).toBe(500_000_000n);
	});
	it('per-strategy alone applies when env is unset', () => {
		delete process.env.SNIPER_MAX_DAILY_LOSS_SOL;
		expect(effectiveDailyLossLimitLamports({ daily_loss_limit_lamports: '250000000' })).toBe(250_000_000n);
	});
	it('takes the tighter (smaller) of env and per-strategy', () => {
		process.env.SNIPER_MAX_DAILY_LOSS_SOL = '1'; // 1e9
		expect(effectiveDailyLossLimitLamports({ daily_loss_limit_lamports: '250000000' })).toBe(250_000_000n);
		process.env.SNIPER_MAX_DAILY_LOSS_SOL = '0.1'; // 1e8
		expect(effectiveDailyLossLimitLamports({ daily_loss_limit_lamports: '250000000' })).toBe(100_000_000n);
	});
});

describe('masterDailyOutflowSol (fails open per-source)', () => {
	beforeEach(() => { H.launcherRunsThrows = false; H.sniperEventsThrows = false; H.launcherSol = 0; H.sniperLamports = 0; });
	it('sums both ledgers', async () => {
		H.launcherSol = 0.7; H.sniperLamports = 300_000_000; // 0.3 SOL
		await expect(masterDailyOutflowSol('mainnet')).resolves.toBeCloseTo(1.0, 6);
	});
	it('does not throw when a ledger table is missing — contributes 0', async () => {
		H.launcherRunsThrows = true; H.sniperLamports = 500_000_000;
		await expect(masterDailyOutflowSol('mainnet')).resolves.toBeCloseTo(0.5, 6);
	});
	it('returns 0 when both sources are unavailable', async () => {
		H.launcherRunsThrows = true; H.sniperEventsThrows = true;
		await expect(masterDailyOutflowSol('mainnet')).resolves.toBe(0);
	});
});
