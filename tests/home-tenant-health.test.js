// The per-tenant half of the Home observability lane.
//
// tests/home-integrity.test.js proves the platform does not page anyone for one
// dark house. That promise is only honest if the owner of that house is told
// instead, which is what this file exercises: the verdict a single household
// sees, and in particular the `fault` field, which answers the only question
// they actually have.
//
// `fault` is allowed to be wrong in exactly one direction. Saying "we cannot
// tell" costs a user nothing; saying "your router" during our own outage costs
// them an evening power-cycling working hardware, so every branch that claims
// `your_home` is asserted against a fleet that is provably fine.

import { describe, expect, it } from 'vitest';

import {
	CORRELATION_MIN_HOMES,
	fleetLooksCorrelated,
	TENANT_STALE_MS,
	tenantHealthVerdict,
} from '../api/_lib/home/health.js';
import { MIN_HOMES_FOR_A_VERDICT } from '../api/_lib/ops/home-health.js';

const NOW = Date.parse('2026-09-03T04:00:00.000Z');
const FRESH = new Date(NOW - 5_000).toISOString();
const OLD = new Date(NOW - TENANT_STALE_MS - 60_000).toISOString();

/** One house that is fine, in a fleet that is fine, as `readTenantHealth` shapes it. */
function signals(overrides = {}) {
	return {
		windowMinutes: 1440,
		home: {
			id: 'e4d0f6b2-0000-4000-8000-000000000001',
			label: 'Home',
			status: 'connected',
			statusDetail: null,
			lastOkAt: FRESH,
			lastErrorAt: null,
			...(overrides.home || {}),
		},
		actions: {
			total: 12, ok: 10, refused: 2, failed: 0, lastFailedAt: null, timed: 12, p95LatencyMs: 380,
			...(overrides.actions || {}),
		},
		confirmations: { total: 3, redeemed: 3, expired: 0, ...(overrides.confirmations || {}) },
		fleet: { live: 40, connected: 40, othersFailing: 0, ...(overrides.fleet || {}) },
	};
}

const verdict = (o) => tenantHealthVerdict(signals(o), { now: NOW });

describe('a healthy house', () => {
	it('says so, blames nobody, and offers no busywork', () => {
		const v = verdict();
		expect(v.state).toBe('live');
		expect(v.fault).toBe('none');
		expect(v.advice).toEqual([]);
	});

	it('counts a refused action as having gone the way it should', () => {
		// The gate stopping an unlock is the product working. A user must never
		// read their own safety gate as a fault in their house.
		expect(verdict().reason).toContain('12 of 12 actions');
	});

	it('does not invent activity for a quiet house', () => {
		const v = verdict({ actions: { total: 0, ok: 0, refused: 0, failed: 0, timed: 0, p95LatencyMs: null } });
		expect(v.state).toBe('live');
		expect(v.reason).toContain('No actions');
	});
});

describe('a house that has gone quiet', () => {
	it('is stale rather than offline, and does not guess whose fault that is', () => {
		const v = verdict({ home: { lastOkAt: OLD } });
		expect(v.state).toBe('stale');
		expect(v.fault).toBe('unknown');
	});

	it('keeps the last state on screen rather than telling the user it is gone', () => {
		expect(verdict({ home: { lastOkAt: OLD } }).advice.join(' ')).toContain('last state we saw');
	});
});

describe('a house that is genuinely down, in a fleet that is fine', () => {
	it('names the house as the fault and says what to check', () => {
		const v = verdict({ home: { status: 'unreachable', lastOkAt: OLD, lastErrorAt: FRESH } });
		expect(v.state).toBe('unreachable');
		expect(v.fault).toBe('your_home');
		expect(v.advice.length).toBeGreaterThan(0);
	});

	it('prefers the real error the handshake recorded over a generic sentence', () => {
		const v = verdict({
			home: { status: 'unreachable', statusDetail: 'Connection refused on port 8123.', lastOkAt: OLD },
		});
		expect(v.reason).toBe('Connection refused on port 8123.');
	});

	it('separates a token being rejected from a house being unreachable', () => {
		// The two look identical to a user and have completely different fixes.
		// A rejected token means the house answered, which is the opposite of down.
		const v = verdict({ home: { status: 'auth_failed', lastOkAt: OLD } });
		expect(v.fault).toBe('your_home');
		expect(v.headline).toContain('rejected');
		expect(v.advice.join(' ')).toContain('long-lived access token');
	});
});

describe('a house that is down because we are down', () => {
	const outage = { fleet: { live: 40, connected: 8, othersFailing: 30 } };

	it('takes the blame instead of sending the user to their router', () => {
		const v = verdict({ ...outage, home: { status: 'unreachable', lastOkAt: OLD } });
		expect(v.fault).toBe('us');
		expect(v.advice.join(' ')).toContain('Nothing to do');
	});

	it('covers a house that has merely gone quiet, not only one marked unreachable', () => {
		expect(verdict({ ...outage, home: { lastOkAt: OLD } }).fault).toBe('us');
	});

	it('does not blame our outage for a home the user disconnected themselves', () => {
		// A revoked home has no token at all. Telling its owner "this one is us"
		// during an unrelated outage would be a lie they might act on.
		const v = verdict({ ...outage, home: { status: 'revoked', lastOkAt: OLD } });
		expect(v.state).toBe('revoked');
		expect(v.fault).toBe('none');
	});

	it('leaves a healthy house alone even while the fleet is burning', () => {
		expect(verdict({ ...outage }).fault).toBe('none');
	});
});

describe('deciding whether it is us', () => {
	it('refuses to call it an outage on a fleet too small to have a share', () => {
		// Three of four houses failing is far more likely to be one person's three
		// test instances on one dead laptop.
		expect(fleetLooksCorrelated({ live: MIN_HOMES_FOR_A_VERDICT - 1, othersFailing: 3 })).toBe(false);
	});

	it('refuses to call two unlucky houses an outage', () => {
		expect(fleetLooksCorrelated({ live: 40, othersFailing: CORRELATION_MIN_HOMES - 1 })).toBe(false);
	});

	it('calls it when a large share of a big enough fleet is failing at once', () => {
		expect(fleetLooksCorrelated({ live: 40, othersFailing: 30 })).toBe(true);
	});

	it('does not call a handful of failures across a large fleet an outage', () => {
		expect(fleetLooksCorrelated({ live: 400, othersFailing: 5 })).toBe(false);
	});
});

describe('a home that never finished connecting', () => {
	it('is reported as still setting up rather than as broken', () => {
		const v = verdict({ home: { status: 'pending', lastOkAt: null } });
		expect(v.state).toBe('pending');
		expect(v.fault).toBe('unknown');
	});
});
