/**
 * quality-bench run budget (pollForge / runOne `deadlineAt`).
 *
 * The weekly /api/cron/quality-bench sweep runs on Cloud Run, where nothing
 * enforces the handler's `maxDuration`. With no self-imposed ceiling the
 * 2026-08-10 run spent 900s on three sequential generations, took a 504 from
 * Cloud Run, left Cloud Scheduler recording DEADLINE_EXCEEDED, and logged its
 * summary 21 minutes after anyone could read it. `deadlineAt` is the fix.
 * Contracts under test:
 *   1. A caller's wall-clock deadline beats pollForge's own patience, and the
 *      failure is tagged `budget_exhausted` rather than a generic poll timeout.
 *   2. No deadline means the old unbounded-patience behavior, unchanged, so the
 *      by-hand full bench in scripts/quality-bench.mjs is untouched.
 *   3. Running out of clock during generation is NOT scored as a zero the way a
 *      broken lane is: it yields a null meanScore, so a short clock can never be
 *      read as a quality regression.
 *   4. The per-view render/judge loop stops at the deadline too, instead of
 *      running on past a response nobody is listening to.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const renderClip = vi.fn();
vi.mock('../api/_lib/render-clip.js', () => ({ renderClip: (...a) => renderClip(...a) }));
vi.mock('../api/_lib/vertex-gemini.js', () => ({
	vertexGeminiAvailable: () => false,
	vertexGeminiChatUrl: () => 'https://vertex.invalid/chat',
	vertexGeminiHeaders: async () => ({}),
}));

import { pollForge, runOne } from '../api/_lib/quality-bench.js';

const BASE = 'https://three.ws';
const PROMPT = { id: 'qb01', subjectClass: 'people', prompt: 'a stone bust', mode: 'text' };

// Forge stand-in: POST /api/forge submits, GET /api/forge?job= reports status.
// `submitResponse` decides whether generation resolves instantly or has to poll.
function stubForge({ submitResponse, pollStatus = 'running' }) {
	return vi.fn(async (url, init) => {
		const method = init?.method || 'GET';
		if (method === 'POST') return { ok: true, json: async () => submitResponse };
		return { ok: true, json: async () => ({ status: pollStatus }) };
	});
}

let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	renderClip.mockReset();
});
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

describe('pollForge deadlineAt', () => {
	it('stops at the caller budget instead of waiting out its own timeout', async () => {
		globalThis.fetch = stubForge({ submitResponse: { job_id: 'j1' } });
		const started = Date.now();
		await expect(
			pollForge(BASE, 'j1', { timeoutMs: 10 * 60 * 1000, intervalMs: 10, deadlineAt: Date.now() + 60 }),
		).rejects.toMatchObject({ code: 'budget_exhausted' });
		// It must give up on the budget, nowhere near the 10-minute patience.
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it('keeps the plain timeout error when no budget is passed', async () => {
		globalThis.fetch = stubForge({ submitResponse: { job_id: 'j1' } });
		await expect(pollForge(BASE, 'j1', { timeoutMs: 40, intervalMs: 10 })).rejects.toThrow(
			/poll timed out after 40ms/,
		);
	});

	it('returns the finished job when it lands inside the budget', async () => {
		globalThis.fetch = stubForge({ submitResponse: { job_id: 'j1' }, pollStatus: 'done' });
		await expect(pollForge(BASE, 'j1', { intervalMs: 10, deadlineAt: Date.now() + 5000 })).resolves.toMatchObject({
			status: 'done',
		});
	});
});

describe('runOne under a budget', () => {
	it('reports an exhausted budget without scoring it as a zero', async () => {
		globalThis.fetch = stubForge({ submitResponse: { job_id: 'j1' } });
		const result = await runOne(BASE, PROMPT, 'lane-a', 'standard', { deadlineAt: Date.now() + 60 });
		expect(result.status).toBe('budget_exhausted');
		// A broken lane scores 0 and drags the mean down. Out of time must not:
		// null keeps it out of the comparison entirely.
		expect(result.meanScore).toBeNull();
		expect(renderClip).not.toHaveBeenCalled();
	});

	it('still scores a lane failure as a zero', async () => {
		globalThis.fetch = vi.fn(async (url, init) => {
			if ((init?.method || 'GET') === 'POST') return { ok: false, json: async () => ({ error: 'lane down' }) };
			return { ok: true, json: async () => ({ status: 'running' }) };
		});
		const result = await runOne(BASE, PROMPT, 'lane-a', 'standard', { deadlineAt: Date.now() + 5000 });
		expect(result.status).toBe('lane_failed');
		expect(result.meanScore).toBe(0);
	});

	it('stops the view sweep at the deadline once generation is done', async () => {
		globalThis.fetch = stubForge({ submitResponse: { status: 'done', glb_url: 'https://cdn.invalid/a.glb' } });
		const result = await runOne(BASE, PROMPT, 'lane-a', 'standard', { deadlineAt: Date.now() - 1 });
		expect(result.glbUrl).toBe('https://cdn.invalid/a.glb');
		expect(result.status).toBe('budget_exhausted');
		expect(result.meanScore).toBeNull();
		expect(result.views).toEqual([]);
		expect(renderClip).not.toHaveBeenCalled();
	});
});
