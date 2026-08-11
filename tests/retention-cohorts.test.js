// Week-2 retention on minted agents — the cohort arithmetic behind the phase-2
// roadmap metric (api/_lib/retention.js, api/cron/retention-rollup.js).
//
// The parts that can quietly produce a WRONG number rather than an error are all
// here: which Monday a mint belongs to, where the day-7..day-13 window falls, when
// a cohort has stopped moving, and how a per-week row becomes the two stored
// metrics. A retention figure that is silently off by a week is worse than no
// figure at all, because it still gets quoted.

import { describe, it, expect } from 'vitest';
import {
	isoWeekStart,
	retentionWindow,
	isCohortComplete,
	cohortRecords,
	summarizeCohorts,
	RETENTION_METRICS,
	WEEK2_TARGET_RATE,
} from '../api/_lib/retention.js';

describe('isoWeekStart', () => {
	it('maps every day of a week to the same Monday', () => {
		// 2026-08-10 is a Monday; 2026-08-16 is the Sunday that closes its week.
		const days = [
			'2026-08-10T00:00:00Z',
			'2026-08-11T13:45:00Z',
			'2026-08-14T23:59:59Z',
			'2026-08-16T23:59:59Z',
		];
		for (const d of days) expect(isoWeekStart(d)).toBe('2026-08-10');
	});

	it('puts Sunday at the END of its week, not the start', () => {
		// The classic off-by-one: JS getUTCDay() calls Sunday 0, which would put
		// 2026-08-16 in the week starting 2026-08-16 instead of 2026-08-10.
		expect(isoWeekStart('2026-08-16T12:00:00Z')).toBe('2026-08-10');
		expect(isoWeekStart('2026-08-17T00:00:00Z')).toBe('2026-08-17');
	});

	it('accepts a bare date string and a Date alike', () => {
		expect(isoWeekStart('2026-08-13')).toBe('2026-08-10');
		expect(isoWeekStart(new Date('2026-08-13T09:00:00Z'))).toBe('2026-08-10');
	});

	it('crosses a month and a year boundary correctly', () => {
		expect(isoWeekStart('2026-03-01T00:00:00Z')).toBe('2026-02-23');
		expect(isoWeekStart('2027-01-01T00:00:00Z')).toBe('2026-12-28');
	});
});

describe('retentionWindow', () => {
	it('opens on day 7 and closes (exclusive) on day 14', () => {
		expect(retentionWindow('2026-08-11T00:00:00Z')).toEqual({
			start: '2026-08-18',
			end: '2026-08-25',
		});
	});

	it('measures from the owner\'s own mint instant, not the week boundary', () => {
		// A Monday minter and a Saturday minter in the SAME cohort week get
		// different absolute windows — that is the point of per-owner windows.
		expect(retentionWindow('2026-08-10T08:00:00Z').start).toBe('2026-08-17');
		expect(retentionWindow('2026-08-15T08:00:00Z').start).toBe('2026-08-22');
	});
});

describe('isCohortComplete', () => {
	it('is complete only once the window end has arrived', () => {
		expect(isCohortComplete('2026-08-25', '2026-08-24')).toBe(false);
		expect(isCohortComplete('2026-08-25', '2026-08-25')).toBe(true);
		expect(isCohortComplete('2026-08-25', '2026-09-01')).toBe(true);
	});
});

