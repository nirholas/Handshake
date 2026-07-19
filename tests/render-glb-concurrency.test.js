// Tests for the renderer's per-container concurrency cap and its
// infra-error retry. Both exist because of the 2026-07-18 incident: a burst of
// parallel renders stacked enough chromium pages to OOM the container, and the
// resulting browser death surfaced as user-facing 502s. The GLB fetch and the
// browser are both stubbed, so these run fast and headless everywhere.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../api/_lib/fetch-model.js', () => ({
	fetchModel: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]) })),
}));

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A controllable stand-in for the puppeteer browser: every page renders
// successfully after `pageDelayMs`, unless a queued failure says otherwise.
function makeFakeBrowser({ pageDelayMs = 25, failures = [] } = {}) {
	const state = { open: 0, maxOpen: 0, pagesCreated: 0 };
	const browser = {
		connected: true,
		on() {},
		async newPage() {
			state.pagesCreated += 1;
			state.open += 1;
			state.maxOpen = Math.max(state.maxOpen, state.open);
			const failure = failures.shift() || null;
			return {
				async setViewport() {},
				async setContent() {},
				async waitForFunction() {
					await new Promise((r) => setTimeout(r, pageDelayMs));
					if (failure) throw new Error(failure);
				},
				async evaluate() {
					return null;
				},
				async screenshot() {
					return PNG_BYTES;
				},
				async close() {
					state.open -= 1;
				},
			};
		},
	};
	return { browser, state };
}

afterEach(async () => {
	const { __setBrowserForTests } = await import('../api/_lib/render-glb.js');
	__setBrowserForTests(null);
});

describe('renderGlbToPng — bounded concurrency', () => {
	it('never runs more pages than the cap, but completes every queued render', async () => {
		const { renderGlbToPng, __setBrowserForTests } = await import('../api/_lib/render-glb.js');
		const { browser, state } = makeFakeBrowser();
		__setBrowserForTests(browser);

		const results = await Promise.all(
			Array.from({ length: 6 }, () => renderGlbToPng({ glbUrl: 'https://example.com/m.glb' })),
		);

		expect(results).toHaveLength(6);
		for (const png of results) expect(png[0]).toBe(0x89);
		// Default cap is 2 (RENDER_GLB_CONCURRENCY unset in tests).
		expect(state.maxOpen).toBeLessThanOrEqual(2);
		expect(state.pagesCreated).toBe(6);
	});
});

describe('renderGlbToPng — infra-error retry', () => {
	it('retries once when the browser dies mid-render', async () => {
		const { renderGlbToPng, __setBrowserForTests } = await import('../api/_lib/render-glb.js');
		const { browser, state } = makeFakeBrowser({
			failures: ['Protocol error (Page.captureScreenshot): Target closed.'],
		});
		__setBrowserForTests(browser);

		const png = await renderGlbToPng({ glbUrl: 'https://example.com/m.glb' });
		expect(png[0]).toBe(0x89);
		expect(state.pagesCreated).toBe(2);
	});

	it('does not retry a genuine render failure', async () => {
		const { renderGlbToPng, __setBrowserForTests } = await import('../api/_lib/render-glb.js');
		const { browser, state } = makeFakeBrowser();
		// A page whose viewer reports a model-side error: evaluate returns the error.
		browser.newPage = async () => {
			state.pagesCreated += 1;
			return {
				async setViewport() {},
				async setContent() {},
				async waitForFunction() {},
				async evaluate() {
					return 'glb parse failed: bad chunk';
				},
				async screenshot() {
					return PNG_BYTES;
				},
				async close() {},
			};
		};
		__setBrowserForTests(browser);

		await expect(renderGlbToPng({ glbUrl: 'https://example.com/m.glb' })).rejects.toThrow(
			/render failed: glb parse failed/,
		);
		expect(state.pagesCreated).toBe(1);
	});
});
