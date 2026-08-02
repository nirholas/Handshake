import { describe, it, expect } from 'vitest';

import {
	mulberry32,
	seedFromString,
	pickDeterministic,
	planFloatMove,
	floatBand,
	isRingAddress,
	executePurchase,
	assessAgentBuyingPower,
	readAgentUsdcAtomic,
	resetAgentUsdcCache,
} from '../api/_lib/x402/agents/persona-kit.js';
import {
	PERSONAS,
	selectPersonasForTick,
} from '../api/_lib/x402/agents/index.js';
import { isOnchainTick, onchainNetwork } from '../api/_lib/x402/agents/onchain.js';
import { persona as endpointShopper } from '../api/_lib/x402/agents/endpoint-shopper.js';
import { persona as agoraCitizen } from '../api/_lib/x402/agents/agora-citizen.js';
import { persona as curator } from '../api/_lib/x402/agents/curator.js';

// ── Deterministic RNG / selection ──────────────────────────────────────────────

describe('persona-kit — deterministic RNG', () => {
	it('mulberry32 is a pure function of its seed', () => {
		const a = mulberry32(12345);
		const b = mulberry32(12345);
		const seqA = [a(), a(), a()];
		const seqB = [b(), b(), b()];
		expect(seqA).toEqual(seqB);
		for (const x of seqA) expect(x).toBeGreaterThanOrEqual(0), expect(x).toBeLessThan(1);
	});

	it('different seeds diverge', () => {
		const a = mulberry32(1)();
		const b = mulberry32(2)();
		expect(a).not.toEqual(b);
	});

	it('seedFromString is stable and 32-bit', () => {
		expect(seedFromString('run-abc')).toBe(seedFromString('run-abc'));
		expect(seedFromString('run-abc')).not.toBe(seedFromString('run-xyz'));
		expect(seedFromString('anything') >>> 0).toBe(seedFromString('anything'));
	});

	it('pickDeterministic returns the same picks for the same seed', () => {
		const items = ['a', 'b', 'c', 'd', 'e'];
		expect(pickDeterministic(items, 7, 2)).toEqual(pickDeterministic(items, 7, 2));
		expect(pickDeterministic(items, 7, 2).length).toBe(2);
		// distinct items (no repeats within one pick)
		const [x, y] = pickDeterministic(items, 7, 2);
		expect(x).not.toBe(y);
	});
});

// ── Persona behaviour selection (deterministic given a tick seed) ───────────────

