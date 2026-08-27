/**
 * A finished forge job's poll frame is built once and remembered
 * (api/_lib/forge-done-cache.js). Before this, every poll of a done job
 * re-materialized and re-scored it (13-33 s each, measured 2026-08-27).
 */
import { describe, it, expect } from 'vitest';

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { doneFrameKey, recallDoneFrame, rememberDoneFrame } = await import('../api/_lib/forge-done-cache.js');

const LONG_JOB = 'f1.' + 'a'.repeat(900) + '.sig';

describe('forge done-frame cache', () => {
	it('keys by a hash so a 1 KB job token becomes a short stable key', () => {
		expect(doneFrameKey(LONG_JOB)).toMatch(/^forge:done:[0-9a-f]{40}$/);
		expect(doneFrameKey(LONG_JOB)).toBe(doneFrameKey(LONG_JOB));
		expect(doneFrameKey(LONG_JOB)).not.toBe(doneFrameKey(LONG_JOB + 'x'));
	});

	it('remembers a done frame and returns it verbatim on recall', async () => {
		const frame = { job_id: LONG_JOB, status: 'done', glb_url: 'https://cdn.test/a.glb', quality_gate: { score: 85 } };
		expect(await recallDoneFrame(LONG_JOB)).toBeNull();
		expect(await rememberDoneFrame(LONG_JOB, frame)).toBe(true);
		expect(await recallDoneFrame(LONG_JOB)).toEqual(frame);
	});

	it('refuses to remember anything that is not a finished frame with a model', async () => {
		expect(await rememberDoneFrame('f1.pending', { status: 'running' })).toBe(false);
		expect(await rememberDoneFrame('f1.nomodel', { status: 'done' })).toBe(false);
		expect(await rememberDoneFrame('', { status: 'done', glb_url: 'x' })).toBe(false);
		expect(await recallDoneFrame('f1.pending')).toBeNull();
	});
});
