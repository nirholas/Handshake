// The Home lane's scoring rules, exercised directly.
//
// The one thing this file is really for: proving that a single dark house does
// NOT read as an outage, and that ten of them at once does. Everything else in
// the observability lane is downstream of getting that distinction right, and it
// is the distinction that is easy to break in a refactor and impossible to
// notice until somebody is paged at 3am for a stranger's router.
//
// `homeHealthVerdict` and `noteSubscriberSample` are pure, so every threshold is
// asserted here without a database. The end-to-end proof against a real Postgres
// and a real Home Assistant is in the order 13 report.

import { beforeEach, describe, expect, it } from 'vitest';

import {
	ACTION_DOWN,
	EXPIRY_DOWN,
	HANDSHAKE_DOWN,
	homeHealthVerdict,
	LATENCY_DOWN_MS,
	MIN_ACTIONS_FOR_A_VERDICT,
	MIN_CONFIRMATIONS_FOR_A_VERDICT,
	MIN_HOMES_FOR_A_VERDICT,
	noteSubscriberSample,
	resetSubscriberSamples,
} from '../api/_lib/ops/home-health.js';

/** A platform where nothing is wrong, as `readHomeSignals` shapes it. */
function healthy(overrides = {}) {
	return {
		windowMinutes: 15,
		homes: { live: 40, connected: 40, unreachable: 0, authFailed: 0 },
		handshakes: { attempts: 40, ok: 40, failed: 0, rate: 1 },
		actions: { total: 200, ok: 198, refused: 2, failed: 0, homes: 30, failedHomes: 0, rate: 1, timed: 200, p95LatencyMs: 300 },
		confirmations: { total: 20, redeemed: 19, expired: 1, expiryRate: 1 / 20 },
		integrity: { violations: 0, lastAt: null, grantBacked: 0, grantBackedWithoutGrant: 0 },
		pool: { open: 12, subscribers: 12, capacity: 200, breakersOpen: 0, byStatus: { connected: 12 }, streams: 12, rung: 'normal' },
		leak: { leaking: false, samples: [12, 12, 12], margins: [0, 0, 0], growth: 0 },
		...overrides,
	};
}

describe('confirmation integrity is a zero-budget invariant', () => {
	it('takes the subsystem down on a single row, however healthy everything else is', () => {
		const verdict = homeHealthVerdict(healthy({ integrity: { violations: 1, lastAt: '2026-09-03T03:37:14.568Z', grantBacked: 0, grantBackedWithoutGrant: 0 } }));
		expect(verdict.status).toBe('down');
		expect(verdict.detail).toContain('no confirmation on record');
		expect(verdict.hint).toContain('Sev 1');
	});

	it('does not fire on an unlock a standing grant already authorised', () => {
		// The shape real traffic produces: the user granted the agent lock.kitchen_door
		// once, so the gate cleared it through the allow list and nobody was asked
		// again. Paging on this would page on every legitimate unlock forever.
		const verdict = homeHealthVerdict(
			healthy({ integrity: { violations: 0, lastAt: null, grantBacked: 2, grantBackedWithoutGrant: 0 } }),
		);
		expect(verdict.status).toBe('ok');
		expect(verdict.detail).toContain('2 guarded action(s) cleared by a standing grant');
	});

	it('reports a grant-backed action whose grant no longer exists without alerting on it', () => {
		// A grant revoked after the action is the ordinary explanation, which is
		// why this is a number to read rather than a page to answer.
		const verdict = homeHealthVerdict(
			healthy({ integrity: { violations: 0, lastAt: null, grantBacked: 3, grantBackedWithoutGrant: 1 } }),
		);
		expect(verdict.status).toBe('ok');
	});

	it('outranks every other signal, so it is never masked by a busy platform', () => {
		const verdict = homeHealthVerdict(
			healthy({
				integrity: { violations: 3, lastAt: '2026-09-03T03:37:14.568Z', grantBacked: 0, grantBackedWithoutGrant: 0 },
				actions: { total: 1000, ok: 1000, refused: 0, failed: 0, homes: 90, failedHomes: 0, rate: 1, timed: 1000, p95LatencyMs: 120 },
			}),
		);
		expect(verdict.status).toBe('down');
		expect(verdict.detail).toContain('3 guarded physical actions');
	});
});

describe('one dark house is a UI state, not an outage', () => {
	it('does not score a handshake rate at all below the home floor', () => {
		// Three homes, one offline: a 33% failure rate that must not page anyone.
		const verdict = homeHealthVerdict(
			healthy({
				homes: { live: 3, connected: 2, unreachable: 1, authFailed: 0 },
				handshakes: { attempts: 3, ok: 2, failed: 1, rate: 2 / 3 },
			}),
		);
		expect(verdict.status).toBe('ok');
		expect(verdict.detail).toContain(`under the ${MIN_HOMES_FOR_A_VERDICT}-home floor, reported not scored`);
	});

	it('still reports the failure, so the operator can see it without being paged for it', () => {
		const verdict = homeHealthVerdict(
			healthy({
				homes: { live: 3, connected: 2, unreachable: 1, authFailed: 0 },
				handshakes: { attempts: 3, ok: 2, failed: 1, rate: 2 / 3 },
			}),
		);
		expect(verdict.detail).toContain('66.7%');
		expect(verdict.detail).toContain('2/3 homes connected');
	});

	it('an expired token on one house of forty does not move the aggregate', () => {
		const verdict = homeHealthVerdict(
			healthy({
				homes: { live: 40, connected: 39, unreachable: 0, authFailed: 1 },
				handshakes: { attempts: 40, ok: 39, failed: 1, rate: 39 / 40 },
			}),
		);
		expect(verdict.status).toBe('ok');
	});
});