describe('ring roster — persona selection is deterministic', () => {
	it('selectPersonasForTick is reproducible for a given seed', () => {
		for (const seed of [0, 1, 42, 999, 2 ** 31]) {
			expect(selectPersonasForTick(seed).map((p) => p.id))
				.toEqual(selectPersonasForTick(seed).map((p) => p.id));
		}
	});

	it('activates all personas by default (≥3 distinct buyers per tick)', () => {
		const ids = selectPersonasForTick(123).map((p) => p.id);
		expect(new Set(ids).size).toBe(PERSONAS.length);
		expect(PERSONAS.length).toBeGreaterThanOrEqual(3);
	});

	it('a smaller window rotates fairly across seeds', () => {
		const first = selectPersonasForTick(0, { window: 1 }).map((p) => p.id);
		const second = selectPersonasForTick(1, { window: 1 }).map((p) => p.id);
		expect(first.length).toBe(1);
		expect(second.length).toBe(1);
		expect(first[0]).not.toBe(second[0]); // seed 0 vs 1 pick different personas
	});

	it('every persona plans a real, valid purchase for a seed', () => {
		for (const persona of PERSONAS) {
			const plan = persona.plan({ origin: 'https://three.ws', seed: 5, maxBuys: 1 });
			expect(plan.length).toBeGreaterThanOrEqual(1);
			// reproducible
			expect(persona.plan({ origin: 'https://three.ws', seed: 5, maxBuys: 1 })).toEqual(plan);
			for (const p of plan) {
				expect(p.slug).toBeTruthy();
				expect(p.url.startsWith('https://three.ws/api/x402/')).toBe(true);
				expect(['GET', 'POST']).toContain(p.method);
				expect(p.priceAtomic).toBeGreaterThan(0);
				expect(typeof p.kind).toBe('string');
			}
		}
	});

	it('personas cover the intended tiers (intel/health, tip/commerce, commerce)', () => {
		expect(endpointShopper.id).toBe('endpoint-shopper');
		expect(agoraCitizen.id).toBe('agora-citizen');
		expect(curator.id).toBe('curator');
		// The curator only ever promotes $THREE — never a third-party mint.
		const curatorPlan = curator.plan({ origin: 'https://three.ws', seed: 0, maxBuys: 2 });
		const billboard = curatorPlan.find((p) => p.slug === 'billboard');
		expect(billboard.url).toContain('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	});
});

// ── Float top-up bounds ────────────────────────────────────────────────────────

describe('float top-up — band arithmetic', () => {
	const band = { floorAtomic: 1_000_000, targetAtomic: 2_000_000, ceilingAtomic: 4_000_000 };

	it('tops up when below the floor, exactly to target', () => {
		const move = planFloatMove({ balanceAtomic: 250_000, ...band });
		expect(move.action).toBe('top_up');
		expect(move.amountAtomic).toBe(2_000_000 - 250_000);
	});

	it('sweeps overflow above the ceiling, back to target', () => {
		const move = planFloatMove({ balanceAtomic: 5_500_000, ...band });
		expect(move.action).toBe('sweep');
		expect(move.amountAtomic).toBe(5_500_000 - 2_000_000);
	});

	it('does nothing inside the band', () => {
		for (const bal of [1_000_000, 2_000_000, 3_999_999]) {
			expect(planFloatMove({ balanceAtomic: bal, ...band }).action).toBe('none');
		}
	});

	it('never returns a negative amount and handles empty balances', () => {
		const move = planFloatMove({ balanceAtomic: 0, ...band });
		expect(move.action).toBe('top_up');
		expect(move.amountAtomic).toBe(2_000_000);
	});

	it('floatBand derives a symmetric band from env defaults', () => {
		const b = floatBand();
		expect(b.targetAtomic).toBe(2_000_000); // $2 default
		expect(b.floorAtomic).toBeLessThan(b.targetAtomic);
		expect(b.ceilingAtomic).toBeGreaterThan(b.targetAtomic);
	});
});

// ── Allowlist enforcement + spend-limit refusal (executePurchase) ──────────────

const TREASURY = 'TREASURYwa11etRing1111111111111111111111111';
const OUTSIDER = '0utsiderwa11et9999999999999999999999999999';
const solanaStub = { conn: {}, blockhash: 'hash', mintInfo: { decimals: 6 } };

// A fake payer that HONORS the onAccept gate exactly like payX402 does, so the
// full guard chain (spend-limit → allowlist → pay → record) is exercised without a
// network. It reports the payTo the caller wants to simulate.
function fakePay(payTo, amountAtomic) {
	return async ({ onAccept }) => {
		const accept = { payTo, asset: 'USDC', amount: String(amountAtomic), network: 'solana' };
		if (typeof onAccept === 'function') {
			const hook = await onAccept(accept);
			if (hook?.abort) {
				return { success: false, paid: false, free: false, skipped: true, refusedByHook: true, amountAtomic, txSig: null, status: 402, responseBody: null, errorMsg: hook.reason };
			}
		}
		return { success: true, paid: true, free: false, skipped: false, amountAtomic, txSig: 'settle-sig-1', status: 200, responseBody: { ok: true } };
	};
}

// An agent whose spend policy is permissive AND whose anomaly guard is disabled, so
// enforceSpendLimit resolves without any DB access (userId present + anomaly off +
// no daily cap ⇒ no query path is reached).
function permissiveAgent() {
	return {
		id: '00000000-0000-0000-0000-000000000001',
		userId: 42,
		address: 'AGENTwa11et1111111111111111111111111111111',
		keypair: { publicKey: { toBase58: () => 'AGENTwa11et1111111111111111111111111111111' } },
		meta: { spend_limits: { per_tx_usd: 1, daily_usd: null }, anomaly: { enabled: false } },
	};
}

describe('executePurchase — allowlist enforcement', () => {
	it('isRingAddress reflects membership', () => {
		const allowed = new Set([TREASURY]);
		expect(isRingAddress(TREASURY, allowed)).toBe(true);
		expect(isRingAddress(OUTSIDER, allowed)).toBe(false);
		expect(isRingAddress(null, allowed)).toBe(false);
	});

	it('pays when the counterparty is inside ringAllowedAddresses()', async () => {
		const out = await executePurchase({
			agent: permissiveAgent(),
			purchase: { slug: 'three-intel', url: 'https://three.ws/api/x402/three-intel', method: 'GET', body: null, priceAtomic: 10_000, kind: 'intel' },
			solana: solanaStub,
			allowed: new Set([TREASURY]),
			persona: 'endpoint-shopper',
			payImpl: fakePay(TREASURY, 10_000),
		});
		expect(out.status).toBe('paid');
		expect(out.txSig).toBe('settle-sig-1');
		expect(out.payTo).toBe(TREASURY);
		expect(out.amountAtomic).toBe(10_000);
	});

	it('REFUSES before paying when the counterparty is outside the ring', async () => {
		const out = await executePurchase({
			agent: permissiveAgent(),
			purchase: { slug: 'three-intel', url: 'https://three.ws/api/x402/three-intel', method: 'GET', body: null, priceAtomic: 10_000, kind: 'intel' },
			solana: solanaStub,
			allowed: new Set([TREASURY]), // OUTSIDER is not in it
			persona: 'endpoint-shopper',
			payImpl: fakePay(OUTSIDER, 10_000),
		});
		expect(out.status).toBe('refused');
		expect(out.reason).toContain('payto_not_ring');
		expect(out.txSig).toBeNull();
	});
});

describe('executePurchase — spend-limit refusal (not thrown through the tick)', () => {
	it('an over-limit purchase is refused by enforceSpendLimit, returned not thrown', async () => {
		const agent = permissiveAgent();
		agent.meta.spend_limits.per_tx_usd = 0.001; // $0.001 ceiling
		let threw = false;
		let out;
		try {
			out = await executePurchase({
				agent,
				// $0.05 purchase — well over the $0.001 per-tx ceiling.
				purchase: { slug: 'billboard', url: 'https://three.ws/api/x402/billboard', method: 'GET', body: null, priceAtomic: 50_000, kind: 'commerce' },
				solana: solanaStub,
				allowed: new Set([TREASURY]),
				persona: 'curator',
				// If the guard fails to refuse, this fake would settle — proving the guard ran.
				payImpl: fakePay(TREASURY, 50_000),
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false); // the tick is never crashed by a refusal
		expect(out.status).toBe('refused');
		expect(out.reason).toContain('spend_limit:per_tx_exceeded');
		expect(out.txSig).toBeNull();
	});
});

// ── On-chain cadence gate ──────────────────────────────────────────────────────

describe('ring on-chain step — cadence gate', () => {
	it('fires only on the Nth tick', () => {
		expect(isOnchainTick(0, 60)).toBe(true);
		expect(isOnchainTick(60, 60)).toBe(true);
		expect(isOnchainTick(1, 60)).toBe(false);
		expect(isOnchainTick(59, 60)).toBe(false);
	});

	it('is disabled when everyN is 0', () => {
		expect(isOnchainTick(0, 0)).toBe(false);
		expect(isOnchainTick(100, 0)).toBe(false);
	});

	it('defaults to devnet (no new mainnet program calls)', () => {
		// Unless AGENT_INVOCATION_NETWORK=mainnet is explicitly set.
		if (process.env.AGENT_INVOCATION_NETWORK !== 'mainnet') {
			expect(onchainNetwork()).toBe('devnet');
		}
	});
});
