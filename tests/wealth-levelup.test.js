// @vitest-environment jsdom
//
// Unit tests for Embodied Finance — the tier "level-up" moment
// (src/shared/wealth-levelup.js). These pin the HONESTY contract of the
// celebration: it fires only on a genuine owner crossing of a real tier
// threshold, exactly once (deduped across reloads via localStorage), and never
// for a visitor, a flat wallet, or a drawdown. The card rendering is DOM glue;
// the logic that decides *whether* to celebrate is what must never lie, so that
// is what we test — deterministically, with no network and an injected event bus.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	tierMetaForLevel,
	shouldCelebrate,
	trackLevelUp,
	installLevelUpCelebrations,
	_internals,
} from '../src/shared/wealth-levelup.js';

const { EVENT, SEEN_PREFIX } = _internals;

function ownerState(level, extra = {}) {
	return { ok: true, isOwner: true, level, balanceUsd: 0, momentumUsd24h: 0, ...extra };
}

function captureEvents() {
	const events = [];
	const handler = (e) => events.push(e.detail);
	window.addEventListener(EVENT, handler);
	return { events, stop: () => window.removeEventListener(EVENT, handler) };
}

beforeEach(() => {
	localStorage.clear();
});

describe('tierMetaForLevel', () => {
	it('maps each level to its real tier and clamps out-of-range input', () => {
		expect(tierMetaForLevel(0).key).toBe('dormant');
		expect(tierMetaForLevel(3).key).toBe('glow');
		expect(tierMetaForLevel(5).key).toBe('luminous');
		expect(tierMetaForLevel(99).key).toBe('luminous'); // clamps up
		expect(tierMetaForLevel(-4).key).toBe('dormant');   // clamps down
		expect(tierMetaForLevel(undefined).key).toBe('dormant');
	});
});

describe('shouldCelebrate', () => {
	it('celebrates only an owner whose real tier strictly increased', () => {
		expect(shouldCelebrate(1, ownerState(2))).toBe(true);
	});
	it('never celebrates a non-owner, even on a real increase', () => {
		expect(shouldCelebrate(1, ownerState(2, { isOwner: false }))).toBe(false);
	});
	it('never celebrates a flat or dropping tier', () => {
		expect(shouldCelebrate(2, ownerState(2))).toBe(false);
		expect(shouldCelebrate(3, ownerState(1))).toBe(false);
	});
	it('does not celebrate on the unprimed (first) read', () => {
		expect(shouldCelebrate(null, ownerState(2))).toBe(false);
		expect(shouldCelebrate(NaN, ownerState(2))).toBe(false);
	});
	it('does not celebrate a soft-failed (neutral) state', () => {
		expect(shouldCelebrate(1, { ok: false, isOwner: true, level: 3 })).toBe(false);
	});
});

describe('trackLevelUp — live crossing', () => {
	it('fires once on a real owner crossing and returns the new level', () => {
		const cap = captureEvents();
		let lvl = null;
		lvl = trackLevelUp('a1', lvl, ownerState(1)); // prime, no stored seen
		expect(lvl).toBe(1);
		expect(cap.events).toHaveLength(0);

		lvl = trackLevelUp('a1', lvl, ownerState(2, { balanceUsd: 40 })); // crossed 1→2
		expect(lvl).toBe(2);
		expect(cap.events).toHaveLength(1);
		expect(cap.events[0]).toMatchObject({ agentId: 'a1', from: 1, to: 2, away: false });

		// Holding at the same tier does not re-fire.
		lvl = trackLevelUp('a1', lvl, ownerState(2, { balanceUsd: 60 }));
		expect(cap.events).toHaveLength(1);
		cap.stop();
	});

	it('never fires for a visitor watching someone else level up', () => {
		const cap = captureEvents();
		let lvl = trackLevelUp('a2', null, ownerState(1, { isOwner: false }));
		lvl = trackLevelUp('a2', lvl, ownerState(3, { isOwner: false }));
		expect(cap.events).toHaveLength(0);
		cap.stop();
	});

	it('does not invent a crossing during an RPC outage (neutral state)', () => {
		const cap = captureEvents();
		let lvl = trackLevelUp('a3', null, ownerState(2));
		// next poll fails → neutral { ok:false }; level must be held, no event
		lvl = trackLevelUp('a3', lvl, { ok: false, isOwner: false, level: 0 });
		expect(lvl).toBe(2);
		expect(cap.events).toHaveLength(0);
		cap.stop();
	});
});

describe('trackLevelUp — "while you were away" + dedup across reloads', () => {
	it('celebrates a crossing that happened since last visit, then never replays it', () => {
		const cap = captureEvents();
		// Last session left this agent at tier 1.
		localStorage.setItem(SEEN_PREFIX + 'a4', '1');

		// This session primes at tier 3 (it grew while away) → one away-celebration.
		let lvl = trackLevelUp('a4', null, ownerState(3, { balanceUsd: 300 }));
		expect(lvl).toBe(3);
		expect(cap.events).toHaveLength(1);
		expect(cap.events[0]).toMatchObject({ agentId: 'a4', from: 1, to: 3, away: true });
		expect(localStorage.getItem(SEEN_PREFIX + 'a4')).toBe('3');

		// A subsequent reload primes again at the same tier → no replay.
		const cap2 = captureEvents();
		trackLevelUp('a4', null, ownerState(3));
		expect(cap2.events).toHaveLength(0);
		cap.stop();
		cap2.stop();
	});

	it('a real drawdown re-arms a future re-climb (persists the lower level)', () => {
		const cap = captureEvents();
		let lvl = trackLevelUp('a5', null, ownerState(3));
		lvl = trackLevelUp('a5', lvl, ownerState(1)); // dropped — no event, persists 1
		expect(cap.events).toHaveLength(0);
		expect(localStorage.getItem(SEEN_PREFIX + 'a5')).toBe('1');

		lvl = trackLevelUp('a5', lvl, ownerState(2)); // climbs back → celebrate
		expect(cap.events).toHaveLength(1);
		expect(cap.events[0]).toMatchObject({ from: 1, to: 2 });
		cap.stop();
	});
});

describe('installLevelUpCelebrations — card rendering', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		// fetchAgentBrief degrades gracefully when the agent read fails.
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
	});

	it('mounts a card showing the REAL new tier label and dismisses on close', async () => {
		const uninstall = installLevelUpCelebrations();
		window.dispatchEvent(new CustomEvent(EVENT, {
			detail: {
				agentId: 'card1', from: 2, to: 3, away: false,
				state: { ok: true, isOwner: true, level: 3, balanceUsd: 420, momentumUsd24h: 12 },
			},
		}));
		await new Promise((r) => requestAnimationFrame(r));

		const card = document.querySelector('.wlu-card');
		expect(card).toBeTruthy();
		// Real tier label from the ladder, real balance, the "view wallet" deep-link.
		expect(card.querySelector('.wlu-tier').textContent).toBe('Glow');
		expect(card.textContent).toContain('$420');
		expect(card.querySelector('[data-wallet]').getAttribute('href')).toBe('/agents/card1/wallet');

		card.querySelector('.wlu-close').click();
		await new Promise((r) => setTimeout(r, 360)); // teardown fallback timer
		expect(document.querySelector('.wlu-card')).toBeNull();
		uninstall();
	});
});