describe('cohortRecords', () => {
	const row = {
		cohort_week: '2026-07-27',
		minted_owners: 40,
		retained_converse: 14,
		retained_return: 22,
		window_start: '2026-08-03',
		window_end: '2026-08-17',
		is_complete: true,
	};

	it('expands one week into one record per stored metric', () => {
		const recs = cohortRecords([row], '2026-08-20');
		expect(recs.map((r) => r.metric)).toEqual([...RETENTION_METRICS]);
		expect(recs[0]).toMatchObject({
			cohortWeek: '2026-07-27',
			metric: 'week2_converse',
			mintedOwners: 40,
			retainedOwners: 14,
			windowStart: '2026-08-03',
			windowEnd: '2026-08-17',
			isComplete: true,
		});
		expect(recs[0].retentionRate).toBeCloseTo(0.35, 10);
		expect(recs[1]).toMatchObject({ metric: 'week2_return', retainedOwners: 22 });
		expect(recs[1].retentionRate).toBeCloseTo(0.55, 10);
	});

	it('drops a cohort with no minters instead of dividing by zero', () => {
		expect(cohortRecords([{ ...row, minted_owners: 0, retained_converse: 0, retained_return: 0 }], '2026-08-20'))
			.toEqual([]);
	});

	it('derives completeness from the window end when the query did not supply it', () => {
		const { is_complete, ...noFlag } = row;
		expect(cohortRecords([noFlag], '2026-08-16')[0].isComplete).toBe(false);
		expect(cohortRecords([noFlag], '2026-08-17')[0].isComplete).toBe(true);
	});

	it('coerces the string counts a driver may hand back', () => {
		const recs = cohortRecords([{ ...row, minted_owners: '40', retained_converse: '10' }], '2026-08-20');
		expect(recs[0].mintedOwners).toBe(40);
		expect(recs[0].retentionRate).toBeCloseTo(0.25, 10);
	});

	it('tolerates an empty or missing result set', () => {
		expect(cohortRecords([], '2026-08-20')).toEqual([]);
		expect(cohortRecords(undefined, '2026-08-20')).toEqual([]);
	});
});

describe('summarizeCohorts', () => {
	const cohorts = [
		{ cohort_week: '2026-07-13', minted_owners: 10, retained_owners: 2, retention_rate: 0.2, is_complete: true },
		{ cohort_week: '2026-07-20', minted_owners: 20, retained_owners: 9, retention_rate: 0.45, is_complete: true },
		// Still open — must not be treated as a settled number.
		{ cohort_week: '2026-07-27', minted_owners: 30, retained_owners: 1, retention_rate: 0.033, is_complete: false },
	];

	it('reports the newest CLOSED cohort, never an open one', () => {
		const s = summarizeCohorts(cohorts);
		expect(s.latestCompleteWeek).toBe('2026-07-20');
		expect(s.latestRate).toBeCloseTo(0.45, 10);
	});

	it('pools closed cohorts by owner, not by averaging the weekly rates', () => {
		// Owner-weighted: 11/30 = 0.3667. A naive mean of 0.2 and 0.45 gives 0.325
		// and would clear the 30% bar for the wrong reason.
		const s = summarizeCohorts(cohorts);
		expect(s.mintedOwners).toBe(30);
		expect(s.retainedOwners).toBe(11);
		expect(s.pooledRate).toBeCloseTo(11 / 30, 10);
		expect(s.completeCohorts).toBe(2);
	});

	it('grades against the roadmap target', () => {
		expect(summarizeCohorts(cohorts).target).toBe(WEEK2_TARGET_RATE);
		expect(summarizeCohorts(cohorts).meetsTarget).toBe(true);
		const weak = [{ cohort_week: '2026-07-20', minted_owners: 20, retained_owners: 3, retention_rate: 0.15, is_complete: true }];
		expect(summarizeCohorts(weak).meetsTarget).toBe(false);
	});

	it('answers null rather than 0% when nothing has closed yet', () => {
		const s = summarizeCohorts([cohorts[2]]);
		expect(s.latestCompleteWeek).toBeNull();
		expect(s.latestRate).toBeNull();
		expect(s.pooledRate).toBeNull();
		expect(s.meetsTarget).toBeNull();
	});

	it('tolerates an empty or missing list', () => {
		expect(summarizeCohorts([]).completeCohorts).toBe(0);
		expect(summarizeCohorts(undefined).pooledRate).toBeNull();
	});
});
