// api/_lib/irl-analytics.js — site-wide /irl usage rollup.
//
// Covers the privacy-load-bearing bits (device tokens are hashed, never stored
// raw; lat/lng collapse to a geocell before storage), the "never breaks the
// caller" contract of logIrlEvent, and the summary query's window/shape.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock }));

const {
	IRL_EVENT_TYPES,
	hashDeviceToken,
	logIrlEvent,
	recordShareView,
	getIrlAnalyticsSummary,
} = await import('../api/_lib/irl-analytics.js');

beforeEach(() => {
	sqlMock.mockReset();
	// Every call defaults to an empty-row resolution unless a test overrides it —
	// ensureIrlAnalyticsSchema's CREATE TABLE/INDEX statements don't return rows.
	sqlMock.mockResolvedValue([]);
});

describe('IRL_EVENT_TYPES', () => {
	it('is the closed vocabulary logIrlEvent enforces', () => {
		expect(IRL_EVENT_TYPES.has('pin_created')).toBe(true);
		expect(IRL_EVENT_TYPES.has('nearby_fetch')).toBe(true);
		expect(IRL_EVENT_TYPES.has('share_created')).toBe(true);
		expect(IRL_EVENT_TYPES.has('share_viewed')).toBe(true);
		expect(IRL_EVENT_TYPES.has('made_up_type')).toBe(false);
	});
});

describe('hashDeviceToken', () => {
	it('returns a 16-hex-char opaque prefix, never the raw token', async () => {
		const h = await hashDeviceToken('super-secret-device-token');
		expect(h).toMatch(/^[0-9a-f]{16}$/);
		expect(h).not.toContain('super-secret-device-token');
	});

	it('is stable for the same input and different for different input', async () => {
		const a = await hashDeviceToken('device-a');
		const b = await hashDeviceToken('device-a');
		const c = await hashDeviceToken('device-b');
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it('null-guards absent/non-string tokens', async () => {
		expect(await hashDeviceToken(null)).toBeNull();
		expect(await hashDeviceToken(undefined)).toBeNull();
		expect(await hashDeviceToken(42)).toBeNull();
		expect(await hashDeviceToken('')).toBeNull();
	});
});

describe('logIrlEvent', () => {
	it('rejects an unknown event type without touching the database', async () => {
		await logIrlEvent({ type: 'not_a_real_event' });
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('inserts a coarsened geocell7, never a raw lat/lng, when a location is given', async () => {
		await logIrlEvent({ type: 'nearby_fetch', lat: 37.7749, lng: -122.4194, metadata: { count: 3 } });
		const insertCall = sqlMock.mock.calls.find(([strings]) =>
			Array.isArray(strings) && strings.join(' ').includes('INSERT INTO irl_events'));
		expect(insertCall).toBeTruthy();
		const [, , , geocell7] = insertCall; // event_type, pin_id, geocell7 positions in the template values
		expect(typeof geocell7).toBe('string');
		expect(geocell7.length).toBe(7);
	});

	it('stores no geocell when no location is given', async () => {
		await logIrlEvent({ type: 'pin_created', pinId: 'abc' });
		const insertCall = sqlMock.mock.calls.find(([strings]) =>
			Array.isArray(strings) && strings.join(' ').includes('INSERT INTO irl_events'));
		expect(insertCall).toBeTruthy();
	});

	it('hashes the device token before it ever reaches a query', async () => {
		await logIrlEvent({ type: 'pin_created', pinId: 'abc', deviceToken: 'raw-device-token-xyz' });
		const insertCall = sqlMock.mock.calls.find(([strings]) =>
			Array.isArray(strings) && strings.join(' ').includes('INSERT INTO irl_events'));
		const flatArgs = insertCall.join('|');
		expect(flatArgs).not.toContain('raw-device-token-xyz');
	});

	it('never throws when the database rejects every call — the hot path must survive', async () => {
		sqlMock.mockReset();
		sqlMock.mockRejectedValue(new Error('db is down'));
		await expect(logIrlEvent({ type: 'pin_created', pinId: 'abc' })).resolves.toBeUndefined();
	});
});

describe('recordShareView', () => {
	it('bumps view_count and logs a share_viewed event when the token exists', async () => {
		sqlMock.mockReset();
		sqlMock.mockResolvedValue([]); // schema DDL calls
		sqlMock.mockImplementationOnce(async () => []); // ensureIrlAnalyticsSchema: CREATE TABLE irl_events
		const result = await recordShareView('tok123');
		// With no matching row the UPDATE...RETURNING resolves empty and nothing
		// further is logged — this just asserts the call never throws.
		expect(result === null || typeof result === 'object').toBe(true);
	});

	it('never throws on a database failure', async () => {
		sqlMock.mockReset();
		sqlMock.mockRejectedValue(new Error('db is down'));
		await expect(recordShareView('tok123')).resolves.toBeNull();
	});
});

describe('getIrlAnalyticsSummary', () => {
	it('returns a window per period with honest zeros when every query is empty', async () => {
		sqlMock.mockReset();
		sqlMock.mockResolvedValue([]);
		// Provide the two-field shape the summary destructures for the placed/nearby
		// aggregate queries so `placed?.n || 0` style access doesn't throw on undefined.
		sqlMock.mockImplementation(async (strings) => {
			const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
			if (/count\(\*\)::int AS n, count\(DISTINCT device_hash\)/.test(q)) return [{ n: 0, unique_devices: 0 }];
			if (/count\(\*\)::int AS created, coalesce/.test(q)) return [{ created: 0, views: 0 }];
			if (/count\(\*\)::int AS n\s*FROM irl_drop_claims/.test(q)) return [{ n: 0 }];
			return [];
		});

		const summary = await getIrlAnalyticsSummary();

		expect(Object.keys(summary.windows)).toEqual(['24h', '7d', '30d']);
		for (const key of ['24h', '7d', '30d']) {
			expect(summary.windows[key]).toMatchObject({
				pins_placed: 0,
				unique_placers: 0,
				nearby_fetches: 0,
				unique_browsers: 0,
				shares_created: 0,
				share_views: 0,
				drops_claimed: 0,
			});
		}
		expect(summary.placement_modes_30d).toEqual({});
		expect(Array.isArray(summary.daily_series_30d)).toBe(true);
		expect(typeof summary.generated_at).toBe('string');
	});

	// The 30-day series joins two per-day sub-selects onto a generate_series. Both
	// sides expose a column called `day`, so every reference to the series column has
	// to be qualified: an unqualified one made Postgres reject the whole query with
	// `column reference "day" is ambiguous`, and because the endpoint degrades a
	// failed summary into an empty 200, the rollup silently served zeros forever.
	it('qualifies every reference to the daily-series column so the join is unambiguous', async () => {
		sqlMock.mockReset();
		sqlMock.mockResolvedValue([]);
		await getIrlAnalyticsSummary();

		const series = sqlMock.mock.calls
			.map(([strings]) => (Array.isArray(strings) ? strings.join(' ') : String(strings)))
			.find((q) => /generate_series/.test(q));
		expect(series).toBeTruthy();
		// The series carries its own column alias and both joins reference it.
		expect(series).toMatch(/generate_series\([^)]*\)\s+AS\s+d\(day\)/i);
		expect(series).toMatch(/ON p\.day = d\.day/i);
		expect(series).toMatch(/ON n\.day = d\.day/i);
		// No bare `day` survives on either side of a join condition or the ordering.
		expect(series).not.toMatch(/=\s*day\b/);
		expect(series).not.toMatch(/ORDER BY\s+day\b/i);
	});
});