describe('a correlated failure is an outage', () => {
	it('goes down when handshakes fail across enough homes at once', () => {
		const attempts = MIN_HOMES_FOR_A_VERDICT + 2;
		const ok = 2;
		const verdict = homeHealthVerdict(
			healthy({
				homes: { live: 40, connected: ok, unreachable: attempts - ok, authFailed: 0 },
				handshakes: { attempts, ok, failed: attempts - ok, rate: ok / attempts },
			}),
		);
		expect(ok / attempts).toBeLessThan(HANDSHAKE_DOWN);
		expect(verdict.status).toBe('down');
		expect(verdict.hint).toContain('almost always us');
	});

	it('degrades between the two thresholds rather than jumping straight to down', () => {
		const verdict = homeHealthVerdict(
			healthy({ handshakes: { attempts: 40, ok: 35, failed: 5, rate: 0.875 } }),
		);
		expect(verdict.status).toBe('degraded');
	});
});

describe('actions', () => {
	it('counts a refused action as a success, because the gate working is not a fault', () => {
		// Every action refused, none failed: the safety gate did its job all day.
		const verdict = homeHealthVerdict(
			healthy({ actions: { total: 100, ok: 0, refused: 100, failed: 0, homes: 20, failedHomes: 0, rate: 1, timed: 100, p95LatencyMs: 200 } }),
		);
		expect(verdict.status).toBe('ok');
	});

	it('goes down when actions genuinely fail across homes', () => {
		const rate = 0.9;
		expect(rate).toBeLessThan(ACTION_DOWN);
		const verdict = homeHealthVerdict(
			healthy({ actions: { total: 100, ok: 90, refused: 0, failed: 10, homes: 25, failedHomes: 6, rate, timed: 100, p95LatencyMs: 300 } }),
		);
		expect(verdict.status).toBe('down');
		expect(verdict.detail).toContain('10 failed');
	});

	it('does not down the platform for failures confined to one house', () => {
		// One home whose Z-Wave stick fell out fails everything sent to it. That is
		// that house, and paging for it is paging for a loose USB port.
		const verdict = homeHealthVerdict(
			healthy({ actions: { total: 100, ok: 88, refused: 0, failed: 12, homes: 25, failedHomes: 1, rate: 0.88, timed: 100, p95LatencyMs: 300 } }),
		);
		expect(verdict.status).toBe('degraded');
		expect(verdict.detail).toContain('12 failed in 1 home (that house, not us)');
		expect(verdict.hint).toContain('confined to one home');
	});

	it('does not score a thin window at all', () => {
		const total = MIN_ACTIONS_FOR_A_VERDICT - 1;
		const verdict = homeHealthVerdict(
			healthy({ actions: { total, ok: total - 4, refused: 0, failed: 4, homes: 5, failedHomes: 4, rate: (total - 4) / total, timed: total, p95LatencyMs: 300 } }),
		);
		expect(verdict.status).toBe('ok');
		expect(verdict.detail).toContain(`under the ${MIN_ACTIONS_FOR_A_VERDICT}-action floor`);
	});

	it('says so plainly when nothing on the act path is timed yet', () => {
		const verdict = homeHealthVerdict(healthy({ actions: { ...healthy().actions, timed: 0, p95LatencyMs: null } }));
		expect(verdict.status).toBe('ok');
		expect(verdict.detail).toContain('no action timings recorded');
	});

	it('goes down on our own leg being slow', () => {
		const verdict = homeHealthVerdict(
			healthy({ actions: { ...healthy().actions, p95LatencyMs: LATENCY_DOWN_MS + 1 } }),
		);
		expect(verdict.status).toBe('down');
		expect(verdict.hint).toContain('The house is excluded from this measurement');
	});
});

describe('confirmations that expire are a UI failure', () => {
	it('goes down when most confirmations time out instead of being answered', () => {
		const expiryRate = EXPIRY_DOWN + 0.1;
		const verdict = homeHealthVerdict(
			healthy({ confirmations: { total: 50, redeemed: 25, expired: 25, expiryRate } }),
		);
		expect(verdict.status).toBe('down');
		expect(verdict.hint).toContain('That is a UI failure, not user hesitation');
	});

	it('does not score three prompts as a broken UI', () => {
		const verdict = homeHealthVerdict(
			healthy({ confirmations: { total: 4, redeemed: 1, expired: 3, expiryRate: 0.75 } }),
		);
		expect(verdict.status).toBe('ok');
		expect(verdict.detail).toContain(`under the ${MIN_CONFIRMATIONS_FOR_A_VERDICT}-confirmation floor`);
	});

	it('ignores an empty window rather than scoring it as perfect or broken', () => {
		const verdict = homeHealthVerdict(
			healthy({ confirmations: { total: 0, redeemed: 0, expired: 0, expiryRate: null } }),
		);
		expect(verdict.status).toBe('ok');
		expect(verdict.detail).toContain('no confirmations in window');
	});
});

