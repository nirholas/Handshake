// Tests for how `scripts/check-cron-drift.mjs` explains a MISSING Cloud
// Scheduler job.
//
// "MISSING" has two causes that look identical in the report and need opposite
// actions, and picking the wrong one is expensive both ways: syncing a cron
// whose handler is not in the running revision schedules a 404 every run, while
// waiting for a deploy that a live handler does not need leaves a declared cron
// that has never fired once (that is exactly how /api/cron/retention-rollup and
// /api/cron/likeness-eval sat unscheduled on 2026-08-14). The classifier reads
// production's own answer on the cron path instead of guessing.

import { describe, it, expect } from 'vitest';
import { classifyMissing } from '../scripts/check-cron-drift.mjs';

describe('classifyMissing', () => {
	it('calls a 404 an undeployed handler, whose job belongs to the next deploy', () => {
		expect(classifyMissing(404)).toBe('handler not deployed');
	});

	it('treats every answering status as live, so the sync is the only thing missing', () => {
		// 401 is a real CRON_SECRET rejecting an unauthenticated probe and 503 is
		// the gate failing closed with the secret unset. Both prove the handler is
		// in the running revision, which is the only question being asked.
		expect(classifyMissing(401)).toBe('deployed, never synced');
		expect(classifyMissing(503)).toBe('deployed, never synced');
		expect(classifyMissing(200)).toBe('deployed, never synced');
		expect(classifyMissing(500)).toBe('deployed, never synced');
	});

	it('stays silent when the probe never answered rather than inventing a cause', () => {
		expect(classifyMissing(null)).toBe(null);
		expect(classifyMissing(undefined)).toBe(null);
	});
});
