import { describe, it, expect } from 'vitest';
import {
	decideSelfhostMissing,
	GCP_TASK_MISSING_GRACE_MS,
	GCP_TASK_MISSING_CODE,
} from '../../api/_lib/forge-selfhost-recovery.js';

// The recovery for the platform's largest generation-failure class: a self-host
// worker 404 ("task not found on gcp service") — 410 of 425 trellis failures,
// all image→3D — that the router used to treat as terminal on the first poll.

describe('decideSelfhostMissing — never dead-end on a recoverable 404', () => {
	const glbUrl = 'https://three.ws/cdn/forge/abc.glb';

	it('passes through any result that is not the recoverable 404 class', () => {
		expect(decideSelfhostMissing({ code: undefined, ageMs: 0 }).action).toBe('passthrough');
		expect(decideSelfhostMissing({ code: 'some_other_error', ageMs: 0 }).action).toBe('passthrough');
		// A genuine done/failed result never carries the missing code, so it flows
		// through untouched.
		expect(decideSelfhostMissing({}).action).toBe('passthrough');
	});

	it('resolves DONE when a durable result already materialized (racing poll / completion write)', () => {
		const d = decideSelfhostMissing({
			code: GCP_TASK_MISSING_CODE,
			row: { status: 'done', glb_url: glbUrl },
			ageMs: GCP_TASK_MISSING_GRACE_MS + 10_000, // even past grace, a real result wins
		});
		expect(d).toEqual({ action: 'done', glbUrl });
	});

	it('keeps the client polling (RUNNING) for a young job — the post-submit cross-instance window', () => {
		const d = decideSelfhostMissing({
			code: GCP_TASK_MISSING_CODE,
			row: { status: 'running', glb_url: null },
			ageMs: 5_000, // 5s after submit: the durable record just isn't visible yet
		});
		expect(d.action).toBe('running');
	});

	it('keeps polling even with no store row yet, while young', () => {
		const d = decideSelfhostMissing({ code: GCP_TASK_MISSING_CODE, row: null, ageMs: 1_000 });
		expect(d.action).toBe('running');
	});

	it('FAILS once the job is older than grace — a still-missing task is genuinely orphaned', () => {
		const d = decideSelfhostMissing({
			code: GCP_TASK_MISSING_CODE,
			row: { status: 'running', glb_url: null },
			ageMs: GCP_TASK_MISSING_GRACE_MS + 1,
		});
		expect(d.action).toBe('fail');
	});

	it('FAILS when age is unknowable (no created_at) — conservative, preserves prior behavior', () => {
		expect(decideSelfhostMissing({ code: GCP_TASK_MISSING_CODE, row: null, ageMs: Infinity }).action).toBe('fail');
		expect(decideSelfhostMissing({ code: GCP_TASK_MISSING_CODE, row: null, ageMs: NaN }).action).toBe('fail');
		expect(decideSelfhostMissing({ code: GCP_TASK_MISSING_CODE, row: null }).action).toBe('fail');
	});

	it('boundary: exactly at grace is terminal, just under is still running', () => {
		expect(decideSelfhostMissing({ code: GCP_TASK_MISSING_CODE, ageMs: GCP_TASK_MISSING_GRACE_MS }).action).toBe('fail');
		expect(decideSelfhostMissing({ code: GCP_TASK_MISSING_CODE, ageMs: GCP_TASK_MISSING_GRACE_MS - 1 }).action).toBe('running');
	});

	it('a done row missing its glb url is not treated as done (falls to grace/fail)', () => {
		const young = decideSelfhostMissing({ code: GCP_TASK_MISSING_CODE, row: { status: 'done', glb_url: null }, ageMs: 1_000 });
		expect(young.action).toBe('running');
		const old = decideSelfhostMissing({ code: GCP_TASK_MISSING_CODE, row: { status: 'done', glb_url: null }, ageMs: GCP_TASK_MISSING_GRACE_MS + 1 });
		expect(old.action).toBe('fail');
	});

	it('grace window is a sane length (covers the visibility window, fits the client poll budget)', () => {
		expect(GCP_TASK_MISSING_GRACE_MS).toBeGreaterThanOrEqual(30_000);
		expect(GCP_TASK_MISSING_GRACE_MS).toBeLessThanOrEqual(180_000);
	});
});
