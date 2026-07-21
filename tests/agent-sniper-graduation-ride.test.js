import { describe, it, expect } from 'vitest';
import { graduationRideGate, BOOST_WINDOW_MS } from '../workers/agent-sniper/graduation-ride.js';

// The pure per-strategy gate that decides whether a PumpPortal migration event
// arms a graduation_ride (BOOST-window) buy. The impure half (pool wait +
// executeBuy) rides the same chokepoint the whole fleet uses and is covered by
// the executor/amm-exit suites.

const NOW = 1_790_000_000_000; // fixed epoch ms
const strat = (over = {}) => ({ trigger: 'graduation_ride', agent_id: 'a', ...over });
const ev = (over = {}) => ({
	mint: 'MintPubkey1111111111111111111111111111111111',
	quote_symbol: 'SOL',
	timestamp: Math.floor(NOW / 1000),
	...over,
});

describe('graduationRideGate', () => {
	it('passes a fresh SOL-paired migration for a graduation_ride strategy', () => {
		expect(graduationRideGate(ev(), strat(), NOW)).toEqual({ pass: true });
	});

	it('rejects every other trigger (and the new_mint default)', () => {
		expect(graduationRideGate(ev(), strat({ trigger: 'new_mint' }), NOW).reason).toBe('not_graduation_ride');
		expect(graduationRideGate(ev(), strat({ trigger: 'intel_confirmed' }), NOW).reason).toBe('not_graduation_ride');
		expect(graduationRideGate(ev(), strat({ trigger: undefined }), NOW).reason).toBe('not_graduation_ride');
	});

	it('rejects an event with no mint', () => {
		expect(graduationRideGate(ev({ mint: null }), strat(), NOW).reason).toBe('no_mint');
		expect(graduationRideGate(null, strat(), NOW).reason).toBe('no_mint');
	});

	it('rejects non-SOL quoted pools (USDC/OTHER BOOST pairs are not lamports-priceable)', () => {
		expect(graduationRideGate(ev({ quote_symbol: 'USDC' }), strat(), NOW).reason).toBe('quote_not_sol');
		expect(graduationRideGate(ev({ quote_symbol: 'OTHER' }), strat(), NOW).reason).toBe('quote_not_sol');
	});

	it('treats a missing quote classification as SOL (live WS events always carry one)', () => {
		expect(graduationRideGate(ev({ quote_symbol: undefined }), strat(), NOW).pass).toBe(true);
	});

	it('rejects a stale event — too little of the 5-minute BOOST window left to ride', () => {
		// 2 minutes old: window has 3 minutes left, the minimum — boundary passes.
		const twoMinOld = ev({ timestamp: Math.floor((NOW - 2 * 60_000) / 1000) });
		expect(graduationRideGate(twoMinOld, strat(), NOW).pass).toBe(true);
		// Past the boundary: reject.
		const stale = ev({ timestamp: Math.floor((NOW - 2 * 60_000 - 5_000) / 1000) });
		expect(graduationRideGate(stale, strat(), NOW).reason).toBe('boost_window_stale');
		// Way past the whole window: reject.
		const dead = ev({ timestamp: Math.floor((NOW - BOOST_WINDOW_MS - 1_000) / 1000) });
		expect(graduationRideGate(dead, strat(), NOW).reason).toBe('boost_window_stale');
	});

	it('treats a missing timestamp as fresh (stamped at receipt on the live path)', () => {
		expect(graduationRideGate(ev({ timestamp: undefined }), strat(), NOW).pass).toBe(true);
	});
});