describe('the subscriber leak detector', () => {
	beforeEach(() => resetSubscriberSamples());

	it('does not accuse anything before it has three samples', () => {
		expect(noteSubscriberSample({ subscribers: 10, open: 1, streams: 10 }).leaking).toBe(false);
		expect(noteSubscriberSample({ subscribers: 20, open: 1, streams: 20 }).leaking).toBe(false);
	});

	it('fires on subscribers climbing while connections do not', () => {
		// The shape a real leaked subscription produces, measured against the
		// runtime's own stats(): six leaked subscriptions over one pooled
		// connection, with the stream gauge moving in lockstep the whole time.
		noteSubscriberSample({ subscribers: 1, open: 1, streams: 1 });
		noteSubscriberSample({ subscribers: 3, open: 1, streams: 3 });
		const third = noteSubscriberSample({ subscribers: 6, open: 1, streams: 6 });

		expect(third.leaking).toBe(true);
		expect(third.samples).toEqual([1, 3, 6]);
		expect(third.growth).toBe(5);
	});

	it('is not fooled by the margin being zero, which it always is', () => {
		// subscribe() registers the subscriber and admits the stream in one call,
		// so a detector built on their difference could never fire. This pins that
		// the margin is recorded but is not what decides the verdict.
		noteSubscriberSample({ subscribers: 1, open: 1, streams: 1 });
		noteSubscriberSample({ subscribers: 3, open: 1, streams: 3 });
		const third = noteSubscriberSample({ subscribers: 6, open: 1, streams: 6 });

		expect(third.margins).toEqual([0, 0, 0]);
		expect(third.leaking).toBe(true);
	});

	it('clears as soon as the leaked subscriptions are released', () => {
		noteSubscriberSample({ subscribers: 1, open: 1, streams: 1 });
		noteSubscriberSample({ subscribers: 3, open: 1, streams: 3 });
		expect(noteSubscriberSample({ subscribers: 6, open: 1, streams: 6 }).leaking).toBe(true);

		expect(noteSubscriberSample({ subscribers: 0, open: 1, streams: 0 }).leaking).toBe(false);
	});

	it('does not call a fleet taking on more houses a leak', () => {
		// Subscribers and connections rising together is growth, not a leak.
		noteSubscriberSample({ subscribers: 10, open: 10, streams: 10 });
		noteSubscriberSample({ subscribers: 40, open: 40, streams: 40 });
		expect(noteSubscriberSample({ subscribers: 90, open: 90, streams: 90 }).leaking).toBe(false);
	});

	it('does not call a big family watching one house a leak', () => {
		// Rising, connections flat, but still a plausible number of people on one
		// home. Below the per-connection ceiling this stays quiet.
		noteSubscriberSample({ subscribers: 1, open: 1, streams: 1 });
		noteSubscriberSample({ subscribers: 2, open: 1, streams: 2 });
		expect(noteSubscriberSample({ subscribers: 4, open: 1, streams: 4 }).leaking).toBe(false);
	});

	it('does not call a falling count a leak', () => {
		noteSubscriberSample({ subscribers: 30, open: 1, streams: 30 });
		noteSubscriberSample({ subscribers: 20, open: 1, streams: 20 });
		expect(noteSubscriberSample({ subscribers: 12, open: 1, streams: 12 }).leaking).toBe(false);
	});

	it('works with no stream gauge at all', () => {
		noteSubscriberSample({ subscribers: 1, open: 1, streams: null });
		noteSubscriberSample({ subscribers: 3, open: 1, streams: null });
		expect(noteSubscriberSample({ subscribers: 6, open: 1, streams: null }).leaking).toBe(true);
	});

	it('surfaces the leak as degraded, not down: every request is still being served', () => {
		const verdict = homeHealthVerdict(
			healthy({ leak: { leaking: true, samples: [1, 3, 6], margins: [0, 0, 0], growth: 5 } }),
		);
		expect(verdict.status).toBe('degraded');
		expect(verdict.hint).toContain('never released');
	});
});

describe('an empty platform', () => {
	it('reports unknown rather than a confident green when no home is connected', () => {
		const verdict = homeHealthVerdict(
			healthy({
				homes: { live: 0, connected: 0, unreachable: 0, authFailed: 0 },
				handshakes: { attempts: 0, ok: 0, failed: 0, rate: null },
			}),
		);
		expect(verdict.status).toBe('unknown');
		expect(verdict.detail).toContain('no homes connected yet');
	});
});
